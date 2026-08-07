# image-resizer on AWS Lambda

*Read this in [French](https://github.com/Smeagolworms4/image-resizer/blob/main/LAMBDA.fr.md).*

The same service, in a zip file. No container, no machine to keep alive: an
`image-resizer-lambda-<version>-<arch>.zip` is uploaded to a Lambda function,
a function URL is put in front of it, and every variant becomes an address —
exactly as with the Docker image.

It really is the same service. The Lambda entry point does not reimplement
routing, presets, signing or error handling: it starts the very Express
application of `src/server.js` once per container and relays each invocation to
it. **The Docker image is unaffected** — it ships the same `src/`, it has no new
dependency, and `src/lambda.js` simply never runs there.

> Serverless and image resizing are a good match only **behind a cache**. Lambda
> has no shared cache: without CloudFront (or an equivalent) in front, the same
> thumbnail is recomputed, and re-invoiced, on every single view. See
> [Putting a cache in front](#putting-a-cache-in-front).

## Getting the package

Ready-made archives are attached to every [release](https://github.com/Smeagolworms4/image-resizer/releases),
one per architecture, with their `sha256`:

| File | Lambda architecture |
| --- | --- |
| `image-resizer-lambda-<version>-x64.zip` | `x86_64` |
| `image-resizer-lambda-<version>-arm64.zip` | `arm64` (Graviton, ~20 % cheaper) |

Or build it yourself — the script only needs Node and `zip`:

```bash
npm run build:lambda            # both architectures, into dist/
./scripts/build-lambda.sh --arch arm64
./scripts/build-lambda.sh --arch x64 --no-public   # without the sample images
```

The build downloads sharp's **precompiled binaries for the target
architecture**, not the ones on your machine: an arm64 package can be built from
an x86 laptop, and vice versa. Two builds of the same commit produce a
byte-identical archive, so the published `sha256` is verifiable.

About 10 MB zipped, 24 MB unpacked — well within Lambda's limits (50 MB for a
direct upload, 250 MB unpacked).

## Deploying in five commands

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 1. An execution role — nothing beyond writing to CloudWatch Logs.
aws iam create-role --role-name image-resizer-lambda \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name image-resizer-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# 2. The function.
aws lambda create-function \
  --function-name image-resizer \
  --runtime nodejs22.x \
  --architectures x86_64 \
  --handler src/lambda.handler \
  --role "arn:aws:iam::$ACCOUNT:role/image-resizer-lambda" \
  --zip-file fileb://dist/image-resizer-lambda-1.3.0-x64.zip \
  --memory-size 2048 \
  --timeout 30 \
  --environment 'Variables={SOURCE_DEMO=/var/task/public,CACHE_DIR=/tmp/cache,HEIC_ENABLED=false}'

# 3. A public URL.
aws lambda create-function-url-config --function-name image-resizer --auth-type NONE
aws lambda add-permission --function-name image-resizer \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
```

`SOURCE_DEMO=/var/task/public` points at the sample images shipped inside the
archive: it lets you check a fresh deployment without configuring storage.

```bash
URL=$(aws lambda get-function-url-config --function-name image-resizer --query FunctionUrl --output text)
curl -s "$URL/health"
curl -s -o beach.webp "$URL/demo/test.png/_cover_320_200_80.webp"
```

Shipping a new version:

```bash
aws lambda update-function-code --function-name image-resizer \
  --zip-file fileb://dist/image-resizer-lambda-1.3.0-x64.zip
```

The **architecture must match**: `--architectures arm64` goes with the `arm64`
zip. A mismatch is not caught at deploy time — the function starts and dies on
the first image with `Could not load the sharp module`.

## Configuration

Everything documented in the [README](README.md#configuration) applies as is:
same variables, same defaults, same URL format. They are set with
`aws lambda update-function-configuration --environment`.

Five of them deserve a different value here.

| Variable | On Lambda | Why |
| --- | --- | --- |
| `CACHE_DIR` | `/tmp/cache`, or empty | `/var/task` is read only. `/tmp` is writable, but it is per container and vanishes with it: it saves the repeated download of an original from a warm container, nothing more. 512 MB by default (`--ephemeral-storage` raises it to 10240). |
| `HEIC_ENABLED` | `false` | `heif-convert` is not in the runtime. Left at `true`, a HEIC photo returns a clear `501` rather than an image — but better to say so up front. |
| `VIDEO_POSTER_ENABLED` | `false` (the default) | Same story with `ffmpeg`. Both can be brought in through a Lambda layer, with `HEIC_COMMAND` / `VIDEO_POSTER_COMMAND` pointing into `/opt/bin`. |
| `MAX_CONCURRENCY` | leave it alone | A container handles one invocation at a time; concurrency is Lambda's business, through reserved concurrency. |
| `BASE_PATH` | `/<stage>` behind a REST API | A function URL and an HTTP API serve at the root, and need nothing. A REST API prefixes paths with its stage name. |

**Memory is the real setting.** Lambda allocates CPU in proportion to it: below
1769 MB a function gets less than a full vCPU, and a resize takes visibly
longer. 2048 MB is a sensible starting point; 3008 MB pays for itself on large
originals, since the invocation gets shorter in the same proportion.

### Sources

An HTTP source works unchanged — any public bucket, any CDN, any origin server:

```
SOURCE_PHOTOS=https://my-bucket.s3.eu-west-3.amazonaws.com
```

The service authenticates nothing: it issues a plain `GET`. For a **private**
bucket, either put CloudFront with an origin access control in front of it, or
pass a token through `FETCH_HEADERS` if the storage accepts one. SigV4 signing
of upstream requests is not implemented.

A local source only makes sense for what travels inside the archive
(`/var/task/...`), since the rest of the filesystem is empty. To read a real
volume, attach an EFS access point and point the source at its mount path.

## Response size

An invocation returns its response inside Lambda's payload, capped at **6 MB**
— and the body travels in base64, which inflates it by a third. The handler
refuses anything above 4.5 MB with an explicit `502` rather than letting API
Gateway answer an undiagnosable `Internal server error`.

In practice, a resized image is far below that. A `_original` on a 8 MB photo is
not. Two ways out:

- lower `MAX_SIZE`, `DEFAULT_QUALITY`, or set `ALLOW_ORIGINAL=false`;
- or deploy the **streaming** handler, which raises the ceiling to 20 MB:

```bash
aws lambda update-function-configuration --function-name image-resizer \
  --handler src/lambda.streamingHandler
aws lambda update-function-url-config --function-name image-resizer \
  --invoke-mode RESPONSE_STREAM
```

The body then leaves as raw bytes, without base64 or JSON envelope. Streaming
requires a **function URL**: an HTTP API or a REST API cannot carry it.

## Putting a cache in front

This is not an optimisation, it is the point. Every uncached hit is a full
resize, billed by the millisecond; the same thumbnail viewed a thousand times
costs a thousand resizes. With CloudFront in front, it costs one.

The service already emits what a CDN needs — `Cache-Control` with a long
`s-maxage`, `ETag`, `stale-while-revalidate`. Point a distribution at the
function URL, with the `CachingOptimized` policy and query strings forwarded to
the origin disabled, and the [Behind a cache](README.md#behind-a-cache) section
of the README applies word for word.

The same reasoning makes [signed URLs](SIGNATURE.md) more useful here than
anywhere else: without them, anyone can make your function compute
`_cover_2048_2048_100` on every image, indefinitely, at your expense. They work
identically on Lambda — signing is a HMAC over the path, and nothing else.

```
SIGNATURE_KEY=<a long random key>
```

## Limits worth knowing

| | |
| --- | --- |
| Cold start | ~1 s, of which most is loading sharp's native library. Provisioned concurrency removes it, at a cost. |
| Response | 6 MB buffered, 20 MB streamed (function URL only). |
| Disk | `/var/task` read only, `/tmp` writable and ephemeral. |
| HEIC and video | absent from the runtime, available through a layer. |
| Timeout | 30 s is plenty; anything slower than that has another problem. |
| Concurrency | Lambda's, not the service's — set a reserved concurrency if you want a ceiling. |

## Troubleshooting

**`Could not load the sharp module` / `Error: Cannot find module '../build/Release/sharp-linux-x64.node'`**
The package architecture does not match the function's. Check
`aws lambda get-function-configuration --query Architectures` and redeploy the
matching zip.

**`Runtime.HandlerNotFound`**
The handler is `src/lambda.handler`, with the directory — not `index.handler`.
For streaming, `src/lambda.streamingHandler`.

**Every request answers `Aucune source configurée`**
The function has no `SOURCE_*` variable. The error is raised at initialisation,
so it shows up in CloudWatch before any request.

**Images come back as garbled text on a REST API**
API Gateway REST decodes base64 only for the media types declared as binary.
Add `*/*` to the API's `binaryMediaTypes` — or use a function URL, which needs
no such thing.

**404 on every path, behind a REST API**
The stage name is part of the path. Set `BASE_PATH=/<stage>`.

**A `%` or an accent in a filename returns 404**
Check that the CDN in front is not decoding the path. The service handles
percent-encoding itself, and takes the path exactly as AWS hands it over.

## What the build does

`scripts/build-lambda.sh` reinstalls the dependencies from `package-lock.json`
in a staging directory, asking npm for `linux` / `glibc` / the target CPU — the
same trick the Dockerfile uses to build an ARM image on an x86 machine. It then
drops everything sharp ships for other platforms (musl, wasm32, macOS, Windows:
some fifteen megabytes of libvips the Amazon Linux runtime would never load),
copies `src/` and `public/`, and zips a sorted file list with a fixed timestamp
so the archive is reproducible.

It fails loudly if `@img/sharp-linux-<arch>` is missing, because that is the one
mistake that only shows up in production.

CI builds both archives on every push and every tag
([`.github/workflows/build_lambda.yml`](.github/workflows/build_lambda.yml)),
unpacks the x64 one and actually invokes the handler on a sample image before
publishing it as an artifact — and, on a tag, attaching it to the release.

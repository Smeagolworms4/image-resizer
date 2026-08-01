# image-resizer

[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/coffee.png)](https://www.buymeacoffee.com/smeagolworms4)
[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/paypal.png)](https://www.paypal.com/donate/?business=SURRPGEXF4YVU&no_recurring=0&item_name=Hello%2C+I%27m+SmeagolWorms4.+For+my+open+source+projects.%0AThanks+you+very+mutch+%21%21%21&currency_code=EUR)

*Read this in [French](https://github.com/Smeagolworms4/image-resizer/blob/main/README.fr.md).*

Resizes and converts your images **on the fly**, over HTTP. Point it at a folder or at
any HTTP storage, and every variant becomes an address: `/photos/beach.jpg/_cover_320_320_80.webp`.
Built to sit **behind a cache** — CloudFront, Varnish, nginx, Cloudflare — which is what
turns it into a fast service: it only ever computes a given variant once.

[![Docker Pulls](https://img.shields.io/docker/pulls/smeagolworms4/image-resizer)](https://hub.docker.com/r/smeagolworms4/image-resizer)
[![Image Size](https://img.shields.io/docker/image-size/smeagolworms4/image-resizer/latest)](https://hub.docker.com/r/smeagolworms4/image-resizer)
![arch](https://img.shields.io/badge/arch-amd64%20%7C%20arm64%20%7C%20armv7-6ee7a8)

## What it does

- **Resizes, crops and converts** to JPEG, PNG, WebP or AVIF, with the five sharp fitting
  modes (`cover`, `contain`, `fill`, `inside`, `outside`).
- **Reads from as many sources as you like**: local folders, HTTP storage (S3, Vercel Blob,
  a plain web server), or a mix — one name per source, and that name opens the URL.
- **Caches originals on disk** so the upstream is hit once, whatever the number of variants.
- **Decodes iPhone photos** (HEIC/HEVC), which sharp cannot open on its own.
- **Applies EXIF orientation** and strips metadata (including GPS) from what it serves.
- **Protects itself**: dimensions are clamped, oversized originals refused, and beyond a
  configurable number of simultaneous transformations it answers `503` instead of falling over.
- **Everything is configured through environment variables** — no config file, nothing to rebuild.
- Runs on **amd64, arm64 and armv7**: a NAS, a VPS or a Raspberry Pi all work.

## The URL format

```
/<source>/<path/to/file>/<preset>
```

The preset is the **last path segment**, and it fully describes the transformation:

```
_<fit>_<width>_<height>_<quality>.<format>
```

| URL | Result |
|---|---|
| `/photos/beach.jpg/_.webp` | WebP, default quality, downscaled to `MAX_SIZE` if needed |
| `/photos/beach.jpg/_cover_320_320_80.webp` | 320×320 WebP, cropped to fill, quality 80 |
| `/photos/beach.jpg/_inside_1200__.jpg` | 1200 px wide, height proportional, default quality |
| `/photos/holiday/2024/beach.jpg/_contain_600_400_90.png` | works at any folder depth |
| `/photos/beach.jpg/_original___.jpg` | the original file, byte for byte |

Empty fields fall back to the defaults, which is why `_original___.jpg` carries three
underscores. Unknown fitting modes and disallowed formats are rejected with a `400` rather
than silently served as something else — a cache would keep that mistake for weeks.

**Why a path segment and not a query string**: caches key on the URL, and many of them are
configured to drop or reorder query strings, which silently multiplies or merges entries.
As a path, each variant is one immutable address — and since the extension comes last,
browsers, `curl -O` and download dialogs all see a real `.webp`.

## Getting started

Nothing to clone, nothing to build: the image is published on
[Docker Hub](https://hub.docker.com/r/smeagolworms4/image-resizer). Create an empty folder
and put this `docker-compose.yml` in it:

```yaml
services:
  image-resizer:
    image: smeagolworms4/image-resizer:latest
    container_name: image-resizer
    restart: unless-stopped
    stop_grace_period: 30s
    user: "${PUID:-1000}:${PGID:-1000}"
    env_file:
      - .env
    ports:
      - "${PORT_HOST:-3000}:3000"
    volumes:
      - ./cache:/cache
      # - /path/to/your/photos:/photos:ro
```

Then, next to it:

```bash
mkdir cache
cat > .env <<'EOF'
SOURCE_DEMO=/app/public
#SOURCE_PHOTOS=/photos
#SOURCE_CDN=https://storage.example.com
EOF
docker compose up -d
```

`env_file` is mandatory, so `.env` has to exist — but **at least one source** is, too:
the service refuses to start without one, rather than starting and 400-ing on everything.

The image ships a few sample images, so the installation can be checked straight away:

```
http://localhost:3000/demo/test.png/_cover_320_240_80.webp
http://localhost:3000/health
```

### The single-command equivalent

```bash
docker run -d \
  --name image-resizer \
  --restart unless-stopped \
  --user 1000:1000 \
  -p 3000:3000 \
  -e SOURCE_PHOTOS=/photos \
  -v "$(pwd)/cache:/cache" \
  -v /path/to/your/photos:/photos:ro \
  smeagolworms4/image-resizer:latest
```

### Without Docker

```bash
npm install
SOURCE_PHOTOS=/path/to/photos CACHE_DIR=./cache npm start
```

Node 20.6 or later. `heif-convert` (package `libheif-examples` on Debian/Ubuntu,
`libheif-tools` on Alpine) is only needed for HEIC photos.

## Sources

A source is a **name**, which becomes the first segment of the URL, and a **target**:

```bash
SOURCE_PHOTOS=/data/photos                 # local folder
SOURCE_MEDIA=file:///mnt/nas/media         # same thing, explicit
SOURCE_CDN=https://storage.example.com     # HTTP storage
```

Or all of them in one variable, which suits managed deployments better:

```bash
SOURCES='{"photos":"/data/photos","cdn":"https://storage.example.com"}'
SOURCES='photos=/data/photos,cdn=https://storage.example.com'
```

**Local sources are read-only**, and the path is checked against the source root: a
`../` in the URL is rejected, never resolved.

**HTTP sources are downloaded once**. The original lands in `CACHE_DIR/originals/<source>/`,
and every later variant is computed from that copy — so ten formats of the same photo cost
one upstream request, not ten. Set `CACHE_ORIGINALS=false` to always go back to the source,
or leave `CACHE_DIR` empty to disable disk writes entirely.

## Behind a cache

This service computes; it is not meant to be the thing your visitors hit. Put a cache in
front, and each variant is computed once for its whole lifetime.

The responses carry what a cache needs: an `ETag`, and a `Cache-Control` with a long
`s-maxage` (shared caches) alongside a shorter `max-age` (browsers) and
`stale-while-revalidate`.

```
Cache-Control: public, max-age=604800, s-maxage=5184000, stale-while-revalidate=604800
```

**CloudFront** — origin the service, cache policy *CachingOptimized*, and **forward no
query string** (they play no part here). `Origin Shield` is worth enabling: it collapses
the requests from every edge location into a single one when a variant is cold.

**Varnish** — nothing special to write, the default `builtin.vcl` already does the right
thing. Just give it room and let the long `s-maxage` do the talking:

```vcl
sub vcl_backend_response {
    set beresp.grace = 24h;
}
```

**nginx** — a full cache in a handful of lines:

```nginx
proxy_cache_path /var/cache/nginx/images levels=1:2 keys_zone=images:50m
                 max_size=20g inactive=90d use_temp_path=off;

location / {
    proxy_pass http://image-resizer:3000;
    proxy_cache images;
    proxy_cache_valid 200 90d;
    proxy_cache_valid 404 1m;
    # One upstream request for a cold variant, even under a burst.
    proxy_cache_lock on;
    proxy_cache_use_stale updating error timeout;
    add_header X-Cache-Status $upstream_cache_status;
}
```

If the service does not live at the root of its domain, `BASE_PATH=/images` shifts every
route, health check included.

## Configuration

Everything is set through environment variables, and nothing else. `.env.example` lists
them all with their defaults.

### Sources and network

| Variable | Default | Purpose |
|---|---|---|
| `SOURCE_<NAME>` | — | One source per variable. The name becomes the first URL segment |
| `SOURCES` | — | All sources at once, as JSON or `name=target,name2=target2` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listening socket |
| `BASE_PATH` | empty | Mount prefix, e.g. `/images` |
| `HEALTH_PATH` | `/health` | Health probe — never logged, never cached |
| `TRUST_PROXY` | empty | Express *trust proxy*: `true`, a hop count, or a list of IPs |

### Cache and transformation

| Variable | Default | Purpose |
|---|---|---|
| `CACHE_DIR` | `/cache` in the image | Where downloaded originals and expensive conversions are kept. Empty disables disk writes |
| `CACHE_ORIGINALS` | `true` | Keep originals downloaded over HTTP |
| `MIN_SIZE` / `MAX_SIZE` | `1` / `2048` | Bounds applied to requested dimensions |
| `MIN_QUALITY` / `DEFAULT_QUALITY` | `10` / `80` | Bounds and default for quality |
| `DEFAULT_FIT` | `cover` | Fitting mode when the preset leaves it out |
| `DEFAULT_FORMAT` | `jpeg` | Only used as a fallback; the URL always states the format |
| `ALLOWED_FORMATS` | `jpeg,png,webp,avif` | Anything else is a `400`. `gif` and `tiff` are available |
| `ALLOW_ORIGINAL` | `true` | Allows `_original___.ext`, which serves the file untouched |
| `AUTO_DOWNSCALE` | `true` | With no dimension requested, still bound the image to `MAX_SIZE` |
| `STRIP_METADATA` | `true` | Remove EXIF, GPS and colour profiles from the output |

### Cache headers

| Variable | Default | Purpose |
|---|---|---|
| `MAX_AGE` | `604800` | `max-age`: browsers (7 days) |
| `S_MAX_AGE` | `5184000` | `s-maxage`: shared caches (60 days) |
| `STALE_WHILE_REVALIDATE` | `604800` | Serve stale while refreshing |
| `ERROR_MAX_AGE` | `60` | How long error responses are cached |
| `CACHE_CONTROL` | — | Replaces the header computed from the four above |
| `CORS_ORIGIN` | `*` | Empty removes the CORS headers entirely |

### Upstream, load and logs

| Variable | Default | Purpose |
|---|---|---|
| `FETCH_TIMEOUT` | `15000` | Timeout on the upstream request, in ms |
| `FETCH_USER_AGENT` | `image-resizer` | `User-Agent` used upstream |
| `MAX_INPUT_BYTES` | `67108864` | Above this, the original is refused (`413`) |
| `MAX_CONCURRENCY` | number of cores | Simultaneous transformations before answering `503` |
| `RETRY_AFTER` | `2` | `Retry-After` sent with a `503`, in seconds |
| `SHARP_CONCURRENCY` / `SHARP_CACHE_MEMORY` | `0` / `50` | sharp internals: threads (0 = automatic) and cache in MiB |
| `LOG_FORMAT` | `tiny` | morgan format, or `off` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

### HEIC and video

| Variable | Default | Purpose |
|---|---|---|
| `HEIC_ENABLED` | `true` | HEIC/HEVC decoding. Disabled, those files get a `415` |
| `HEIC_COMMAND` | `heif-convert` | The converter binary |
| `HEIC_MAX_CONCURRENCY` | `2` | Simultaneous conversions — this one is expensive |
| `HEIC_TIMEOUT` | `30000` | Timeout, in ms |
| `VIDEO_POSTER_ENABLED` | `false` | Poster frames — see below |
| `VIDEO_POSTER_COMMAND` | `ffmpeg` | The extraction binary |
| `VIDEO_POSTER_EXTENSIONS` | `mp4,mov,webm,m4v,mkv,avi` | Extensions treated as video |
| `VIDEO_POSTER_SEEK` | `1` | Timestamp of the extracted frame, in seconds |
| `VIDEO_POSTER_WIDTH` | `1280` | Width of the extracted frame |
| `VIDEO_POSTER_TIMEOUT` | `30000` | Timeout, in ms |

## iPhone photos (HEIC / HEVC)

sharp's prebuilt binaries read the HEIC header but **cannot decode HEVC** — it ships no
decoder for it. So the service detects the container by its signature (twelve bytes: an
`ftyp` box and its brand) and hands those files to `heif-convert`, which the image already
contains. AVIF shares that container but sharp decodes it natively, so it never takes that
detour.

The conversion is expensive, in CPU and in memory: it is capped at
`HEIC_MAX_CONCURRENCY` simultaneous runs, and **its result is cached on disk** in
`CACHE_DIR/converted/`. A burst of requests on the same photo therefore triggers one
conversion, not fifty — a stampede of parallel conversions is precisely what takes a
resizer down.

## Video poster frames

Off by default. Once `VIDEO_POSTER_ENABLED=true` is set, appending an image extension to a
video name extracts a frame from it:

```
/media/holiday/clip.mp4.jpg/_cover_640_360_80.webp
```

The frame goes through the same pipeline, and the same cache, as any other image. It needs
**ffmpeg**, which the published image does not carry — it would add several hundred
megabytes for an optional feature. Rebuild it with:

```yaml
services:
  image-resizer:
    build:
      context: https://github.com/Smeagolworms4/image-resizer.git
      args:
        INSTALL_FFMPEG: "true"
```

## Holding up under load

sharp is greedy, and a burst of large originals is enough to bring a machine to its knees.
Rather than queue up work nobody is waiting for any more, the service **refuses**: past
`MAX_CONCURRENCY` simultaneous transformations, it answers `503` with a `Retry-After`. A
cache in front retries, and the service stays up.

Two other bounds matter: `MAX_SIZE`, which caps requested dimensions — nobody gets to ask
for 30000 px — and `MAX_INPUT_BYTES`, which refuses an oversized original before decoding it.

## Tests

```bash
npm test
```

49 tests, no network access needed: fixtures come from `public/`, and a fake upstream HTTP
server is started on the fly. They cover every fitting mode and output format, dimension
and quality clamping, automatic downscaling, byte-for-byte originals, path traversal,
percent-encoded names, `BASE_PATH`, cache and CORS headers, `304` revalidation, upstream
error translation, disk caching (proven by counting upstream requests), and load shedding.

The HEIC tests generate a **real HEVC file** with `heif-enc` and check, among other things,
that sharp still cannot decode it — the day that test fails, the external converter can go.

The image itself is tested too:

```bash
docker build -t image-resizer:test .
test/docker-smoke.sh image-resizer:test
```

It checks that the container starts, runs as a non-root user, ships `heif-convert`, writes
to its cache volume, and returns images of the right dimensions. It runs on every push
through GitHub Actions, on Node 20, 22 and 24 — **and on the three published architectures**,
the two ARM ones under QEMU.

## Architecture

```
src/
  index.js        entry point: configuration, listening socket, clean shutdown
  config.js       environment → configuration, and the checks done at startup
  server.js       routing, CORS, cache headers, error handling
  preset.js       parsing of the _fit_w_h_q.ext segment
  pipeline.js     sharp: decoding, rotation, resizing, encoding
  storage.js      sources, path safety, upstream download, disk cache
  converters.js   HEIC/HEVC and video poster frames, through external binaries
  semaphore.js    concurrency limiting
  logger.js       levelled logs
```

`config.js` is the only module that reads `process.env`: one place to look to know what is
adjustable, and tests can build a configuration without touching the environment.

## Docker Hub image and automatic publication

**https://hub.docker.com/r/smeagolworms4/image-resizer**

Published for `linux/amd64`, `linux/arm64` and `linux/arm/v7` from a single multi-arch
manifest — the same tag works on a PC, a NAS and a Raspberry Pi.

| Tag | Built on |
|---|---|
| `latest` | every push to `main`, and every git tag — the one to use |
| `main` | every push to the `main` branch |
| `<version>` (e.g. `1.0.0`) | creation of a git tag of that name, to pin a version |

The image is Debian-based rather than Alpine: sharp publishes no musl binary for 32-bit
ARM, and an image that does not run on a Raspberry Pi would miss the point. Dependencies
are installed for the target architecture from the build machine's own architecture
(`npm ci --os --libc --cpu`), so nothing has to run under QEMU during the build.

### GitHub secrets to create by hand

Two workflows handle publication: `build_images.yml` (multi-arch build and push) and
`push_readme.yml` (syncs the Docker Hub description from this README). Both need **two
repository secrets**, added in *Settings → Secrets and variables → Actions*:

| Secret | Content |
|---|---|
| `DOCKER_USERNAME` | your Docker Hub username (also used to build the image name) |
| `DOCKER_PASSWORD` | a Docker Hub *access token* |

## Troubleshooting

**`Configuration invalide : Aucune source configurée`** — the service refuses to start
without a source. Set at least one `SOURCE_<NAME>`.

**Every URL returns `400 Source '...' inconnue`** — the first URL segment is the source
*name*, not a folder. `SOURCE_PHOTOS=/data` serves `/photos/beach.jpg/_.webp`.

**`404` on a file that does exist** — check the mount inside the container
(`docker exec image-resizer ls /photos`), and remember that a local source is rooted at its
folder: `/photos/2024/beach.jpg/_.webp` reads `<source>/2024/beach.jpg`.

**`501 'heif-convert' is not installed`** — the HEIC converter is missing from the image,
which happens on a custom build made with `--build-arg INSTALL_HEIF=false`.

**`503` under load** — that is the intended behaviour, not a bug. Raise `MAX_CONCURRENCY`
if the machine can take it, and above all put a cache in front so those requests never
reach it twice.

**The cache volume is not writable** — the container runs as UID 1000. Set `PUID`/`PGID`
to match your own, or `chown` the `cache` folder.

## Security

Sources are named and fixed: no URL can make the service fetch an address you have not
configured, which is what separates this from an open proxy. Paths are checked against the
source root, so a `../` is rejected rather than resolved.

Output metadata is stripped by default (`STRIP_METADATA=true`), including **GPS
coordinates** — worth keeping in mind before setting it to `false` on holiday photos.

The service has no notion of authentication, and does not try to: it serves what its
sources contain. Anything private belongs behind the cache or the reverse proxy that
fronts it, where authentication is that layer's job.

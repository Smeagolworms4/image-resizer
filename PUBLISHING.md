# Publishing

*Read this in [French](https://github.com/Smeagolworms4/image-resizer/blob/main/PUBLISHING.fr.md).*
*Back to the [README](https://github.com/Smeagolworms4/image-resizer/blob/main/README.md).*

How the Docker image and the Lambda archives get built and published, and what a fork needs
to set up to do the same. Nothing here is required to *use* the service.

## The Docker image

**https://hub.docker.com/r/smeagolworms4/image-resizer**

Published for `linux/amd64`, `linux/arm64` and `linux/arm/v7` from a single multi-arch
manifest — the same tag works on a PC, a NAS and a Raspberry Pi.

| Tag | Built on |
|---|---|
| `latest` | every push to `main`, and every git tag — the one to use |
| `main` | every push to the `main` branch |
| `<version>` (e.g. `1.3.0`) | creation of a git tag of that name, to pin a version |

The image is Debian-based rather than Alpine: sharp publishes no musl binary for 32-bit ARM,
and an image that does not run on a Raspberry Pi would miss the point.

Dependencies are installed **for the target architecture from the build machine's own**
(`npm ci --os --libc --cpu`), so nothing runs under QEMU during the build. Running npm — so
V8 — under emulated ARM is slow and known to die on «illegal instruction»; sharp ships
prebuilt binaries per platform, and npm can fetch someone else's. The Lambda build uses the
same trick.

## The workflows

| Workflow | Runs on | Does |
|---|---|---|
| `tests.yml` | every push and pull request | the test suite on Node 20, 22 and 24, plus the container smoke test on all three published architectures |
| `build_images.yml` | pushes to `main`, and tags | multi-arch build, push to Docker Hub |
| `push_readme.yml` | pushes to `main` | syncs the Docker Hub description from `README.md` |
| `build_lambda.yml` | pushes, tags, manual | the `x64` and `arm64` Lambda archives, published as artifacts and attached to the GitHub release on a tag |

`build_lambda.yml` is deliberately independent of the image build: it needs neither buildx
nor QEMU, and a failure of one should not keep the other from shipping. It unpacks the x64
archive and actually invokes the handler on a sample image before publishing it — a package
that cannot start is caught here rather than on a Lambda.

## GitHub secrets to create by hand

Only `build_images.yml` and `push_readme.yml` need them. Added in *Settings → Secrets and
variables → Actions*:

| Secret | Content |
|---|---|
| `DOCKER_USERNAME` | your Docker Hub username (also used to build the image name) |
| `DOCKER_PASSWORD` | a Docker Hub *access token* |

`build_lambda.yml` needs no secret: it only writes to the repository's own artifacts and
releases.

## Cutting a version

The convention in the history: feature commits, then a `Version X.Y.Z` commit that bumps
`package.json`, then a tag of the same name prefixed with `v`.

```bash
npm version 1.4.0 --no-git-tag-version
git commit -am "Version 1.4.0"
git tag -a v1.4.0 -m "Version 1.4.0"
git push origin main && git push origin v1.4.0
```

The tag is what produces the versioned Docker tag and the GitHub release with the Lambda
archives and their `sha256` attached.

## Two limits that bite

**Docker Hub caps the long description at 25000 characters**, and the API rejects anything
above it — with no error on the client side if the response is not read. That is how a
workflow can report success while leaving the previous description online. `push_readme.yml`
now checks the length before sending, reads the HTTP status, and re-reads the published
description to confirm it matches; a test in `test/dockerfile.test.js` catches it before the
push. When `README.md` gets close, the fix is to move a section into a file of its own —
which is where [SIGNATURE.md](https://github.com/Smeagolworms4/image-resizer/blob/main/SIGNATURE.md),
[HEIC.md](https://github.com/Smeagolworms4/image-resizer/blob/main/HEIC.md),
[LAMBDA.md](https://github.com/Smeagolworms4/image-resizer/blob/main/LAMBDA.md) and this file
come from.

**The short description is capped at 100 bytes**, bytes and not characters. It is taken from
the GitHub repository description and truncated on a whole word when needed.

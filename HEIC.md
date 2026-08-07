# iPhone photos (HEIC / HEVC)

*Read this in [French](https://github.com/Smeagolworms4/image-resizer/blob/main/HEIC.fr.md).*
*Back to the [README](https://github.com/Smeagolworms4/image-resizer/blob/main/README.md).*

Every photo an iPhone takes is a HEIC file, and a resizer that cannot open them is a resizer
half your library is invisible to. The service handles them — but not through sharp, and it
is worth knowing why.

## Why an external binary

sharp's prebuilt binaries read the HEIC **header** but cannot decode **HEVC**: no decoder for
it is shipped, for patent reasons. sharp will happily tell you the dimensions of a photo it
is unable to turn into pixels.

So the service sniffs the container itself — twelve bytes: an `ftyp` box and its brand — and
hands those files to `heif-convert`, which turns them into PNG before the usual pipeline
picks them up. AVIF uses the same container, but sharp decodes it natively, so it never takes
that detour.

A test checks that sharp still cannot decode a real HEVC file, committed as
`public/photo.heic`. The day that test fails, this whole detour can go.

## The cost, and the cache

Conversion is expensive in both CPU and memory — several hundred milliseconds for a photo,
and a burst of them is exactly what takes a resizer down. Two things keep that in check:

- `HEIC_MAX_CONCURRENCY` caps how many run at once, independently of `MAX_CONCURRENCY`.
  Past it, requests get a `503` with a `Retry-After` rather than dragging everything down.
- **The result is cached on disk** in `CACHE_DIR/converted/`, so fifty parallel requests on
  the same photo trigger one conversion, not fifty.

Without a `CACHE_DIR`, every request reconverts. With HEIC, a cache directory stops being an
optimisation.

## Installing the decoder

| Where | What to do |
|---|---|
| **Docker image** | Nothing — `heif-convert` is already in it. Only a custom build with `--build-arg INSTALL_HEIF=false` leaves it out |
| **Debian / Ubuntu** | `apt install libheif-examples`. On **Ubuntu 24.04 and later**, also `libheif-plugin-libde265` — without it the tool is installed but decodes nothing |
| **Alpine** | `apk add libheif-tools` |
| **AWS Lambda** | Not in the runtime. Either set `HEIC_ENABLED=false`, or ship the binary in a layer and point `HEIC_COMMAND` at `/opt/bin/heif-convert` — see [LAMBDA.md](https://github.com/Smeagolworms4/image-resizer/blob/main/LAMBDA.md) |

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `HEIC_ENABLED` | `true` | HEIC/HEVC decoding. Disabled, those files get a `415` |
| `HEIC_COMMAND` | `heif-convert` | The converter binary, or an absolute path to it |
| `HEIC_MAX_CONCURRENCY` | `2` | Simultaneous conversions — this one is expensive |
| `HEIC_TIMEOUT` | `30000` | Timeout in ms; a binary that never returns would hold a slot forever |

Turning it off is a legitimate choice: if nothing in your library is HEIC, `HEIC_ENABLED=false`
answers `415` immediately instead of spawning a process that will fail.

## Troubleshooting

**`501 'heif-convert' is not installed`** — the binary is not on `PATH`. On the official
image this only happens with a custom build made with `--build-arg INSTALL_HEIF=false`;
elsewhere, install it from the table above.

**`500 'heif-convert' failed: ...`** — the tool is there but could not decode. On Ubuntu 24.04
and later this is almost always the missing `libheif-plugin-libde265`: the HEVC decoder lives
in a separate plugin, and without it libheif reads the container and stops there. The message
carries the tool's own first line of `stderr`, which usually says so.

**`504 'heif-convert' timed out`** — a very large photo, or a machine under load. Raise
`HEIC_TIMEOUT`, or lower `HEIC_MAX_CONCURRENCY` so each conversion gets more CPU.

**`415 HEIC support is disabled`** — `HEIC_ENABLED=false`.

**It works, then gets slow again** — check that `CACHE_DIR` is set *and* writable. A cache
that silently fails to write turns every request back into a conversion; the service logs a
warning when that happens.

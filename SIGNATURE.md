# Signed URLs

*Read this in [French](https://github.com/Smeagolworms4/image-resizer/blob/main/SIGNATURE.fr.md).*
*Back to the [README](https://github.com/Smeagolworms4/image-resizer/blob/main/README.md).*

The dimensions live in the URL, which is what makes this service pleasant to use — and what
makes it easy to abuse. Anyone reading the HTML can ask for `_cover_1999_1999_100.avif`, and
every variation of it: each one is a cache miss, a decode, a resize and an encode, for a
picture no page will ever show. A handful of scripted requests are enough to fill the cache
with noise and keep the CPU busy.

**Signed URLs close that door.** Once `SIGNATURE_KEY` is set, an address is only served if it
carries a HMAC computed with that key — so only the application that writes your pages can
produce one. Every other request gets a `403`, before any file is read and before sharp is
even asked to work.

Leave `SIGNATURE_KEY` empty and none of this happens: the service behaves exactly as it did
before, and unsigned URLs are served normally.

## Turning it on

```yaml
environment:
  SIGNATURE_KEY: "a-long-random-secret"   # empty = disabled (default)
  #SIGNATURE_ALGORITHM: sha256            # sha256 (default), sha1, sha512
  #SIGNATURE_LENGTH: 16                   # hex characters kept, 8 to 128
```

A key is a secret, not a password to remember: 32 random bytes are plenty.

```bash
openssl rand -hex 32
```

It goes to the service **and** to the application that builds the URLs — nowhere else, and
above all not into anything the browser downloads.

## Where the signature goes

It is one more field at the end of the preset, right **before the extension**:

```
/photos/holiday/beach.jpg/_cover_320_320_80.webp              unsigned
/photos/holiday/beach.jpg/_cover_320_320_80_3dc222d73386b95c.webp   signed
```

The extension stays last, so browsers, `curl -O` and download dialogs still see a real
`.webp` — the reason the preset is a path segment in the first place.

## The rule, in three steps

1. **Build the string to sign**: the source name, the file path and the unsigned preset,
   joined by slashes. No leading slash, and no `BASE_PATH`.

   ```
   <source>/<path/to/file>/<preset>
   photos/holiday/beach.jpg/_cover_320_320_80.webp
   ```

   Use the path **as you know it**, decoded: `holiday/été 2024.jpg`, not
   `holiday/%C3%A9t%C3%A9%202024.jpg`. Percent-encoding happens afterwards, when the URL is
   assembled, and it plays no part in the signature.

2. **Compute** `HMAC-SHA256(key, string)`, in lowercase hexadecimal, and keep the first
   `SIGNATURE_LENGTH` characters (16 by default).

3. **Insert** `_<signature>` just before the extension of the preset.

That is the whole specification. Everything below is the same three lines, written out in
five languages.

### Reference values

Handy for checking an implementation before pointing it at the service. Key `my-secret-key`,
default settings (`sha256`, 16 characters):

| String signed | Signature | Resulting preset |
|---|---|---|
| `photos/holiday/beach.jpg/_cover_320_320_80.webp` | `3dc222d73386b95c` | `_cover_320_320_80_3dc222d73386b95c.webp` |
| `photos/beach.jpg/_.webp` | `3bf642fda3cc3c5b` | `__3bf642fda3cc3c5b.webp` |
| `photos/beach.jpg/_original___.jpg` | `e8df70fdec7844a1` | `_original____e8df70fdec7844a1.jpg` |
| `photos/accented folder/été 2024.jpg/_inside_1200__.webp` | `6b62f352febf053b` | `_inside_1200___6b62f352febf053b.webp` |

Note the second and third rows: the preset always keeps its own fields, so a signature added
to `_.webp` produces two underscores, and `_original___.jpg` ends up with four. Nothing
special is going on — `_<signature>` is simply inserted before the dot.

And from a shell, to check a value by hand:

```bash
printf '%s' 'photos/holiday/beach.jpg/_cover_320_320_80.webp' \
  | openssl dgst -sha256 -hmac 'my-secret-key' -r | cut -c1-16
```

## JavaScript / TypeScript

### Node.js

```js
import { createHmac } from 'node:crypto';

const KEY = process.env.SIGNATURE_KEY;
const LENGTH = 16;

export function imageUrl(source, path, preset, { base = '' } = {}) {
	const canonical = `${source}/${path}/${preset}`;
	const signature = createHmac('sha256', KEY).update(canonical, 'utf8').digest('hex').slice(0, LENGTH);
	const dot = preset.lastIndexOf('.');
	const signed = `${preset.slice(0, dot)}_${signature}${preset.slice(dot)}`;

	// Encoding comes after the signature, segment by segment.
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${base}/${source}/${encoded}/${signed}`;
}

imageUrl('photos', 'holiday/beach.jpg', '_cover_320_320_80.webp');
// /photos/holiday/beach.jpg/_cover_320_320_80_3dc222d73386b95c.webp
```

### Web Crypto (Cloudflare Workers, Deno, edge runtimes)

The same thing where `node:crypto` does not exist. **Server side only** — a key shipped to a
browser is a key everybody has.

```js
const encoder = new TextEncoder();

export async function sign(canonical, key, length = 16) {
	const material = await crypto.subtle.importKey(
		'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [ 'sign' ],
	);
	const digest = await crypto.subtle.sign('HMAC', material, encoder.encode(canonical));
	return [ ...new Uint8Array(digest) ]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, length);
}
```

## PHP

```php
<?php

function image_url(string $source, string $path, string $preset, string $base = ''): string
{
    $key    = getenv('SIGNATURE_KEY');
    $length = 16;

    $canonical = "$source/$path/$preset";
    $signature = substr(hash_hmac('sha256', $canonical, $key), 0, $length);

    $dot    = strrpos($preset, '.');
    $signed = substr($preset, 0, $dot) . '_' . $signature . substr($preset, $dot);

    $encoded = implode('/', array_map('rawurlencode', explode('/', $path)));

    return "$base/$source/$encoded/$signed";
}

echo image_url('photos', 'holiday/beach.jpg', '_cover_320_320_80.webp');
// /photos/holiday/beach.jpg/_cover_320_320_80_3dc222d73386b95c.webp
```

In Twig, a filter makes it usable straight from a template:

```php
$twig->addFilter(new \Twig\TwigFilter('image', function (string $path, string $preset, string $source = 'photos') {
    return image_url($source, $path, $preset);
}));
```

```twig
<img src="{{ 'holiday/beach.jpg'|image('_cover_320_320_80.webp') }}" alt="">
```

## Python

```python
import hashlib
import hmac
import os
from urllib.parse import quote

KEY = os.environ["SIGNATURE_KEY"].encode()
LENGTH = 16


def image_url(source: str, path: str, preset: str, base: str = "") -> str:
    canonical = f"{source}/{path}/{preset}"
    signature = hmac.new(KEY, canonical.encode(), hashlib.sha256).hexdigest()[:LENGTH]

    stem, dot, extension = preset.rpartition(".")
    signed = f"{stem}_{signature}{dot}{extension}"

    encoded = "/".join(quote(part, safe="") for part in path.split("/"))
    return f"{base}/{source}/{encoded}/{signed}"


image_url("photos", "holiday/beach.jpg", "_cover_320_320_80.webp")
# /photos/holiday/beach.jpg/_cover_320_320_80_3dc222d73386b95c.webp
```

As a Django template filter:

```python
from django import template

register = template.Library()


@register.simple_tag
def image(path, preset, source="photos"):
    return image_url(source, path, preset)
```

```html
<img src="{% image "holiday/beach.jpg" "_cover_320_320_80.webp" %}" alt="">
```

## .NET (C#)

```csharp
using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

public static class ImageUrl
{
    private const int Length = 16;

    public static string Build(string source, string path, string preset, string key, string basePath = "")
    {
        var canonical = $"{source}/{path}/{preset}";

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
        var digest = hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical));
        var signature = Convert.ToHexString(digest).ToLowerInvariant()[..Length];

        var dot = preset.LastIndexOf('.');
        var signed = $"{preset[..dot]}_{signature}{preset[dot..]}";

        var encoded = string.Join('/', path.Split('/').Select(Uri.EscapeDataString));

        return $"{basePath}/{source}/{encoded}/{signed}";
    }
}

// ImageUrl.Build("photos", "holiday/beach.jpg", "_cover_320_320_80.webp", "my-secret-key")
// /photos/holiday/beach.jpg/_cover_320_320_80_3dc222d73386b95c.webp
```

`HMACSHA256` is not thread-safe: build one per call, as above, or use the static
`HMACSHA256.HashData(key, data)` in hot paths.

## Java

```java
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.stream.Collectors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class ImageUrl {

    private static final int LENGTH = 16;

    public static String build(String source, String path, String preset, String key, String base) {
        String canonical = source + "/" + path + "/" + preset;
        String signature = hmac(canonical, key).substring(0, LENGTH);

        int dot = preset.lastIndexOf('.');
        String signed = preset.substring(0, dot) + "_" + signature + preset.substring(dot);

        String encoded = Arrays.stream(path.split("/"))
                .map(part -> URLEncoder.encode(part, StandardCharsets.UTF_8).replace("+", "%20"))
                .collect(Collectors.joining("/"));

        return base + "/" + source + "/" + encoded + "/" + signed;
    }

    private static String hmac(String message, String key) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));

            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (java.security.GeneralSecurityException error) {
            throw new IllegalStateException(error);
        }
    }
}

// ImageUrl.build("photos", "holiday/beach.jpg", "_cover_320_320_80.webp", "my-secret-key", "")
// /photos/holiday/beach.jpg/_cover_320_320_80_3dc222d73386b95c.webp
```

`URLEncoder` is written for form fields, which is why spaces come out as `+`: the
`replace("+", "%20")` above puts that right for a path.

## Details worth knowing

**`BASE_PATH` is not signed.** Moving the service under `/images` does not invalidate URLs
already published, and does not change what your application computes.

**The path is signed decoded, and encoded afterwards.** A file named `été 2024.jpg` is signed
as `été 2024.jpg`, then travels as `%C3%A9t%C3%A9%202024.jpg`. The service decodes before
verifying, so both sides agree without either having to know the other's encoder.

**The path is signed normalised.** `photos/./beach.jpg` and `photos/beach.jpg` are the same
address as far as the service is concerned — sign the plain form.

**Video poster frames are signed like anything else**: the path is `clip.mp4.jpg`, and that
is the string that goes into the signature.

**Serving the original still obeys `ALLOW_ORIGINAL`.** A signature grants what the URL asks
for, not more: presets stay bounded by `MIN_SIZE`, `MAX_SIZE`, `MIN_QUALITY` and
`ALLOWED_FORMATS`.

**`403` responses are cached** for `ERROR_MAX_AGE` seconds, like every other error — a page
referencing a badly signed image does not hammer the service on every visit.

**Changing the key invalidates every URL at once**, which makes rotation a deliberate act:
deploy the new key to the service and to the application in the same move. The cache in front
keeps serving what it already holds — the addresses have not changed for it — but the new
pages point at new addresses, so it will fill up again. That property is also the simplest
purge there is.

**No expiry date.** A signed URL is valid for as long as the key lives. That is the point
here: the addresses have to stay stable so a cache can keep them for months. Signing binds a
URL to *a variant*, not to *a visitor* — it stops the service from being used as a free image
farm, and does nothing about access control, which belongs to the reverse proxy in front.

## Troubleshooting

**Everything answers `403 Signature invalide`** — print the string you are signing before
hashing it. Nine times out of ten it carries a leading slash, `BASE_PATH`, or a
percent-encoded path.

**`403 Signature manquante`** — the preset in the URL has no signature field at all. With a
key set, `_cover_320_320_80.webp` alone is never valid.

**It works on plain names, fails on accents or spaces** — the signature is being computed on
the encoded path. Sign first, encode second.

**Half the images pass, the other half do not** — check `SIGNATURE_LENGTH` and
`SIGNATURE_ALGORITHM` on both sides; a truncation length that differs still produces valid
prefixes for shorter values.

**Testing quickly, without the application**: the repository's own test suite signs its URLs
with the module the service uses, in
[`test/signature.test.js`](https://github.com/Smeagolworms4/image-resizer/blob/main/test/signature.test.js).

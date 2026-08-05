# Les URL signées

*Lire ceci en [anglais](https://github.com/Smeagolworms4/image-resizer/blob/main/SIGNATURE.md).*
*Retour au [README](https://github.com/Smeagolworms4/image-resizer/blob/main/README.fr.md).*

Les dimensions vivent dans l'URL, ce qui rend ce service agréable à utiliser — et facile à
détourner. N'importe qui lisant le HTML peut réclamer `_cover_1999_1999_100.avif`, et toutes
ses variantes : chacune est un défaut de cache, un décodage, un redimensionnement et un
encodage, pour une image qu'aucune page n'affichera jamais. Quelques requêtes scriptées
suffisent à remplir le cache de bruit et à occuper le processeur.

**Les URL signées ferment cette porte.** Une fois `SIGNATURE_KEY` renseignée, une adresse
n'est servie que si elle porte un HMAC calculé avec cette clé — donc seule l'application qui
écrit vos pages sait en fabriquer. Tout le reste reçoit un `403`, avant qu'aucun fichier ne
soit lu et avant même qu'on demande quoi que ce soit à sharp.

Laissez `SIGNATURE_KEY` vide et rien de tout cela n'existe : le service se comporte
exactement comme avant, et les URL non signées sont servies normalement.

## L'activer

```yaml
environment:
  SIGNATURE_KEY: "une-longue-chaîne-secrète"   # vide = désactivé (défaut)
  #SIGNATURE_ALGORITHM: sha256                 # sha256 (défaut), sha1, sha512
  #SIGNATURE_LENGTH: 16                        # caractères hexadécimaux gardés, 8 à 128
```

Une clé est un secret, pas un mot de passe à retenir : 32 octets aléatoires suffisent
largement.

```bash
openssl rand -hex 32
```

Elle va au service **et** à l'application qui construit les URL — nulle part ailleurs, et
surtout pas dans ce que le navigateur télécharge.

## Où se place la signature

C'est un champ de plus à la fin du preset, juste **avant l'extension** :

```
/photos/vacances/plage.jpg/_cover_320_320_80.webp                     non signée
/photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp    signée
```

L'extension reste en dernier : les navigateurs, `curl -O` et les boîtes de dialogue de
téléchargement voient toujours un vrai `.webp` — c'est la raison même pour laquelle le preset
est un segment de chemin.

## La règle, en trois étapes

1. **Construire la chaîne à signer** : le nom de la source, le chemin du fichier et le preset
   non signé, joints par des barres obliques. Sans barre de tête, et sans `BASE_PATH`.

   ```
   <source>/<chemin/du/fichier>/<preset>
   photos/vacances/plage.jpg/_cover_320_320_80.webp
   ```

   Le chemin est celui **que vous connaissez**, décodé : `vacances/été 2024.jpg`, et non
   `vacances/%C3%A9t%C3%A9%202024.jpg`. L'encodage vient après, au moment d'assembler l'URL,
   et ne joue aucun rôle dans la signature.

2. **Calculer** `HMAC-SHA256(clé, chaîne)`, en hexadécimal minuscule, et garder les
   `SIGNATURE_LENGTH` premiers caractères (16 par défaut).

3. **Insérer** `_<signature>` juste avant l'extension du preset.

C'est toute la spécification. Ce qui suit n'est que ces trois lignes, écrites dans cinq
langages.

### Valeurs de référence

Pratiques pour vérifier une implémentation avant de la brancher sur le service. Clé
`ma-clé-secrète`, réglages par défaut (`sha256`, 16 caractères) :

| Chaîne signée | Signature | Preset obtenu |
|---|---|---|
| `photos/vacances/plage.jpg/_cover_320_320_80.webp` | `3d08b5b853888bb5` | `_cover_320_320_80_3d08b5b853888bb5.webp` |
| `photos/plage.jpg/_.webp` | `4c03b1d14cd834d3` | `__4c03b1d14cd834d3.webp` |
| `photos/plage.jpg/_original___.jpg` | `bf3bd221c968df58` | `_original____bf3bd221c968df58.jpg` |
| `photos/dossier accentué/été 2024.jpg/_inside_1200__.webp` | `fde1353aa25c9754` | `_inside_1200___fde1353aa25c9754.webp` |

Regardez les deuxième et troisième lignes : le preset garde ses propres champs, donc une
signature ajoutée à `_.webp` donne deux tirets bas, et `_original___.jpg` en compte quatre au
bout. Rien de particulier ne se passe — `_<signature>` est simplement inséré avant le point.

Et depuis un shell, pour vérifier une valeur à la main :

```bash
printf '%s' 'photos/vacances/plage.jpg/_cover_320_320_80.webp' \
  | openssl dgst -sha256 -hmac 'ma-clé-secrète' -r | cut -c1-16
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

	// L'encodage vient après la signature, segment par segment.
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${base}/${source}/${encoded}/${signed}`;
}

imageUrl('photos', 'vacances/plage.jpg', '_cover_320_320_80.webp');
// /photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp
```

### Web Crypto (Cloudflare Workers, Deno, runtimes edge)

La même chose là où `node:crypto` n'existe pas. **Côté serveur uniquement** — une clé livrée
au navigateur est une clé que tout le monde possède.

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

echo image_url('photos', 'vacances/plage.jpg', '_cover_320_320_80.webp');
// /photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp
```

En Twig, un filtre rend la chose utilisable directement dans un gabarit :

```php
$twig->addFilter(new \Twig\TwigFilter('image', function (string $path, string $preset, string $source = 'photos') {
    return image_url($source, $path, $preset);
}));
```

```twig
<img src="{{ 'vacances/plage.jpg'|image('_cover_320_320_80.webp') }}" alt="">
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


image_url("photos", "vacances/plage.jpg", "_cover_320_320_80.webp")
# /photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp
```

En filtre de gabarit Django :

```python
from django import template

register = template.Library()


@register.simple_tag
def image(path, preset, source="photos"):
    return image_url(source, path, preset)
```

```html
<img src="{% image "vacances/plage.jpg" "_cover_320_320_80.webp" %}" alt="">
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

// ImageUrl.Build("photos", "vacances/plage.jpg", "_cover_320_320_80.webp", "ma-clé-secrète")
// /photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp
```

`HMACSHA256` n'est pas réentrant : on en construit un par appel, comme ci-dessus, ou on
utilise la méthode statique `HMACSHA256.HashData(key, data)` dans les chemins chauds.

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

// ImageUrl.build("photos", "vacances/plage.jpg", "_cover_320_320_80.webp", "ma-clé-secrète", "")
// /photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp
```

`URLEncoder` est écrit pour les champs de formulaire, d'où les espaces rendus en `+` : le
`replace("+", "%20")` ci-dessus remet les choses en place pour un chemin.

## Les détails qui comptent

**`BASE_PATH` n'est pas signé.** Déplacer le service sous `/images` n'invalide pas les URL
déjà publiées, et ne change rien à ce que calcule votre application.

**Le chemin est signé décodé, et encodé ensuite.** Un fichier nommé `été 2024.jpg` se signe
`été 2024.jpg`, puis voyage en `%C3%A9t%C3%A9%202024.jpg`. Le service décode avant de
vérifier : les deux côtés tombent d'accord sans que l'un ait à connaître l'encodeur de
l'autre.

**Le chemin est signé normalisé.** `photos/./plage.jpg` et `photos/plage.jpg` sont la même
adresse pour le service — signez la forme simple.

**Les vignettes vidéo se signent comme le reste** : le chemin est `clip.mp4.jpg`, et c'est
cette chaîne-là qui entre dans la signature.

**La diffusion de l'original obéit toujours à `ALLOW_ORIGINAL`.** Une signature accorde ce
que l'URL demande, pas davantage : les presets restent bornés par `MIN_SIZE`, `MAX_SIZE`,
`MIN_QUALITY` et `ALLOWED_FORMATS`.

**Les réponses `403` sont cachées** pendant `ERROR_MAX_AGE` secondes, comme les autres
erreurs — une page qui référence une image mal signée ne martèle pas le service à chaque
visite.

**Changer la clé invalide toutes les URL d'un coup**, ce qui fait de la rotation un geste
délibéré : déployez la nouvelle clé sur le service et sur l'application dans le même
mouvement. Le cache placé devant continue de servir ce qu'il détient — pour lui les adresses
n'ont pas changé — mais les nouvelles pages pointent vers de nouvelles adresses, donc il se
remplira de nouveau. Cette propriété est accessoirement la purge la plus simple qui soit.

**Pas de date d'expiration.** Une URL signée vaut aussi longtemps que la clé. C'est
volontaire : les adresses doivent rester stables pour qu'un cache les garde des mois durant.
Signer lie une URL à *une variante*, pas à *un visiteur* — cela empêche qu'on se serve du
service comme d'une ferme à images gratuite, et ne remplace en rien un contrôle d'accès, qui
reste le métier du reverse proxy placé devant.

## Dépannage

**Tout répond `403 Signature invalide`** — affichez la chaîne que vous signez avant de la
hacher. Neuf fois sur dix elle porte une barre oblique de tête, le `BASE_PATH`, ou un chemin
déjà encodé.

**`403 Signature manquante`** — le preset de l'URL n'a aucun champ signature. Avec une clé
posée, `_cover_320_320_80.webp` tout seul n'est jamais valide.

**Ça marche sur les noms simples et échoue sur les accents ou les espaces** — la signature
est calculée sur le chemin encodé. On signe d'abord, on encode ensuite.

**La moitié des images passe, l'autre non** — vérifiez `SIGNATURE_LENGTH` et
`SIGNATURE_ALGORITHM` des deux côtés ; une longueur de troncature différente produit tout de
même des préfixes valides pour les valeurs plus courtes.

**Pour essayer vite, sans l'application** : les tests du dépôt signent leurs URL avec le
module que le service utilise, dans
[`test/signature.test.js`](https://github.com/Smeagolworms4/image-resizer/blob/main/test/signature.test.js).

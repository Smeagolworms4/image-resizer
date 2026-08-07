# image-resizer

[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/coffee.png)](https://www.buymeacoffee.com/smeagolworms4)
[!["Buy Me A Coffee"](https://raw.githubusercontent.com/Smeagolworms4/donate-assets/master/paypal.png)](https://www.paypal.com/donate/?business=SURRPGEXF4YVU&no_recurring=0&item_name=Hello%2C+I%27m+SmeagolWorms4.+For+my+open+source+projects.%0AThanks+you+very+mutch+%21%21%21&currency_code=EUR)

*Lire ceci en [anglais](https://github.com/Smeagolworms4/image-resizer/blob/main/README.md).*

Redimensionne et convertit vos images **à la volée**, en HTTP. Pointez-le sur un dossier ou
sur n'importe quel stockage HTTP, et chaque variante devient une adresse :
`/photos/plage.jpg/_cover_320_320_80.webp`. Conçu pour vivre **derrière un cache** —
CloudFront, Varnish, nginx, Cloudflare — c'est ce qui en fait un service rapide : une
variante donnée n'est calculée qu'une seule fois.

[![Docker Pulls](https://img.shields.io/docker/pulls/smeagolworms4/image-resizer)](https://hub.docker.com/r/smeagolworms4/image-resizer)
[![Image Size](https://img.shields.io/docker/image-size/smeagolworms4/image-resizer/latest)](https://hub.docker.com/r/smeagolworms4/image-resizer)
![arch](https://img.shields.io/badge/arch-amd64%20%7C%20arm64%20%7C%20armv7-6ee7a8)

## Ce qu'il fait

- **Redimensionne, recadre et convertit** en JPEG, PNG, WebP ou AVIF, avec les cinq modes
  d'ajustement de sharp (`cover`, `contain`, `fill`, `inside`, `outside`).
- **Lit autant de sources que vous voulez** : dossiers locaux, stockage HTTP (S3, Vercel
  Blob, un simple serveur web), ou un mélange — un nom par source, et ce nom ouvre l'URL.
- **Met les originaux en cache disque** : la source n'est interrogée qu'une fois, quel que
  soit le nombre de variantes.
- **Décode les photos iPhone** (HEIC/HEVC), que sharp ne sait pas ouvrir seul.
- **Applique l'orientation EXIF** et retire les métadonnées (GPS compris) de ce qu'il sert.
- **Se protège** : dimensions bornées, originaux trop gros refusés, et au-delà d'un nombre
  configurable de transformations simultanées il répond `503` plutôt que de s'écrouler.
- **Signe ses URL, si vous le voulez** : une clé posée, une adresse n'est servie que si elle
  porte le bon HMAC — personne ne commande les variantes qui lui chantent.
- **Tout se configure par variables d'environnement** — aucun fichier de configuration,
  rien à reconstruire.
- Tourne sur **amd64, arm64 et armv7** : un NAS, un VPS ou un Raspberry Pi font l'affaire.

## Le format d'URL

```
/<source>/<chemin/du/fichier>/<preset>
```

Le preset est le **dernier segment du chemin**, et il décrit entièrement la transformation :

```
_<ajustement>_<largeur>_<hauteur>_<qualité>.<format>
```

| URL | Résultat |
|---|---|
| `/photos/plage.jpg/_.webp` | WebP, qualité par défaut, réduit à `MAX_SIZE` si nécessaire |
| `/photos/plage.jpg/_cover_320_320_80.webp` | WebP 320×320, recadré pour remplir, qualité 80 |
| `/photos/plage.jpg/_inside_1200__.jpg` | 1200 px de large, hauteur proportionnelle |
| `/photos/vacances/2024/plage.jpg/_contain_600_400_90.png` | fonctionne à n'importe quelle profondeur |
| `/photos/plage.jpg/_original___.jpg` | le fichier d'origine, octet pour octet |

Les champs vides reprennent les valeurs par défaut, d'où les trois tirets bas de
`_original___.jpg`. Un mode d'ajustement inconnu ou un format non autorisé donne un `400`
plutôt qu'une image approchante servie en silence — un cache garderait l'erreur des
semaines durant.

Un preset peut aussi porter une **signature**, optionnelle et désactivée par défaut — voir
[Les URL signées](https://github.com/Smeagolworms4/image-resizer/blob/main/README.fr.md#les-url-signées)
plus bas :

```
/photos/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp
```

**Pourquoi un segment de chemin et pas une query string** : les caches indexent sur l'URL,
et beaucoup sont configurés pour ignorer ou réordonner les query strings, ce qui multiplie
ou fusionne les entrées sans prévenir. En chemin, chaque variante est une adresse
immuable — et comme l'extension est en dernier, les navigateurs, `curl -O` et les boîtes de
dialogue de téléchargement voient un vrai `.webp`.

## Démarrage

Rien à cloner, rien à construire : l'image est publiée sur
[Docker Hub](https://hub.docker.com/r/smeagolworms4/image-resizer). Créez un dossier vide et
mettez-y ce `docker-compose.yml` :

```yaml
services:
  image-resizer:
    image: smeagolworms4/image-resizer:latest
    container_name: image-resizer
    restart: unless-stopped
    stop_grace_period: 30s
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      SOURCE_DEMO: /app/public
      #SOURCE_PHOTOS: /photos
      #SOURCE_CDN: https://storage.example.com
    ports:
      - "${PORT_HOST:-3000}:3000"
    volumes:
      - ./cache:/cache
      # - /chemin/vers/vos/photos:/photos:ro
```

Puis, à côté :

```bash
mkdir cache
docker compose up -d
```

Aucun fichier de configuration : chaque réglage est une variable d'environnement, déclarée
là où ça vous arrange — le `environment:` ci-dessus, un `env_file:`, des `-e`, ou le
mécanisme de votre orchestrateur. `.env.example` les liste toutes, et peut servir
d'`env_file` si vous préférez les regrouper dans un fichier.

**Au moins une source reste obligatoire** : le service refuse de démarrer sans, plutôt que
de démarrer et de répondre 400 à tout.

L'image embarque quelques images d'exemple, de quoi vérifier l'installation immédiatement :

```
http://localhost:3000/demo/test.png/_cover_320_240_80.webp
http://localhost:3000/health
```

### L'équivalent en une commande

```bash
docker run -d \
  --name image-resizer \
  --restart unless-stopped \
  --user 1000:1000 \
  -p 3000:3000 \
  -e SOURCE_PHOTOS=/photos \
  -v "$(pwd)/cache:/cache" \
  -v /chemin/vers/vos/photos:/photos:ro \
  smeagolworms4/image-resizer:latest
```

### Sans Docker

```bash
npm install
SOURCE_PHOTOS=/chemin/vers/photos CACHE_DIR=./cache npm start
```

Node 20.6 ou plus récent. `heif-convert` n'est nécessaire que pour les photos HEIC : paquet
`libheif-examples` sur Debian/Ubuntu, `libheif-tools` sur Alpine. À partir d'Ubuntu 24.04, le
décodeur HEVC vit dans un greffon séparé, `libheif-plugin-libde265` — sans lui l'outil est
bien installé mais ne décode rien. L'image Docker, elle, a déjà tout.

### Sur AWS Lambda

Le même service existe aussi en zip prêt à déposer sur une fonction Lambda — pas de
conteneur, pas de machine à maintenir en vie. Une archive toute faite est attachée à chaque
[publication](https://github.com/Smeagolworms4/image-resizer/releases), une par
architecture, et `npm run build:lambda` la reconstruit.

```bash
aws lambda create-function --function-name image-resizer \
  --runtime nodejs22.x --architectures x86_64 --handler src/lambda.handler \
  --zip-file fileb://dist/image-resizer-lambda-1.2.0-x64.zip \
  --memory-size 2048 --timeout 30 --role "$ROLE_ARN" \
  --environment 'Variables={SOURCE_DEMO=/var/task/public,CACHE_DIR=/tmp/cache,HEIC_ENABLED=false}'
```

Tout ce qui suit s'applique sans changement — mêmes variables, même format d'URL, même
signature. Ce qui diffère, c'est ce que le sans-serveur change : le cache n'est plus
conseillé mais obligatoire, `/tmp` est le seul disque accessible en écriture, et le HEIC et
la vidéo demandent une couche. **[LAMBDA.fr.md](LAMBDA.fr.md)** couvre l'ensemble.

## Les sources

Une source, c'est un **nom**, qui devient le premier segment de l'URL, et une **cible** :

```bash
SOURCE_PHOTOS=/data/photos                 # dossier local
SOURCE_MEDIA=file:///mnt/nas/media         # la même chose, explicite
SOURCE_CDN=https://storage.example.com     # stockage HTTP
```

Ou toutes dans une seule variable, ce qui convient mieux aux déploiements pilotés :

```bash
SOURCES='{"photos":"/data/photos","cdn":"https://storage.example.com"}'
SOURCES='photos=/data/photos,cdn=https://storage.example.com'
```

**Les sources locales sont en lecture seule**, et le chemin est vérifié par rapport à la
racine de la source : un `../` dans l'URL est refusé, jamais résolu.

**Les sources HTTP sont téléchargées une fois.** L'original atterrit dans
`CACHE_DIR/originals/<source>/`, et toutes les variantes suivantes en sont calculées — dix
formats de la même photo coûtent une requête amont, pas dix. `CACHE_ORIGINALS=false` force
le retour à la source à chaque fois, et un `CACHE_DIR` vide désactive toute écriture disque.

## Derrière un cache

Ce service calcule ; il n'est pas fait pour encaisser directement vos visiteurs. Mettez un
cache devant, et chaque variante n'est calculée qu'une fois pour toute sa durée de vie.

Les réponses portent ce qu'un cache attend : un `ETag`, et un `Cache-Control` avec un
`s-maxage` long (caches partagés) à côté d'un `max-age` plus court (navigateurs) et d'un
`stale-while-revalidate`.

```
Cache-Control: public, max-age=604800, s-maxage=5184000, stale-while-revalidate=604800
```

**CloudFront** — origine : le service, politique de cache *CachingOptimized*, et **aucune
query string transmise** (elles ne jouent aucun rôle ici). `Origin Shield` vaut le coup :
il regroupe en une seule les requêtes de tous les points de présence quand une variante est
froide.

**Varnish** — rien de particulier à écrire, le `builtin.vcl` par défaut fait déjà ce qu'il
faut. Donnez-lui de la place et laissez le long `s-maxage` parler :

```vcl
sub vcl_backend_response {
    set beresp.grace = 24h;
}
```

**nginx** — un cache complet en quelques lignes :

```nginx
proxy_cache_path /var/cache/nginx/images levels=1:2 keys_zone=images:50m
                 max_size=20g inactive=90d use_temp_path=off;

location / {
    proxy_pass http://image-resizer:3000;
    proxy_cache images;
    proxy_cache_valid 200 90d;
    proxy_cache_valid 404 1m;
    # Une seule requête amont pour une variante froide, même en rafale.
    proxy_cache_lock on;
    proxy_cache_use_stale updating error timeout;
    add_header X-Cache-Status $upstream_cache_status;
}
```

Si le service ne vit pas à la racine de son domaine, `BASE_PATH=/images` décale toutes les
routes, sonde de santé comprise.

## Configuration

Tout passe par des variables d'environnement, et rien d'autre. Elles sont **toutes déclarées
dans l'image avec leur valeur par défaut**, de sorte qu'on peut lister les réglages sans
ouvrir la documentation :

```bash
docker run --rm smeagolworms4/image-resizer:latest env
```

Une valeur vide n'est pas un réglage absent : elle rend la main au code (source non
configurée, en-tête calculé, nombre de cœurs). `.env.example` reprend les mêmes variables
avec des commentaires, et un test vérifie que ces listes ne divergent jamais.

### Sources et réseau

| Variable | Défaut | Rôle |
|---|---|---|
| `SOURCE_<NOM>` | — | Une source par variable. Le nom devient le premier segment de l'URL |
| `SOURCES` | — | Toutes les sources d'un coup, en JSON ou en `nom=cible,nom2=cible2` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Socket d'écoute |
| `BASE_PATH` | vide | Préfixe de montage, par exemple `/images` |
| `HEALTH_PATH` | `/health` | Sonde de santé — jamais journalisée, jamais cachée |
| `TRUST_PROXY` | vide | *trust proxy* d'Express : `true`, un nombre de sauts, ou une liste d'IP |

### Cache et transformation

| Variable | Défaut | Rôle |
|---|---|---|
| `CACHE_DIR` | `/cache` dans l'image | Où sont conservés les originaux téléchargés et les conversions coûteuses. Vide = aucune écriture disque |
| `CACHE_ORIGINALS` | `true` | Conserver les originaux téléchargés en HTTP |
| `MIN_SIZE` / `MAX_SIZE` | `1` / `2048` | Bornes appliquées aux dimensions demandées |
| `MIN_QUALITY` / `DEFAULT_QUALITY` | `10` / `80` | Bornes et valeur par défaut de la qualité |
| `DEFAULT_FIT` | `cover` | Ajustement quand le preset n'en précise pas |
| `DEFAULT_FORMAT` | `jpeg` | Sert seulement de repli ; l'URL indique toujours le format |
| `ALLOWED_FORMATS` | `jpeg,png,webp,avif` | Tout autre format donne un `400`. `gif` et `tiff` sont disponibles |
| `ALLOW_ORIGINAL` | `true` | Autorise `_original___.ext`, qui sert le fichier tel quel |
| `AUTO_DOWNSCALE` | `true` | Sans dimension demandée, borne quand même l'image à `MAX_SIZE` |
| `STRIP_METADATA` | `true` | Retire EXIF, GPS et profils colorimétriques de la sortie |

### En-têtes de cache

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_AGE` | `604800` | `max-age` : navigateurs (7 jours) |
| `S_MAX_AGE` | `5184000` | `s-maxage` : caches partagés (60 jours) |
| `STALE_WHILE_REVALIDATE` | `604800` | Servir du périmé pendant le rafraîchissement |
| `ERROR_MAX_AGE` | `60` | Durée de cache des réponses d'erreur |
| `CACHE_CONTROL` | — | Remplace l'en-tête calculé à partir des quatre valeurs ci-dessus |
| `CORS_ORIGIN` | `*` | Vide retire complètement les en-têtes CORS |

### URL signées

| Variable | Défaut | Rôle |
|---|---|---|
| `SIGNATURE_KEY` | vide | Le secret du HMAC. **Vide désactive la signature**, et les URL sont servies comme avant |
| `SIGNATURE_ALGORITHM` | `sha256` | `sha256`, `sha1` ou `sha512` |
| `SIGNATURE_LENGTH` | `16` | Caractères hexadécimaux gardés, de 8 à 128 — dans la limite de l'empreinte |

### Décodage et redimensionnement

| Variable | Défaut | Rôle |
|---|---|---|
| `AUTO_ROTATE` | `true` | Applique l'orientation EXIF — sans lui, les photos de téléphone sortent couchées |
| `ALLOW_ENLARGEMENT` | `true` | Autorise l'agrandissement au-delà de la taille de l'original |
| `DEFAULT_POSITION` | `center` | Zone conservée par `cover`/`contain` : `top`, `left top`… ou `entropy` / `attention`, qui choisissent la zone la plus riche |
| `RESIZE_KERNEL` | `lanczos3` | `nearest`, `linear`, `cubic`, `mitchell`, `lanczos2`, `lanczos3`, `mks2013`, `mks2021` |
| `CONTAIN_BACKGROUND` | `#000000` | Couleur des bandes ajoutées par `contain`. `#00000000` pour du transparent |
| `FAIL_ON` | `none` | Sévérité au décodage : `none`, `truncated`, `error`, `warning` |

### Encodage

| Variable | Défaut | Rôle |
|---|---|---|
| `JPEG_MOZJPEG` | `true` | ~10 % de moins à qualité égale, un peu plus lent. Implique le progressif |
| `JPEG_PROGRESSIVE` | `false` | JPEG progressif (déjà le cas avec mozjpeg) |
| `JPEG_CHROMA_SUBSAMPLING` | `4:2:0` | `4:4:4` garde le détail des couleurs, au prix du poids |
| `PNG_COMPRESSION_LEVEL` | `9` | de 0 à 9 |
| `PNG_PALETTE` | `false` | Quantifie en palette : bien plus léger, au prix des dégradés |
| `WEBP_EFFORT` | `4` | de 0 à 6 — plus haut = plus petit et plus lent |
| `WEBP_LOSSLESS` | `false` | WebP sans perte |
| `WEBP_SMART_SUBSAMPLE` | `false` | Limite les bavures de couleur sur les bords nets |
| `AVIF_EFFORT` | `4` | de 0 à 9 — plus haut = plus petit et beaucoup plus lent |
| `AVIF_LOSSLESS` | `false` | AVIF sans perte |
| `AVIF_CHROMA_SUBSAMPLING` | `4:4:4` | Même compromis qu'en JPEG |

### Amont, charge et journaux

| Variable | Défaut | Rôle |
|---|---|---|
| `FETCH_TIMEOUT` | `15000` | Délai maximum de la requête amont, en ms |
| `FETCH_USER_AGENT` | `image-resizer` | `User-Agent` utilisé en amont |
| `FETCH_HEADERS` | — | Objet JSON d'en-têtes ajoutés en amont — c'est par là que passe l'authentification d'un stockage privé |
| `FETCH_REDIRECT` | `follow` | `follow`, `error`, `manual` |
| `MAX_INPUT_BYTES` | `67108864` | Au-delà, l'original est refusé (`413`) |
| `MAX_CONCURRENCY` | nombre de cœurs | Transformations simultanées avant de répondre `503` |
| `RETRY_AFTER` | `2` | `Retry-After` envoyé avec un `503`, en secondes |
| `SHARP_CONCURRENCY` / `SHARP_CACHE_MEMORY` | `0` / `50` | Réglages internes de sharp : fils (0 = automatique) et cache en Mio |
| `LOG_FORMAT` | `tiny` | Format morgan, ou `off` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `SHUTDOWN_TIMEOUT` | `10000` | Délai laissé aux transformations en cours après un `SIGTERM`, en ms |

### HEIC et vidéo

| Variable | Défaut | Rôle |
|---|---|---|
| `HEIC_ENABLED` | `true` | Décodage HEIC/HEVC. Désactivé, ces fichiers donnent un `415` |
| `HEIC_COMMAND` | `heif-convert` | Le binaire de conversion |
| `HEIC_MAX_CONCURRENCY` | `2` | Conversions simultanées — celle-ci coûte cher |
| `HEIC_TIMEOUT` | `30000` | Délai maximum, en ms |
| `VIDEO_POSTER_ENABLED` | `false` | Vignettes vidéo — voir plus bas |
| `VIDEO_POSTER_COMMAND` | `ffmpeg` | Le binaire d'extraction |
| `VIDEO_POSTER_EXTENSIONS` | `mp4,mov,webm,m4v,mkv,avi` | Extensions traitées comme des vidéos |
| `VIDEO_POSTER_SEEK` | `1` | Instant de l'image extraite, en secondes |
| `VIDEO_POSTER_WIDTH` | `1280` | Largeur de l'image extraite |
| `VIDEO_POSTER_TIMEOUT` | `30000` | Délai maximum, en ms |

## Les URL signées

Désactivées par défaut, et à activer le jour où le service fait face à l'internet ouvert. Les
dimensions vivent dans l'URL : n'importe qui lisant le HTML peut réclamer
`_cover_1999_1999_100.avif` et toutes ses variantes — chacune est un défaut de cache et un
décodage-redimensionnement-encodage complet, pour une image qu'aucune page n'affichera.

Posez une clé, et une adresse n'est servie que si elle porte le HMAC correspondant :

```yaml
environment:
  SIGNATURE_KEY: "une-longue-chaîne-secrète"   # openssl rand -hex 32
```

```
/photos/vacances/plage.jpg/_cover_320_320_80.webp                      403
/photos/vacances/plage.jpg/_cover_320_320_80_3d08b5b853888bb5.webp     200
```

La signature est un champ de plus à la fin du preset, avant l'extension. La produire tient en
trois lignes : joindre `<source>/<chemin>/<preset>`, en prendre le
`HMAC-SHA256(clé, cette chaîne)` en hexadécimal, garder les 16 premiers caractères et les
insérer avant l'extension. Le refus tombe avant toute lecture de fichier : une requête non
signée coûte un HMAC, et rien d'autre.

**→ [Comment générer la signature, en JS, PHP, Python, .NET et Java](https://github.com/Smeagolworms4/image-resizer/blob/main/SIGNATURE.fr.md)** —
avec des valeurs de référence pour vérifier une implémentation, et les détails sur lesquels
on trébuche (encodage, `BASE_PATH`, rotation de la clé).

Une `SIGNATURE_KEY` vide — le défaut — désactive tout le mécanisme : rien n'est vérifié, et
les URL fonctionnent exactement comme avant.

## Les photos iPhone (HEIC / HEVC)

Les binaires précompilés de sharp lisent l'en-tête HEIC mais **ne savent pas décoder le
HEVC** : aucun décodeur n'y est embarqué. Le service reconnaît donc le conteneur à sa
signature (douze octets : une boîte `ftyp` et sa marque) et confie ces fichiers à
`heif-convert`, déjà présent dans l'image. L'AVIF partage ce conteneur mais sharp le décode
nativement : il ne prend jamais ce détour.

La conversion coûte cher, en processeur comme en mémoire : elle est plafonnée à
`HEIC_MAX_CONCURRENCY` exécutions simultanées, et **son résultat est mis en cache disque**
dans `CACHE_DIR/converted/`. Une rafale de requêtes sur la même photo déclenche donc une
conversion, pas cinquante — c'est précisément une ruée de conversions parallèles qui met un
redimensionneur à terre.

## Les vignettes vidéo

Désactivées par défaut. Une fois `VIDEO_POSTER_ENABLED=true` posé, ajouter une extension
d'image derrière un nom de vidéo en extrait une image :

```
/media/vacances/clip.mp4.jpg/_cover_640_360_80.webp
```

L'image extraite passe par le même pipeline, et le même cache, que n'importe quelle autre.
Il faut **ffmpeg**, que l'image publiée n'embarque pas — plusieurs centaines de mégaoctets
pour une fonction optionnelle. Reconstruisez-la avec :

```yaml
services:
  image-resizer:
    build:
      context: https://github.com/Smeagolworms4/image-resizer.git
      args:
        INSTALL_FFMPEG: "true"
```

## Tenir la charge

sharp est gourmand, et une rafale de gros originaux suffit à mettre une machine à genoux.
Plutôt que d'empiler du travail que plus personne n'attend, le service **refuse** : au-delà
de `MAX_CONCURRENCY` transformations simultanées, il répond `503` avec un `Retry-After`. Le
cache placé devant réessaie, et le service reste debout.

Deux autres bornes comptent : `MAX_SIZE`, qui plafonne les dimensions demandées — personne
ne réclame 30000 px — et `MAX_INPUT_BYTES`, qui refuse un original trop gros avant même de
le décoder.

## Les tests

```bash
npm test
```

77 tests, sans accès réseau : les images viennent de `public/`, et un faux serveur HTTP
amont est démarré à la volée. Ils couvrent tous les modes d'ajustement et formats de
sortie, le bornage des dimensions et de la qualité, la réduction automatique, l'original
octet pour octet, la traversée de chemin, les noms encodés, `BASE_PATH`, les en-têtes de
cache et CORS, la revalidation `304`, la traduction des erreurs amont, le cache disque
(prouvé en comptant les requêtes amont) et le refus sous charge.

La signature des URL a son fichier : qu'une clé vide ne change rien, qu'une signature
n'ouvre que la variante pour laquelle elle a été calculée — une signature volée n'achète pas
un 2000×2000 — et que ni `BASE_PATH` ni l'encodage des caractères n'entrent dans le calcul.

Les tests HEIC travaillent sur un **vrai fichier HEVC** versionné avec les images d'exemple
(`public/photo.heic`), et vérifient entre autres que sharp ne sait toujours pas le décoder —
le jour où ce test échouera, le convertisseur externe pourra disparaître. Le fichier est
versionné plutôt que fabriqué parce que le libheif livré par Debian et Ubuntu n'embarque pas
d'encodeur x265 : il lit le HEIC, il ne sait pas l'écrire.

Le point d'entrée Lambda a le sien : qu'une image revienne en base64 quand le JSON reste du
texte, que les charges `2.0` et REST/ALB mènent au même endroit, qu'une requête
conditionnelle rende toujours un `304` — ce qui n'est pas le cas si le relais passe par
`fetch`, qui retire les en-têtes dont dépend ce contrôle — et qu'une réponse trop grosse
pour Lambda soit refusée avec un message qui dit quoi faire.

L'image elle-même est testée :

```bash
docker build -t image-resizer:test .
test/docker-smoke.sh image-resizer:test
```

Il vérifie que le conteneur démarre, tourne en utilisateur non privilégié, embarque
`heif-convert`, écrit dans son volume de cache et rend des images aux bonnes dimensions.
Le tout tourne à chaque poussée via GitHub Actions, sur Node 20, 22 et 24 — **et sur les
trois architectures publiées**, les deux ARM sous QEMU.

## Architecture

```
src/
  index.js        point d'entrée : configuration, écoute, arrêt propre
  lambda.js       point d'entrée AWS Lambda : événement → requête, réponse → JSON
  config.js       environnement → configuration, et les contrôles au démarrage
  server.js       routage, CORS, en-têtes de cache, gestion des erreurs
  preset.js       analyse du segment _ajustement_l_h_q.ext
  signature.js    signature HMAC des URL, optionnelle
  pipeline.js     sharp : décodage, rotation, redimensionnement, encodage
  storage.js      sources, sûreté des chemins, téléchargement amont, cache disque
  converters.js   HEIC/HEVC et vignettes vidéo, via des binaires externes
  semaphore.js    limitation de concurrence
  logger.js       journaux par niveau
```

`config.js` est le seul module qui lit `process.env` : un seul endroit à regarder pour
savoir ce qui est réglable, et les tests peuvent fabriquer une configuration sans toucher à
l'environnement.

## Image Docker Hub et publication automatique

**https://hub.docker.com/r/smeagolworms4/image-resizer**

Publiée pour `linux/amd64`, `linux/arm64` et `linux/arm/v7` depuis un manifeste multi-arch
unique — le même tag fonctionne sur un PC, un NAS et un Raspberry Pi.

| Tag | Construit sur |
|---|---|
| `latest` | chaque poussée sur `main`, et chaque tag git — celui à utiliser |
| `main` | chaque poussée sur la branche `main` |
| `<version>` (ex. `1.0.0`) | création d'un tag git de ce nom, pour figer une version |

L'image est basée sur Debian plutôt qu'Alpine : sharp ne publie pas de binaire musl pour
l'ARM 32 bits, et une image qui ne tourne pas sur un Raspberry Pi manquerait la cible. Les
dépendances sont installées pour l'architecture visée depuis celle de la machine qui
construit (`npm ci --os --libc --cpu`), ce qui évite de faire tourner quoi que ce soit sous
QEMU pendant la construction.

### Secrets GitHub à créer à la main

Deux workflows gèrent la publication : `build_images.yml` (construction multi-arch et
poussée) et `push_readme.yml` (synchronise la description Docker Hub depuis le README
anglais). Les deux ont besoin de **deux secrets de dépôt**, à ajouter dans *Settings →
Secrets and variables → Actions* :

Un troisième, `build_lambda.yml`, est indépendant : il construit les archives Lambda `x64`
et `arm64`, invoque le point d'entrée sur une image d'exemple pour prouver que le paquet
fonctionne, les publie en artefacts et, sur un tag, les attache à la publication GitHub. Il
n'a besoin d'aucun secret.

| Secret | Contenu |
|---|---|
| `DOCKER_USERNAME` | votre identifiant Docker Hub (sert aussi à construire le nom de l'image) |
| `DOCKER_PASSWORD` | un *access token* Docker Hub |

## Dépannage

**`Configuration invalide : Aucune source configurée`** — le service refuse de démarrer
sans source. Renseignez au moins un `SOURCE_<NOM>`.

**Toutes les URL répondent `400 Source '...' inconnue`** — le premier segment de l'URL est
le *nom* de la source, pas un dossier. `SOURCE_PHOTOS=/data` sert `/photos/plage.jpg/_.webp`.

**`404` sur un fichier qui existe** — vérifiez le montage dans le conteneur
(`docker exec image-resizer ls /photos`), et rappelez-vous qu'une source locale est enracinée
sur son dossier : `/photos/2024/plage.jpg/_.webp` lit `<source>/2024/plage.jpg`.

**`501 'heif-convert' is not installed`** — le convertisseur HEIC manque dans l'image, ce
qui arrive sur une construction personnalisée faite avec `--build-arg INSTALL_HEIF=false`.

**`403 Signature manquante` / `Signature invalide`** — `SIGNATURE_KEY` est renseignée, donc
chaque URL doit porter sa signature. Vérifiez que l'application signe
`<source>/<chemin>/<preset>` **décodé**, sans barre oblique de tête ni `BASE_PATH`, et que
les deux côtés s'accordent sur `SIGNATURE_LENGTH` et `SIGNATURE_ALGORITHM`. Le
[guide de signature](https://github.com/Smeagolworms4/image-resizer/blob/main/SIGNATURE.fr.md)
donne des valeurs de référence pour comparer.

**`503` sous charge** — c'est le comportement voulu, pas une panne. Augmentez
`MAX_CONCURRENCY` si la machine le supporte, et surtout mettez un cache devant pour que ces
requêtes n'y arrivent pas deux fois.

**Le volume de cache n'est pas accessible en écriture** — le conteneur tourne en UID 1000.
Renseignez `PUID`/`PGID` avec les vôtres, ou faites un `chown` du dossier `cache`.

## Sécurité

Les sources sont nommées et fixées : aucune URL ne peut faire chercher au service une
adresse que vous n'avez pas configurée, ce qui le sépare d'un proxy ouvert. Les chemins sont
vérifiés par rapport à la racine de la source, donc un `../` est refusé plutôt que résolu.

Les métadonnées de sortie sont retirées par défaut (`STRIP_METADATA=true`), **coordonnées
GPS comprises** — à garder en tête avant de passer ce réglage à `false` sur des photos de
vacances.

`SIGNATURE_KEY` lie chaque URL à la variante qu'elle demande : sans la clé, une adresse ne se
fabrique pas, et le service cesse d'être une ferme à images gratuite pour qui sait lire votre
HTML. Ce n'est pas un contrôle d'accès — une URL signée reste valable pour qui la détient,
et c'est précisément ce qui permet à un cache de la garder des mois.

Le service ne connaît pas l'authentification, et n'essaie pas : il sert ce que ses sources
contiennent. Ce qui est privé se met derrière le cache ou le reverse proxy placé devant,
où l'authentification est le métier de cette couche.

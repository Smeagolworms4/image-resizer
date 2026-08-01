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
    env_file:
      - .env
    ports:
      - "${PORT_HOST:-3000}:3000"
    volumes:
      - ./cache:/cache
      # - /chemin/vers/vos/photos:/photos:ro
```

Puis, à côté :

```bash
mkdir cache
cat > .env <<'EOF'
SOURCE_DEMO=/app/public
#SOURCE_PHOTOS=/photos
#SOURCE_CDN=https://storage.example.com
EOF
docker compose up -d
```

`env_file` est obligatoire, donc le fichier `.env` doit exister — mais **au moins une
source** l'est aussi : le service refuse de démarrer sans, plutôt que de démarrer et de
répondre 400 à tout.

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

Node 20.6 ou plus récent. `heif-convert` (paquet `libheif-examples` sur Debian/Ubuntu,
`libheif-tools` sur Alpine) n'est nécessaire que pour les photos HEIC.

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

Tout passe par des variables d'environnement, et rien d'autre. `.env.example` les liste
toutes avec leurs valeurs par défaut.

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

### Amont, charge et journaux

| Variable | Défaut | Rôle |
|---|---|---|
| `FETCH_TIMEOUT` | `15000` | Délai maximum de la requête amont, en ms |
| `FETCH_USER_AGENT` | `image-resizer` | `User-Agent` utilisé en amont |
| `MAX_INPUT_BYTES` | `67108864` | Au-delà, l'original est refusé (`413`) |
| `MAX_CONCURRENCY` | nombre de cœurs | Transformations simultanées avant de répondre `503` |
| `RETRY_AFTER` | `2` | `Retry-After` envoyé avec un `503`, en secondes |
| `SHARP_CONCURRENCY` / `SHARP_CACHE_MEMORY` | `0` / `50` | Réglages internes de sharp : fils (0 = automatique) et cache en Mio |
| `LOG_FORMAT` | `tiny` | Format morgan, ou `off` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

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

49 tests, sans accès réseau : les images viennent de `public/`, et un faux serveur HTTP
amont est démarré à la volée. Ils couvrent tous les modes d'ajustement et formats de
sortie, le bornage des dimensions et de la qualité, la réduction automatique, l'original
octet pour octet, la traversée de chemin, les noms encodés, `BASE_PATH`, les en-têtes de
cache et CORS, la revalidation `304`, la traduction des erreurs amont, le cache disque
(prouvé en comptant les requêtes amont) et le refus sous charge.

Les tests HEIC travaillent sur un **vrai fichier HEVC** versionné dans `test/fixtures/`, et
vérifient entre autres que sharp ne sait toujours pas le décoder — le jour où ce test
échouera, le convertisseur externe pourra disparaître. Le fichier est versionné plutôt que
fabriqué parce que le libheif livré par Debian et Ubuntu n'embarque pas d'encodeur x265 :
il lit le HEIC, il ne sait pas l'écrire.

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
  config.js       environnement → configuration, et les contrôles au démarrage
  server.js       routage, CORS, en-têtes de cache, gestion des erreurs
  preset.js       analyse du segment _ajustement_l_h_q.ext
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

Le service ne connaît pas l'authentification, et n'essaie pas : il sert ce que ses sources
contiennent. Ce qui est privé se met derrière le cache ou le reverse proxy placé devant,
où l'authentification est le métier de cette couche.

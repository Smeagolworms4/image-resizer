# image-resizer sur AWS Lambda

*Lire ceci en [anglais](https://github.com/Smeagolworms4/image-resizer/blob/main/LAMBDA.md).*

Le même service, dans un fichier zip. Pas de conteneur, pas de machine à
maintenir en vie : une archive `image-resizer-lambda-<version>-<arch>.zip` est
déposée sur une fonction Lambda, une URL de fonction est mise devant, et chaque
variante devient une adresse — exactement comme avec l'image Docker.

C'est bien le même service. Le point d'entrée Lambda ne réécrit ni le routage,
ni les presets, ni la signature, ni la gestion d'erreurs : il démarre
l'application Express de `src/server.js` une fois par conteneur et lui relaie
chaque invocation. **L'image Docker n'est pas touchée** — elle embarque le même
`src/`, elle n'a aucune dépendance nouvelle, et `src/lambda.js` n'y est
simplement jamais exécuté.

> Le sans-serveur et le redimensionnement d'images ne vont bien ensemble que
> **derrière un cache**. Lambda n'en a pas : sans CloudFront (ou équivalent)
> devant, la même vignette est recalculée, et refacturée, à chaque affichage.
> Voir [Mettre un cache devant](#mettre-un-cache-devant).

## Récupérer le paquet

Les archives prêtes à l'emploi sont attachées à chaque
[publication](https://github.com/Smeagolworms4/image-resizer/releases), une par
architecture, avec leur `sha256` :

| Fichier | Architecture Lambda |
| --- | --- |
| `image-resizer-lambda-<version>-x64.zip` | `x86_64` |
| `image-resizer-lambda-<version>-arm64.zip` | `arm64` (Graviton, ~20 % moins cher) |

Ou construisez-la : le script ne demande que Node et `zip`.

```bash
npm run build:lambda            # les deux architectures, dans dist/
./scripts/build-lambda.sh --arch arm64
./scripts/build-lambda.sh --arch x64 --no-public   # sans les images d'exemple
```

La construction télécharge les **binaires précompilés de sharp pour
l'architecture visée**, pas ceux de votre machine : un paquet arm64 se fabrique
depuis un portable x86, et réciproquement. Deux constructions du même commit
rendent une archive identique octet pour octet, ce qui rend le `sha256` publié
vérifiable.

Une dizaine de mégaoctets compressés, 24 décompressés — loin des limites de
Lambda (50 Mo pour un envoi direct, 250 Mo décompressés).

## Déployer en cinq commandes

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 1. Un rôle d'exécution — rien de plus que l'écriture dans CloudWatch Logs.
aws iam create-role --role-name image-resizer-lambda \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name image-resizer-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# 2. La fonction.
aws lambda create-function \
  --function-name image-resizer \
  --runtime nodejs22.x \
  --architectures x86_64 \
  --handler src/lambda.handler \
  --role "arn:aws:iam::$ACCOUNT:role/image-resizer-lambda" \
  --zip-file fileb://dist/image-resizer-lambda-1.2.0-x64.zip \
  --memory-size 2048 \
  --timeout 30 \
  --environment 'Variables={SOURCE_DEMO=/var/task/public,CACHE_DIR=/tmp/cache,HEIC_ENABLED=false}'

# 3. Une URL publique.
aws lambda create-function-url-config --function-name image-resizer --auth-type NONE
aws lambda add-permission --function-name image-resizer \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
```

`SOURCE_DEMO=/var/task/public` pointe sur les images d'exemple embarquées dans
l'archive : de quoi vérifier un déploiement tout neuf sans avoir configuré le
moindre stockage.

```bash
URL=$(aws lambda get-function-url-config --function-name image-resizer --query FunctionUrl --output text)
curl -s "$URL/health"
curl -s -o plage.webp "$URL/demo/test.png/_cover_320_200_80.webp"
```

Livrer une nouvelle version :

```bash
aws lambda update-function-code --function-name image-resizer \
  --zip-file fileb://dist/image-resizer-lambda-1.3.0-x64.zip
```

L'**architecture doit correspondre** : `--architectures arm64` va avec le zip
`arm64`. L'erreur n'est pas rattrapée au déploiement — la fonction démarre et
meurt à la première image sur un `Could not load the sharp module`.

## Configuration

Tout ce que documente le [README](README.fr.md#configuration) s'applique tel
quel : mêmes variables, mêmes valeurs par défaut, même format d'URL. Elles se
posent avec `aws lambda update-function-configuration --environment`.

Cinq d'entre elles méritent une autre valeur ici.

| Variable | Sur Lambda | Pourquoi |
| --- | --- | --- |
| `CACHE_DIR` | `/tmp/cache`, ou vide | `/var/task` est en lecture seule. `/tmp` est accessible en écriture, mais il appartient au conteneur et disparaît avec lui : il évite de retélécharger un original depuis un conteneur déjà chaud, rien de plus. 512 Mo par défaut (`--ephemeral-storage` monte à 10240). |
| `HEIC_ENABLED` | `false` | `heif-convert` n'est pas dans le runtime. Laissée à `true`, une photo HEIC rend un `501` explicite plutôt qu'une image — autant le dire d'avance. |
| `VIDEO_POSTER_ENABLED` | `false` (le défaut) | Même histoire avec `ffmpeg`. Les deux peuvent arriver par une couche Lambda, en pointant `HEIC_COMMAND` / `VIDEO_POSTER_COMMAND` dans `/opt/bin`. |
| `MAX_CONCURRENCY` | ne pas y toucher | Un conteneur traite une invocation à la fois ; la concurrence est l'affaire de Lambda, via la concurrence réservée. |
| `BASE_PATH` | `/<stage>` derrière une REST API | Une URL de fonction et une HTTP API servent à la racine, et n'ont besoin de rien. Une REST API, elle, préfixe les chemins du nom de son stage. |

**Le vrai réglage, c'est la mémoire.** Lambda alloue le processeur
proportionnellement : en dessous de 1769 Mo, une fonction n'a pas un vCPU
entier, et un redimensionnement s'en ressent nettement. 2048 Mo est un bon point
de départ ; 3008 Mo se rentabilisent sur les gros originaux, l'invocation
raccourcissant d'autant.

### Les sources

Une source HTTP fonctionne sans rien changer — n'importe quel bucket public,
n'importe quel CDN, n'importe quel serveur d'origine :

```
SOURCE_PHOTOS=https://mon-bucket.s3.eu-west-3.amazonaws.com
```

Le service ne s'authentifie pas : il fait un `GET`, point. Pour un bucket
**privé**, soit vous mettez CloudFront devant avec un contrôle d'accès à
l'origine, soit vous passez un jeton par `FETCH_HEADERS` si le stockage en
accepte un. La signature SigV4 des requêtes amont n'est pas implémentée.

Une source locale n'a de sens que pour ce qui voyage dans l'archive
(`/var/task/...`), le reste du système de fichiers étant vide. Pour lire un vrai
volume, attachez un point d'accès EFS et pointez la source sur son chemin de
montage.

## La taille des réponses

Une invocation rend sa réponse dans la charge utile de Lambda, plafonnée à
**6 Mo** — et le corps y voyage en base64, ce qui l'alourdit d'un tiers. Le
point d'entrée refuse au-delà de 4,5 Mo avec un `502` explicite, plutôt que de
laisser API Gateway répondre un `Internal server error` indéchiffrable.

En pratique, une image redimensionnée est très loin du compte. Un `_original`
sur une photo de 8 Mo, non. Deux issues :

- baisser `MAX_SIZE`, `DEFAULT_QUALITY`, ou poser `ALLOW_ORIGINAL=false` ;
- ou déployer le point d'entrée **en flux**, qui monte le plafond à 20 Mo :

```bash
aws lambda update-function-configuration --function-name image-resizer \
  --handler src/lambda.streamingHandler
aws lambda update-function-url-config --function-name image-resizer \
  --invoke-mode RESPONSE_STREAM
```

Le corps sort alors en octets bruts, sans base64 ni enveloppe JSON. Le mode flux
exige une **URL de fonction** : ni une HTTP API ni une REST API ne savent le
transporter.

## Mettre un cache devant

Ce n'est pas une optimisation, c'est le principe. Chaque requête non cachée est
un redimensionnement complet, facturé à la milliseconde ; la même vignette vue
mille fois coûte mille redimensionnements. Avec CloudFront devant, elle en coûte
un.

Le service émet déjà ce qu'un CDN attend — `Cache-Control` avec un `s-maxage`
long, `ETag`, `stale-while-revalidate`. Pointez une distribution sur l'URL de
fonction, avec la politique `CachingOptimized` et sans transmettre les chaînes
de requête à l'origine, et la section [Derrière un
cache](README.fr.md#derrière-un-cache) du README s'applique mot pour mot.

Le même raisonnement rend les [URL signées](SIGNATURE.fr.md) plus utiles ici
qu'ailleurs : sans elles, n'importe qui peut faire calculer à votre fonction un
`_cover_2048_2048_100` sur chaque image, indéfiniment, à vos frais. Elles
fonctionnent à l'identique sur Lambda — la signature est un HMAC sur le chemin,
et rien d'autre.

```
SIGNATURE_KEY=<une longue clé aléatoire>
```

## Les limites à connaître

| | |
| --- | --- |
| Démarrage à froid | ~1 s, dont l'essentiel est le chargement de la bibliothèque native de sharp. La concurrence provisionnée l'élimine, contre paiement. |
| Réponse | 6 Mo en mode classique, 20 Mo en flux (URL de fonction uniquement). |
| Disque | `/var/task` en lecture seule, `/tmp` en écriture et éphémère. |
| HEIC et vidéo | absents du runtime, disponibles via une couche. |
| Délai | 30 s suffisent largement ; ce qui met plus longtemps a un autre problème. |
| Concurrence | celle de Lambda, pas celle du service — posez une concurrence réservée si vous voulez un plafond. |

## Dépannage

**`Could not load the sharp module` / `Error: Cannot find module '../build/Release/sharp-linux-x64.node'`**
L'architecture du paquet ne correspond pas à celle de la fonction. Vérifiez avec
`aws lambda get-function-configuration --query Architectures` et redéployez le
bon zip.

**`Runtime.HandlerNotFound`**
Le handler est `src/lambda.handler`, avec le dossier — pas `index.handler`. Pour
le mode flux, `src/lambda.streamingHandler`.

**Toutes les requêtes répondent « Aucune source configurée »**
La fonction n'a aucune variable `SOURCE_*`. L'erreur est levée à
l'initialisation : elle apparaît dans CloudWatch avant la moindre requête.

**Les images reviennent en texte illisible derrière une REST API**
API Gateway REST ne décode le base64 que pour les types déclarés binaires.
Ajoutez `*/*` aux `binaryMediaTypes` de l'API — ou passez à une URL de fonction,
qui n'a besoin de rien de tel.

**404 sur tous les chemins derrière une REST API**
Le nom du stage fait partie du chemin. Posez `BASE_PATH=/<stage>`.

**Un `%` ou un accent dans un nom de fichier rend 404**
Vérifiez que le CDN devant ne décode pas le chemin. Le service gère lui-même
l'encodage, et prend le chemin exactement tel qu'AWS le lui passe.

## Ce que fait la construction

`scripts/build-lambda.sh` réinstalle les dépendances depuis `package-lock.json`
dans un dossier de travail, en demandant à npm `linux` / `glibc` / le processeur
visé — le même tour que celui du Dockerfile pour construire une image ARM sur
une machine x86. Il jette ensuite tout ce que sharp embarque pour les autres
plateformes (musl, wasm32, macOS, Windows : une quinzaine de mégaoctets de
libvips que le runtime Amazon Linux ne chargera jamais), copie `src/` et
`public/`, et compresse une liste de fichiers triée avec un horodatage fixe,
pour que l'archive soit reproductible.

Il échoue bruyamment si `@img/sharp-linux-<arch>` manque, parce que c'est
l'erreur qui, sinon, ne se voit qu'en production.

La CI construit les deux archives à chaque poussée et à chaque tag
([`.github/workflows/build_lambda.yml`](.github/workflows/build_lambda.yml)),
décompresse celle en x64 et invoque réellement le point d'entrée sur une image
d'exemple avant de la publier en artefact — et, sur un tag, de l'attacher à la
publication.

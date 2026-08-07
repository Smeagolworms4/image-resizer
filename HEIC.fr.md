# Les photos iPhone (HEIC / HEVC)

*Lire ceci en [anglais](https://github.com/Smeagolworms4/image-resizer/blob/main/HEIC.md).*
*Retour au [README](https://github.com/Smeagolworms4/image-resizer/blob/main/README.fr.md).*

Toute photo prise par un iPhone est un fichier HEIC, et un redimensionneur incapable de les
ouvrir est un redimensionneur auquel la moitié de votre photothèque est invisible. Le service
sait les traiter — mais pas par sharp, et il vaut la peine de savoir pourquoi.

## Pourquoi un binaire externe

Les binaires précompilés de sharp lisent l'**en-tête** HEIC mais ne savent pas décoder le
**HEVC** : aucun décodeur n'y est embarqué, pour des raisons de brevets. sharp vous donnera
volontiers les dimensions d'une photo qu'il est incapable de transformer en pixels.

Le service reconnaît donc le conteneur lui-même — douze octets : une boîte `ftyp` et sa
marque — et confie ces fichiers à `heif-convert`, qui les rend en PNG avant que le pipeline
habituel ne les reprenne. L'AVIF utilise le même conteneur, mais sharp le décode nativement :
il ne prend jamais ce détour.

Un test vérifie que sharp ne sait toujours pas décoder un vrai fichier HEVC, versionné sous
`public/photo.heic`. Le jour où ce test échouera, tout ce détour pourra disparaître.

## Le coût, et le cache

La conversion coûte cher, en processeur comme en mémoire — plusieurs centaines de
millisecondes pour une photo, et une rafale est précisément ce qui met un redimensionneur à
terre. Deux choses tiennent cela en bride :

- `HEIC_MAX_CONCURRENCY` plafonne le nombre de conversions simultanées, indépendamment de
  `MAX_CONCURRENCY`. Au-delà, les requêtes reçoivent un `503` avec un `Retry-After` plutôt
  que d'entraîner tout le reste vers le fond.
- **Le résultat est mis en cache disque** dans `CACHE_DIR/converted/` : cinquante requêtes
  parallèles sur la même photo déclenchent une conversion, pas cinquante.

Sans `CACHE_DIR`, chaque requête reconvertit. Avec du HEIC, un dossier de cache cesse d'être
une optimisation.

## Installer le décodeur

| Où | Quoi faire |
|---|---|
| **Image Docker** | Rien — `heif-convert` y est déjà. Seule une construction sur mesure avec `--build-arg INSTALL_HEIF=false` s'en passe |
| **Debian / Ubuntu** | `apt install libheif-examples`. À partir d'**Ubuntu 24.04**, aussi `libheif-plugin-libde265` — sans lui l'outil est installé mais ne décode rien |
| **Alpine** | `apk add libheif-tools` |
| **AWS Lambda** | Absent du runtime. Soit `HEIC_ENABLED=false`, soit le binaire dans une couche, avec `HEIC_COMMAND` pointant sur `/opt/bin/heif-convert` — voir [LAMBDA.fr.md](https://github.com/Smeagolworms4/image-resizer/blob/main/LAMBDA.fr.md) |

## Les réglages

| Variable | Défaut | Rôle |
|---|---|---|
| `HEIC_ENABLED` | `true` | Décodage HEIC/HEVC. Désactivé, ces fichiers donnent un `415` |
| `HEIC_COMMAND` | `heif-convert` | Le binaire de conversion, ou son chemin absolu |
| `HEIC_MAX_CONCURRENCY` | `2` | Conversions simultanées — celle-ci coûte cher |
| `HEIC_TIMEOUT` | `30000` | Délai maximum en ms ; un binaire qui ne rend jamais la main bloquerait un créneau pour toujours |

Le désactiver est un choix légitime : si rien n'est en HEIC dans votre photothèque,
`HEIC_ENABLED=false` répond `415` tout de suite au lieu de lancer un processus voué à
l'échec.

## Dépannage

**`501 'heif-convert' is not installed`** — le binaire n'est pas dans le `PATH`. Sur l'image
officielle cela n'arrive qu'avec une construction sur mesure faite avec
`--build-arg INSTALL_HEIF=false` ; ailleurs, installez-le depuis le tableau ci-dessus.

**`500 'heif-convert' failed: ...`** — l'outil est bien là mais n'a pas su décoder. À partir
d'Ubuntu 24.04 c'est presque toujours le `libheif-plugin-libde265` manquant : le décodeur
HEVC vit dans un greffon séparé, et sans lui libheif lit le conteneur et s'arrête là. Le
message reprend la première ligne du `stderr` de l'outil, qui le dit en général.

**`504 'heif-convert' timed out`** — une photo très grande, ou une machine chargée. Montez
`HEIC_TIMEOUT`, ou baissez `HEIC_MAX_CONCURRENCY` pour laisser plus de processeur à chaque
conversion.

**`415 HEIC support is disabled`** — `HEIC_ENABLED=false`.

**Ça marche, puis ça redevient lent** — vérifiez que `CACHE_DIR` est renseigné *et*
accessible en écriture. Un cache qui échoue en silence à l'écriture retransforme chaque
requête en conversion ; le service émet un avertissement quand cela arrive.

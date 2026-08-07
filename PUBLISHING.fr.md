# La publication

*Lire ceci en [anglais](https://github.com/Smeagolworms4/image-resizer/blob/main/PUBLISHING.md).*
*Retour au [README](https://github.com/Smeagolworms4/image-resizer/blob/main/README.fr.md).*

Comment l'image Docker et les archives Lambda sont construites et publiées, et ce qu'un fork
doit mettre en place pour en faire autant. Rien ici n'est nécessaire pour *utiliser* le
service.

## L'image Docker

**https://hub.docker.com/r/smeagolworms4/image-resizer**

Publiée pour `linux/amd64`, `linux/arm64` et `linux/arm/v7` depuis un manifeste multi-arch
unique — le même tag fonctionne sur un PC, un NAS et un Raspberry Pi.

| Tag | Construit sur |
|---|---|
| `latest` | chaque poussée sur `main`, et chaque tag git — celui à utiliser |
| `main` | chaque poussée sur la branche `main` |
| `<version>` (ex. `1.3.0`) | création d'un tag git de ce nom, pour figer une version |

L'image est basée sur Debian plutôt qu'Alpine : sharp ne publie pas de binaire musl pour
l'ARM 32 bits, et une image qui ne tourne pas sur un Raspberry Pi manquerait la cible.

Les dépendances sont installées **pour l'architecture visée depuis celle de la machine qui
construit** (`npm ci --os --libc --cpu`), ce qui évite de faire tourner quoi que ce soit sous
QEMU. Faire tourner npm — donc V8 — en ARM émulé est lent et connu pour mourir en « illegal
instruction » ; sharp est distribué en binaires précompilés par plateforme, et npm sait aller
chercher ceux d'une autre. La construction Lambda emploie la même astuce.

## Les workflows

| Workflow | Se déclenche sur | Fait |
|---|---|---|
| `tests.yml` | chaque poussée et chaque pull request | la suite de tests sur Node 20, 22 et 24, plus le smoke test du conteneur sur les trois architectures publiées |
| `build_images.yml` | poussées sur `main`, et tags | construction multi-arch, poussée sur Docker Hub |
| `push_readme.yml` | poussées sur `main` | synchronise la description Docker Hub depuis `README.md` |
| `build_lambda.yml` | poussées, tags, manuel | les archives Lambda `x64` et `arm64`, publiées en artefacts et attachées à la publication GitHub sur un tag |

`build_lambda.yml` est volontairement indépendant de la construction d'image : il n'a besoin
ni de buildx ni de QEMU, et la panne de l'un ne doit pas empêcher l'autre de sortir. Il
décompresse l'archive x64 et invoque réellement le point d'entrée sur une image d'exemple
avant de la publier — un paquet incapable de démarrer est attrapé ici plutôt que sur une
Lambda.

## Les secrets GitHub à créer à la main

Seuls `build_images.yml` et `push_readme.yml` en ont besoin. À ajouter dans *Settings →
Secrets and variables → Actions* :

| Secret | Contenu |
|---|---|
| `DOCKER_USERNAME` | votre identifiant Docker Hub (sert aussi à construire le nom de l'image) |
| `DOCKER_PASSWORD` | un *access token* Docker Hub |

`build_lambda.yml` n'a besoin d'aucun secret : il n'écrit que dans les artefacts et les
publications du dépôt lui-même.

## Sortir une version

La convention de l'historique : des commits de fonctionnalité, puis un commit
`Version X.Y.Z` qui met à jour `package.json`, puis un tag du même nom préfixé d'un `v`.

```bash
npm version 1.4.0 --no-git-tag-version
git commit -am "Version 1.4.0"
git tag -a v1.4.0 -m "Version 1.4.0"
git push origin main && git push origin v1.4.0
```

C'est le tag qui produit le tag Docker versionné et la publication GitHub, avec les archives
Lambda et leurs `sha256` attachés.

## Deux limites qui mordent

**Docker Hub plafonne la description longue à 25000 caractères**, et l'API refuse au-delà —
sans la moindre erreur côté client si l'on ne lit pas sa réponse. C'est ainsi qu'un workflow
peut se déclarer vert en laissant la description précédente en ligne. `push_readme.yml`
contrôle désormais la longueur avant l'envoi, lit le code HTTP, et relit la description
publiée pour vérifier qu'elle correspond ; un test de `test/dockerfile.test.js` l'attrape
avant même la poussée. Quand `README.md` s'en approche, le remède est de déplacer une section
dans un fichier à elle — c'est de là que viennent
[SIGNATURE.fr.md](https://github.com/Smeagolworms4/image-resizer/blob/main/SIGNATURE.fr.md),
[HEIC.fr.md](https://github.com/Smeagolworms4/image-resizer/blob/main/HEIC.fr.md),
[LAMBDA.fr.md](https://github.com/Smeagolworms4/image-resizer/blob/main/LAMBDA.fr.md) et ce
fichier.

**La description courte est plafonnée à 100 octets**, des octets et non des caractères. Elle
est reprise de la description du dépôt GitHub et tronquée sur un mot entier si besoin.

# --- Dépendances -------------------------------------------------------------
# `--platform=$BUILDPLATFORM` épingle cette étape sur l'architecture de la
# machine qui construit, jamais sur celle qui est visée : sous QEMU, faire
# tourner npm (donc V8) en ARM émulé est lent et connu pour mourir en « illegal
# instruction ».
#
# Il n'y a pourtant rien à compiler ici : sharp est distribué en binaires
# précompilés par plateforme, et npm sait les télécharger pour une cible autre
# que la sienne avec --os/--libc/--cpu. C'est ce qui rend la construction
# multi-architecture rapide et fiable.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps

ARG TARGETPLATFORM
WORKDIR /app

COPY package.json package-lock.json ./

RUN set -eux; \
	case "$TARGETPLATFORM" in \
		linux/amd64)  NPM_CPU=x64   ;; \
		linux/arm64)  NPM_CPU=arm64 ;; \
		linux/arm/v7) NPM_CPU=arm   ;; \
		*) echo "Plateforme non gérée : $TARGETPLATFORM" >&2; exit 1 ;; \
	esac; \
	npm ci --omit=dev --os=linux --libc=glibc --cpu="$NPM_CPU"; \
	npm cache clean --force

# --- Image finale ------------------------------------------------------------
# Debian plutôt qu'Alpine : sharp ne publie pas de binaire musl pour ARM 32
# bits, et une image qui ne tourne pas sur un Raspberry Pi n'a pas d'intérêt ici.
FROM node:22-bookworm-slim

# heif-convert (paquet libheif-examples) décode le HEVC des photos iPhone, que
# les binaires précompilés de sharp ne savent pas ouvrir. ffmpeg ne sert qu'aux
# vignettes vidéo, une fonction optionnelle qui pèse plusieurs centaines de
# mégaoctets : elle s'ajoute à la demande.
ARG INSTALL_HEIF=true
ARG INSTALL_FFMPEG=false

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends tini; \
	if [ "$INSTALL_HEIF" = "true" ]; then apt-get install -y --no-install-recommends libheif-examples; fi; \
	if [ "$INSTALL_FFMPEG" = "true" ]; then apt-get install -y --no-install-recommends ffmpeg; fi; \
	rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Images d'exemple : permettent de vérifier une installation sans rien
# configurer d'autre (SOURCE_DEMO=/app/public).
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Tout le reste se règle par variable d'environnement, sans reconstruire :
# voir .env.example pour la liste complète.
ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0 \
	CACHE_DIR=/cache

RUN mkdir -p /cache && chown node:node /cache
VOLUME [ "/cache" ]
EXPOSE 3000

USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.HEALTH_PATH||'/health')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini : sans lui, Node est PID 1 et n'a pas de gestionnaire de signaux par
# défaut — `docker stop` finirait en SIGKILL au milieu d'une transformation.
ENTRYPOINT [ "/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh" ]
CMD [ "node", "src/index.js" ]

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

# Tout est réglable par variable d'environnement, sans reconstruire. La liste
# est déclarée ici en entier, avec les valeurs par défaut : `docker inspect`
# suffit alors à savoir ce qui existe et ce que ça vaut, sans lire le code ni
# la documentation. Les valeurs vides ne sont pas des réglages absents : elles
# laissent la main au code (source non configurée, en-tête calculé, nombre de
# cœurs). Un test vérifie que ce bloc ne dérive pas des valeurs par défaut
# réelles du service.
ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0 \
	BASE_PATH= \
	HEALTH_PATH=/health \
	TRUST_PROXY= \
	SOURCES= \
	CACHE_DIR=/cache \
	CACHE_ORIGINALS=true \
	MIN_SIZE=1 \
	MAX_SIZE=2048 \
	MIN_QUALITY=10 \
	DEFAULT_QUALITY=80 \
	DEFAULT_FIT=cover \
	DEFAULT_FORMAT=jpeg \
	ALLOWED_FORMATS=jpeg,png,webp,avif \
	ALLOW_ORIGINAL=true \
	AUTO_DOWNSCALE=true \
	STRIP_METADATA=true \
	FAIL_ON=none \
	AUTO_ROTATE=true \
	ALLOW_ENLARGEMENT=true \
	RESIZE_KERNEL=lanczos3 \
	DEFAULT_POSITION=center \
	CONTAIN_BACKGROUND=#000000 \
	JPEG_PROGRESSIVE=false \
	JPEG_MOZJPEG=true \
	JPEG_CHROMA_SUBSAMPLING=4:2:0 \
	PNG_COMPRESSION_LEVEL=9 \
	PNG_PALETTE=false \
	WEBP_EFFORT=4 \
	WEBP_LOSSLESS=false \
	WEBP_SMART_SUBSAMPLE=false \
	AVIF_EFFORT=4 \
	AVIF_LOSSLESS=false \
	AVIF_CHROMA_SUBSAMPLING=4:4:4 \
	MAX_AGE=604800 \
	S_MAX_AGE=5184000 \
	STALE_WHILE_REVALIDATE=604800 \
	ERROR_MAX_AGE=60 \
	CACHE_CONTROL= \
	CORS_ORIGIN=* \
	SIGNATURE_KEY= \
	SIGNATURE_ALGORITHM=sha256 \
	SIGNATURE_LENGTH=16 \
	FETCH_TIMEOUT=15000 \
	FETCH_USER_AGENT=image-resizer \
	FETCH_HEADERS= \
	FETCH_REDIRECT=follow \
	MAX_INPUT_BYTES=67108864 \
	SHUTDOWN_TIMEOUT=10000 \
	MAX_CONCURRENCY= \
	RETRY_AFTER=2 \
	SHARP_CONCURRENCY=0 \
	SHARP_CACHE_MEMORY=50 \
	HEIC_ENABLED=true \
	HEIC_COMMAND=heif-convert \
	HEIC_MAX_CONCURRENCY=2 \
	HEIC_TIMEOUT=30000 \
	VIDEO_POSTER_ENABLED=false \
	VIDEO_POSTER_COMMAND=ffmpeg \
	VIDEO_POSTER_EXTENSIONS=mp4,mov,webm,m4v,mkv,avi \
	VIDEO_POSTER_SEEK=1 \
	VIDEO_POSTER_WIDTH=1280 \
	VIDEO_POSTER_TIMEOUT=30000 \
	LOG_FORMAT=tiny \
	LOG_LEVEL=info

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

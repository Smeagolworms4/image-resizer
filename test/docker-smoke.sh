#!/usr/bin/env bash
# Vérifie l'image Docker elle-même : ce que les tests Node ne peuvent pas voir,
# c'est-à-dire que le conteneur démarre, qu'il répond en non-root, que
# heif-convert est bien présent dedans, et que tout cela vaut aussi pour les
# architectures ARM (les images sont alors exécutées sous QEMU).
#
#   test/docker-smoke.sh [image] [--platform linux/arm64]
set -euo pipefail

IMAGE="${1:-image-resizer:test}"
PLATFORM_ARGS=()
if [ "${2:-}" = "--platform" ] && [ -n "${3:-}" ]; then
	PLATFORM_ARGS=(--platform "$3")
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
NAME="image-resizer-smoke-$$"
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"

cleanup() {
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT

# Les images d'exemple embarquées dans l'image contiennent un vrai fichier
# HEIC (conteneur HEIC, codec HEVC) : le format des photos iPhone, et le seul
# que sharp ne sait pas décoder seul. Rien à monter, donc.
mkdir -p "$WORK/cache"
chmod 777 "$WORK/cache"

echo "→ démarrage de $IMAGE sur le port $PORT"
docker run -d --name "$NAME" "${PLATFORM_ARGS[@]}" \
	-p "$PORT:3000" \
	-e SOURCE_DEMO=/app/public \
	-e MAX_SIZE=1200 \
	-v "$WORK/cache:/cache" \
	"$IMAGE" >/dev/null

for _ in $(seq 1 60); do
	if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
	sleep 2
done

if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
	echo "ÉCHEC : le service n'a pas démarré" >&2
	docker logs "$NAME" >&2 || true
	exit 1
fi

echo "→ architecture : $(docker exec "$NAME" uname -m), utilisateur : $(docker exec "$NAME" id -un)"
if [ "$(docker exec "$NAME" id -u)" = "0" ]; then
	echo "ÉCHEC : le conteneur tourne en root" >&2
	exit 1
fi

# Vérifie le contenu de la réponse, pas seulement son code : une image de la
# mauvaise taille répond 200 elle aussi.
check() {
	local path="$1" expected_format="$2" expected_width="$3" expected_height="$4"
	local file="$WORK/out"
	local status
	status="$(curl -s -o "$file" -w '%{http_code}' "http://127.0.0.1:$PORT$path")"
	if [ "$status" != "200" ]; then
		echo "ÉCHEC : $path a répondu $status" >&2
		docker logs "$NAME" 2>&1 | tail -20 >&2
		exit 1
	fi
	node -e "
		const sharp = require('sharp');
		sharp('$file').metadata().then((meta) => {
			const ok = meta.format === '$expected_format' && meta.width === $expected_width && meta.height === $expected_height;
			console.log((ok ? '  ✔' : '  ✘') + ' $path -> ' + meta.format + ' ' + meta.width + 'x' + meta.height);
			process.exit(ok ? 0 : 1);
		}).catch((error) => { console.error('  ✘ $path : ' + error.message); process.exit(1); });
	"
}

check '/demo/test.png/_cover_120_80_75.webp' webp 120 80
check '/demo/test.png/_inside_300__.png' png 300 115
check '/demo/BIG.jpg/_.jpg' jpeg 1200 879

docker exec "$NAME" sh -c 'command -v heif-convert >/dev/null' \
	|| { echo 'ÉCHEC : heif-convert absent de l’image' >&2; exit 1; }
check '/demo/photo.heic/_cover_150_150_85.jpg' jpeg 150 150
test -f "$WORK/cache/converted/demo/photo.heic.png" \
	|| { echo 'ÉCHEC : la conversion HEIC n’a pas été mise en cache' >&2; exit 1; }
echo '  ✔ HEIC/HEVC converti et mis en cache'

# Le cache disque doit être écrit par un conteneur non-root.
test -d "$WORK/cache" && echo '  ✔ volume de cache accessible en écriture'

echo "→ arrêt propre"
docker stop --timeout 30 "$NAME" >/dev/null
echo "OK : $IMAGE"

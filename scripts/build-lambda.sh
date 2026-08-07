#!/usr/bin/env bash
#
# Fabrique le paquet AWS Lambda : une archive zip contenant le service, ses
# dépendances et les binaires sharp de l'architecture visée.
#
# Le point délicat est sharp : il est distribué en binaires précompilés par
# plateforme, et ceux installés sur la machine qui construit ne sont presque
# jamais ceux dont Lambda a besoin. On les demande explicitement avec les
# options --os/--libc/--cpu de npm, exactement comme le fait le Dockerfile pour
# construire une image ARM depuis une machine x86.
#
#   ./scripts/build-lambda.sh                  # x64, l'architecture Lambda par défaut
#   ./scripts/build-lambda.sh --arch arm64     # Graviton
#   ./scripts/build-lambda.sh --all            # les deux
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"
ARCHITECTURES=()
WITH_PUBLIC=true

usage() {
	cat <<-EOF
		Usage: $(basename "$0") [options]

		  --arch <x64|arm64>  Architecture visée (par défaut : x64)
		  --all               Construit x64 et arm64
		  --out <dossier>     Dossier de sortie (par défaut : dist)
		  --no-public         N'embarque pas les images d'exemple de public/
		  -h, --help          Affiche cette aide
	EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--arch) ARCHITECTURES+=("$2"); shift 2 ;;
		--all) ARCHITECTURES+=(x64 arm64); shift ;;
		--out) OUT="$(mkdir -p "$2" && cd "$2" && pwd)"; shift 2 ;;
		--no-public) WITH_PUBLIC=false; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "Option inconnue : $1" >&2; usage >&2; exit 2 ;;
	esac
done

[ ${#ARCHITECTURES[@]} -eq 0 ] && ARCHITECTURES=(x64)

command -v zip >/dev/null || { echo "ERREUR : 'zip' est introuvable (paquet zip)." >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
mkdir -p "$OUT"

build() {
	local arch="$1"
	local stage="$OUT/.stage-$arch"
	local zipfile="$OUT/image-resizer-lambda-$VERSION-$arch.zip"

	case "$arch" in
		x64|arm64) ;;
		*) echo "ERREUR : architecture inconnue '$arch' (attendu : x64, arm64)" >&2; exit 2 ;;
	esac

	echo "==> image-resizer $VERSION — paquet Lambda linux/$arch"

	rm -rf "$stage"
	mkdir -p "$stage"

	# Le paquet est reconstruit depuis package-lock.json plutôt que copié
	# depuis le node_modules local : c'est la seule façon d'obtenir les
	# binaires de l'architecture visée, et cela garantit qu'aucune dépendance
	# de développement ne se glisse dans l'archive.
	cp "$ROOT/package.json" "$ROOT/package-lock.json" "$stage/"

	( cd "$stage" && npm ci --omit=dev --ignore-scripts --os=linux --libc=glibc --cpu="$arch" --no-audit --no-fund )

	# Le contrôle qui compte : sans ce dossier, la Lambda démarre et meurt à la
	# première image sur un « Could not load the sharp module ».
	if [ ! -d "$stage/node_modules/@img/sharp-linux-$arch" ]; then
		echo "ERREUR : @img/sharp-linux-$arch absent — npm n'a pas installé le binaire de la cible." >&2
		exit 1
	fi

	# --libc=glibc ne suffit pas : npm laisse passer les variantes musl et
	# wasm32, soit une bonne dizaine de mégaoctets de libvips que le runtime
	# Amazon Linux ne chargera jamais. On ne garde que le binaire visé, sa
	# libvips, et @img/colour qui est une vraie dépendance de sharp.
	for module in "$stage/node_modules/@img"/*; do
		case "$(basename "$module")" in
			colour|"sharp-linux-$arch"|"sharp-libvips-linux-$arch") ;;
			*) rm -rf "$module" ;;
		esac
	done

	cp -R "$ROOT/src" "$stage/src"
	if [ "$WITH_PUBLIC" = true ]; then
		cp -R "$ROOT/public" "$stage/public"
	fi
	cp "$ROOT/LICENSE" "$stage/LICENSE"

	# Lambda facture le temps de démarrage à froid, qui dépend du nombre de
	# fichiers à décompresser : tout ce qui n'est ni du code ni un binaire part.
	find "$stage/node_modules" \
		\( -name '*.md' -o -name '*.markdown' -o -name '*.ts' -o -name '*.map' \
		-o -name '.editorconfig' -o -name '.eslintrc*' -o -name '.npmignore' \
		-o -name 'LICENSE*' -o -name 'AUTHORS*' \) -type f -delete
	find "$stage/node_modules" -type d \
		\( -name test -o -name tests -o -name __tests__ -o -name example -o -name examples -o -name docs -o -name .github \) \
		-prune -exec rm -rf {} +
	rm -f "$stage/package-lock.json"

	rm -f "$zipfile"
	# Liste triée et horodatage fixe : deux constructions du même commit
	# rendent la même archive, ce qui rend une somme de contrôle vérifiable.
	find "$stage" -exec touch -h -t 200001010000 {} +
	( cd "$stage" && find . \( -type f -o -type l \) | LC_ALL=C sort | zip -q -X -@ "$zipfile" )
	rm -rf "$stage"

	echo "    $zipfile ($(du -h "$zipfile" | cut -f1))"
}

for arch in "${ARCHITECTURES[@]}"; do
	build "$arch"
done

echo
echo "Handler          : src/lambda.handler   (ou src/lambda.streamingHandler en mode RESPONSE_STREAM)"
echo "Runtime          : nodejs22.x (ou nodejs20.x)"
echo "Variables requises : au moins une source, par ex. SOURCE_DEMO=/var/task/public"
echo "Documentation    : LAMBDA.md"

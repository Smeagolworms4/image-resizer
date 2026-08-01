#!/bin/sh
set -e

CACHE_DIR="${CACHE_DIR:-/cache}"

if [ -n "$CACHE_DIR" ]; then
	# Le conteneur peut tourner sous l'UID de l'hôte (`user:` dans le compose) :
	# le dossier existe peut-être déjà sans nous appartenir, auquel cas il est
	# normal de ne pas pouvoir le recréer.
	mkdir -p "$CACHE_DIR" 2>/dev/null || true

	if [ ! -w "$CACHE_DIR" ]; then
		echo "ERREUR : $CACHE_DIR n'est pas accessible en écriture." >&2
		echo "Vérifiez PUID/PGID dans .env, les droits du volume, ou videz CACHE_DIR pour désactiver le cache disque." >&2
		exit 1
	fi
fi

exec "$@"

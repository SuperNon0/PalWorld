#!/usr/bin/env bash
# Sauvegarde du monde Palworld (dossier Pal/Saved) dans une archive tar.gz.
# Conserve les KEEP dernières sauvegardes (défaut : 10).
#   sudo -u palworld /opt/palworld/scripts/backup.sh
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-/opt/palworld/server}"
BACKUP_DIR="${BACKUP_DIR:-/opt/palworld/backups}"
KEEP="${KEEP:-10}"

STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$BACKUP_DIR/palworld-$STAMP.tar.gz"

if [[ ! -d "$SERVER_DIR/Pal/Saved" ]]; then
    echo "[backup] Aucune donnée à sauvegarder ($SERVER_DIR/Pal/Saved introuvable)." >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
echo "[backup] Création de $ARCHIVE…"
tar czf "$ARCHIVE" -C "$SERVER_DIR/Pal" Saved

# Rotation : suppression des archives les plus anciennes au-delà de KEEP
ls -1t "$BACKUP_DIR"/palworld-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --

echo "[backup] Sauvegarde terminée : $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))"

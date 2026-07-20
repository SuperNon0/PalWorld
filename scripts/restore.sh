#!/usr/bin/env bash
# Restaure une sauvegarde du monde créée par backup.sh.
# Le monde ACTUEL est d'abord archivé (sauvegarde de sécurité), puis remplacé.
#   sudo -u palworld /opt/palworld/scripts/restore.sh palworld-AAAAMMJJ-HHMMSS.tar.gz
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-/opt/palworld/server}"
BACKUP_DIR="${BACKUP_DIR:-/opt/palworld/backups}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

NAME=$(basename "${1:?usage : restore.sh NOM_ARCHIVE.tar.gz}")
ARCHIVE="$BACKUP_DIR/$NAME"
[[ -f $ARCHIVE ]] || { echo "[restore] Archive introuvable : $ARCHIVE" >&2; exit 1; }

WAS_ACTIVE=0
if systemctl is-active --quiet palworld.service; then
    WAS_ACTIVE=1
    echo "[restore] Arrêt du serveur…"
    sudo -n /usr/bin/systemctl stop palworld.service
fi

if [[ -d "$SERVER_DIR/Pal/Saved" ]]; then
    echo "[restore] Sauvegarde de sécurité du monde actuel…"
    # KEEP élevé : la rotation ne doit surtout pas supprimer l'archive à restaurer
    KEEP=1000 "$SCRIPT_DIR/backup.sh"
    rm -rf "$SERVER_DIR/Pal/Saved"
fi

echo "[restore] Restauration de $NAME…"
tar xzf "$ARCHIVE" -C "$SERVER_DIR/Pal"

if [[ $WAS_ACTIVE -eq 1 ]]; then
    echo "[restore] Redémarrage du serveur…"
    sudo -n /usr/bin/systemctl start palworld.service
fi

echo "[restore] Restauration terminée."

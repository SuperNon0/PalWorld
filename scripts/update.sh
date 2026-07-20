#!/usr/bin/env bash
# Mise à jour du serveur Palworld via SteamCMD.
# Exécuté par le panel (utilisateur palworld) ou manuellement :
#   sudo -u palworld /opt/palworld/scripts/update.sh
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-/opt/palworld/server}"
STEAMCMD="${STEAMCMD:-/usr/games/steamcmd}"
APP_ID=2394010
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

WAS_ACTIVE=0
if systemctl is-active --quiet palworld.service; then
    WAS_ACTIVE=1
    echo "[update] Arrêt du serveur Palworld…"
    sudo -n /usr/bin/systemctl stop palworld.service
fi

if [[ -d "$SERVER_DIR/Pal/Saved" ]]; then
    echo "[update] Sauvegarde de sécurité du monde avant mise à jour…"
    "$SCRIPT_DIR/backup.sh" || echo "[update] AVERTISSEMENT : sauvegarde échouée, poursuite de la mise à jour."
fi

echo "[update] Téléchargement de la mise à jour via SteamCMD…"
"$STEAMCMD" +force_install_dir "$SERVER_DIR" +login anonymous +app_update "$APP_ID" validate +quit

if [[ $WAS_ACTIVE -eq 1 ]]; then
    echo "[update] Redémarrage du serveur…"
    sudo -n /usr/bin/systemctl start palworld.service
fi

echo "[update] Mise à jour terminée."

#!/usr/bin/env bash
# Mise à jour du serveur Palworld via SteamCMD.
# Exécuté par le panel (utilisateur palworld) ou manuellement :
#   sudo -u palworld /opt/palworld/scripts/update.sh
set -euo pipefail

SERVER_DIR="${SERVER_DIR:-/opt/palworld/server}"
STEAMCMD="${STEAMCMD:-/usr/games/steamcmd}"
APP_ID=2394010

WAS_ACTIVE=0
if systemctl is-active --quiet palworld.service; then
    WAS_ACTIVE=1
    echo "[update] Arrêt du serveur Palworld…"
    sudo -n /usr/bin/systemctl stop palworld.service
fi

echo "[update] Téléchargement de la mise à jour via SteamCMD…"
"$STEAMCMD" +force_install_dir "$SERVER_DIR" +login anonymous +app_update "$APP_ID" validate +quit

if [[ $WAS_ACTIVE -eq 1 ]]; then
    echo "[update] Redémarrage du serveur…"
    sudo -n /usr/bin/systemctl start palworld.service
fi

echo "[update] Mise à jour terminée."

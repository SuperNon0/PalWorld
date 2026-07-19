#!/usr/bin/env bash
#
# ============================================================================
#  Installation automatique : serveur dédié Palworld + panel web
#  Cible : Ubuntu Server 22.04 / 24.04 (VM Proxmox ou machine dédiée)
#
#  Usage :
#      git clone https://github.com/SuperNon0/PalWorld.git
#      cd PalWorld
#      sudo ./install.sh
#
#  Options :
#      --game-port PORT        Port UDP du serveur de jeu   (défaut : 8211)
#      --panel-port PORT       Port HTTP du panel web       (défaut : 8080)
#      --panel-password MDP    Mot de passe du panel        (défaut : généré)
#      --admin-password MDP    Mot de passe admin/API       (défaut : généré)
#      --max-players N         Nombre maximum de joueurs    (défaut : 32)
#      -h, --help              Affiche cette aide
# ============================================================================
set -euo pipefail

PALWORLD_HOME=/opt/palworld
SERVER_DIR=$PALWORLD_HOME/server
PANEL_DIR=$PALWORLD_HOME/panel
SCRIPTS_DIR=$PALWORLD_HOME/scripts
BACKUP_DIR=$PALWORLD_HOME/backups
ETC_DIR=/etc/palworld-panel
STEAMCMD=/usr/games/steamcmd
APP_ID=2394010

GAME_PORT=8211
PANEL_PORT=8080
MAX_PLAYERS=32
PANEL_PASSWORD=""
ADMIN_PASSWORD=""
ADMIN_PASSWORD_FORCED=0

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

log()  { echo -e "\033[1;36m[install]\033[0m $*"; }
fail() { echo -e "\033[1;31m[erreur]\033[0m $*" >&2; exit 1; }

usage() { sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,2\}//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --game-port)      GAME_PORT=$2; shift 2 ;;
        --panel-port)     PANEL_PORT=$2; shift 2 ;;
        --panel-password) PANEL_PASSWORD=$2; shift 2 ;;
        --admin-password) ADMIN_PASSWORD=$2; ADMIN_PASSWORD_FORCED=1; shift 2 ;;
        --max-players)    MAX_PLAYERS=$2; shift 2 ;;
        -h|--help)        usage; exit 0 ;;
        *)                fail "Option inconnue : $1 (voir --help)" ;;
    esac
done

[[ $EUID -eq 0 ]] || fail "Ce script doit être lancé en root : sudo ./install.sh"
command -v apt-get >/dev/null || fail "apt-get introuvable : ce script cible Ubuntu/Debian."
[[ -d "$REPO_DIR/panel" ]] || fail "Dossier panel/ introuvable : lancez le script depuis le dépôt cloné."

# ----------------------------------------------------------- 1. paquets système
log "Installation des paquets système…"
dpkg --add-architecture i386
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    software-properties-common curl tar python3 python3-flask
add-apt-repository -y multiverse >/dev/null 2>&1 || true
apt-get update -y

# Acceptation automatique de la licence Steam
echo steam steam/question select "I AGREE" | debconf-set-selections
echo steam steam/license note "" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y steamcmd lib32gcc-s1

[[ -x $STEAMCMD ]] || fail "SteamCMD n'a pas pu être installé."

# --------------------------------------------------- 2. utilisateur et dossiers
if ! id palworld >/dev/null 2>&1; then
    log "Création de l'utilisateur système 'palworld'…"
    useradd --system --create-home --home-dir "$PALWORLD_HOME" --shell /bin/bash palworld
fi
install -d -o palworld -g palworld "$PALWORLD_HOME" "$SERVER_DIR" "$BACKUP_DIR"

# ------------------------------------------------- 3. fichiers du panel/scripts
log "Copie du panel et des scripts…"
rm -rf "$PANEL_DIR" "$SCRIPTS_DIR"
cp -a "$REPO_DIR/panel" "$PANEL_DIR"
cp -a "$REPO_DIR/scripts" "$SCRIPTS_DIR"
chmod +x "$SCRIPTS_DIR"/*.sh
chown -R palworld:palworld "$PANEL_DIR" "$SCRIPTS_DIR"

# ------------------------------------------------ 4. serveur Palworld (SteamCMD)
log "Téléchargement / mise à jour du serveur Palworld (peut prendre plusieurs minutes)…"
sudo -u palworld "$STEAMCMD" +force_install_dir "$SERVER_DIR" \
    +login anonymous +app_update "$APP_ID" validate +quit

[[ -f "$SERVER_DIR/PalServer.sh" ]] || fail "L'installation du serveur a échoué (PalServer.sh introuvable)."

# Correctif SDK Steam requis par PalServer
SDK_DIR=$PALWORLD_HOME/.steam/sdk64
install -d -o palworld -g palworld "$PALWORLD_HOME/.steam" "$SDK_DIR"
STEAMCLIENT=$(find "$PALWORLD_HOME" -path "*steamcmd/linux64/steamclient.so" 2>/dev/null | head -n1)
[[ -z $STEAMCLIENT ]] && STEAMCLIENT=$(find "$PALWORLD_HOME" -name steamclient.so -path "*linux64*" 2>/dev/null | head -n1)
if [[ -n $STEAMCLIENT ]]; then
    install -o palworld -g palworld "$STEAMCLIENT" "$SDK_DIR/steamclient.so"
else
    log "AVERTISSEMENT : steamclient.so introuvable, le serveur peut afficher des erreurs Steam."
fi

# ------------------------------------------------------- 5. configuration du jeu
CONF_DIR=$SERVER_DIR/Pal/Saved/Config/LinuxServer
INI=$CONF_DIR/PalWorldSettings.ini
NEW_INI=0
install -d -o palworld -g palworld \
    "$SERVER_DIR/Pal" "$SERVER_DIR/Pal/Saved" "$SERVER_DIR/Pal/Saved/Config" "$CONF_DIR"
if [[ ! -f $INI ]]; then
    cp "$SERVER_DIR/DefaultPalWorldSettings.ini" "$INI"
    chown palworld:palworld "$INI"
    NEW_INI=1
fi

[[ -n $ADMIN_PASSWORD ]] || ADMIN_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(8))')
[[ -n $PANEL_PASSWORD ]] || PANEL_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(8))')

log "Configuration de PalWorldSettings.ini (API REST, RCON, ports)…"
INI_ARGS=(
    "RESTAPIEnabled=True" "RESTAPIPort=8212"
    "RCONEnabled=True" "RCONPort=25575"
    "PublicPort=$GAME_PORT" "ServerPlayerMaxNum=$MAX_PLAYERS"
)
# Le mot de passe admin n'est écrasé que sur une première installation
# ou si --admin-password a été fourni explicitement.
if [[ $NEW_INI -eq 1 || $ADMIN_PASSWORD_FORCED -eq 1 ]]; then
    INI_ARGS+=("AdminPassword=\"$ADMIN_PASSWORD\"")
else
    ADMIN_PASSWORD="(inchangé — voir $INI)"
fi
python3 "$PANEL_DIR/palworld_config.py" "$INI" set "${INI_ARGS[@]}"
chown palworld:palworld "$INI"

# ------------------------------------------------------ 6. configuration du panel
install -d "$ETC_DIR"
log "Écriture de la configuration du panel…"
PANEL_HASH=$(python3 -c "import sys; from werkzeug.security import generate_password_hash; print(generate_password_hash(sys.argv[1]))" "$PANEL_PASSWORD")
SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))')

PANEL_HASH="$PANEL_HASH" SECRET_KEY="$SECRET_KEY" PANEL_PORT="$PANEL_PORT" \
SERVER_DIR="$SERVER_DIR" BACKUP_DIR="$BACKUP_DIR" SCRIPTS_DIR="$SCRIPTS_DIR" \
python3 - <<'PYEOF'
import json, os
config = {
    "panel_password_hash": os.environ["PANEL_HASH"],
    "secret_key": os.environ["SECRET_KEY"],
    "panel_port": int(os.environ["PANEL_PORT"]),
    "bind": "0.0.0.0",
    "service_name": "palworld",
    "server_dir": os.environ["SERVER_DIR"],
    "backup_dir": os.environ["BACKUP_DIR"],
    "scripts_dir": os.environ["SCRIPTS_DIR"],
    "api_url": "http://127.0.0.1:8212",
}
with open("/etc/palworld-panel/config.json", "w") as handle:
    json.dump(config, handle, indent=2)
PYEOF
chown root:palworld "$ETC_DIR/config.json"
chmod 640 "$ETC_DIR/config.json"

# ------------------------------------------------------------- 7. services systemd
log "Installation des services systemd…"
sed "s/@GAME_PORT@/$GAME_PORT/" "$REPO_DIR/systemd/palworld.service" > /etc/systemd/system/palworld.service
cp "$REPO_DIR/systemd/palworld-panel.service" /etc/systemd/system/palworld-panel.service

# Droits sudo limités : le panel ne peut piloter QUE le service palworld
cat > /etc/sudoers.d/palworld-panel <<'EOF'
palworld ALL=(root) NOPASSWD: /usr/bin/systemctl start palworld.service, /usr/bin/systemctl stop palworld.service, /usr/bin/systemctl restart palworld.service
EOF
chmod 440 /etc/sudoers.d/palworld-panel

# Accès aux logs journald pour la console du panel
usermod -aG systemd-journal palworld

systemctl daemon-reload
systemctl enable --now palworld.service palworld-panel.service

# ------------------------------------------------------------------- 8. pare-feu
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    log "Ouverture des ports dans UFW…"
    ufw allow "$GAME_PORT/udp"  comment "Palworld jeu"
    ufw allow "$PANEL_PORT/tcp" comment "Palworld panel"
fi

# -------------------------------------------------------------------- 9. résumé
IP=$(hostname -I | awk '{print $1}')
cat <<EOF

============================================================
  Installation terminée !
------------------------------------------------------------
  Panel web           : http://$IP:$PANEL_PORT
  Mot de passe panel  : $PANEL_PASSWORD

  Serveur de jeu      : $IP:$GAME_PORT (UDP)
  Mot de passe admin  : $ADMIN_PASSWORD
  (API REST + RCON — modifiable dans l'onglet Configuration)

  Dossier serveur     : $SERVER_DIR
  Sauvegardes         : $BACKUP_DIR
  Services            : systemctl status palworld / palworld-panel
------------------------------------------------------------
  NOTEZ CES MOTS DE PASSE : ils ne seront plus réaffichés.
============================================================
EOF

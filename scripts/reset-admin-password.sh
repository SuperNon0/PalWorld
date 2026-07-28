#!/usr/bin/env bash
# Réinitialise le mot de passe du compte « admin » du panel Palworld.
#
# À lancer SUR LA VM (console Proxmox ou SSH) quand le mot de passe est oublié
# et qu'on ne peut plus se connecter au panel. Écrit un nouveau hash dans le
# fichier des comptes, puis aligne le propriétaire du fichier sur celui du
# dossier (l'utilisateur « palworld » qui fait tourner le panel).
#
# Usage :
#   sudo bash reset-admin-password.sh                 # demande le mot de passe
#   sudo bash reset-admin-password.sh 'MonNouveauMDP' # mot de passe en argument
set -euo pipefail

CONFIG="${PANEL_CONFIG:-/etc/palworld-panel/config.json}"

# Emplacement du fichier des comptes (lu depuis la config, défaut /opt/palworld/…).
USERS_FILE="$(python3 - "$CONFIG" <<'PY' 2>/dev/null || true
import json, os, sys
try:
    cfg = json.load(open(sys.argv[1]))
except OSError:
    cfg = {}
state = cfg.get("state_file", "/opt/palworld/panel-state.json")
print(cfg.get("users_file", os.path.join(os.path.dirname(state), "panel-users.json")))
PY
)"
USERS_FILE="${USERS_FILE:-/opt/palworld/panel-users.json}"

# Mot de passe : argument, sinon saisie masquée.
PASSWORD="${1:-}"
if [ -z "$PASSWORD" ]; then
    read -rsp "Nouveau mot de passe du panel (8 caractères min.) : " PASSWORD
    echo
fi
if [ "${#PASSWORD}" -lt 8 ]; then
    echo "Erreur : le mot de passe doit faire au moins 8 caractères." >&2
    exit 1
fi

python3 - "$USERS_FILE" "$PASSWORD" <<'PY'
import json, sys
from werkzeug.security import generate_password_hash
path, password = sys.argv[1], sys.argv[2]
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"admin": generate_password_hash(password)}, handle, indent=2)
print("Fichier des comptes réécrit :", path)
PY

# Le panel tourne en tant que « palworld » : il doit pouvoir réécrire ce fichier.
chown --reference="$(dirname "$USERS_FILE")" "$USERS_FILE" 2>/dev/null || true
chmod 600 "$USERS_FILE" 2>/dev/null || true

echo "✅ Mot de passe du compte « admin » réinitialisé. Reconnecte-toi sur le panel."

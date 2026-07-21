#!/usr/bin/env bash
#
# ============================================================================
#  Tunnel playit.gg pour Palworld — accès sans ouvrir de port
#
#  L'agent playit.gg tourne sur cette VM et se connecte EN SORTIE au réseau
#  playit.gg. Ce réseau reçoit les joueurs et relaie leur trafic UDP vers le
#  serveur Palworld local. Résultat : aucun port à ouvrir sur ta box.
#
#  Prérequis : un compte GRATUIT sur https://playit.gg
#
#  Usage :
#      sudo ./tunnel-playit.sh
#      sudo GAME_PORT=8211 ./tunnel-playit.sh   # si port de jeu personnalisé
#
#  Le script est réexécutable sans risque (idempotent).
# ============================================================================
set -euo pipefail

GAME_PORT="${GAME_PORT:-8211}"

log()  { echo -e "\033[1;36m[playit]\033[0m $*"; }
warn() { echo -e "\033[1;33m[playit]\033[0m $*"; }
fail() { echo -e "\033[1;31m[erreur]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Ce script doit être lancé en root : sudo ./tunnel-playit.sh"
command -v apt-get >/dev/null || fail "apt-get introuvable : ce script cible Ubuntu/Debian."

# Outils nécessaires
command -v curl >/dev/null && command -v gpg >/dev/null || {
    log "Installation de curl et gnupg…"
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl gnupg
}

# -------------------------------------------------- 1. installation de l'agent
install_via_apt() {
    log "Ajout du dépôt apt officiel playit.gg (packages.playit.gg)…"
    # Méthode officielle actuelle (cf. playit.gg → Agents → Download for Linux).
    curl -SsL https://packages.playit.gg/keys/playit.gpg \
        | gpg --dearmor | tee /usr/share/keyrings/playit.gpg >/dev/null
    chmod 0644 /usr/share/keyrings/playit.gpg
    curl -fsSL -o /etc/apt/sources.list.d/playit.list \
        https://packages.playit.gg/repo-files/playit-debian.list
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y playit
}

install_via_binary() {
    local arch bin_arch
    arch=$(uname -m)
    case "$arch" in
        x86_64)  bin_arch=amd64 ;;
        aarch64) bin_arch=aarch64 ;;
        armv7l)  bin_arch=armv7 ;;
        *) fail "Architecture non gérée pour le binaire : $arch" ;;
    esac
    log "Dépôt apt indisponible — téléchargement du binaire playit ($bin_arch)…"
    curl -SsL -o /usr/local/bin/playit \
        "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-$bin_arch"
    chmod +x /usr/local/bin/playit

    id playit >/dev/null 2>&1 || useradd --system --create-home \
        --home-dir /var/lib/playit --shell /usr/sbin/nologin playit
    install -d -o playit -g playit /etc/playit

    cat > /etc/systemd/system/playit.service <<'EOF'
[Unit]
Description=Agent tunnel playit.gg
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=playit
Group=playit
ExecStart=/usr/local/bin/playit --secret_path /etc/playit/playit.toml
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable playit.service
}

if install_via_apt; then
    log "Agent playit installé via apt."
else
    warn "Installation apt échouée, bascule sur le binaire GitHub."
    install_via_binary
fi

# ---------------------------------------------------- 2. démarrage du service
systemctl enable playit.service >/dev/null 2>&1 || true
systemctl restart playit.service

# ------------------------------------------- 3. récupération du lien d'association
log "Démarrage de l'agent, récupération du lien d'association…"
CLAIM_URL=""
for _ in $(seq 1 10); do
    CLAIM_URL=$(journalctl -u playit.service -n 80 --no-pager 2>/dev/null \
        | grep -oE 'https://playit\.gg/(claim|setup|mc-tunnel)/[A-Za-z0-9]+' \
        | tail -n1 || true)
    [[ -n $CLAIM_URL ]] && break
    sleep 2
done

# ------------------------------------------------------------------- 4. résumé
cat <<EOF

============================================================
  Agent playit.gg installé et démarré !
------------------------------------------------------------
  À FAIRE MANUELLEMENT (dans ton navigateur) :

  1. Crée un compte gratuit sur  https://playit.gg
     (si ce n'est pas déjà fait)

  2. Associe cette VM à ton compte en ouvrant ce lien :
EOF
if [[ -n $CLAIM_URL ]]; then
    echo "         $CLAIM_URL"
else
    echo "         (lien pas encore visible dans les logs)"
    echo "         Lance :  journalctl -u playit -f"
    echo "         puis copie l'URL https://playit.gg/... affichée."
fi
cat <<EOF

  3. Dans le tableau de bord playit.gg, crée un tunnel :
       - Type       : Palworld  (ou « UDP » si Palworld absent)
       - Port local : $GAME_PORT
       - Adresse    : 127.0.0.1
     playit.gg te donne alors une adresse du type
       quelquechose.playit.gg:PORT

  4. Donne cette adresse à tes joueurs. Dans Palworld :
       Multijoueur (dédié) > Rejoindre par IP > colle l'adresse.
     Aucun port à ouvrir sur ta box !
------------------------------------------------------------
  État du tunnel :  systemctl status playit
  Logs en direct :  journalctl -u playit -f
============================================================
EOF

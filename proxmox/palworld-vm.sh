#!/usr/bin/env bash
#
# ============================================================================
#  Palworld — déploiement automatique d'une VM sur Proxmox VE
#
#  À COLLER DANS LE SHELL DE L'HÔTE PROXMOX (pas dans une VM).
#  Le script crée une VM Ubuntu 24.04, la configure via cloud-init, puis
#  installe automatiquement au premier démarrage le serveur Palworld + le
#  panel web (via install.sh du dépôt).
#
#  Usage (shell Proxmox) :
#      bash -c "$(wget -qLO - https://raw.githubusercontent.com/SuperNon0/PalWorld/BRANCHE/proxmox/palworld-vm.sh)"
#
#  Personnalisation (variables d'environnement, toutes optionnelles) :
#      VMID=210 CORES=6 RAM=32768 DISK=60 STORAGE=local-lvm BRIDGE=vmbr0 \
#      HOSTNAME=palworld MAX_PLAYERS=32 bash palworld-vm.sh
#
#  Accès SSH par clé (recommandé) — sinon la clé de l'hôte Proxmox est reprise :
#      SSH_KEY="ssh-ed25519 AAAA... toi@pc" bash palworld-vm.sh
#      SSH_KEY_FILE=/root/.ssh/id_ed25519.pub bash palworld-vm.sh
#
#  Inspiré des scripts community-scripts.org (Proxmox VE Helper-Scripts).
# ============================================================================
set -euo pipefail

# ------------------------------------------------------------------ paramètres
VMID="${VMID:-}"                       # vide = prochain ID libre
HOSTNAME="${HOSTNAME:-palworld}"
CORES="${CORES:-4}"
RAM="${RAM:-16384}"                    # Mo — Palworld est gourmand en RAM
DISK="${DISK:-40}"                     # Go
STORAGE="${STORAGE:-local-lvm}"        # stockage des disques VM
SNIPPET_STORAGE="${SNIPPET_STORAGE:-local}"   # stockage acceptant les snippets
BRIDGE="${BRIDGE:-vmbr0}"
MAX_PLAYERS="${MAX_PLAYERS:-32}"
GAME_PORT="${GAME_PORT:-8211}"         # port UDP du serveur de jeu
PANEL_PORT="${PANEL_PORT:-8080}"       # port HTTP du panel (le « site »)

# Dépôt à installer. Tant que la branche n'est pas fusionnée dans main,
# on clone la branche de travail pour que l'installation fonctionne.
PW_REPO="${PW_REPO:-https://github.com/SuperNon0/PalWorld.git}"
PW_BRANCH="${PW_BRANCH:-claude/palworld-install-script-panel-b41cfo}"

UBUNTU_URL="https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img"
IMAGE_CACHE="/var/lib/vz/template/iso/ubuntu-24.04-palworld-cloudimg.img"

# --------------------------------------------------------------------- couleurs
YW=$'\033[33m'; GN=$'\033[1;92m'; RD=$'\033[01;31m'; BL=$'\033[36m'; CL=$'\033[m'
msg_info()  { echo -e " ${YW}➤${CL} $1"; }
msg_ok()    { echo -e " ${GN}✓${CL} $1"; }
msg_error() { echo -e " ${RD}✗${CL} $1"; }
header() {
    echo -e "${BL}"
    echo "   ____       _                    _     _ "
    echo "  |  _ \ __ _| |_ __      _____  _ | | __| |"
    echo "  | |_) / _\` | \\ \\ /\\ / / _ \\| '_| |/ _\` |"
    echo "  |  __/ (_| | |\\ V  V / (_) | | | | | (_| |"
    echo "  |_|   \\__,_|_| \\_/\\_/ \\___/|_| |_|_|\\__,_|"
    echo -e "        VM Proxmox + serveur + panel${CL}\n"
}

# Récupère l'IPv4 LAN de la VM via l'agent invité (vide si pas encore prêt).
get_vm_ip() {
    qm guest cmd "$VMID" network-get-interfaces 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for iface in data:
    if iface.get("name") == "lo":
        continue
    for ip in iface.get("ip-addresses", []):
        addr = ip.get("ip-address", "")
        if ip.get("ip-address-type") == "ipv4" and not addr.startswith("127."):
            print(addr); sys.exit(0)
sys.exit(1)
'
}

# ------------------------------------------------------------------- contrôles
header
[[ $EUID -eq 0 ]] || { msg_error "Lance ce script en root, dans le shell de l'hôte Proxmox."; exit 1; }
command -v qm  >/dev/null || { msg_error "Commande 'qm' introuvable : ce script tourne sur l'HÔTE Proxmox, pas dans une VM."; exit 1; }
command -v pvesm >/dev/null || { msg_error "Outils Proxmox introuvables (pvesm)."; exit 1; }

# ------------------------------------------------ réglages (défaut ou avancé)
if command -v whiptail >/dev/null && [[ -t 0 ]]; then
    if whiptail --title "Palworld VM" --yesno \
        "Créer la VM avec les réglages par défaut ?\n\n  Cœurs : $CORES\n  RAM   : $RAM Mo\n  Disque: $DISK Go\n  Stock.: $STORAGE\n  Pont  : $BRIDGE\n\nChoisir « Non » pour personnaliser." 18 60; then
        :
    else
        HOSTNAME=$(whiptail --inputbox "Nom de la VM"        8 50 "$HOSTNAME" --title "Réglages" 3>&1 1>&2 2>&3)
        CORES=$(whiptail    --inputbox "Nombre de cœurs"     8 50 "$CORES"    --title "Réglages" 3>&1 1>&2 2>&3)
        RAM=$(whiptail      --inputbox "RAM (Mo)"            8 50 "$RAM"      --title "Réglages" 3>&1 1>&2 2>&3)
        DISK=$(whiptail     --inputbox "Disque (Go)"        8 50 "$DISK"     --title "Réglages" 3>&1 1>&2 2>&3)
        STORAGE=$(whiptail  --inputbox "Stockage des disques" 8 50 "$STORAGE" --title "Réglages" 3>&1 1>&2 2>&3)
        BRIDGE=$(whiptail   --inputbox "Pont réseau"         8 50 "$BRIDGE"   --title "Réglages" 3>&1 1>&2 2>&3)
    fi
fi

[[ -n $VMID ]] || VMID=$(pvesh get /cluster/nextid)
msg_ok "VM ID choisi : $VMID"

if qm status "$VMID" >/dev/null 2>&1; then
    msg_error "Le VM ID $VMID existe déjà. Relance avec VMID=<autre>."
    exit 1
fi

# Mots de passe générés (affichés à la fin)
gen_pw() { openssl rand -hex 8 2>/dev/null || tr -dc 'a-f0-9' </dev/urandom | head -c16; }
VM_PASSWORD=$(gen_pw)
PANEL_PASSWORD=$(gen_pw)
ADMIN_PASSWORD=$(gen_pw)

# --------------------------------------------------- image cloud Ubuntu (cache)
if [[ ! -f $IMAGE_CACHE ]]; then
    msg_info "Téléchargement de l'image cloud Ubuntu 24.04…"
    wget -qO "$IMAGE_CACHE" "$UBUNTU_URL" || { msg_error "Téléchargement de l'image échoué."; exit 1; }
    msg_ok "Image téléchargée."
else
    msg_ok "Image Ubuntu déjà en cache."
fi

# ------------------------------------------ snippet cloud-init (install auto)
SNIPPET_DIR="/var/lib/vz/snippets"
[[ $SNIPPET_STORAGE != local ]] && SNIPPET_DIR=$(pvesm path "${SNIPPET_STORAGE}:snippets" 2>/dev/null || echo "$SNIPPET_DIR")
mkdir -p "$SNIPPET_DIR"

# S'assure que le stockage accepte les snippets
if ! pvesm status -content snippets 2>/dev/null | grep -qw "$SNIPPET_STORAGE"; then
    msg_info "Activation du type de contenu « snippets » sur le stockage $SNIPPET_STORAGE…"
    CURRENT=$(grep -A6 "^dir: $SNIPPET_STORAGE\|^.*: $SNIPPET_STORAGE" /etc/pve/storage.cfg 2>/dev/null | grep -m1 content | sed 's/.*content //' || true)
    pvesm set "$SNIPPET_STORAGE" --content "${CURRENT:+$CURRENT,}snippets" 2>/dev/null \
        || msg_error "Impossible d'activer les snippets automatiquement — active « Snippets » sur le stockage $SNIPPET_STORAGE dans l'interface Proxmox si l'étape cloud-init échoue."
fi

# Clé SSH (optionnelle) : accès sans mot de passe pour l'utilisateur ubuntu.
# Priorité : $SSH_KEY (collée), puis $SSH_KEY_FILE, puis les clés déjà
# autorisées sur l'hôte Proxmox (/root/.ssh/authorized_keys) — pratique si tu
# accèdes déjà à Proxmox par clé, la VM la réutilise automatiquement.
SSH_KEY="${SSH_KEY:-}"
if [[ -z $SSH_KEY && -n ${SSH_KEY_FILE:-} && -f ${SSH_KEY_FILE:-} ]]; then
    SSH_KEY=$(cat "$SSH_KEY_FILE")
fi
if [[ -z $SSH_KEY && -f /root/.ssh/authorized_keys ]]; then
    SSH_KEY=$(grep -m1 -E '^(ssh-|ecdsa-|sk-)' /root/.ssh/authorized_keys || true)
    [[ -n $SSH_KEY ]] && msg_ok "Clé SSH reprise depuis /root/.ssh/authorized_keys de l'hôte."
fi
SSH_KEY_YAML=""
if [[ -n $SSH_KEY ]]; then
    SSH_KEY_YAML=$'\n    ssh_authorized_keys:\n      - '"$SSH_KEY"
    msg_ok "Accès SSH par clé activé pour l'utilisateur ubuntu."
fi

SNIPPET_FILE="$SNIPPET_DIR/palworld-vm-$VMID.yaml"
msg_info "Écriture de la configuration cloud-init (installation au 1er démarrage)…"
cat > "$SNIPPET_FILE" <<EOF
#cloud-config
hostname: $HOSTNAME
manage_etc_hosts: true
timezone: Europe/Paris
users:
  - name: ubuntu
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false${SSH_KEY_YAML}
password: $VM_PASSWORD
chpasswd:
  expire: false
ssh_pwauth: true
package_update: true
packages:
  - git
  - qemu-guest-agent
runcmd:
  - export DEBIAN_FRONTEND=noninteractive
  - systemctl enable --now qemu-guest-agent || true
  - git clone --branch $PW_BRANCH $PW_REPO /opt/palworld-src
  - bash /opt/palworld-src/install.sh --panel-password '$PANEL_PASSWORD' --admin-password '$ADMIN_PASSWORD' --max-players $MAX_PLAYERS --game-port $GAME_PORT --panel-port $PANEL_PORT
EOF
chmod 600 "$SNIPPET_FILE"
msg_ok "cloud-init prêt."

# ---------------------------------------------------------- création de la VM
msg_info "Création de la VM $VMID ($HOSTNAME)…"
qm create "$VMID" \
    --name "$HOSTNAME" \
    --cores "$CORES" --cpu host --memory "$RAM" \
    --net0 "virtio,bridge=$BRIDGE" \
    --scsihw virtio-scsi-pci \
    --ostype l26 \
    --agent enabled=1

msg_info "Import du disque…"
qm importdisk "$VMID" "$IMAGE_CACHE" "$STORAGE" >/dev/null
qm set "$VMID" --scsi0 "$STORAGE:vm-$VMID-disk-0" >/dev/null
qm set "$VMID" --ide2 "$STORAGE:cloudinit" >/dev/null
qm set "$VMID" --boot order=scsi0 >/dev/null
qm set "$VMID" --serial0 socket --vga serial0 >/dev/null   # requis par les images cloud
qm disk resize "$VMID" scsi0 "${DISK}G" >/dev/null
qm set "$VMID" --ipconfig0 ip=dhcp >/dev/null
qm set "$VMID" --cicustom "user=${SNIPPET_STORAGE}:snippets/palworld-vm-$VMID.yaml" >/dev/null
qm set "$VMID" --tags "palworld" >/dev/null 2>&1 || true
msg_ok "VM créée et configurée."

msg_info "Démarrage de la VM…"
qm start "$VMID"
msg_ok "VM démarrée."

# Identifiants affichés tout de suite (au cas où tu interromps l'attente)
cat <<EOF

  ${YW}Identifiants (note-les) :${CL}
    Panel (le site) — mot de passe : ${BL}$PANEL_PASSWORD${CL}
    Admin du jeu    — identifiant : ${BL}admin${CL} · mot de passe : ${BL}$ADMIN_PASSWORD${CL}
EOF

# ----------------------------------------- attente de la fin de l'installation
msg_info "Installation en cours dans la VM (SteamCMD ~8 Go, ~10 à 20 min)…"
msg_info "Tu peux quitter avec Ctrl+C sans risque : l'installation continue dans la VM."
IP=""
PANEL_READY=0
DEADLINE=$((SECONDS + 1800))   # 30 min max d'attente
while [[ $SECONDS -lt $DEADLINE ]]; do
    if [[ -z $IP ]]; then
        IP=$(get_vm_ip || true)
        [[ -n $IP ]] && msg_ok "IP de la VM détectée : $IP"
    fi
    if [[ -n $IP ]] && curl -sf -o /dev/null --max-time 3 "http://$IP:$PANEL_PORT/login"; then
        PANEL_READY=1
        break
    fi
    printf "."
    sleep 15
done
echo

# -------------------------------------------------------------------- résumé
if [[ $PANEL_READY -eq 1 ]]; then
    cat <<EOF

${GN}============================================================${CL}
  ${GN}Ton serveur Palworld est prêt !${CL}
------------------------------------------------------------
  🌐 Panel (le site) : ${BL}http://$IP:$PANEL_PORT${CL}
        mot de passe : ${BL}$PANEL_PASSWORD${CL}

  🎮 Admin du jeu    : identifiant ${BL}admin${CL} · mot de passe ${BL}$ADMIN_PASSWORD${CL}
  🎮 Adresse serveur (LAN) : ${BL}$IP:$GAME_PORT${CL}

  Accès des joueurs sans ouvrir de port : onglet « Accès / Tunnel »
  du panel, ou   sudo /opt/palworld-src/scripts/tunnel-playit.sh
------------------------------------------------------------
  VM $VMID · $CORES cœurs · $RAM Mo · $DISK Go
  Accès système (secours only) : ubuntu / ${BL}$VM_PASSWORD${CL} (console Proxmox)
${GN}============================================================${CL}
EOF
else
    cat <<EOF

${YW}============================================================${CL}
  Installation encore en cours après 30 min (gros téléchargement).
  Elle se termine toute seule dans la VM.
------------------------------------------------------------
  ${IP:+Panel bientôt disponible : ${BL}http://$IP:$PANEL_PORT${CL}}
  ${IP:-IP pas encore détectée — vérifie l'onglet Résumé de la VM $VMID dans Proxmox.}

  Suivre la fin de l'installation :
      qm terminal $VMID   (Entrée, login ubuntu, puis :)
      sudo tail -f /var/log/cloud-init-output.log

  Identifiants — panel : ${BL}$PANEL_PASSWORD${CL} · admin : ${BL}admin / $ADMIN_PASSWORD${CL}
${YW}============================================================${CL}
EOF
fi

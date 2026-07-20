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
    lock_passwd: false
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
  - bash /opt/palworld-src/install.sh --panel-password '$PANEL_PASSWORD' --admin-password '$ADMIN_PASSWORD' --max-players $MAX_PLAYERS
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
msg_ok "VM démarrée — l'installation de Palworld se lance automatiquement (5 à 15 min)."

# -------------------------------------------------------------------- résumé
cat <<EOF

${GN}============================================================${CL}
  VM Palworld déployée sur Proxmox !
------------------------------------------------------------
  VM ID / nom     : $VMID / $HOSTNAME
  Ressources      : $CORES cœurs · $RAM Mo RAM · $DISK Go

  Accès SSH VM    : utilisateur ${BL}ubuntu${CL} / mot de passe ${BL}$VM_PASSWORD${CL}
  Mot de passe panel : ${BL}$PANEL_PASSWORD${CL}
  Mot de passe admin : ${BL}$ADMIN_PASSWORD${CL}
  ${YW}Note ces mots de passe : ils ne seront plus réaffichés.${CL}

  L'installation tourne au premier démarrage (SteamCMD télécharge
  ~8 Go). Patiente quelques minutes.

  Trouver l'IP de la VM — deux méthodes :
    1) Agent invité (dispo après ~2 min, une fois installé par cloud-init) :
         qm guest cmd $VMID network-get-interfaces
    2) Console série (tout de suite) :
         qm terminal $VMID        (Entrée, login ubuntu, puis : ip a)
         (quitter la console série : Ctrl+O)
  Puis : panel sur  http://IP_DE_LA_VM:8080

  Suivre l'installation (console série, puis) :
      tail -f /var/log/cloud-init-output.log
  → « Installation terminée ! » = panel prêt.
------------------------------------------------------------
  Ensuite, pour l'accès des joueurs sans ouvrir de port :
  dans la VM, lance  sudo /opt/palworld-src/scripts/tunnel-playit.sh
${GN}============================================================${CL}
EOF

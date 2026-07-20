# 🐑 Palworld Server + Panel Web

Installation **entièrement automatique** d'un serveur dédié Palworld avec un
panel web d'administration, pour une machine **Ubuntu Server 22.04 / 24.04**
(typiquement une VM sur un cluster **Proxmox**).

## Fonctionnalités

**Serveur**
- Installation automatique via SteamCMD (app `2394010`)
- Service systemd `palworld` : démarrage au boot, redémarrage automatique en cas de crash
- API REST officielle de Palworld activée (pilotage local du serveur)
- Sauvegarde du monde forcée avant chaque arrêt/redémarrage

**Panel web** (service systemd `palworld-panel`)
- 🔐 Connexion par mot de passe (modifiable depuis le panel)
- ▶ Démarrer / ■ Arrêter / ⟳ Redémarrer le serveur, plus **arrêt différé**
  avec compte à rebours annoncé aux joueurs
- 🖥 Console : logs du serveur en temps réel (journald)
- 📊 **Graphiques 24 h** : joueurs connectés, FPS serveur, RAM (avec infobulle)
- ⚙ Édition complète de `PalWorldSettings.ini` depuis le navigateur
- 👥 Joueurs connectés : niveau, ping, kick/ban avec raison personnalisée,
  déban par identifiant
- 📢 Annonces en jeu
- ⬆ Mise à jour du serveur en un clic (SteamCMD), avec sauvegarde de
  sécurité du monde avant chaque mise à jour
- 📦 Sauvegardes du monde : création, **restauration**, suppression,
  téléchargement, rotation automatique
- ⏱ **Sauvegardes automatiques** planifiées (intervalle et rétention réglables)
- 🔄 **Redémarrage quotidien programmable** avec préavis aux joueurs en jeu
  (5 min et 1 min avant)
- 📈 RAM et disque de la machine sur le tableau de bord

## Prérequis (VM Proxmox recommandée)

| Ressource | Minimum | Recommandé |
|-----------|---------|------------|
| CPU       | 4 vCPU  | 6+ vCPU |
| RAM       | 16 Go   | 32 Go (Palworld consomme beaucoup de RAM) |
| Disque    | 40 Go   | 60 Go |
| OS        | Ubuntu Server 22.04 | Ubuntu Server 24.04 |

> ⚠️ Utilisez une **VM** Proxmox, pas un conteneur LXC : SteamCMD et le
> serveur Palworld fonctionnent mal en LXC non privilégié.

## Installation

Sur la VM Ubuntu fraîchement créée :

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/SuperNon0/PalWorld.git
cd PalWorld
sudo ./install.sh
```

À la fin, le script affiche :
- l'URL du panel (`http://IP_DE_LA_VM:8080`) et son mot de passe ;
- le mot de passe admin du serveur (API REST / RCON).

**Notez ces mots de passe**, ils ne seront plus réaffichés.

### Options du script

```bash
sudo ./install.sh \
  --game-port 8211 \          # port UDP du jeu
  --panel-port 8080 \         # port HTTP du panel
  --panel-password monMdp \   # sinon généré aléatoirement
  --admin-password monMdp \   # sinon généré aléatoirement
  --max-players 32
```

Le script est réexécutable sans risque : il met à jour le serveur et le panel
sans toucher au monde sauvegardé, et conserve le mot de passe admin existant
(sauf si `--admin-password` est fourni).

## Ports à ouvrir / rediriger

| Port  | Protocole | Usage | Exposition |
|-------|-----------|-------|------------|
| 8211  | UDP | Serveur de jeu | Internet (redirection box/routeur) |
| 8080  | TCP | Panel web | **LAN uniquement** (ou derrière un reverse proxy HTTPS) |
| 8212  | TCP | API REST Palworld | localhost (utilisée par le panel) |
| 25575 | TCP | RCON (optionnel) | localhost |

## Exploitation courante

```bash
# état des services
systemctl status palworld
systemctl status palworld-panel

# logs en direct (aussi disponibles dans l'onglet Console du panel)
journalctl -u palworld -f

# mise à jour manuelle du serveur
sudo -u palworld /opt/palworld/scripts/update.sh

# sauvegarde manuelle du monde
sudo -u palworld /opt/palworld/scripts/backup.sh
```

### Sauvegardes automatiques et redémarrage quotidien

Tout se règle depuis le bloc **Automatisation** du tableau de bord du panel :
- sauvegarde automatique du monde à intervalle régulier (1 à 168 h) avec
  rétention configurable ;
- redémarrage quotidien du serveur à heure fixe (conseillé : Palworld a des
  fuites mémoire connues), avec annonces en jeu 5 min et 1 min avant.

La restauration d'une sauvegarde se fait depuis l'onglet **Sauvegardes** :
le serveur est arrêté, le monde actuel est archivé en sécurité, puis remplacé
par la sauvegarde choisie, et le serveur redémarre.

## Arborescence installée

```
/opt/palworld/
├── server/            # serveur Palworld (SteamCMD)
├── panel/             # panel web Flask
├── scripts/           # update.sh, backup.sh, restore.sh
├── backups/           # archives du monde (tar.gz)
└── panel-state.json   # état de l'automatisation (créé par le panel)
/etc/palworld-panel/config.json   # config du panel (hash du mot de passe…)
/etc/systemd/system/palworld.service
/etc/systemd/system/palworld-panel.service
```

## Sécurité

- Le panel tourne sous l'utilisateur système `palworld`, sans privilèges, avec
  des droits `sudo` limités aux seules commandes `systemctl start/stop/restart palworld`.
- Le mot de passe du panel est stocké **hashé** dans
  `/etc/palworld-panel/config.json` et se change depuis l'onglet
  Configuration du panel (section « Mot de passe du panel »).
- N'exposez pas le port du panel directement sur Internet : gardez-le en LAN
  ou placez-le derrière un reverse proxy HTTPS (Nginx Proxy Manager, Caddy…).

## Design

Le panel suit la charte graphique du projet : fond quasi noir, texte
monospace (DM Mono), titres serif dorés (DM Serif Display), accents
or / teal / orange. Les polices sont **embarquées** dans
`panel/static/fonts.css` : aucune connexion Internet n'est nécessaire.

Tout le thème est défini par les variables CSS en tête de
[`panel/static/style.css`](panel/static/style.css) (couleurs, polices,
rayons) : modifier ce bloc `:root` suffit pour ajuster la charte.

## Développement

Voir [DEVELOPMENT.md](DEVELOPMENT.md) pour l'architecture, le lancement du
panel en local et le workflow GitHub.

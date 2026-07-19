# Guide de développement

Ce document décrit l'architecture du projet et comment développer / tester
chaque composant.

## Architecture

```
┌──────────────────────────── VM Ubuntu (Proxmox) ────────────────────────────┐
│                                                                             │
│  Navigateur ──HTTP:8080──► panel Flask (palworld-panel.service)             │
│                               │        │           │                        │
│                               │        │           └── journalctl -f  (console)
│                               │        └── sudo systemctl start/stop/restart
│                               │                                             │
│                               └──HTTP:8212──► API REST Palworld             │
│                                                (infos, joueurs, save,       │
│                                                 annonces, kick/ban)         │
│                                                                             │
│  PalServer.sh (palworld.service) ◄── SteamCMD (install / update)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Fichier | Rôle |
|---------|------|
| `install.sh` | Installation complète sur Ubuntu (paquets, SteamCMD, serveur, panel, systemd, sudoers, UFW) |
| `panel/app.py` | Application Flask : authentification, API du panel, flux SSE de la console |
| `panel/palworld_api.py` | Client de l'API REST officielle de Palworld (port 8212) |
| `panel/palworld_config.py` | Parseur/écrivain de `PalWorldSettings.ini` (format `OptionSettings=(...)`) — utilisable en CLI |
| `panel/templates/`, `panel/static/` | Interface web (vanilla JS, thème via variables CSS) |
| `scripts/update.sh` | Arrêt → mise à jour SteamCMD → redémarrage |
| `scripts/backup.sh` | Archive `Pal/Saved` + rotation |
| `systemd/*.service` | Unités systemd (le port jeu est injecté par `install.sh` via `@GAME_PORT@`) |

Choix techniques :
- **Python 3 + Flask** installés via `apt` (`python3-flask`) : aucune
  dépendance pip, aucune étape de build.
- Le panel parle au serveur via **l'API REST officielle** de Palworld
  (`RESTAPIEnabled=True`), plus fiable que le RCON du jeu.
- La console est un flux **SSE** alimenté par `journalctl -f`.
- Sécurité : utilisateur système dédié, sudoers limité à 3 commandes
  `systemctl`, mot de passe du panel hashé (werkzeug).

## Développer le panel en local (sans serveur Palworld)

```bash
sudo apt install -y python3-flask        # ou : pip install flask

# 1. Arborescence factice + config du jeu d'exemple
mkdir -p /tmp/palworld-dev/server/Pal/Saved/Config/LinuxServer /tmp/palworld-dev/backups
cp docs/PalWorldSettings.exemple.ini \
   /tmp/palworld-dev/server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini

# 2. Config du panel de dev (mot de passe : dev)
python3 - <<'EOF'
import json
from werkzeug.security import generate_password_hash
json.dump({
    "panel_password_hash": generate_password_hash("dev"),
    "secret_key": "dev-secret",
    "panel_port": 8080,
    "bind": "127.0.0.1",
    "service_name": "palworld",
    "server_dir": "/tmp/palworld-dev/server",
    "backup_dir": "/tmp/palworld-dev/backups",
    "scripts_dir": "/tmp/palworld-dev/scripts",
    "api_url": "http://127.0.0.1:8212",
}, open("/tmp/palworld-dev/config.json", "w"), indent=2)
EOF

# 3. Lancement
cd panel
PANEL_CONFIG=/tmp/palworld-dev/config.json python3 app.py
```

Puis ouvrir <http://127.0.0.1:8080> (mot de passe `dev`). Sans serveur
Palworld, le statut restera « Hors ligne » mais les onglets Configuration et
Sauvegardes sont pleinement testables.

Tester le parseur de configuration seul :

```bash
python3 panel/palworld_config.py docs/PalWorldSettings.exemple.ini get
python3 panel/palworld_config.py /tmp/test.ini set 'ServerName="Mon serveur"' ExpRate=2.0
```

## Tester l'installation complète

L'idéal est une VM Ubuntu jetable sur le cluster Proxmox :

1. Créer une VM Ubuntu Server 24.04 (4 vCPU / 16 Go RAM / 40 Go) — ou cloner
   un template cloud-init.
2. Prendre un **snapshot** juste après l'installation de l'OS.
3. `git clone` de votre branche, puis `sudo ./install.sh`.
4. Vérifier : `systemctl status palworld palworld-panel`, puis le panel sur
   le port 8080.
5. Restaurer le snapshot pour retester de zéro.

Vérifications rapides sans VM :

```bash
bash -n install.sh scripts/*.sh                 # syntaxe shell
python3 -m py_compile panel/*.py                # syntaxe python
```

## Workflow GitHub

1. Créer une branche depuis `main` : `git checkout -b feat/ma-fonctionnalite`
2. Commits en français, à l'impératif : `Ajoute la rotation des sauvegardes`
3. Pousser : `git push -u origin feat/ma-fonctionnalite`
4. Ouvrir une Pull Request vers `main` et décrire le test effectué
   (VM de test, panel en local…)

## Pistes d'évolution

- [ ] Planification de redémarrages automatiques depuis le panel
- [ ] Restauration d'une sauvegarde depuis le panel
- [ ] Graphiques (FPS, joueurs, RAM) à partir de `/v1/api/metrics`
- [ ] Whitelist / liste des bannis
- [ ] Support multi-serveurs (plusieurs instances Palworld sur la même VM)
- [ ] HTTPS natif ou intégration reverse proxy documentée

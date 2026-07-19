# CLAUDE.md — Mémoire du projet

## Contexte utilisateur (à retenir)

- L'utilisateur héberge son infrastructure sur **Proxmox**, en
  **multi-serveurs sur des mini-PC**.
- Les serveurs de jeu sont déployés dans des **VM Ubuntu** créées sur ce
  cluster Proxmox (pas de LXC pour les serveurs de jeu).
- Langue de travail : **français** — documentation, interface du panel,
  messages de commit et échanges se font en français.
- **Design du panel** : l'utilisateur doit fournir sa propre maquette/charte
  graphique. En attendant, le panel utilise un thème sombre par défaut dont
  toutes les couleurs sont centralisées dans le bloc `:root` de
  `panel/static/style.css` — appliquer le futur design revient à modifier ces
  variables (et si besoin les templates dans `panel/templates/`).

## Le projet

Installation automatisée d'un serveur dédié **Palworld** + **panel web**
d'administration sur Ubuntu Server (VM Proxmox). Voir `README.md`
(utilisation) et `DEVELOPMENT.md` (architecture, dev local, workflow GitHub).

## Conventions

- Pas de dépendances pip ni d'étape de build : Python 3 + Flask via `apt`,
  JavaScript vanilla côté navigateur.
- Le panel parle au serveur via l'API REST officielle de Palworld
  (port 8212, localhost) ; le pilotage du process passe par systemd avec un
  sudoers limité à `systemctl start/stop/restart palworld`.
- Toute modification de `install.sh` doit rester **idempotente** (le script
  est réexécutable sans casser une installation existante ni écraser le
  monde sauvegardé).
- Vérifications minimales avant commit :
  `bash -n install.sh scripts/*.sh` et `python3 -m py_compile panel/*.py`.

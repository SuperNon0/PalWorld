# CLAUDE.md — Mémoire du projet

## Contexte utilisateur (à retenir)

- L'utilisateur héberge son infrastructure sur **Proxmox**, en
  **multi-serveurs sur des mini-PC**.
- Les serveurs de jeu sont déployés dans des **VM Ubuntu** créées sur ce
  cluster Proxmox (pas de LXC pour les serveurs de jeu).
- Langue de travail : **français** — documentation, interface du panel,
  messages de commit et échanges se font en français.
- **Design du panel** : l'utilisateur a fourni sa charte graphique (maquette
  « CDC / MultiOutils », juillet 2026), désormais appliquée au panel :
  fond quasi noir `#0e0f11`, texte mono **DM Mono**, titres serif dorés
  **DM Serif Display** (`#e8c547`), accents teal `#4fc3a1` / orange
  `#e87c47` / rouge `#e85c47` / violet `#a78bfa`, chips translucides,
  rayon 12 px. Les polices sont embarquées en base64 dans
  `panel/static/fonts.css` (le panel fonctionne hors ligne). Toutes les
  couleurs restent centralisées dans le bloc `:root` de
  `panel/static/style.css`. Tout nouvel élément d'interface doit suivre
  cette charte (logotype : minuscules serif, préfixe doré + suffixe
  italique, badge mono uppercase).

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

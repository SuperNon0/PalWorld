<p align="center">
  <img src="docs/images/logo/logo-icon-512.png" width="130" alt="Logo Palworld Panel">
</p>

<h1 align="center">Palworld — Serveur dédié + Panel web</h1>

<p align="center">
  Installation <b>entièrement automatique</b> d'un serveur dédié Palworld et de
  son <b>panel web d'administration</b> (français), sur Ubuntu Server —
  typiquement une VM sur un cluster <b>Proxmox</b>.
</p>

---

## ✨ Fonctionnalités

**Serveur de jeu**
- Installation automatique via **SteamCMD**, service **systemd** (démarrage au
  boot, redémarrage auto en cas de crash).
- API REST officielle de Palworld activée (pilotage local par le panel).
- Sauvegarde du monde forcée avant chaque arrêt / mise à jour.

**Panel web — Serveur**
- ▶ **Démarrer / ■ Arrêter / ⟳ Redémarrer**, plus **arrêt différé** avec compte
  à rebours annoncé aux joueurs.
- 📊 **Tableau de bord** : joueurs, FPS, uptime, version, RAM, disque, adresse
  LAN + tunnel, **graphiques 24 h** (joueurs / FPS / RAM).
- 🖥 **Console** : logs du serveur en temps réel.
- ⚙ **Configuration** : édition de **tous** les paramètres de
  `PalWorldSettings.ini` (chaque réglage expliqué), **enregistrement vérifié sur
  le disque**.
- 📦 **Sauvegardes** : créer, **restaurer**, supprimer, télécharger, rotation
  automatique + **sauvegardes planifiées**.
- 👥 **Joueurs** : niveau, ping, **kick / ban** (raison), déban par identifiant.
- 📢 **Annonces** en jeu · 🔄 **redémarrage quotidien** programmable (préavis 5
  et 1 min).
- 🌐 **Accès / Tunnel** : pilote le tunnel **playit.gg** depuis le panel.

**Panel web — Outils**
- 🥚 **Reproduction** (hors ligne, 288 Pals) : enfant de deux Pals, tous les
  couples pour un Pal cible, **toutes les chaînes d'accouplements**, **favoris**,
  auto-complétion visuelle (photo + n° + type). Sous-onglets dédiés.
- ⬆ **Maintenance** : met à jour le **serveur** (SteamCMD) **et le panel**
  (depuis GitHub) en un clic ; détection des MAJ disponibles.

**Intégrations & notifications**
- 💬 **Notifications Discord** via un *botpanel* à chaque événement : serveur
  démarré / arrêté / redémarré, **joueur connecté / déconnecté**, MAJ dispo,
  sauvegarde OK / échec, disque faible — avec **valeurs dynamiques** (`{var:…}` :
  joueurs, serveur, FPS…) envoyées directement, **sans Home Assistant**.
- 🏠 **Home Assistant** : publication de capteurs + **intégration HACS** dédiée
  → voir [`custom_components/palworld_panel/`](custom_components/palworld_panel/README.md).

**Confort & sûreté**
- 🔐 Panel **mono-compte** (`admin`) protégé par mot de passe, **auto-login
  Cloudflare Access** optionnel.
- ♻️ **Anti-cache** : fichiers statiques versionnés → après une mise à jour, le
  navigateur recharge toujours la dernière version.

---

## 🔔 Notifications botpanel — variables disponibles

À chaque événement, le panel envoie ces valeurs au botpanel
(`POST /api/notify`, champ `vars`). Utilise-les dans tes **templates** avec
`{var:nom}` (ou `{var:nom|valeur_par_défaut}` si la valeur peut manquer).

**Envoyées avec chaque notification :**

| Variable | Contenu |
|---|---|
| `serveur` | Nom du serveur |
| `statut` | En ligne / Démarrage / Hors ligne |
| `joueurs` · `joueurs_max` | Joueurs connectés / maximum |
| `joueurs_noms` | Pseudos connectés (liste) |
| `fps` | FPS du serveur |
| `ping_moyen` | Ping moyen des joueurs (ms) |
| `uptime` · `jours` | Minutes de fonctionnement / jours en jeu |
| `ram` · `ram_total` | RAM utilisée / totale (Go) |
| `disque_libre` | Disque libre (Go) |
| `version` | Build installé |
| `nb_sauvegardes` · `derniere_sauvegarde` | Nombre / date de la dernière sauvegarde |
| `maj_serveur` · `maj_panel` | Mise à jour dispo (oui / non) |
| `ip` · `playit` | Adresse LAN / tunnel |

**En plus, selon l'événement :**

| Événement | Variables supplémentaires |
|---|---|
| Joueur connecté / déconnecté | `joueur` (le pseudo concerné) |
| Sauvegarde terminée | `sauvegarde_nom`, `sauvegarde_taille` |

Chaque notification est un **embed Discord** (carte à barre colorée). Modèles
prêts à copier dans l'éditeur du botpanel — un par événement.

**Réglages communs à tous les embeds :**
- **Miniature** (`icon_url`) — le logo :
  `https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-icon-512.png`
- **Footer** : `{var:serveur}` · **horodatage** (`show_timestamp`) activé.

**Exemple complet — « Serveur démarré » :**
| Réglage | Valeur |
|---|---|
| Couleur | `#4fc3a1` (vert/teal) |
| Titre | `🟢 {var:serveur} — En ligne` |
| Message | `Le serveur est prêt, rejoignez la partie !` |
| Champ (inline) | **🎮 Adresse** = `{var:playit}` |
| Champ (inline) | **👥 Joueurs** = `{var:joueurs}/{var:joueurs_max}` |
| Champ (inline) | **⚡ FPS** = `{var:fps}` |

**Tous les événements — couleur · titre · champs :**

| Événement | Couleur | Titre | Champs de l'embed (nom = valeur) |
|---|---|---|---|
| 🟢 Serveur démarré | `#4fc3a1` | `🟢 {var:serveur} — En ligne` | 🎮 Adresse = `{var:playit}`<br>👥 Joueurs = `{var:joueurs}/{var:joueurs_max}`<br>⚡ FPS = `{var:fps}` |
| 🔴 Hors ligne | `#e85c47` | `🔴 {var:serveur} — Hors ligne` | 👥 Derniers joueurs = `{var:joueurs}`<br>📝 Qui = `{var:joueurs_noms}`<br>💽 Disque = `{var:disque_libre} Go` |
| 🔄 Redémarré | `#e8c547` | `🔄 {var:serveur} — Redémarré` | 🏷️ Build = `{var:version}`<br>💽 Disque = `{var:disque_libre} Go` |
| 👋 Joueur connecté | `#4fc3a1` | `👋 {var:joueur} a rejoint` | 🖥️ Serveur = `{var:serveur}`<br>👥 En ligne = `{var:joueurs}/{var:joueurs_max}`<br>📶 Ping moyen = `{var:ping_moyen} ms` |
| 🚪 Joueur déconnecté | `#6b6f7a` | `🚪 {var:joueur} a quitté` | 👥 Restants = `{var:joueurs}/{var:joueurs_max}`<br>📝 Encore là = `{var:joueurs_noms}` |
| ⬆️ MAJ serveur | `#e8c547` | `⬆️ Mise à jour serveur dispo` | ✅ Disponible = `{var:maj_serveur}`<br>🏷️ Build actuel = `{var:version}` |
| ⬆️ MAJ panel | `#a78bfa` | `⬆️ Mise à jour panel dispo` | ✅ Disponible = `{var:maj_panel}`<br>🖥️ Serveur = `{var:serveur}` |
| 💾 Sauvegarde terminée | `#4fc3a1` | `💾 Sauvegarde terminée` | 📁 Fichier = `{var:sauvegarde_nom}`<br>📦 Taille = `{var:sauvegarde_taille}`<br>🗄️ Total = `{var:nb_sauvegardes}` |
| ⚠️ Sauvegarde échouée | `#e85c47` | `⚠️ Échec de la sauvegarde` | 🖥️ Serveur = `{var:serveur}`<br>💽 Disque libre = `{var:disque_libre} Go` |
| 💽 Disque faible | `#e87c47` | `💽 Espace disque faible` | 💽 Disque = `{var:disque_libre} Go`<br>🧠 RAM = `{var:ram}/{var:ram_total} Go` |

> Couleurs = charte du projet (vert `#4fc3a1` OK, rouge `#e85c47` alerte, or
> `#e8c547` info, orange `#e87c47` attention, violet `#a78bfa` panel). Les
> champs `inline` s'affichent en grille (2-3 par ligne dans Discord).

---

## 🧰 Prérequis (VM Proxmox recommandée)

| Ressource | Minimum | Recommandé |
|-----------|---------|------------|
| CPU | 4 vCPU | 6+ vCPU |
| RAM | 16 Go | 32 Go (Palworld consomme beaucoup de RAM) |
| Disque | 40 Go | 60 Go |
| OS | Ubuntu Server 22.04 | Ubuntu Server 24.04 |

> ⚠️ Pour le **serveur de jeu**, utilisez une **VM** (pas un LXC non privilégié) :
> SteamCMD et Palworld y fonctionnent mal.

---

## 🚀 Installation

### A. Automatique depuis Proxmox (recommandé)
À coller **dans le shell de l'hôte Proxmox** : crée une VM Ubuntu 24.04 et
installe serveur + panel tout seul.

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/proxmox/palworld-vm.sh)"
```

Réglages optionnels : `VMID`, `CORES`, `RAM`, `DISK`, `STORAGE`, `BRIDGE`,
`MAX_PLAYERS`, `PANEL_PORT`… en variables d'environnement. Le script affiche à
la fin l'**adresse du panel** (`http://IP:8080`) et les **mots de passe** ; le
serveur de jeu (~8 Go) se télécharge ensuite en arrière-plan (suivi dans le
panel).

### B. Manuelle (VM/LXC Ubuntu existante)

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/SuperNon0/PalWorld.git
cd PalWorld
sudo ./install.sh
```

Options : `--game-port`, `--panel-port`, `--panel-password`, `--admin-password`,
`--max-players`. Le script est **réexécutable** sans écraser le monde ni le mot
de passe existant.

---

## 🔌 Ports & accès des joueurs

| Port | Proto | Usage | Exposition |
|------|-------|-------|------------|
| 8211 | UDP | Serveur de jeu | Internet (redirection) **ou** tunnel |
| 8080 | TCP | Panel web | **LAN** (ou reverse proxy HTTPS) |
| 8212 | TCP | API REST Palworld | localhost |
| 25575 | TCP | RCON (option) | localhost |

Sans ouvrir de port : l'onglet **Accès / Tunnel** installe **playit.gg**
(gratuit, connexion sortante) et donne une adresse `xxxxx.playit.gg:PORT` à
partager. Alternatives : **Tailscale** / **ZeroTier**.

---

## 🎨 Thème (défini par variables)

Interface sombre, accent **doré**, titres **serif** (DM Serif Display), corps
**mono** (DM Mono). **Toutes** les couleurs viennent d'un seul bloc `:root`
dans [`panel/static/style.css`](panel/static/style.css) ; les polices sont
**embarquées** ([`panel/static/fonts.css`](panel/static/fonts.css)) → rendu
**hors ligne**. Modifier le `:root` suffit pour ré-habiller le panel.

```
Fond #0e0f11 · Carte #1c1f25 · Bordure #2a2d35 · Accent doré #e8c547
Teal #4fc3a1 · Orange #e87c47 · Violet #a78bfa · Rouge #e85c47
Texte #f0ede6 · Atténué #6b6f7a · Rayon 12px
```

---

## 🔒 Sécurité

- Panel exécuté sous l'utilisateur non-root `palworld`, `sudo` limité aux seules
  commandes `systemctl start/stop/restart palworld`.
- Mot de passe du panel **haché** ; API du jeu en **localhost**.
- N'exposez pas le panel directement sur Internet : LAN ou reverse proxy HTTPS.

---

## 📚 Aller plus loin

- 🛠️ **Développement / architecture** → [`DEVELOPMENT.md`](DEVELOPMENT.md)
- 🏠 **Intégration Home Assistant (HACS)** → [`custom_components/palworld_panel/README.md`](custom_components/palworld_panel/README.md)
- 🖼️ **Logo & déclinaisons** → [`docs/images/logo/`](docs/images/logo/) (icône 1024 / 512 / SVG, bannière, wordmark)

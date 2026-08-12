<p align="center">
  <img src="https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-icon-512.png" width="140" alt="Logo Palworld Panel">
</p>

# CDC — Palworld (serveur dédié + panel web)

Cahier des charges du projet : un **serveur dédié Palworld** installé
automatiquement sur Ubuntu (VM/LXC Proxmox), piloté par un **panel web
d'administration** en français, plus des intégrations (notifications Discord
via botpanel, Home Assistant).

> Ce document décrit **ce que fait le projet** et **comment l'installer**. Le
> guide de connexion n'y figure pas volontairement (il sera refait à part).

---

## 1. Présentation — l'essentiel

- **Cible** : hébergement maison sur **Proxmox VE** (mini-PC), serveur de jeu
  dans une **VM/LXC Ubuntu 24.04**.
- **Deux briques** :
  1. le **serveur dédié Palworld** (installé via SteamCMD, géré par systemd) ;
  2. le **panel web** (Flask + JavaScript vanilla) qui l'administre depuis le
     navigateur.
- **Principes** : pas d'étape de build, quasi aucune dépendance (Python 3 +
  Flask via `apt`), **fonctionne hors ligne**, installation **idempotente**
  (réexécutable sans écraser le monde sauvegardé).
- **Dialogue** : le panel parle au serveur via l'**API REST officielle de
  Palworld** (port 8212, en local) ; le pilotage du process passe par
  **systemd** avec un `sudoers` limité à `start/stop/restart`.

---

## 2. Fonctionnalités du panel

### 2.1 Serveur — Tableau de bord
- **État en direct** : statut (En ligne / Démarrage / Hors ligne), nombre de
  joueurs, FPS serveur, uptime, jours en jeu, version installée, RAM machine,
  disque libre, **adresse LAN** et **adresse publique du tunnel** (playit).
- **Graphiques 24 h** : joueurs connectés, FPS, RAM utilisée.
- **Annonce en jeu** : diffuser un message aux joueurs connectés.
- **Automatisation** : **redémarrage quotidien** à heure fixe (avec préavis 5 et
  1 min aux joueurs + sauvegarde avant), **sauvegarde automatique** (intervalle +
  rétention configurables).
- **Arrêt différé** : compte à rebours annoncé en jeu, sauvegarde avant l'arrêt.
- **Joueurs connectés** : liste (nom, identifiant, niveau, ping), **kick / ban**,
  **débannir** un identifiant.

### 2.2 Serveur — Console
- **Logs du serveur en temps réel** (flux SSE depuis `journalctl`).

### 2.3 Serveur — Configuration
- Édition de **tous les paramètres** de `PalWorldSettings.ini` via des champs
  typés (texte, nombre, oui/non), avec description de chaque réglage.
- **Sauvegarde vérifiée** : après écriture, le panel **relit le fichier** et
  confirme que les valeurs sont bien sur le disque (sinon message d'erreur
  précis). *(Rappel Palworld : redémarrer le serveur pour appliquer.)*

### 2.4 Serveur — Sauvegardes
- **Créer**, **restaurer**, **supprimer**, **télécharger** une sauvegarde du
  monde ; **rétention** automatique (nombre d'archives conservées).

### 2.5 Serveur — Accès / Tunnel
- **Adresse publique du tunnel playit** (saisie/affichée), et commandes systemd
  prêtes à copier pour piloter le tunnel.

### 2.6 Reproduction (calculateur d'accouplements)
- **Hors ligne**, 4 sous-onglets :
  - **Parents → Enfant** : l'enfant de deux Pals.
  - **Pal ciblé** : tous les couples qui donnent un Pal précis.
  - **J'ai → je veux** : toutes les chaînes d'accouplements les plus courtes,
    avec à chaque étape tous les partenaires possibles.
  - **⭐ Favoris** : couples et chaînes enregistrés (par compte).
- **Auto-complétion visuelle** : vignette + numéro de Paldex + nom + type(s)
  coloré(s), liste déroulante filtrable.

### 2.7 Paramètres
- **Maintenance & mises à jour** : mettre à jour le **serveur** (SteamCMD) et le
  **panel** (depuis GitHub, redémarrage automatique), détection des MAJ dispo.
- **Mot de passe** du panel (compte unique `admin`).
- **Connexion Google (Cloudflare)** : auto-login derrière Cloudflare Access.
- **Notifications** (voir §2.8) et **Home Assistant** (voir §3).

### 2.8 Notifications Discord (via botpanel)
Le panel déclenche des notifications sur le **botpanel** (`POST /api/notify`)
à chaque événement, en envoyant les **valeurs dynamiques** directement (champ
`vars` → placeholders `{var:nom}` des templates, **sans passer par Home
Assistant**).

- **Événements** : serveur démarré / arrêté / redémarré, **joueur connecté**,
  **joueur déconnecté**, MAJ serveur dispo, MAJ panel dispo, sauvegarde
  terminée / échouée, disque faible.
- **Variables fournies** : `serveur`, `statut`, `joueurs`, `joueurs_max`,
  `joueurs_noms`, `fps`, `ping_moyen`, `uptime`, `jours`, `ram`, `ram_total`,
  `disque_libre`, `version`, `nb_sauvegardes`, `derniere_sauvegarde`,
  `maj_serveur`, `maj_panel`, `ip`, `playit` ; en plus, pour un joueur :
  `joueur` ; pour une sauvegarde : `sauvegarde_nom`, `sauvegarde_taille`.

### 2.9 Connexion & sécurité (résumé)
- **Compte unique `admin`** protégé par mot de passe (haché), **auto-login
  Cloudflare** optionnel, page **« mot de passe oublié »** + script de reset.
- Utilisateur système **non-root**, `sudoers` minimal, API du jeu en localhost.
- **Anti-cache** : les fichiers statiques sont versionnés (`?v=…`) → après une
  mise à jour, le navigateur recharge toujours la nouvelle version.

---

## 3. Intégration Home Assistant *(conservée)*

Deux sens possibles :
- **Push** : le panel publie des **capteurs** Palworld dans HA (statut, joueurs,
  FPS, RAM, disque, version, sauvegardes…) via l'API REST de HA.
- **Pull (HACS)** : le composant `custom_components/palworld_panel/` interroge
  le panel (`/api/ha/stats`) et crée l'appareil **Palworld** + ses capteurs.

> À l'ajout dans HA : utiliser l'**adresse locale** du panel
> (`http://IP:8080`, **pas** l'URL Cloudflare) et le mot de passe du panel.

---

## 4. Installation

### 4.1 En une commande — Proxmox (recommandé)
À coller **dans le shell de l'hôte Proxmox** : crée une VM Ubuntu 24.04 via
cloud-init et lance l'installation automatiquement au premier démarrage.

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/proxmox/palworld-vm.sh)"
```

Personnalisable par variables d'environnement (`VMID`, `CORES`, `RAM`, `DISK`,
`HOSTNAME`, `MAX_PLAYERS`, `PANEL_PORT`, `SSH_KEY`…).

### 4.2 Manuel — sur une VM/LXC Ubuntu existante
```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/SuperNon0/PalWorld.git /opt/palworld-src
sudo bash /opt/palworld-src/install.sh
```

`install.sh` est **idempotent** : il installe le serveur (SteamCMD), le panel,
les services systemd et le `sudoers`, génère la config, et **n'écrase pas** le
monde ni le mot de passe existants. À la fin, le panel est joignable sur
`http://<ip>:8080`.

---

## 5. Thème (défini par variables)

Interface **sombre**, accent **doré**, titres **serif** (DM Serif Display),
corps **monospace** (DM Mono). Toutes les couleurs viennent d'un **seul bloc
`:root`** dans `panel/static/style.css` ; les polices sont **embarquées en
base64** (`panel/static/fonts.css`) pour un rendu **hors ligne**.

### 5.1 Jetons (design tokens)

| Variable | Hex | Rôle |
|---|---|---|
| `--bg` | `#0e0f11` | Fond global (quasi noir) |
| `--bg-panel` | `#16181c` | Barres, en-têtes |
| `--bg-card` | `#1c1f25` | Cartes / panneaux |
| `--bg-input` | `#0e0f11` | Champs de saisie |
| `--border` | `#2a2d35` | Filets, séparateurs |
| `--text` | `#f0ede6` | Texte principal |
| `--muted` | `#6b6f7a` | Texte secondaire, labels |
| `--accent` | `#e8c547` | **Or** — titres, actions principales (hover `--accent-hover` `#f2d76a`) |
| `--green` | `#4fc3a1` | Teal — états positifs |
| `--orange` | `#e87c47` | Orange — avertissements |
| `--red` | `#e85c47` | Rouge — danger |
| `--pending` | `#a78bfa` | Violet — tâches en cours |
| `--console-bg` / `--console-text` | `#0a0b0d` / `#4fc3a1` | Terminal / logs |
| `--radius` | `12px` | Rayon d'arrondi |

Typographie : `--font-serif: "DM Serif Display", Georgia, serif` ·
`--font-mono: "DM Mono", ui-monospace, …, monospace`. Corps `0.85rem`,
interligne `1.5`, labels en petites capitales espacées.

### 5.2 Bloc `:root` (à copier tel quel)

```css
:root {
  --bg: #0e0f11;
  --bg-panel: #16181c;
  --bg-card: #1c1f25;
  --bg-input: #0e0f11;
  --border: #2a2d35;
  --text: #f0ede6;
  --muted: #6b6f7a;
  --accent: #e8c547;        /* or — titres, actions principales */
  --accent-hover: #f2d76a;
  --green: #4fc3a1;         /* teal — états positifs */
  --orange: #e87c47;        /* orange — avertissements */
  --red: #e85c47;           /* rouge — danger */
  --pending: #a78bfa;       /* violet — tâches en cours */
  --console-bg: #0a0b0d;
  --console-text: #4fc3a1;
  --radius: 12px;
  --font-serif: "DM Serif Display", Georgia, serif;
  --font-mono: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

> Règle : **ne jamais coder une couleur en dur** — toujours passer par ces
> variables. Voir aussi le CDC de thème séparé pour la version « tokens »
> réutilisable dans un autre stack.

---

## 6. Logo & identité

Logo du projet (patte des Pals dans un engrenage = gestion/bot, anneau teal =
supervision). Fichiers dans `docs/images/logo/` — liens `raw` directs :

| Fichier | Lien |
|---|---|
| Icône 1024 px | `https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-icon-1024.png` |
| Icône 512 px | `https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-icon-512.png` |
| Icône SVG (vectoriel) | `https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-icon.svg` |
| Bannière (emblème + wordmark) | `https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-banniere.png` |
| Wordmark seul | `https://raw.githubusercontent.com/SuperNon0/PalWorld/claude/palworld-install-script-panel-b41cfo/docs/images/logo/logo-wordmark.png` |

> Les liens `raw` fonctionnent si le dépôt est **public** ; ils pointent sur la
> branche courante (à mettre à jour vers `main` après fusion, ou via une
> Release pour un lien permanent).

---

## 7. Pile technique (repères)

- **Backend** : Python 3 + Flask (via `apt`), systemd, API REST Palworld (8212).
- **Frontend** : HTML + CSS + JavaScript **vanilla** (aucun framework, aucun build).
- **Config** : `/etc/palworld-panel/config.json` ; état dans
  `/opt/palworld/panel-state.json`.
- **Vérifs avant commit** : `bash -n install.sh scripts/*.sh` ·
  `python3 -m py_compile panel/*.py` · `node --check panel/static/app.js`.

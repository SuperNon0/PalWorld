# Intégration Home Assistant — Palworld Panel

Cette intégration ajoute à **Home Assistant** un appareil **« Palworld »** avec
tous les capteurs de ton serveur (statut, joueurs, FPS, ping moyen, uptime,
jours en jeu, RAM, disque, mises à jour, sauvegardes, version…). Elle
**interroge** ton panel Palworld — contrairement à la méthode « push » intégrée
au panel, ici les entités sont regroupées en appareil, survivent aux
redémarrages de HA et se configurent depuis l'interface de HA.

## Prérequis

- Home Assistant **2024.4** ou plus récent.
- [HACS](https://hacs.xyz) installé.
- Le panel Palworld accessible depuis Home Assistant (même réseau local).
- Le **mot de passe** du panel (compte unique `admin`).

> ⚠️ Utilise l'**adresse locale** du panel (`http://IP:8080`), **pas** une URL
> publique / Cloudflare : Cloudflare Access bloque l'accès automatisé de Home
> Assistant.

## Installation via HACS

1. Dans Home Assistant : **HACS → menu ⋮ (en haut à droite) → Dépôts
   personnalisés**.
2. Colle l'URL du dépôt : `https://github.com/SuperNon0/PalWorld`
   — catégorie : **Intégration** — puis **Ajouter**.
3. Cherche **« Palworld Panel »** dans HACS, ouvre-la, clique **Télécharger**.
4. **Redémarre Home Assistant** (Paramètres → Système → Redémarrer).

## Configuration

1. **Paramètres → Appareils et services → Ajouter une intégration**.
2. Cherche **« Palworld Panel »**.
3. Renseigne :
   - **URL du panel** — l'adresse **locale**, ex. `http://192.168.0.10:8080`
   - **Mot de passe** du panel
4. Valide : l'appareil **Palworld** et ses capteurs apparaissent.

## Capteurs créés

| Entité | Contenu |
|---|---|
| `sensor.palworld_statut` | En ligne / Hors ligne / Démarrage |
| `sensor.palworld_joueurs` | Nombre de joueurs (attribut `max`) |
| `sensor.palworld_joueurs_noms` | Pseudos connectés (attributs `liste`, `details`) |
| `sensor.palworld_fps` | FPS du serveur |
| `sensor.palworld_ping_moyen` | Ping moyen des joueurs |
| `sensor.palworld_uptime` | Temps de fonctionnement (min) |
| `sensor.palworld_jours` | Jours écoulés en jeu |
| `sensor.palworld_ram` | RAM utilisée (Go, attribut `total`) |
| `sensor.palworld_disque_libre` | Espace disque libre (Go) |
| `sensor.palworld_maj_serveur` | Mise à jour serveur dispo (oui/non) |
| `sensor.palworld_maj_panel` | Mise à jour panel dispo (oui/non) |
| `sensor.palworld_nb_sauvegardes` | Nombre de sauvegardes |
| `sensor.palworld_derniere_sauvegarde` | Date de la dernière sauvegarde |
| `sensor.palworld_version` | Build installé |

> Le capteur « dernière sauvegarde » n'apparaît qu'une fois qu'au moins une
> sauvegarde existe. Recharge l'intégration après ta première sauvegarde pour
> le voir.

## Mise à jour / interrogation

Le panel est interrogé toutes les 30 secondes. Aucun port supplémentaire à
ouvrir : tout reste sur ton réseau local.

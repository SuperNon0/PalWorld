#!/usr/bin/env bash
#
# Met à jour le panel (le « site ») depuis GitHub : récupère les dernières
# modifications du dépôt, recopie les fichiers du panel et des scripts, puis
# redémarre le service du panel.
#
# Lancé en root par le panel (bouton « Mettre à jour le panel ») via sudo,
# ou manuellement :  sudo /opt/palworld/scripts/update-panel.sh
#
# Le corps est encapsulé dans main() : bash parse toute la fonction en mémoire
# avant de l'exécuter, ce qui permet au script de se remplacer lui-même sans
# risque de corruption pendant la copie.
set -euo pipefail

main() {
    # Déclaration + affectation combinées : la partie droite est évaluée avec
    # la valeur d'environnement AVANT que le local ne la masque.
    local SOURCE_DIR="${SOURCE_DIR:-/opt/palworld-src}"
    local PANEL_DIR="${PANEL_DIR:-/opt/palworld/panel}"
    local SCRIPTS_DIR="${SCRIPTS_DIR:-/opt/palworld/scripts}"
    local PANEL_SERVICE="${PANEL_SERVICE:-palworld-panel}"

    [[ -d "$SOURCE_DIR/.git" ]] || {
        echo "[update-panel] Dépôt source introuvable dans $SOURCE_DIR" >&2
        exit 1
    }

    echo "[update-panel] Récupération des dernières modifications GitHub…"
    git config --global --add safe.directory "$SOURCE_DIR" 2>/dev/null || true
    git -C "$SOURCE_DIR" pull --ff-only

    echo "[update-panel] Copie des fichiers du panel et des scripts…"
    cp -a "$SOURCE_DIR/panel/." "$PANEL_DIR/"
    cp -a "$SOURCE_DIR/scripts/." "$SCRIPTS_DIR/"
    chown -R palworld:palworld "$PANEL_DIR"
    chown -R root:root "$SCRIPTS_DIR"
    chmod +x "$SCRIPTS_DIR"/*.sh

    echo "[update-panel] Redémarrage du panel…"
    # Redémarrage détaché : sinon systemd tuerait ce script (enfant du service
    # palworld-panel) au moment d'arrêter le service.
    if command -v systemd-run >/dev/null; then
        systemd-run --quiet --on-active=2 systemctl restart "$PANEL_SERVICE.service"
    else
        systemctl restart "$PANEL_SERVICE.service"
    fi
    echo "[update-panel] Mise à jour terminée, le panel redémarre."
}

main "$@"

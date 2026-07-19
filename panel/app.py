#!/usr/bin/env python3
"""Panel web d'administration pour un serveur dédié Palworld.

Fonctionnalités : démarrer/arrêter/redémarrer le serveur (systemd), console
en temps réel (journalctl), édition de PalWorldSettings.ini, joueurs
connectés (kick/ban), annonces en jeu, mise à jour SteamCMD et sauvegardes.

La configuration du panel est lue depuis le fichier JSON pointé par la
variable d'environnement PANEL_CONFIG (défaut : /etc/palworld-panel/config.json).
"""
import json
import logging
import os
import re
import subprocess
import threading
import time
from functools import wraps
from pathlib import Path

from flask import (Flask, Response, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from werkzeug.security import check_password_hash

import palworld_config
from palworld_api import APIError, PalworldAPI

CONFIG_PATH = os.environ.get("PANEL_CONFIG", "/etc/palworld-panel/config.json")
with open(CONFIG_PATH, encoding="utf-8") as _handle:
    CONFIG = json.load(_handle)

SERVICE = CONFIG.get("service_name", "palworld")
SERVER_DIR = Path(CONFIG.get("server_dir", "/opt/palworld/server"))
BACKUP_DIR = Path(CONFIG.get("backup_dir", "/opt/palworld/backups"))
SCRIPTS_DIR = Path(CONFIG.get("scripts_dir", "/opt/palworld/scripts"))
API_URL = CONFIG.get("api_url", "http://127.0.0.1:8212")
SETTINGS_FILE = SERVER_DIR / "Pal" / "Saved" / "Config" / "LinuxServer" / "PalWorldSettings.ini"

VALID_BARE_VALUE = re.compile(r"^[A-Za-z0-9_.+\-]*$")
VALID_QUOTED_VALUE = re.compile(r'^"[^"\r\n]*"$')
VALID_KEY = re.compile(r"^[A-Za-z0-9_]+$")
VALID_BACKUP_NAME = re.compile(r"^palworld-\d{8}-\d{6}\.tar\.gz$")

app = Flask(__name__)
app.secret_key = CONFIG["secret_key"]
logging.getLogger("werkzeug").setLevel(logging.WARNING)

_task_lock = threading.Lock()
_current_task = None


# --------------------------------------------------------------- utilitaires
def palworld_api():
    settings = palworld_config.read_settings(SETTINGS_FILE)
    password = palworld_config.unquote(settings.get("AdminPassword", ""))
    return PalworldAPI(API_URL, password)


def service_state():
    result = subprocess.run(
        ["systemctl", "is-active", f"{SERVICE}.service"],
        capture_output=True, text=True, check=False,
    )
    return result.stdout.strip() or "unknown"


def systemctl(action):
    result = subprocess.run(
        ["sudo", "-n", "/usr/bin/systemctl", action, f"{SERVICE}.service"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"systemctl {action} a échoué")


def run_script_async(task_name, script_path):
    """Lance un script en arrière-plan (une seule tâche à la fois)."""
    global _current_task
    if not _task_lock.acquire(blocking=False):
        return False
    _current_task = task_name

    def worker():
        global _current_task
        try:
            subprocess.run(["/usr/bin/bash", str(script_path)], check=False)
        finally:
            _current_task = None
            _task_lock.release()

    threading.Thread(target=worker, daemon=True).start()
    return True


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/"):
                return jsonify(error="Non authentifié"), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapper


# --------------------------------------------------------------------- pages
@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        if check_password_hash(CONFIG["panel_password_hash"], request.form.get("password", "")):
            session["logged_in"] = True
            return redirect(url_for("index"))
        time.sleep(1)  # freine les tentatives de force brute
        error = "Mot de passe incorrect."
    return render_template("login.html", error=error)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
@login_required
def index():
    return render_template("index.html")


# ----------------------------------------------------------------------- API
@app.get("/api/status")
@login_required
def api_status():
    state = service_state()
    data = {"service": state, "task": _current_task, "api_ok": False}
    if state == "active":
        try:
            api = palworld_api()
            data["info"] = api.info()
            data["metrics"] = api.metrics()
            data["players"] = api.players().get("players", [])
            data["api_ok"] = True
        except APIError:
            pass  # serveur en cours de démarrage ou API désactivée
    return jsonify(data)


@app.post("/api/action")
@login_required
def api_action():
    action = (request.get_json(silent=True) or {}).get("action", "")
    try:
        if action in ("stop", "restart"):
            try:
                palworld_api().save()  # sauvegarde du monde avant coupure
            except APIError:
                pass
            systemctl(action)
        elif action == "start":
            systemctl("start")
        elif action == "save":
            palworld_api().save()
        elif action == "update":
            if not run_script_async("update", SCRIPTS_DIR / "update.sh"):
                return jsonify(error="Une tâche est déjà en cours."), 409
        elif action == "backup":
            if not run_script_async("backup", SCRIPTS_DIR / "backup.sh"):
                return jsonify(error="Une tâche est déjà en cours."), 409
        else:
            return jsonify(error=f"Action inconnue : {action}"), 400
    except APIError as exc:
        return jsonify(error=str(exc)), 502
    except RuntimeError as exc:
        return jsonify(error=str(exc)), 500
    return jsonify(ok=True)


@app.post("/api/announce")
@login_required
def api_announce():
    message = (request.get_json(silent=True) or {}).get("message", "").strip()
    if not message:
        return jsonify(error="Message vide."), 400
    try:
        palworld_api().announce(message)
    except APIError as exc:
        return jsonify(error=str(exc)), 502
    return jsonify(ok=True)


@app.post("/api/players/<action>")
@login_required
def api_players(action):
    if action not in ("kick", "ban", "unban"):
        return jsonify(error="Action inconnue."), 400
    userid = (request.get_json(silent=True) or {}).get("userid", "").strip()
    if not userid:
        return jsonify(error="Identifiant joueur manquant."), 400
    try:
        getattr(palworld_api(), action)(userid)
    except APIError as exc:
        return jsonify(error=str(exc)), 502
    return jsonify(ok=True)


@app.get("/api/config")
@login_required
def api_config_get():
    try:
        settings = palworld_config.read_settings(SETTINGS_FILE)
    except OSError as exc:
        return jsonify(error=f"Fichier de configuration illisible : {exc}"), 500
    return jsonify(settings=settings, path=str(SETTINGS_FILE))


@app.post("/api/config")
@login_required
def api_config_set():
    settings = (request.get_json(silent=True) or {}).get("settings", {})
    if not isinstance(settings, dict) or not settings:
        return jsonify(error="Aucun paramètre reçu."), 400
    for key, value in settings.items():
        if not VALID_KEY.match(str(key)):
            return jsonify(error=f"Clé invalide : {key}"), 400
        value = str(value)
        if not (VALID_BARE_VALUE.match(value) or VALID_QUOTED_VALUE.match(value)):
            return jsonify(error=f"Valeur invalide pour {key}."), 400
    try:
        palworld_config.write_settings(SETTINGS_FILE, {k: str(v) for k, v in settings.items()})
    except OSError as exc:
        return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.get("/api/backups")
@login_required
def api_backups():
    backups = []
    if BACKUP_DIR.is_dir():
        for path in sorted(BACKUP_DIR.glob("palworld-*.tar.gz"), reverse=True):
            stat = path.stat()
            backups.append({"name": path.name, "size": stat.st_size, "mtime": stat.st_mtime})
    return jsonify(backups=backups)


@app.get("/api/backups/<name>/download")
@login_required
def api_backup_download(name):
    if not VALID_BACKUP_NAME.match(name):
        return jsonify(error="Nom de sauvegarde invalide."), 400
    return send_from_directory(BACKUP_DIR, name, as_attachment=True)


@app.get("/api/console")
@login_required
def api_console():
    def stream():
        yield f"data: {json.dumps('— console connectée, en attente de logs… —')}\n\n"
        process = subprocess.Popen(
            ["journalctl", "-f", "-n", "200", "--no-hostname",
             "-u", f"{SERVICE}.service", "-u", "palworld-panel.service"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        try:
            for line in process.stdout:
                yield f"data: {json.dumps(line.rstrip())}\n\n"
        finally:
            process.kill()

    return Response(stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    app.run(
        host=CONFIG.get("bind", "0.0.0.0"),
        port=int(CONFIG.get("panel_port", 8080)),
        threaded=True,
    )

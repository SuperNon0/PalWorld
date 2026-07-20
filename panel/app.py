#!/usr/bin/env python3
"""Panel web d'administration pour un serveur dédié Palworld.

Fonctionnalités : démarrer/arrêter/redémarrer le serveur (systemd), console
en temps réel (journalctl), édition de PalWorldSettings.ini, joueurs
connectés (kick/ban), annonces en jeu, mise à jour SteamCMD, sauvegardes
(création, restauration, suppression, téléchargement), sauvegardes
automatiques et redémarrage quotidien planifiés.

La configuration du panel est lue depuis le fichier JSON pointé par la
variable d'environnement PANEL_CONFIG (défaut : /etc/palworld-panel/config.json).
L'état du planificateur est conservé dans le fichier ``state_file``
(défaut : /opt/palworld/panel-state.json), inscriptible par l'utilisateur
``palworld``.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta
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
STATE_FILE = Path(CONFIG.get("state_file", "/opt/palworld/panel-state.json"))
API_URL = CONFIG.get("api_url", "http://127.0.0.1:8212")
SETTINGS_FILE = SERVER_DIR / "Pal" / "Saved" / "Config" / "LinuxServer" / "PalWorldSettings.ini"

VALID_BARE_VALUE = re.compile(r"^[A-Za-z0-9_.+\-]*$")
VALID_QUOTED_VALUE = re.compile(r'^"[^"\r\n]*"$')
VALID_KEY = re.compile(r"^[A-Za-z0-9_]+$")
VALID_BACKUP_NAME = re.compile(r"^palworld-\d{8}-\d{6}\.tar\.gz$")
VALID_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")

STATE_DEFAULTS = {
    "auto_backup_enabled": False,
    "auto_backup_interval_hours": 24,
    "auto_backup_keep": 14,
    "last_auto_backup": 0,
    "auto_restart_enabled": False,
    "auto_restart_time": "05:00",
}

app = Flask(__name__)
app.secret_key = CONFIG["secret_key"]
logging.getLogger("werkzeug").setLevel(logging.WARNING)

_task_lock = threading.Lock()
_current_task = None
_state_lock = threading.Lock()


# --------------------------------------------------------------- utilitaires
def palworld_api():
    settings = palworld_config.read_settings(SETTINGS_FILE)
    password = palworld_config.unquote(settings.get("AdminPassword", ""))
    return PalworldAPI(API_URL, password)


def announce_quiet(message):
    try:
        palworld_api().announce(message)
    except (APIError, OSError):
        pass


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


def run_script_async(task_name, script_path, args=(), extra_env=None):
    """Lance un script en arrière-plan (une seule tâche à la fois)."""
    global _current_task
    if not _task_lock.acquire(blocking=False):
        return False
    _current_task = task_name
    env = dict(os.environ, SERVER_DIR=str(SERVER_DIR), BACKUP_DIR=str(BACKUP_DIR))
    if extra_env:
        env.update(extra_env)

    def worker():
        global _current_task
        try:
            subprocess.run(["/usr/bin/bash", str(script_path), *args], check=False, env=env)
        finally:
            _current_task = None
            _task_lock.release()

    threading.Thread(target=worker, daemon=True).start()
    return True


def load_state():
    state = dict(STATE_DEFAULTS)
    try:
        with open(STATE_FILE, encoding="utf-8") as handle:
            state.update(json.load(handle))
    except (OSError, ValueError):
        pass
    return state


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)


def system_stats():
    """RAM et disque de la machine (utile pour dimensionner la VM Proxmox)."""
    stats = {}
    try:
        meminfo = {}
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                meminfo[key.strip()] = int(rest.strip().split()[0]) * 1024
        stats["mem_total"] = meminfo["MemTotal"]
        stats["mem_used"] = meminfo["MemTotal"] - meminfo["MemAvailable"]
    except (OSError, KeyError, ValueError, IndexError):
        pass
    try:
        usage = shutil.disk_usage(SERVER_DIR if SERVER_DIR.exists() else Path("/"))
        stats["disk_total"] = usage.total
        stats["disk_free"] = usage.free
    except OSError:
        pass
    return stats


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/"):
                return jsonify(error="Non authentifié"), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapper


# -------------------------------------------------------------- planificateur
def _shift_minutes(hhmm, delta):
    moment = datetime.strptime(hhmm, "%H:%M") - timedelta(minutes=delta)
    return moment.strftime("%H:%M")


def scheduler_loop():
    """Sauvegardes automatiques + redémarrage quotidien avec préavis en jeu."""
    last_minute = None
    while True:
        time.sleep(20)
        try:
            with _state_lock:
                state = load_state()

            if state["auto_backup_enabled"]:
                elapsed = time.time() - float(state.get("last_auto_backup", 0))
                if elapsed >= float(state["auto_backup_interval_hours"]) * 3600:
                    started = run_script_async(
                        "backup", SCRIPTS_DIR / "backup.sh",
                        extra_env={"KEEP": str(state["auto_backup_keep"])},
                    )
                    if started:
                        with _state_lock:
                            fresh = load_state()
                            fresh["last_auto_backup"] = time.time()
                            save_state(fresh)

            minute = time.strftime("%H:%M")
            if minute == last_minute:
                continue
            last_minute = minute
            if not state["auto_restart_enabled"] or service_state() != "active":
                continue
            target = state["auto_restart_time"]
            if minute == _shift_minutes(target, 5):
                announce_quiet("Redemarrage automatique du serveur dans 5 minutes")
            elif minute == _shift_minutes(target, 1):
                announce_quiet("Redemarrage automatique du serveur dans 1 minute")
            elif minute == target:
                announce_quiet("Redemarrage du serveur...")
                try:
                    palworld_api().save()
                except APIError:
                    pass
                try:
                    systemctl("restart")
                except RuntimeError:
                    logging.exception("Redémarrage automatique impossible")
        except Exception:
            logging.exception("Erreur du planificateur")


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
    data = {"service": state, "task": _current_task, "api_ok": False,
            "system": system_stats()}
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


@app.get("/api/scheduler")
@login_required
def api_scheduler_get():
    with _state_lock:
        return jsonify(load_state())


@app.post("/api/scheduler")
@login_required
def api_scheduler_set():
    data = request.get_json(silent=True) or {}
    try:
        interval = float(data.get("auto_backup_interval_hours", 24))
        keep = int(data.get("auto_backup_keep", 14))
        restart_time = str(data.get("auto_restart_time", "05:00"))
        if not 0.5 <= interval <= 168:
            raise ValueError("intervalle entre 0,5 et 168 heures")
        if not 1 <= keep <= 200:
            raise ValueError("rétention entre 1 et 200 archives")
        if not VALID_TIME.match(restart_time):
            raise ValueError("heure au format HH:MM")
    except (TypeError, ValueError) as exc:
        return jsonify(error=f"Paramètres invalides : {exc}"), 400
    with _state_lock:
        state = load_state()
        state.update(
            auto_backup_enabled=bool(data.get("auto_backup_enabled")),
            auto_backup_interval_hours=interval,
            auto_backup_keep=keep,
            auto_restart_enabled=bool(data.get("auto_restart_enabled")),
            auto_restart_time=restart_time,
        )
        try:
            save_state(state)
        except OSError as exc:
            return jsonify(error=f"Écriture de l'état impossible : {exc}"), 500
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


@app.post("/api/backups/<name>/restore")
@login_required
def api_backup_restore(name):
    if not VALID_BACKUP_NAME.match(name):
        return jsonify(error="Nom de sauvegarde invalide."), 400
    if not (BACKUP_DIR / name).is_file():
        return jsonify(error="Sauvegarde introuvable."), 404
    if not run_script_async("restore", SCRIPTS_DIR / "restore.sh", args=(name,)):
        return jsonify(error="Une tâche est déjà en cours."), 409
    return jsonify(ok=True)


@app.delete("/api/backups/<name>")
@login_required
def api_backup_delete(name):
    if not VALID_BACKUP_NAME.match(name):
        return jsonify(error="Nom de sauvegarde invalide."), 400
    try:
        (BACKUP_DIR / name).unlink()
    except FileNotFoundError:
        return jsonify(error="Sauvegarde introuvable."), 404
    except OSError as exc:
        return jsonify(error=str(exc)), 500
    return jsonify(ok=True)


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
    threading.Thread(target=scheduler_loop, daemon=True).start()
    app.run(
        host=CONFIG.get("bind", "0.0.0.0"),
        port=int(CONFIG.get("panel_port", 8080)),
        threaded=True,
    )

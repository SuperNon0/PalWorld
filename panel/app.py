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
import collections
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

from flask import (Flask, Response, jsonify, redirect, render_template,
                   request, send_from_directory, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import palworld_config
from palworld_api import APIError, PalworldAPI

CONFIG_PATH = os.environ.get("PANEL_CONFIG", "/etc/palworld-panel/config.json")
with open(CONFIG_PATH, encoding="utf-8") as _handle:
    CONFIG = json.load(_handle)

SERVICE = CONFIG.get("service_name", "palworld")
PANEL_SERVICE = CONFIG.get("panel_service_name", "palworld-panel")
PLAYIT_SERVICE = "playit"
SERVER_DIR = Path(CONFIG.get("server_dir", "/opt/palworld/server"))
BACKUP_DIR = Path(CONFIG.get("backup_dir", "/opt/palworld/backups"))
SCRIPTS_DIR = Path(CONFIG.get("scripts_dir", "/opt/palworld/scripts"))
SOURCE_DIR = Path(CONFIG.get("source_dir", "/opt/palworld-src"))
STATE_FILE = Path(CONFIG.get("state_file", "/opt/palworld/panel-state.json"))
API_URL = CONFIG.get("api_url", "http://127.0.0.1:8212")
SETTINGS_FILE = SERVER_DIR / "Pal" / "Saved" / "Config" / "LinuxServer" / "PalWorldSettings.ini"

STEAM_APP_ID = "2394010"
STEAMCMD_API = f"https://api.steamcmd.net/v1/info/{STEAM_APP_ID}"
# Unités systemd que le panel a le droit de piloter (via le sudoers d'install)
ALLOWED_UNITS = {SERVICE, PLAYIT_SERVICE}
# Seuil d'alerte disque bas (5 Go)
LOW_DISK_BYTES = 5 * 1024 ** 3

VALID_BARE_VALUE = re.compile(r"^[A-Za-z0-9_.+\-]*$")
VALID_QUOTED_VALUE = re.compile(r'^"[^"\r\n]*"$')
VALID_KEY = re.compile(r"^[A-Za-z0-9_]+$")
VALID_BACKUP_NAME = re.compile(r"^palworld-\d{8}-\d{6}\.tar\.gz$")
VALID_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
# Adresse d'un tunnel playit.gg : hôte (ou IP) avec un port optionnel.
VALID_PLAYIT = re.compile(r"^[A-Za-z0-9.\-]{1,110}(?::\d{1,5})?$")
# URL de base du botpanel (http[s]://hôte[:port], sans chemin).
VALID_NOTIFY_URL = re.compile(r"^https?://[A-Za-z0-9.\-]{1,110}(?::\d{1,5})?$")
# Slug d'une notification botpanel.
VALID_SLUG = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")

STATE_DEFAULTS = {
    "auto_backup_enabled": False,
    "auto_backup_interval_hours": 24,
    "auto_backup_keep": 14,
    "last_auto_backup": 0,
    "auto_restart_enabled": False,
    "auto_restart_time": "05:00",
    # Détection de mises à jour (renseignée par le planificateur)
    "update_check_time": 0,
    "server_local_build": "",
    "server_latest_build": "",
    "server_update_available": False,
    "panel_update_available": False,
    # Mot de passe système (VM) affiché sur la page Infos, modifiable par l'admin
    "vm_user": "",
    "vm_password": "",
    # Adresse publique du tunnel playit.gg (xxxxx.playit.gg:PORT), saisie par l'admin
    "playit_address": "",
    # Notifications Discord via le botpanel (POST /api/notify {"id": slug})
    "notify_enabled": False,
    "notify_url": "",          # URL de base du botpanel, ex : http://192.168.0.30:8080
    "notify_slugs": {},        # {clé d'événement: slug de la notif botpanel}
}

app = Flask(__name__)
app.secret_key = CONFIG["secret_key"]
app.config.update(SESSION_COOKIE_SAMESITE="Lax", SESSION_COOKIE_HTTPONLY=True)
logging.getLogger("werkzeug").setLevel(logging.WARNING)

_task_lock = threading.Lock()
_current_task = None
_state_lock = threading.Lock()
_history_lock = threading.Lock()
_users_lock = threading.Lock()

# Suivi des transitions pour les notifications (évite d'alerter à chaque tick).
_last_online = None    # bool | None : dernier état connu du serveur (en ligne ?)
_disk_was_low = False  # le disque était-il déjà en dessous du seuil au dernier tick ?

# Événements notifiables → libellé affiché dans le panel (et repère pour l'admin).
NOTIFY_EVENTS = {
    "server_online": "🟢 Serveur démarré",
    "server_offline": "🔴 Serveur arrêté / hors ligne",
    "server_restart": "🔄 Serveur redémarré",
    "server_update": "⬆️ Mise à jour du serveur disponible",
    "panel_update": "⬆️ Mise à jour du panel disponible",
    "backup_done": "💾 Sauvegarde terminée",
    "backup_failed": "⚠️ Sauvegarde échouée",
    "disk_low": "💽 Espace disque faible",
}

# Comptes du panel : {identifiant: hash}. Fichier inscriptible par palworld.
USERS_FILE = Path(CONFIG.get("users_file", str(STATE_FILE.parent / "panel-users.json")))
VALID_USERNAME = re.compile(r"^[A-Za-z0-9_.\-]{3,32}$")
# Identifiants système (accès VM), écrits à l'installation, lus par la page Infos.
CREDENTIALS_FILE = Path(CONFIG.get("credentials_file", str(STATE_FILE.parent / "panel-credentials.json")))
HISTORY = collections.deque(maxlen=1440)  # ~24 h à raison d'un point par minute


# --------------------------------------------------------------- utilitaires
def palworld_api():
    try:
        settings = palworld_config.read_settings(SETTINGS_FILE)
    except OSError as exc:
        # Fichier de config absent (serveur pas encore installé) ou illisible :
        # on renvoie une APIError (déjà gérée partout) pour un message clair côté
        # panel, plutôt qu'une erreur 500 brute.
        raise APIError(
            "Configuration du serveur illisible — le serveur est-il installé "
            f"et démarré ? ({exc})"
        ) from exc
    password = palworld_config.unquote(settings.get("AdminPassword", ""))
    return PalworldAPI(API_URL, password, timeout=3)


def announce_quiet(message):
    try:
        palworld_api().announce(message)
    except (APIError, OSError):
        pass


def service_state():
    try:
        result = subprocess.run(
            ["systemctl", "is-active", f"{SERVICE}.service"],
            capture_output=True, text=True, check=False,
        )
    except OSError:
        return "unknown"  # machine sans systemd (environnement de dev)
    return result.stdout.strip() or "unknown"


def systemctl(action, unit=SERVICE):
    if unit not in ALLOWED_UNITS:
        raise RuntimeError(f"Unité non autorisée : {unit}")
    result = subprocess.run(
        ["sudo", "-n", "/usr/bin/systemctl", action, f"{unit}.service"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"systemctl {action} a échoué")


def run_script_async(task_name, script_path, args=(), extra_env=None, sudo=False, on_done=None):
    """Lance un script en arrière-plan (une seule tâche à la fois).

    Avec ``sudo=True``, le script est exécuté en root via ``sudo -n`` — réservé
    aux scripts root explicitement autorisés dans le sudoers du panel.
    ``on_done(returncode)`` est appelé après la fin du script (verrou déjà relâché).
    """
    global _current_task
    if not _task_lock.acquire(blocking=False):
        return False
    _current_task = task_name
    env = dict(os.environ, SERVER_DIR=str(SERVER_DIR), BACKUP_DIR=str(BACKUP_DIR))
    if extra_env:
        env.update(extra_env)
    if sudo:
        command = ["sudo", "-n", str(script_path), *args]
    else:
        command = ["/usr/bin/bash", str(script_path), *args]

    def worker():
        global _current_task
        returncode = None
        try:
            returncode = subprocess.run(command, check=False, env=env).returncode
        finally:
            _current_task = None
            _task_lock.release()
        if on_done is not None:
            try:
                on_done(returncode)
            except Exception:
                logging.exception("Callback de fin de tâche en échec")

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


def load_users():
    """Comptes du panel. Migre depuis le mot de passe unique existant au 1er accès."""
    try:
        with open(USERS_FILE, encoding="utf-8") as handle:
            users = json.load(handle)
        if isinstance(users, dict) and users:
            return users
    except (OSError, ValueError):
        pass
    users = {"admin": CONFIG["panel_password_hash"]}
    try:
        save_users(users)
    except OSError:
        pass
    return users


def save_users(users):
    USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(USERS_FILE, "w", encoding="utf-8") as handle:
        json.dump(users, handle, indent=2)


def is_admin():
    """Le compte « admin » est le seul à voir les informations sensibles."""
    return session.get("user") == "admin"


def local_ip():
    """IP locale (LAN) de la machine, sans dépendance ni trafic réseau réel."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))  # ne fait que choisir l'interface de sortie
            return sock.getsockname()[0]
        finally:
            sock.close()
    except OSError:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return None


def game_port():
    try:
        settings = palworld_config.read_settings(SETTINGS_FILE)
        port = palworld_config.unquote(settings.get("PublicPort", "8211"))
        return int(port) if port.isdigit() else 8211
    except (OSError, ValueError):
        return 8211


def system_stats():
    """RAM et disque de la machine (utile pour dimensionner la VM Proxmox)."""
    stats = {"ip": local_ip()}
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


# ------------------------------------------------------ détection des mises à jour
def server_local_build():
    """Numéro de build Palworld installé (depuis l'appmanifest SteamCMD)."""
    manifest = SERVER_DIR / "steamapps" / f"appmanifest_{STEAM_APP_ID}.acf"
    try:
        text = manifest.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    match = re.search(r'"buildid"\s+"(\d+)"', text)
    return match.group(1) if match else ""


def server_latest_build():
    """Dernier build public Palworld via l'API communautaire steamcmd.net."""
    try:
        request = urllib.request.Request(STEAMCMD_API, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=6) as response:
            data = json.loads(response.read().decode(errors="replace"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return ""
    try:
        branches = data["data"][STEAM_APP_ID]["depots"]["branches"]
        return str(branches["public"]["buildid"])
    except (KeyError, TypeError):
        return ""


def panel_update_available():
    """True si la copie locale du dépôt est en retard sur son origine GitHub.

    Utilise ``git ls-remote`` (lecture seule, réseau) plutôt que ``git fetch``
    (écriture) : fonctionne même si le dépôt appartient à root (déploiement
    Proxmox) et sans droit d'écriture. ``safe.directory`` évite l'erreur
    « dubious ownership » quand le dépôt n'appartient pas à l'utilisateur.
    """
    if not (SOURCE_DIR / ".git").exists():
        return False
    git = ["git", "-c", f"safe.directory={SOURCE_DIR}", "-C", str(SOURCE_DIR)]
    try:
        local = subprocess.run(git + ["rev-parse", "HEAD"],
                               capture_output=True, text=True, check=False)
        branch = subprocess.run(git + ["rev-parse", "--abbrev-ref", "HEAD"],
                                capture_output=True, text=True, check=False)
        ref = branch.stdout.strip() or "HEAD"
        remote = subprocess.run(git + ["ls-remote", "origin", ref],
                                capture_output=True, text=True, check=False, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    if local.returncode or remote.returncode or not remote.stdout.strip():
        return False
    return local.stdout.strip() != remote.stdout.split()[0]


def check_for_updates():
    """Met à jour l'état avec la disponibilité des mises à jour (serveur + panel)."""
    local_build = server_local_build()
    latest_build = server_latest_build()
    panel_upd = panel_update_available()
    with _state_lock:
        state = load_state()
        was_server = bool(state.get("server_update_available"))
        was_panel = bool(state.get("panel_update_available"))
        state["update_check_time"] = int(time.time())
        state["server_local_build"] = local_build
        # ne signale une MAJ serveur que si les deux builds sont connus et diffèrent
        if local_build and latest_build:
            state["server_latest_build"] = latest_build
            state["server_update_available"] = local_build != latest_build
        state["panel_update_available"] = panel_upd
        now_server = bool(state.get("server_update_available"))
        save_state(state)
    # Notifie seulement au passage « pas de MAJ » → « MAJ dispo » (pas à chaque contrôle).
    if now_server and not was_server:
        notify_external_async("server_update")
    if panel_upd and not was_panel:
        notify_external_async("panel_update")


def build_notifications(state, stats):
    """Liste de notifications à afficher dans le panel."""
    notes = []
    if state.get("server_update_available"):
        notes.append({
            "level": "warn",
            "text": "Une mise à jour du serveur Palworld est disponible.",
            "action": "update",
        })
    if state.get("panel_update_available"):
        notes.append({
            "level": "info",
            "text": "Une mise à jour du panel est disponible sur GitHub.",
            "action": "update-panel",
        })
    if stats.get("disk_free") is not None and stats["disk_free"] < LOW_DISK_BYTES:
        notes.append({
            "level": "danger",
            "text": "Espace disque faible sur la machine.",
            "action": None,
        })
    return notes


# --------------------------------------------- notifications Discord (botpanel)
def _post_notify(url, slug):
    """POST {"id": slug} sur <url>/api/notify. Retourne (succès, détail)."""
    payload = json.dumps({"id": slug}).encode()
    request = urllib.request.Request(
        url.rstrip("/") + "/api/notify", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            body = response.read().decode(errors="replace").strip()
            return True, body[:200] or "envoyée"
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode(errors="replace")[:200]
        except OSError:
            detail = ""
        return False, f"HTTP {exc.code}{(' — ' + detail) if detail else ''}"
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
        return False, str(exc)


def notify_external(event):
    """Déclenche la notification botpanel associée à un événement, si configurée."""
    with _state_lock:
        state = load_state()
    if not state.get("notify_enabled"):
        return
    url = (state.get("notify_url") or "").strip()
    slug = (state.get("notify_slugs") or {}).get(event, "")
    if not url or not slug:
        return
    ok, detail = _post_notify(url, slug)
    if not ok:
        logging.warning("Notification botpanel (%s) échouée : %s", event, detail)


def notify_external_async(event):
    """Envoi non bloquant : ne ralentit jamais l'action qui l'a déclenché."""
    threading.Thread(target=notify_external, args=(event,), daemon=True).start()


def _on_backup_done(returncode):
    notify_external_async("backup_done" if returncode == 0 else "backup_failed")


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            if request.path.startswith("/api/"):
                return jsonify(error="Non authentifié"), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapper


def admin_required(view):
    """Réserve l'accès au compte admin (gestion des comptes, infos sensibles)."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify(error="Non authentifié"), 401
        if not is_admin():
            return jsonify(error="Réservé au compte admin."), 403
        return view(*args, **kwargs)
    return wrapper


# -------------------------------------------------------------- planificateur
def _shift_minutes(hhmm, delta):
    moment = datetime.strptime(hhmm, "%H:%M") - timedelta(minutes=delta)
    return moment.strftime("%H:%M")


def sample_metrics():
    """Un point d'historique par minute (joueurs, FPS, RAM) pour les graphiques."""
    entry = {"t": int(time.time())}
    if service_state() == "active":
        try:
            metrics = palworld_api().metrics()
            entry["fps"] = metrics.get("serverfps")
            entry["players"] = metrics.get("currentplayernum")
        except APIError:
            pass
    stats = system_stats()
    if "mem_used" in stats:
        entry["mem"] = stats["mem_used"]
        entry["mem_total"] = stats["mem_total"]
    with _history_lock:
        HISTORY.append(entry)


def _check_service_transition():
    """Notifie au passage en ligne ↔ hors ligne du serveur (états stables seulement)."""
    global _last_online
    state = service_state()
    if state == "active":
        online = True
    elif state in ("inactive", "failed", "deactivating"):
        online = False
    else:
        return  # activating/unknown : transitoire, on ignore (évite le flapping)
    if _last_online is None:
        _last_online = online  # premier relevé : on mémorise sans notifier
        return
    if online != _last_online:
        _last_online = online
        notify_external_async("server_online" if online else "server_offline")


def _check_disk_transition(stats):
    """Notifie une seule fois quand le disque passe sous le seuil d'alerte."""
    global _disk_was_low
    free = stats.get("disk_free")
    if free is None:
        return
    low = free < LOW_DISK_BYTES
    if low and not _disk_was_low:
        notify_external_async("disk_low")
    _disk_was_low = low


def scheduler_loop():
    """Sauvegardes auto + redémarrage quotidien + vérification des mises à jour."""
    last_minute = None
    last_update_check = 0.0
    while True:
        time.sleep(20)
        try:
            # Vérification des mises à jour toutes les 6 h (et au démarrage)
            if time.time() - last_update_check >= 6 * 3600:
                last_update_check = time.time()
                try:
                    check_for_updates()
                except Exception:
                    logging.exception("Vérification des mises à jour impossible")

            # Détection des transitions (serveur en ligne/hors ligne, disque bas)
            _check_service_transition()
            _check_disk_transition(system_stats())

            with _state_lock:
                state = load_state()

            if state["auto_backup_enabled"]:
                elapsed = time.time() - float(state.get("last_auto_backup", 0))
                if elapsed >= float(state["auto_backup_interval_hours"]) * 3600:
                    started = run_script_async(
                        "backup", SCRIPTS_DIR / "backup.sh",
                        extra_env={"KEEP": str(state["auto_backup_keep"])},
                        on_done=_on_backup_done,
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
            sample_metrics()
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
                    notify_external_async("server_restart")
                except RuntimeError:
                    logging.exception("Redémarrage automatique impossible")
        except Exception:
            logging.exception("Erreur du planificateur")


# --------------------------------------------------------------------- pages
@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        with _users_lock:
            stored = load_users().get(username)
        if stored and check_password_hash(stored, password):
            session["logged_in"] = True
            session["user"] = username
            return redirect(url_for("index"))
        time.sleep(1)  # freine les tentatives de force brute
        error = "Identifiant ou mot de passe incorrect."
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
    stats = system_stats()
    data = {"service": state, "task": _current_task, "api_ok": False,
            "system": stats, "game_port": game_port(),
            "server_installed": (SERVER_DIR / "PalServer.sh").exists(),
            "is_admin": is_admin()}
    with _state_lock:
        persisted = load_state()
    data["notifications"] = build_notifications(persisted, stats)
    data["playit_address"] = persisted.get("playit_address", "")
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


@app.get("/api/info")
@admin_required
def api_info():
    try:
        settings = palworld_config.read_settings(SETTINGS_FILE)
    except OSError:
        settings = {}

    def value(key, default=""):
        return palworld_config.unquote(settings.get(key, default))

    # Identifiants système (accès VM) : priorité à l'état (modifiable par l'admin
    # dans Paramètres), puis au fichier écrit à l'installation.
    creds = {}
    try:
        with open(CREDENTIALS_FILE, encoding="utf-8") as handle:
            creds = json.load(handle)
    except (OSError, ValueError):
        pass
    with _state_lock:
        state = load_state()

    # Récapitulatif des notifications Discord (aide-mémoire sur la page Infos).
    notify_slugs = state.get("notify_slugs") or {}
    notify_events = [{"label": label, "slug": notify_slugs.get(key, "")}
                     for key, label in NOTIFY_EVENTS.items()]

    return jsonify(
        ip=local_ip(),
        game_port=game_port(),
        panel_port=int(CONFIG.get("panel_port", 8080)),
        server_name=value("ServerName"),
        server_password=value("ServerPassword"),
        admin_password=value("AdminPassword"),
        rest_api_port=value("RESTAPIPort", "8212"),
        rcon_port=value("RCONPort", "25575"),
        server_dir=str(SERVER_DIR),
        backup_dir=str(BACKUP_DIR),
        settings_file=str(SETTINGS_FILE),
        source_dir=str(SOURCE_DIR),
        ssh_user=state.get("vm_user") or creds.get("vm_user") or "ubuntu",
        vm_password=state.get("vm_password") or creds.get("vm_password", ""),
        playit_address=state.get("playit_address", ""),
        notify_enabled=bool(state.get("notify_enabled")),
        notify_url=state.get("notify_url", ""),
        notify_events=notify_events,
    )


@app.post("/api/credentials")
@admin_required
def api_credentials_set():
    """Met à jour le mot de passe système (VM) affiché sur la page Infos.

    Le panel ne peut pas lire le mot de passe système (chiffré) : c'est un champ
    que l'admin tient à jour quand il change le mot de passe de la VM.
    """
    data = request.get_json(silent=True) or {}
    with _state_lock:
        state = load_state()
        if "vm_user" in data:
            state["vm_user"] = str(data.get("vm_user", "")).strip()
        if "vm_password" in data:
            state["vm_password"] = str(data.get("vm_password", ""))
        try:
            save_state(state)
        except OSError as exc:
            return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.post("/api/playit")
@login_required
def api_playit_set():
    """Enregistre l'adresse publique du tunnel playit.gg à donner aux joueurs.

    Le panel ne peut pas la connaître (le tunnel est créé sur playit.gg) : l'admin
    la colle ici et elle s'affiche sur le tableau de bord et la page Infos.
    """
    data = request.get_json(silent=True) or {}
    addr = str(data.get("playit_address", "")).strip()
    if addr and not VALID_PLAYIT.match(addr):
        return jsonify(error="Adresse invalide (attendu : xxxxx.playit.gg:PORT)."), 400
    with _state_lock:
        state = load_state()
        state["playit_address"] = addr
        try:
            save_state(state)
        except OSError as exc:
            return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.get("/api/notifications-config")
@admin_required
def api_notify_config_get():
    with _state_lock:
        state = load_state()
    slugs = state.get("notify_slugs") or {}
    return jsonify(
        enabled=bool(state.get("notify_enabled")),
        url=state.get("notify_url", ""),
        events=[{"key": key, "label": label, "slug": slugs.get(key, "")}
                for key, label in NOTIFY_EVENTS.items()],
    )


@app.post("/api/notifications-config")
@admin_required
def api_notify_config_set():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url", "")).strip().rstrip("/")
    if url and not VALID_NOTIFY_URL.match(url):
        return jsonify(error="URL du botpanel invalide (ex : http://192.168.0.30:8080)."), 400
    raw = data.get("slugs") or {}
    if not isinstance(raw, dict):
        return jsonify(error="Format des slugs invalide."), 400
    slugs = {}
    for key, value in raw.items():
        if key not in NOTIFY_EVENTS:
            continue
        value = str(value).strip()
        if not value:
            continue  # vide = événement désactivé
        if not VALID_SLUG.match(value):
            return jsonify(error=f"Slug invalide pour « {NOTIFY_EVENTS[key]} »."), 400
        slugs[key] = value
    with _state_lock:
        state = load_state()
        state["notify_enabled"] = bool(data.get("enabled"))
        state["notify_url"] = url
        state["notify_slugs"] = slugs
        try:
            save_state(state)
        except OSError as exc:
            return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.post("/api/notifications-config/test")
@admin_required
def api_notify_test():
    slug = str((request.get_json(silent=True) or {}).get("slug", "")).strip()
    if not slug:
        return jsonify(error="Renseigne d'abord le slug à tester."), 400
    with _state_lock:
        url = (load_state().get("notify_url") or "").strip()
    if not url:
        return jsonify(error="Renseigne d'abord l'URL du botpanel (puis Enregistre)."), 400
    ok, detail = _post_notify(url, slug)
    if ok:
        return jsonify(ok=True, detail=detail)
    return jsonify(error=f"Échec de l'envoi : {detail}"), 502


@app.post("/api/action")
@login_required
def api_action():
    payload = request.get_json(silent=True) or {}
    action = payload.get("action", "")
    try:
        if action in ("stop", "restart"):
            try:
                palworld_api().save()  # sauvegarde du monde avant coupure
            except APIError:
                pass
            systemctl(action)
            if action == "restart":
                notify_external_async("server_restart")
        elif action == "start":
            systemctl("start")
        elif action == "save":
            palworld_api().save()
        elif action == "shutdown":
            try:
                waittime = int(payload.get("waittime", 300))
            except (TypeError, ValueError):
                return jsonify(error="Délai invalide."), 400
            if not 10 <= waittime <= 3600:
                return jsonify(error="Délai entre 10 et 3600 secondes."), 400
            message = str(payload.get("message") or "").strip() \
                or f"Arret du serveur dans {max(1, waittime // 60)} min"
            palworld_api().shutdown(waittime, message)
        elif action == "update":
            if not run_script_async("update", SCRIPTS_DIR / "update.sh"):
                return jsonify(error="Une tâche est déjà en cours."), 409
        elif action == "update-panel":
            if not run_script_async("update-panel", SCRIPTS_DIR / "update-panel.sh", sudo=True):
                return jsonify(error="Une tâche est déjà en cours."), 409
        elif action == "backup":
            if not run_script_async("backup", SCRIPTS_DIR / "backup.sh", on_done=_on_backup_done):
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
    data = request.get_json(silent=True) or {}
    userid = str(data.get("userid", "")).strip()
    message = str(data.get("message") or "").strip()
    if not userid:
        return jsonify(error="Identifiant joueur manquant."), 400
    try:
        api = palworld_api()
        if action == "unban":
            api.unban(userid)
        elif message:
            getattr(api, action)(userid, message)
        else:
            getattr(api, action)(userid)
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


@app.get("/api/history")
@login_required
def api_history():
    with _history_lock:
        return jsonify(history=list(HISTORY))


@app.get("/api/users")
@admin_required
def api_users_list():
    with _users_lock:
        users = load_users()
    return jsonify(users=sorted(users.keys()), current=session.get("user"))


@app.post("/api/users")
@admin_required
def api_users_create():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if not VALID_USERNAME.match(username):
        return jsonify(error="Identifiant invalide (3 à 32 caractères : lettres, chiffres, . _ -)."), 400
    if len(password) < 8:
        return jsonify(error="Le mot de passe doit faire au moins 8 caractères."), 400
    with _users_lock:
        users = load_users()
        if username in users:
            return jsonify(error="Cet identifiant existe déjà."), 409
        users[username] = generate_password_hash(password)
        try:
            save_users(users)
        except OSError as exc:
            return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.delete("/api/users/<username>")
@admin_required
def api_users_delete(username):
    with _users_lock:
        users = load_users()
        if username not in users:
            return jsonify(error="Compte introuvable."), 404
        if len(users) <= 1:
            return jsonify(error="Impossible de supprimer le dernier compte."), 400
        del users[username]
        try:
            save_users(users)
        except OSError as exc:
            return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.post("/api/users/<username>/password")
@admin_required
def api_users_password(username):
    data = request.get_json(silent=True) or {}
    password = str(data.get("password", ""))
    if len(password) < 8:
        return jsonify(error="Le mot de passe doit faire au moins 8 caractères."), 400
    with _users_lock:
        users = load_users()
        if username not in users:
            return jsonify(error="Compte introuvable."), 404
        users[username] = generate_password_hash(password)
        try:
            save_users(users)
        except OSError as exc:
            return jsonify(error=f"Écriture impossible : {exc}"), 500
    return jsonify(ok=True)


@app.get("/api/scheduler")
@login_required
def api_scheduler_get():
    with _state_lock:
        state = dict(load_state())
    # Version installée lue en direct (le champ mis en cache n'est rafraîchi que
    # toutes les 6 h ; on garantit ainsi que l'onglet Maintenance l'affiche).
    live_build = server_local_build()
    if live_build:
        state["server_local_build"] = live_build
    return jsonify(state)


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


@app.post("/api/check-updates")
@login_required
def api_check_updates():
    check_for_updates()
    with _state_lock:
        state = load_state()
    return jsonify({key: state[key] for key in (
        "update_check_time", "server_local_build", "server_latest_build",
        "server_update_available", "panel_update_available")})


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
        try:
            process = subprocess.Popen(
                # Suit les 2 services + la sortie SteamCMD (taguée « palworld-steamcmd »
                # pendant l'installation/mise à jour). Le « + » est un OU entre filtres.
                ["journalctl", "-f", "-n", "200", "--no-hostname",
                 f"_SYSTEMD_UNIT={SERVICE}.service", "+",
                 f"_SYSTEMD_UNIT={PANEL_SERVICE}.service", "+",
                 f"_SYSTEMD_UNIT={PLAYIT_SERVICE}.service", "+",
                 "SYSLOG_IDENTIFIER=palworld-steamcmd"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            )
        except OSError as exc:
            yield f"data: {json.dumps(f'journalctl indisponible : {exc}')}\n\n"
            return
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

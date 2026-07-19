#!/usr/bin/env python3
"""Client minimal pour l'API REST officielle de Palworld.

L'API doit être activée dans PalWorldSettings.ini :
    RESTAPIEnabled=True, RESTAPIPort=8212
L'authentification est en Basic auth avec l'utilisateur ``admin`` et le
mot de passe défini par ``AdminPassword``.
"""
import base64
import json
import urllib.error
import urllib.request


class APIError(Exception):
    """Erreur de communication avec l'API du serveur Palworld."""


class PalworldAPI:
    def __init__(self, base_url, admin_password, timeout=5):
        self.base_url = base_url.rstrip("/")
        token = base64.b64encode(f"admin:{admin_password}".encode()).decode()
        self.headers = {"Authorization": f"Basic {token}", "Accept": "application/json"}
        self.timeout = timeout

    def _call(self, method, path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            self.base_url + path, data=data, method=method, headers=dict(self.headers)
        )
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode(errors="replace").strip()
                if body.startswith("{") or body.startswith("["):
                    return json.loads(body)
                return {"raw": body}
        except urllib.error.HTTPError as exc:
            raise APIError(f"HTTP {exc.code} sur {path}") from exc
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            raise APIError(f"API injoignable ({exc})") from exc

    # --- lecture ---------------------------------------------------------
    def info(self):
        return self._call("GET", "/v1/api/info")

    def players(self):
        return self._call("GET", "/v1/api/players")

    def metrics(self):
        return self._call("GET", "/v1/api/metrics")

    def settings(self):
        return self._call("GET", "/v1/api/settings")

    # --- actions ---------------------------------------------------------
    def announce(self, message):
        return self._call("POST", "/v1/api/announce", {"message": message})

    def save(self):
        return self._call("POST", "/v1/api/save")

    def kick(self, userid, message="Kick par un administrateur"):
        return self._call("POST", "/v1/api/kick", {"userid": userid, "message": message})

    def ban(self, userid, message="Ban par un administrateur"):
        return self._call("POST", "/v1/api/ban", {"userid": userid, "message": message})

    def unban(self, userid):
        return self._call("POST", "/v1/api/unban", {"userid": userid})

    def shutdown(self, waittime=30, message="Le serveur va s'arrêter"):
        return self._call("POST", "/v1/api/shutdown", {"waittime": waittime, "message": message})

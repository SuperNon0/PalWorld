"""Coordinateur : interroge le panel Palworld et met en cache ses capteurs."""
from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class _AuthExpired(Exception):
    """La session du panel a expiré : il faut se reconnecter."""


class PalworldPanelCoordinator(DataUpdateCoordinator):
    """Récupère les capteurs exposés par le panel (/api/ha/stats)."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=SCAN_INTERVAL),
        )
        self.entry = entry
        self._base = str(entry.data[CONF_URL]).rstrip("/")
        self._user = entry.data[CONF_USERNAME]
        self._password = entry.data[CONF_PASSWORD]
        # Session dédiée (cookie jar propre à cette intégration).
        self._session = aiohttp.ClientSession()

    async def async_close(self) -> None:
        """Ferme la session HTTP (au déchargement de l'intégration)."""
        await self._session.close()

    async def _login(self) -> None:
        """Ouvre une session sur le panel avec le compte configuré."""
        try:
            async with self._session.post(
                f"{self._base}/login",
                data={"username": self._user, "password": self._password},
                allow_redirects=False,
            ) as resp:
                if resp.status not in (302, 303):
                    raise ConfigEntryAuthFailed("Identifiant ou mot de passe du panel incorrect")
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Connexion au panel impossible : {err}") from err

    async def _fetch(self) -> dict:
        try:
            async with self._session.get(f"{self._base}/api/ha/stats") as resp:
                if resp.status == 401:
                    raise _AuthExpired
                resp.raise_for_status()
                return await resp.json()
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Lecture du panel impossible : {err}") from err

    async def _async_update_data(self) -> dict[str, dict]:
        try:
            payload = await self._fetch()
        except _AuthExpired:
            await self._login()
            payload = await self._fetch()
        return {item["entity"]: item for item in payload.get("entities", [])}

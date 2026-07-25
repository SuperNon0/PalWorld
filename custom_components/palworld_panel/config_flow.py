"""Config flow de l'intégration Palworld Panel."""
from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME
from homeassistant.helpers.aiohttp_client import async_create_clientsession

from .const import DEVICE_NAME, DOMAIN


class PalworldPanelConfigFlow(ConfigFlow, domain=DOMAIN):
    """Assistant d'ajout : URL du panel + compte."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = str(user_input[CONF_URL]).rstrip("/")
            errors = await self._validate(
                url, user_input[CONF_USERNAME], user_input[CONF_PASSWORD]
            )
            if not errors:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=DEVICE_NAME,
                    data={
                        CONF_URL: url,
                        CONF_USERNAME: user_input[CONF_USERNAME],
                        CONF_PASSWORD: user_input[CONF_PASSWORD],
                    },
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_URL, default="http://192.168.0.10:8080"): str,
                vol.Required(CONF_USERNAME, default="admin"): str,
                vol.Required(CONF_PASSWORD): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def _validate(self, url: str, username: str, password: str) -> dict[str, str]:
        """Vérifie l'URL et le compte en se connectant réellement au panel."""
        session = async_create_clientsession(self.hass)
        try:
            async with session.post(
                f"{url}/login",
                data={"username": username, "password": password},
                allow_redirects=False,
            ) as resp:
                if resp.status not in (302, 303):
                    return {"base": "invalid_auth"}
            async with session.get(f"{url}/api/ha/stats") as resp:
                if resp.status != 200:
                    return {"base": "cannot_connect"}
        except aiohttp.ClientError:
            return {"base": "cannot_connect"}
        return {}

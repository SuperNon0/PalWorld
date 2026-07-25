"""Capteurs de l'intégration Palworld Panel."""
from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import DEVICE_NAME, DOMAIN
from .coordinator import PalworldPanelCoordinator


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Crée un capteur par entité exposée par le panel."""
    coordinator: PalworldPanelCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        PalworldPanelSensor(coordinator, entry, entity_id)
        for entity_id in coordinator.data
    )


class PalworldPanelSensor(CoordinatorEntity[PalworldPanelCoordinator], SensorEntity):
    """Un capteur reflétant une entité renvoyée par le panel."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: PalworldPanelCoordinator,
        entry: ConfigEntry,
        entity_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._entity_id = entity_id  # ex : "sensor.palworld_statut"
        key = entity_id.split(".", 1)[-1]
        attrs = self._raw_attributes()
        friendly = attrs.get("friendly_name", key)
        # Le nom de l'appareil est déjà "Palworld" (has_entity_name) : on retire le préfixe.
        self._attr_name = friendly.replace("Palworld – ", "").replace("Palworld - ", "")
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_icon = attrs.get("icon")
        self._attr_native_unit_of_measurement = attrs.get("unit_of_measurement")
        if attrs.get("device_class") == "timestamp":
            self._attr_device_class = SensorDeviceClass.TIMESTAMP
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=DEVICE_NAME,
            manufacturer="Palworld Panel",
            model="Serveur dédié",
        )

    def _raw(self) -> dict:
        return self.coordinator.data.get(self._entity_id, {})

    def _raw_attributes(self) -> dict:
        return self._raw().get("attributes", {})

    @property
    def available(self) -> bool:
        return super().available and self._entity_id in self.coordinator.data

    @property
    def native_value(self):
        state = self._raw().get("state")
        if self.device_class == SensorDeviceClass.TIMESTAMP and state:
            return dt_util.parse_datetime(state)
        return state

    @property
    def extra_state_attributes(self) -> dict:
        attrs = dict(self._raw_attributes())
        for key in ("friendly_name", "icon", "unit_of_measurement", "device_class"):
            attrs.pop(key, None)
        return attrs

"""Turn hourly physical states into virtual observations for M3."""

import math
from datetime import datetime, timedelta, timezone

from .anomalies import analyze_telemetry


# Field, equipment ID, sensor ID, metric and unit. IDs are unique within a station.
SENSORS = (
    ("tank_stock_m3", "tank-01", "tank-level-01", "tank_volume", "m3"),
    ("pumped_m3", "pump-01", "pump-flow-01", "pumped_flow", "m3/h"),
    ("water_in_m3", "tank-01", "inlet-flow-01", "inlet_flow", "m3/h"),
    ("distributed_m3", "distribution-01", "delivery-flow-01", "distributed_flow", "m3/h"),
    ("pump_power_kw", "pump-01", "pump-power-01", "pump_power", "kW"),
    ("pump_energy_total_kwh", "pump-01", "pump-energy-01", "pump_energy_total", "kWh"),
    ("solar_generated_wh", "pv-01", "pv-generation-01", "solar_generation", "Wh"),
    ("solar_used_wh", "pv-01", "pv-use-01", "solar_self_consumption", "Wh"),
    ("grid_import_wh", "grid-01", "grid-import-01", "grid_import_for_pumping", "Wh"),
    ("grid_available", "grid-01", "grid-state-01", "grid_available", "boolean"),
)
REQUIRED = ("pumped_m3", "consumed_wh", "water_in_m3", "distributed_m3", "tank_stock_m3", "grid_available")


def project_telemetry(states, reference, missing_flow_slots=(), *, initial_stock_m3=None):
    if not isinstance(states, list) or not 0 < len(states) <= 24:
        raise ValueError("states: provide 1 to 24 hourly states for one station")
    if not isinstance(missing_flow_slots, (list, tuple, set)) or any(
        type(slot) is not int or not 0 <= slot <= 23 for slot in missing_flow_slots
    ):
        raise ValueError("missing_flow_slots: use integer slots from 0 through 23")
    missing = set(missing_flow_slots)
    readings, measurements = [], []
    total_wh = 0
    previous_slot = -1
    previous_timestamp = None
    for index, state in enumerate(states):
        prefix = f"states[{index}]"
        if not isinstance(state, dict) or any(key not in state for key in (*REQUIRED, "site_id", "timestamp", "simulation_slot")):
            raise ValueError(f"{prefix}: incomplete physical state")
        site, slot = state["site_id"], state["simulation_slot"]
        if not isinstance(site, str) or not site or (readings and site != readings[0]["site_id"]):
            raise ValueError(f"{prefix}.site_id: states must belong to one station")
        if type(slot) is not int or not previous_slot < slot <= 23:
            raise ValueError(f"{prefix}.simulation_slot: provide ascending unique slots from 0 through 23")
        timestamp = datetime.fromisoformat(state["timestamp"])
        if timestamp.tzinfo is None or timestamp.minute or timestamp.second or timestamp.microsecond:
            raise ValueError(f"{prefix}.timestamp: provide a timezone-aware hourly timestamp")
        try:
            utc_time = timestamp.astimezone(timezone.utc)
            utc_time + timedelta(hours=1)
        except OverflowError as error:
            raise ValueError(f"{prefix}.timestamp: the hourly interval is outside the UTC datetime range") from error
        if previous_timestamp and (utc_time - previous_timestamp).total_seconds() != (slot - previous_slot) * 3600:
            raise ValueError(f"{prefix}.timestamp: the time difference must match the slot difference")

        available = state["grid_available"]
        if type(available) is not bool:
            raise ValueError(f"{prefix}.grid_available: provide a boolean physical state")
        for field in (*REQUIRED[:-1], "solar_wh"):
            value = state.get(field)
            if field == "solar_wh" and value is None:
                continue
            if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
                raise ValueError(f"{prefix}.{field}: provide a finite, nonnegative value")
        consumed = state["consumed_wh"]
        if not available and (consumed or state["pumped_m3"]):
            raise ValueError(f"{prefix}: grid-tied pumping must stop during a grid outage")
        generated = state.get("solar_wh") if available else 0
        solar_used = min(generated, consumed) if generated is not None else None
        if total_wh is not None:
            total_wh = total_wh + consumed if slot == previous_slot + 1 else None
        observed = {**state, "timestamp": utc_time.isoformat().replace("+00:00", "Z"), "provenance": "simulated",
                    "pumped_m3": None if slot in missing else state["pumped_m3"],
                    "pump_power_kw": consumed / 1000, "pump_energy_total_kwh": total_wh / 1000 if total_wh is not None else None,
                    "solar_generated_wh": generated, "solar_used_wh": solar_used,
                    "grid_import_wh": consumed - solar_used if solar_used is not None else (0 if consumed == 0 else None)}
        readings.append(observed)
        for field, equipment, sensor_id, metric, unit in SENSORS:
            value = observed[field]
            measurements.append({"site_id": site, "equipment_id": equipment, "sensor_id": sensor_id, "simulation_slot": slot,
                                 "timestamp": observed["timestamp"], "metric": metric, "value": value, "unit": unit,
                                 "source": "virtual_sensor", "quality": "valid" if value is not None else
                                 ("missing" if field == "pumped_m3" and slot in missing else "unavailable")})
        previous_slot, previous_timestamp = slot, utc_time
    return {"records": readings, "measurements": measurements,
            **analyze_telemetry(readings, reference, initial_stock_m3=initial_stock_m3)}

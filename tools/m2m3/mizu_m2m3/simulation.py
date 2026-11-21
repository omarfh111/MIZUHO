import json
import math
import os
import random
from datetime import datetime, timedelta, timezone
from urllib.error import URLError
from urllib.request import Request, urlopen

from .anomalies import analyze_telemetry
from .sensors import project_telemetry
from .stations import DEFAULT_SITE, STATIONS, demo_station


START = datetime.fromisoformat("2026-11-21T00:00:00+01:00")
HOURS = 24
DEMO_SEED = 21
MAX_SEED = 4_294_967_295
SCENARIOS = {"stress", "routine"}
FAULTS = {"inefficiency", "imbalance", "outage", "sensor_dropout"}
NUMERIC_FIELDS = ("consumed_wh", "pumped_m3", "water_in_m3", "distributed_m3", "tank_stock_m3")


def demo_snapshot(hour, faults=(), *, seed=DEMO_SEED, scenario="stress", site_id=DEFAULT_SITE, solar_profile=None):
    station = demo_station(site_id)
    if type(hour) is not int or not 0 <= hour < HOURS:
        raise ValueError("hour: expected H00–H23")
    if not isinstance(faults, (list, tuple)) or len(faults) > HOURS:
        raise ValueError("faults: invalid fault queue")
    if type(seed) is not int or not 0 <= seed <= MAX_SEED:
        raise ValueError(f"seed: enter a whole number from 0 to {MAX_SEED}")
    if not isinstance(scenario, str) or scenario not in SCENARIOS:
        raise ValueError("scenario: select routine or stress")
    events = {9: "inefficiency", 10: "inefficiency", 14: "imbalance"} if scenario == "stress" else {}
    missing_flow_slots = set()
    for injection in faults:
        if not isinstance(injection, dict) or type(injection.get("hour")) is not int:
            raise ValueError("faults: expected a fault kind and hour")
        slot, kind = injection["hour"], injection.get("kind")
        if not 0 <= slot < HOURS or not isinstance(kind, str) or kind not in FAULTS:
            raise ValueError("faults: unknown hour or kind")
        if kind == "sensor_dropout":
            missing_flow_slots.update(range(slot, min(slot + 2, HOURS)))
            continue
        events[slot] = kind
        if kind == "inefficiency" and slot + 1 < HOURS:
            events[slot + 1] = kind

    records = station_day(seed, START, events, site_id=site_id)[:hour + 1]
    for slot, row in enumerate(records):
        row.update(simulation_slot=slot, solar_wh=solar_profile["slots"][slot]["solar_wh"] if solar_profile else None)
    telemetry = project_telemetry(records, station.reference, missing_flow_slots)
    return {**_snapshot_metadata(station.reference, "simulated"), **telemetry, "solar_input": solar_profile,
            "physical_source": "local_replay", "seed": seed, "scenario": scenario,
            "site_id": site_id, "label": station.label, "capacity_m3": station.capacity_m3}


def station_day(seed, start, events, stock=None, *, site_id=DEFAULT_SITE):
    """Generate a repeatable day of hourly meter readings from operating conditions."""
    station = demo_station(site_id)
    if stock is None:
        stock = station.target_stock_m3
    rng = random.Random(seed)
    base_temperature = rng.uniform(19, 25)
    demand_factor = rng.uniform(0.85, 1.15)
    records = []
    for slot in range(HOURS):
        event = events.get(slot)
        available = event != "outage"
        daytime = max(0, math.sin(math.pi * (slot - 5) / 15))
        temperature = round(base_temperature + 9 * daytime + rng.uniform(-0.6, 0.6), 1)
        demand = max(3, round((4 + 4 * daytime) * demand_factor * station.demand_scale + rng.uniform(-1, 1)))
        pump_adjustment = rng.choice([-1, 0, 0, 1])
        energy_per_m3 = rng.randint(475, 535)
        auxiliary_kw = rng.uniform(0.10, 0.35)
        pumped = min(station.max_pump_m3, max(2, demand + pump_adjustment + (station.target_stock_m3 - stock) // 6)) if available else 0
        intensity = 700 if event == "inefficiency" else energy_per_m3 + round((station.reference - 0.50) * 1000)
        consumed = pumped * intensity
        inflow, unaccounted = pumped, 0
        delivery = min(demand if available else 2, stock + inflow)
        if event == "imbalance":
            # A metered transfer adds inflow independent of the electric pump.
            inflow, unaccounted = pumped + 15, 13
        stock += inflow - delivery - unaccounted
        records.append({
            "site_id": site_id, "timestamp": (start + timedelta(hours=slot)).isoformat(),
            "grid_available": available, "provenance": "simulated", "pumped_m3": pumped,
            "consumed_wh": consumed, "water_in_m3": inflow, "distributed_m3": delivery,
            "tank_stock_m3": stock, "event": event, "temperature_c": temperature,
            "load_kw": round(consumed / 1000 + auxiliary_kw, 3) if available else 0,
        })
    return records


def demo_network_snapshot(hour, site_id, fault_queues, *, seed=DEMO_SEED, scenario="routine", solar_profile=None):
    demo_station(site_id)
    if not isinstance(fault_queues, dict) or set(fault_queues) - STATIONS.keys():
        raise ValueError("fault_queues: use configured station IDs")
    snapshots = [demo_snapshot(hour, fault_queues.get(station, []), seed=seed, scenario=scenario, site_id=station,
                               solar_profile=solar_profile if solar_profile and solar_profile["site_id"] == station else None)
                 for station in STATIONS]
    return _network_snapshot(snapshots, site_id)


def telemetry_configured():
    return bool(os.environ.get("MIZU_TELEMETRY_URL"))


def connected_snapshot(site_id=None):
    url = os.environ.get("MIZU_TELEMETRY_URL")
    if not url:
        raise ValueError("Configure MIZU_TELEMETRY_URL to connect a station feed.")
    reference = float(os.environ.get("MIZU_TELEMETRY_REFERENCE", "0.5"))
    if not math.isfinite(reference) or reference <= 0:
        raise ValueError("MIZU_TELEMETRY_REFERENCE must be positive.")
    request = Request(url, headers={"Accept": "application/json"})
    if token := os.environ.get("MIZU_TELEMETRY_TOKEN"):
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urlopen(request, timeout=4) as response:
            body = response.read(256_001)
        if len(body) > 256_000:
            raise ValueError("Telemetry response exceeds 256 KB.")
        payload = json.loads(body)
    except (URLError, TimeoutError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Could not read the configured station feed.") from error
    records = payload.get("records") if isinstance(payload, dict) else None
    if not isinstance(records, list) or len(records) > 96:
        raise ValueError("The station feed must return up to 96 records.")
    allowed = (*NUMERIC_FIELDS, "site_id", "timestamp", "grid_available")
    samples = []
    for row in records:
        if not isinstance(row, dict) or not isinstance(row.get("site_id"), str) or not isinstance(row.get("timestamp"), str):
            raise ValueError("Each telemetry row needs a site_id and timestamp.")
        if any(row.get(key) is not None and (type(row[key]) not in {int, float} or not math.isfinite(row[key])) for key in NUMERIC_FIELDS):
            raise ValueError("Meter readings must be finite numbers or null.")
        if row.get("grid_available") is not None and type(row["grid_available"]) is not bool:
            raise ValueError("grid_available must be true, false or null.")
        samples.append({**{key: row.get(key) for key in allowed}, "provenance": "observed"})
    samples.sort(key=lambda row: datetime.fromisoformat(row["timestamp"]))
    references = payload.get("references", {})
    if not isinstance(references, dict) or any(type(value) not in {int, float} or not math.isfinite(value) or value <= 0
                                                for value in references.values()):
        raise ValueError("references: provide a positive kWh/m³ value per station")
    groups = {}
    for row in samples:
        groups.setdefault(row["site_id"], []).append(row)
    if not groups:
        return {**_snapshot([], None, "connected"), "stations": []}
    selected = next(iter(groups)) if site_id is None else site_id
    if not isinstance(selected, str) or selected not in groups:
        raise ValueError("site_id: no readings for the selected connected station")
    snapshots = []
    for station, rows in groups.items():
        station_reference = references.get(station, reference if len(groups) == 1 else None)
        snapshots.append({**_snapshot(rows[-24:], station_reference, "connected"), "site_id": station, "label": station})
    return _network_snapshot(snapshots, selected)


def _network_snapshot(snapshots, selected):
    overview = []
    for snapshot in snapshots:
        latest = snapshot["records"][-1]
        overview.append({"site_id": snapshot["site_id"], "label": snapshot["label"], "reference": snapshot["reference"],
                         "alerts": len(snapshot["alerts"]), "timestamp": latest["timestamp"],
                         "grid_available": latest["grid_available"], "stock_m3": latest["tank_stock_m3"],
                         "energy_check": snapshot["diagnostics"][0]["pump_energy_intensity"]})
    return {**next(snapshot for snapshot in snapshots if snapshot["site_id"] == selected), "stations": overview}


def _snapshot(records, reference, mode):
    analysis = analyze_telemetry(records, reference) if records else {"alerts": [], "diagnostics": []}
    return {**_snapshot_metadata(reference, mode), **analysis, "records": records}


def _snapshot_metadata(reference, mode):
    return {"reference": reference, "mode": mode, "connected_available": telemetry_configured(),
            "retrieved_at": datetime.now(timezone.utc).isoformat()}

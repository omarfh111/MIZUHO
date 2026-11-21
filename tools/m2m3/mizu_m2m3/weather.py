import json
import math
import random
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from .inputs import DATA


def _profile(profile, name):
    required = {"id", "issued_at", "timezone", "risk_start_slot", "source_id", "provenance", "slots"}
    if not isinstance(profile, dict) or required.difference(profile):
        raise ValueError(f"{name}: incomplete weather profile")
    if not all(isinstance(profile[field], str) and profile[field].strip() for field in (
        "id", "issued_at", "timezone", "source_id", "provenance",
    )):
        raise ValueError(f"{name}: expected nonempty profile metadata")
    if profile["provenance"] not in {"simulated", "estimated"}:
        raise ValueError(f"{name}.provenance: expected simulated or estimated")
    zone = ZoneInfo(profile["timezone"])
    issued = datetime.fromisoformat(profile["issued_at"])
    if issued.tzinfo is None:
        raise ValueError(f"{name}.issued_at: timezone offset required")
    valid = issued.astimezone(zone).date() + timedelta(days=1)
    if "valid_date" in profile and date.fromisoformat(profile["valid_date"]) != valid:
        raise ValueError(f"{name}.valid_date: expected the local day after issue")
    risk = profile["risk_start_slot"]
    if type(risk) is not int or not 0 <= risk < 24:
        raise ValueError(f"{name}.risk_start_slot: expected an integer from 0 to 23")

    slots = profile["slots"]
    if not isinstance(slots, list) or len(slots) != 24:
        raise ValueError(f"{name}.slots: expected 24 hourly entries")
    for hour, slot in enumerate(slots):
        if not isinstance(slot, dict) or type(slot.get("slot")) is not int or slot["slot"] != hour:
            raise ValueError(f"{name}.slots[{hour}].slot: expected {hour}")
        if type(slot.get("solar_wh")) not in {int, float} or not math.isfinite(slot["solar_wh"]) or slot["solar_wh"] < 0:
            raise ValueError(f"{name}.slots[{hour}].solar_wh: expected finite, nonnegative Wh")
        temperature = slot.get("temperature_c")
        if temperature is not None and (type(temperature) not in {int, float} or not math.isfinite(temperature)):
            raise ValueError(f"{name}.slots[{hour}].temperature_c: expected a finite temperature")
    return issued, valid


def load_weather_pair(pair_id, path=DATA / "weather/jplus1_demo.json"):
    with open(path, encoding="utf-8") as file:
        return validate_weather_pair(pair_id, json.load(file))


def validate_weather_pair(pair_id, pairs):
    if not isinstance(pairs, dict) or pair_id not in pairs:
        raise ValueError(f"pair: unknown weather pair {pair_id!r}")
    pair = pairs[pair_id]
    if not isinstance(pair, dict):
        raise ValueError(f"{pair_id}: expected a weather pair object")
    central, adverse = pair.get("central"), pair.get("adverse")
    issued, valid = _profile(central, "central")
    adverse_issued, adverse_valid = _profile(adverse, "adverse")
    risk = central["risk_start_slot"]
    if (
        issued != adverse_issued or valid != adverse_valid
        or central["timezone"] != adverse["timezone"] or risk != adverse["risk_start_slot"]
    ):
        raise ValueError("pair: profiles must share issue time, valid day, timezone, and risk start")
    if central["id"] == adverse["id"]:
        raise ValueError("pair: profiles need distinct ids")
    for base, lower in zip(central["slots"], adverse["slots"], strict=True):
        hour = base["slot"]
        if (hour < risk and base["solar_wh"] != lower["solar_wh"]) or lower["solar_wh"] > base["solar_wh"]:
            raise ValueError(f"adverse.slots[{hour}].solar_wh: must match before risk and cannot exceed central")
    return {"id": pair_id, "valid_date": valid.isoformat(), "risk_start_slot": risk,
            "central": central, "adverse": adverse}


def seeded_weather_pair(seed):
    if type(seed) is not int or not 0 <= seed <= 4_294_967_295:
        raise ValueError("seed: enter a whole number from 0 to 4294967295")
    rng = random.Random(seed)
    pair_id = f"jplus1-seed-{seed}"
    risk = rng.randint(10, 13)
    peak_wh = rng.randint(4500, 6500)
    cloud = rng.uniform(0.35, 0.65)
    central, adverse = [], []
    for hour in range(24):
        daylight = max(0, math.sin(math.pi * (hour - 7) / 11)) if 7 < hour < 18 else 0
        solar = round(peak_wh * daylight * rng.uniform(0.92, 1.0))
        temperature = round(15 + 9 * daylight + rng.uniform(-0.8, 0.8), 1)
        central.append({"slot": hour, "solar_wh": solar, "temperature_c": temperature})
        adverse.append({**central[-1], "solar_wh": round(solar * cloud) if hour >= risk else solar})
    metadata = {"issued_at": "2026-11-20T18:00:00+01:00", "timezone": "Africa/Tunis",
                "source_id": "seeded-solar-demo", "provenance": "simulated", "risk_start_slot": risk}
    pair = {"central": {**metadata, "id": f"{pair_id}-central", "slots": central},
            "adverse": {**metadata, "id": f"{pair_id}-adverse", "slots": adverse}}
    return {**validate_weather_pair(pair_id, {pair_id: pair}), "seed": seed}

import json
import math
from functools import lru_cache
from zoneinfo import ZoneInfo

import pandas as pd

from .inputs import DATA, grid_flags, hourly_timestamps, numeric, read_csv


def _load_series(path, site_id):
    if path is None:
        return None
    frame = read_csv(path, {"site_id", "timestamp", "load_wh", "grid_available"})
    frame = frame.loc[frame.site_id == site_id].copy()
    if frame.empty:
        raise ValueError(f"{path}: no load records for site_id {site_id!r}")
    frame.index = hourly_timestamps(frame.timestamp, "load.timestamp")
    if frame.index.has_duplicates:
        raise ValueError("load.timestamp: duplicate hour for the site")
    frame["load_wh"] = numeric(frame.load_wh, "load_wh", nonnegative=True)
    frame["grid_available"] = grid_flags(frame.grid_available)
    return frame


@lru_cache(maxsize=32)
def simulation_solar_profile(site_id, option_id, day=None):
    if not isinstance(site_id, str) or not isinstance(option_id, str) or (day is not None and not isinstance(day, str)):
        raise ValueError("provide site_id, option_id, and an optional profile date")
    option, = compare_solar(site_id, [option_id], load_path=None, day=day)
    return {"site_id": site_id, "solar_option_id": option_id, "label": option["label"],
            "profile_date": option["profile_date"], "timezone": option["timezone"], "source_id": option["source_id"],
            "provenance": option["provenance"], "source_url": option["source_url"],
            "latitude": option["latitude"], "longitude": option["longitude"],
            "capacity_kwp": option["capacity_kwp"], "tilt_deg": option["tilt_deg"],
            "compass_azimuth_deg": (180 + option["azimuth_deg"]) % 360,
            "slots": [{"slot": slot, "solar_wh": value} for slot, value in enumerate(option["profile_wh"])]}


def _self_consumed_kwh(solar, load):
    if load is None:
        return None
    aligned = load.reindex(solar.index)
    connected = aligned.grid_available.fillna(False)
    if aligned.grid_available.isna().any() or aligned.loc[connected, "load_wh"].isna().any():
        return None
    used_wh = solar.clip(upper=aligned.load_wh.fillna(0)).where(connected, 0)
    return float(used_wh.sum()) / 1000


def compare_solar(
    site_id, option_ids, price_tnd_per_kwh=None, *,
    options_path=DATA / "energy/options.json", profiles_path=DATA / "energy/pv_profiles.csv",
    load_path=DATA / "energy/load.csv", day=None,
):
    if price_tnd_per_kwh is not None and (
        not math.isfinite(price_tnd_per_kwh) or price_tnd_per_kwh < 0
    ):
        raise ValueError("price_tnd_per_kwh: expected a finite, nonnegative tariff")
    if not option_ids or len(set(option_ids)) != len(option_ids):
        raise ValueError("option_ids: provide distinct solar options")

    with open(options_path, encoding="utf-8") as file:
        catalog = json.load(file)
    site = catalog.get(site_id)
    if site is None:
        raise ValueError(f"site_id: unknown site {site_id!r}")
    for option_id in option_ids:
        if option_id not in site["options"]:
            raise ValueError(f"option_ids: unknown option {option_id!r} for {site_id}")

    day = pd.Timestamp(day or site["demo_day"])
    if pd.isna(day) or day.tzinfo is not None or day != day.normalize():
        raise ValueError("day: expected a local date in YYYY-MM-DD format")
    start = day.tz_localize(ZoneInfo(site["timezone"])).tz_convert("UTC")
    day_hours = pd.date_range(start, periods=24, freq="h")
    profiles = read_csv(profiles_path, {"site_id", "option_id", "timestamp", "solar_wh"})
    load = _load_series(load_path, site_id)
    results = []
    for option_id in option_ids:
        option = site["options"][option_id]
        rows = profiles.loc[(profiles.site_id == site_id) & (profiles.option_id == option_id)]
        solar = numeric(rows.solar_wh, "solar_wh", nonnegative=True)
        solar.index = hourly_timestamps(rows.timestamp, "solar.timestamp")
        if solar.index.has_duplicates:
            raise ValueError(f"solar.timestamp: duplicate hour for {site_id}/{option_id}")
        daily = solar.reindex(day_hours)
        if daily.isna().any():
            raise ValueError(f"solar_wh: incomplete profile for {site_id}/{option_id} on {day.date()}")

        year = option.get("series_year")
        annual = None
        if year is not None:
            year_hours = pd.date_range(f"{year}-01-01", f"{year + 1}-01-01", inclusive="left", freq="h", tz="UTC")
            candidate = solar.reindex(year_hours)
            if candidate.notna().all():
                annual = candidate
        consumed = _self_consumed_kwh(daily, load)
        annual_consumed = _self_consumed_kwh(annual, load) if annual is not None else None
        gross = consumed * price_tnd_per_kwh if consumed is not None and price_tnd_per_kwh is not None else None
        annual_gross = annual_consumed * price_tnd_per_kwh if annual_consumed is not None and price_tnd_per_kwh is not None else None
        operating_cost = option.get("annual_extra_cost_tnd")
        investment = option.get("investment_tnd")
        net = annual_gross - operating_cost if annual_gross is not None and operating_cost is not None else None
        results.append({
            **option,
            "id": option_id,
            "site_id": site_id,
            "timezone": site["timezone"],
            "profile_date": str(day.date()),
            "profile_wh": [int(round(value)) for value in daily],
            "production_kwh": float(daily.sum()) / 1000,
            "self_consumed_kwh": consumed,
            "grid_avoided_kwh": consumed,
            "gross_savings_tnd": gross,
            "annual_production_kwh": float(annual.sum()) / 1000 if annual is not None else None,
            "annual_self_consumed_kwh": annual_consumed,
            "annual_grid_avoided_kwh": annual_consumed,
            "annual_gross_savings_tnd": annual_gross,
            "net_savings_tnd": net,
            "payback_years": investment / net if investment is not None and net is not None and net > 0 else None,
        })
    return results

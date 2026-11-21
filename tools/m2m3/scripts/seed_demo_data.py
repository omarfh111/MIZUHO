"""Rebuild the shipped seeded CSVs from the station simulation model."""

import csv
import random
from datetime import datetime, timedelta
from pathlib import Path

from mizu_m2m3.simulation import DEMO_SEED, station_day
from mizu_m2m3.stations import STATIONS


DATA = Path(__file__).resolve().parents[1] / "data"
FIELDS = ["site_id", "timestamp", "load_kw", "temperature_c", "grid_available", "pumped_m3",
          "consumed_wh", "water_in_m3", "distributed_m3", "tank_stock_m3", "provenance"]


def write_csv(path, fields, rows):
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def telemetry(site_id, stressed):
    rng = random.Random(DEMO_SEED)
    start = datetime.fromisoformat("2026-10-17T00:00:00+01:00")
    stock = STATIONS[site_id].target_stock_m3
    result = []
    for day in range(35):
        events = {}
        if stressed and day in {9, 21, 34}:
            events = {9: "inefficiency", 10: "inefficiency", 14: "imbalance", 16: "outage"}
        rows = station_day(rng.getrandbits(32), start + timedelta(days=day), events, stock=stock, site_id=site_id)
        stock = rows[-1]["tank_stock_m3"]
        result.extend(rows if day < 34 else rows[:19])
    return result


def main():
    for scenario in ["routine", "stress"]:
        rows = (row for site_id in STATIONS for row in telemetry(site_id, scenario == "stress"))
        write_csv(DATA / f"telemetry/{scenario}-seed-{DEMO_SEED}.csv", FIELDS, rows)
    start = datetime.fromisoformat("2023-06-21T00:00:00+01:00")
    rows = station_day(DEMO_SEED, start, {13: "outage"})
    for row in rows:
        row["load_wh"] = round(row["load_kw"] * 1000)
    write_csv(DATA / "energy/load-irrigation.csv", ["site_id", "timestamp", "load_wh", "grid_available"], rows)


if __name__ == "__main__":
    main()

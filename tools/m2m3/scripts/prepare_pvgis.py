"""Rebuild the simulation CSV from the official PVGIS responses in the catalog."""

import csv
import json
from datetime import datetime, timezone
from pathlib import Path


ENERGY = Path(__file__).resolve().parents[1] / "data" / "energy"


def main():
    catalog = json.loads((ENERGY / "options.json").read_text(encoding="utf-8"))
    with (ENERGY / "pv_profiles.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file, lineterminator="\n")
        writer.writerow(["site_id", "option_id", "timestamp", "solar_wh"])
        for site_id, site in catalog.items():
            for option_id, option in site["options"].items():
                source = json.loads((ENERGY / option["source_file"]).read_text(encoding="utf-8"))
                for sample in source["outputs"]["hourly"]:
                    time = datetime.strptime(sample["time"], "%Y%m%d:%H%M").replace(minute=0, tzinfo=timezone.utc)
                    # Approximate each hour's Wh by treating its PVGIS power sample as representative of that hour.
                    writer.writerow([site_id, option_id, time.isoformat().replace("+00:00", "Z"), sample["P"]])


if __name__ == "__main__":
    main()

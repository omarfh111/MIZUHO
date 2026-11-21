"""Build data/agriculture/resilience.json from the downloaded climate and solar files.

    .\\.venv\\Scripts\\python.exe scripts\\m1_build_resilience.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

import json  # noqa: E402

from backend import resilience  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATASETS = {
    "data/raw/power/power_daily_1981-2025.json": {
        "source_id": "nasa-power-daily-1981-2025",
        "title": "NASA POWER daily T2M, T2M_MAX, PRECTOTCORR at the cluster point, 1981-2025",
        "organisation": "NASA Langley Research Center (POWER project)",
        "license": "public, no restriction (NASA open data)",
        "resolution": "0.5 x 0.625 degrees (MERRA-2)", "unit": "°C, mm/day", "status": "reanalysis"},
    "data/raw/pvgis/pvgis_pvcalc_1kwp.json": {
        "source_id": "jrc-pvgis-5.3",
        "title": "JRC PVGIS 5.3 PVcalc, 1 kWp free-standing, optimal angles, monthly yield at the cluster point",
        "organisation": "European Commission, Joint Research Centre",
        "license": "free reuse with attribution (European Commission reuse policy)",
        "resolution": "point, satellite radiation PVGIS-SARAH3", "unit": "kWh/kWp", "status": "modelled long-term average"},
}


def update_manifest() -> None:
    """Record the two climate files in data/manifest.json, with URL, query and SHA-256 from the download log."""
    log = {e["file"]: e for e in json.loads((ROOT / "data/raw/m1_downloads.json").read_text(encoding="utf-8"))}
    path = ROOT / "data/manifest.json"
    man = json.loads(path.read_text(encoding="utf-8"))
    for raw, meta in DATASETS.items():
        e = log[raw]
        entry = {**meta, "url": e["url"], "query": e["query"], "retrieved_at": e["retrieved_at"], "sha256": e["sha256"],
                 "raw_file": raw, "outputs": ["data/agriculture/resilience.json"]}
        man["datasets"] = [x for x in man["datasets"] if x["source_id"] != meta["source_id"]] + [entry]
    path.write_text(json.dumps(man, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


update_manifest()
d = resilience.build()
h = d["heat"]
print("heat", h["period"], {k: (v["slope_per_decade"], v["p"], v["verdict"]) for k, v in h["trend"].items()})
print("decades", h["decades"])
print("demand link", d["demand_link"])
for pid, s in d["seasons"].items():
    print(pid, [(x["year"], x["gap_mm_day"]) for x in s["seasons"]], s["gap_trend"]["verdict"], s["gap_vs_heat"])
print("solar", d["solar"]["pv_vs_demand"], d["solar"]["summer_pv_kwh_per_kwp_day"], d["solar"]["system"])

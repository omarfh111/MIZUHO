"""Refresh the offline Assila survey snapshot from the reviewed M1 Git revision."""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REVISION = "9f2a0c2b3246cf656ea7e07891987725f7d17b5b"
DESTINATION = ROOT / "data" / "agriculture" / "assila"


def source(path):
    return json.loads(subprocess.check_output(["git", "show", f"{REVISION}:data/{path}"], cwd=ROOT))


def write(name, data, *, compact=False):
    with (DESTINATION / name).open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=None if compact else 2,
                  separators=(",", ":") if compact else None)
        stream.write("\n")


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    site = source("sites.geojson")["features"][0]
    plots = source("plots.geojson")
    temperatures = source("agriculture/temperature_effect.json")
    manifest = source("manifest.json")
    write("site.geojson", site)
    write("plots.geojson", plots)
    write("wapor.geojson", source("layers/wapor_aeti_2026-07-D2.geojson"), compact=True)
    write("sources.json", [s for s in manifest["datasets"] if s.get("url")])
    write("temperature.json", {
        "period": temperatures["period"],
        "source_ids": temperatures["source_ids"],
        "plots": {p["plot_id"]: p["effect"]["all_year_equal_rain"] for p in temperatures["plots"]},
    })


if __name__ == "__main__":
    main()

"""M1 - download every raw source used by the agriculture data (no synthetic values).

Run from the repo root:
    .\\.venv\\Scripts\\python.exe scripts\\m1_fetch_sources.py

Writes into data/raw/ and records URL, query, retrieval time and SHA-256 of each
file in data/raw/m1_downloads.json, so anyone can re-download and compare.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
UA = {"User-Agent": "mizu-nexus-hackathon/0.1"}
OVERPASS = "https://overpass-api.de/api/interpreter"

# OSM area id of "Gouvernorat Jendouba" (relation 1435834, ISO3166-2 TN-32).
JENDOUBA_AREA = 3601435834
# Point inside the selected parcel cluster (see scripts/m1_build_data.py).
CLUSTER_POINT = (36.617, 8.981)
# WaPOR v3 dekad matching the STEG outage notice of 19 July 2026 (cahier, ref [1]).
WAPOR_DEKAD = "2026-07-D2"
WAPOR_MAPSETS = ["L2-AETI-D", "L1-PCP-D", "L1-RET-D"]
WAPOR_BOUNDS = (8.960, 36.600, 9.002, 36.634)  # lon_min, lat_min, lon_max, lat_max

log: list[dict] = []


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _record(path: Path, source: str, url: str, query: str | None = None) -> None:
    log.append({
        "file": path.relative_to(ROOT).as_posix(),
        "source": source,
        "url": url,
        "query": query,
        "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sha256": _sha256(path),
    })


def overpass(query: str, out: Path, tries: int = 6) -> None:
    for i in range(tries):
        r = requests.post(OVERPASS, data={"data": query}, headers=UA, timeout=180)
        if r.ok and r.text.lstrip().startswith("{"):
            data = r.json()
            if data.get("elements"):
                out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
                _record(out, "OpenStreetMap via Overpass API (ODbL)", OVERPASS, query)
                return
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"Overpass failed for {out.name}")


def fetch_osm() -> None:
    d = RAW / "osm"
    d.mkdir(parents=True, exist_ok=True)
    overpass(
        f'[out:json][timeout:120];area({JENDOUBA_AREA})->.j;'
        'way["landuse"~"farmland|orchard"](area.j);out meta geom;',
        d / "jendouba_farmland.json",
    )
    lat, lon = CLUSTER_POINT
    overpass(
        f'[out:json][timeout:60];is_in({lat},{lon})->.a;'
        'area.a["boundary"="administrative"];out tags;',
        d / "is_in_cluster.json",
    )


def fetch_wapor() -> None:
    import rasterio
    from rasterio.windows import Window, from_bounds

    d = RAW / "wapor"
    d.mkdir(parents=True, exist_ok=True)
    for ms in WAPOR_MAPSETS:
        code = f"WAPOR-3.{ms}.{WAPOR_DEKAD}"
        url = ("https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/"
               f"MAPSET/{ms}/{code}.tif")
        with rasterio.open("/vsicurl/" + url) as src:
            f = from_bounds(*WAPOR_BOUNDS, transform=src.transform)
            c0, r0 = math.floor(f.col_off), math.floor(f.row_off)
            w = Window(c0, r0, math.ceil(f.col_off + f.width) - c0,
                       math.ceil(f.row_off + f.height) - r0)
            a = src.read(1, window=w, boundless=True, fill_value=src.nodata)
            prof = {k: v for k, v in src.profile.items() if k not in ("blockxsize", "blockysize")}
            prof.update(driver="GTiff", width=a.shape[1], height=a.shape[0],
                        transform=src.window_transform(w), compress="deflate",
                        tiled=False, BIGTIFF="NO")
            out = d / f"{code}.tif"
            with rasterio.open(out, "w", **prof) as dst:
                dst.write(a, 1)
                dst.scales = src.scales
        _record(out, "FAO WaPOR v3 (CC BY 4.0), window read of the published COG",
                url, f"bounds={WAPOR_BOUNDS}")


# --- time series for the temperature effect ------------------------------------
SERIES_START, SERIES_END = "2018-01-D1", "2026-10-D3"
WAPOR_CATALOG = "https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets"
POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"


def wapor_dekads(mapset: str) -> list[str]:
    codes = []
    for off in range(0, 2000, 100):
        r = requests.get(f"{WAPOR_CATALOG}/{mapset}/rasters", params={"offset": off, "limit": 100},
                         headers=UA, timeout=90)
        r.raise_for_status()
        items = r.json()["response"]["items"]
        codes += [i["code"].split(".")[-1] for i in items]
        if len(items) < 100:
            break
    return sorted(c for c in set(codes) if SERIES_START <= c <= SERIES_END)


def fetch_wapor_series() -> None:
    """Window reads of every dekad, stacked as one multi-band GeoTIFF per mapset."""
    from concurrent.futures import ThreadPoolExecutor

    import numpy as np
    import rasterio
    from rasterio.windows import Window, from_bounds

    d = RAW / "wapor_series"
    d.mkdir(parents=True, exist_ok=True)
    for ms in ["L2-AETI-D", "L1-RET-D"]:
        dekads = wapor_dekads(ms)
        base = f"https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/{ms}/WAPOR-3.{ms}."
        with rasterio.open(f"/vsicurl/{base}{dekads[-1]}.tif") as src:
            f = from_bounds(*WAPOR_BOUNDS, transform=src.transform)
            c0, r0 = math.floor(f.col_off), math.floor(f.row_off)
            w = Window(c0, r0, math.ceil(f.col_off + f.width) - c0, math.ceil(f.row_off + f.height) - r0)
            prof = {k: v for k, v in src.profile.items() if k not in ("blockxsize", "blockysize")}
            prof.update(driver="GTiff", width=int(w.width), height=int(w.height), count=len(dekads),
                        transform=src.window_transform(w), compress="deflate", tiled=False, BIGTIFF="NO")
            scale = src.scales[0]

        def read(code: str):
            for i in range(4):
                try:
                    with rasterio.open(f"/vsicurl/{base}{code}.tif") as s:
                        return s.read(1, window=w, boundless=True, fill_value=s.nodata)
                except Exception:
                    time.sleep(3 * (i + 1))
            raise RuntimeError(f"WaPOR read failed: {ms} {code}")

        with ThreadPoolExecutor(8) as ex:
            arrays = list(ex.map(read, dekads))
        out = d / f"WAPOR-3.{ms}.{SERIES_START}_{SERIES_END}.tif"
        with rasterio.open(out, "w", **prof) as dst:
            dst.write(np.stack(arrays))
            dst.scales = [scale] * len(dekads)
            for i, code in enumerate(dekads, start=1):
                dst.set_band_description(i, code)
        _record(out, f"FAO WaPOR v3 {ms} (CC BY 4.0), one band per dekad, window reads",
                base + "{dekad}.tif", f"bounds={WAPOR_BOUNDS}; dekads {dekads[0]}..{dekads[-1]} ({len(dekads)})")
        print(ms, len(dekads), "dekads")


def fetch_power_temperature() -> None:
    d = RAW / "power"
    d.mkdir(parents=True, exist_ok=True)
    lat, lon = CLUSTER_POINT
    params = {"parameters": "T2M,T2M_MAX,PRECTOTCORR", "community": "AG", "latitude": lat,
              "longitude": lon, "start": "20180101", "end": "20261031", "format": "JSON"}
    r = requests.get(POWER_URL, params=params, headers=UA, timeout=180)
    r.raise_for_status()
    out = d / "power_daily_2018-2026.json"
    out.write_text(json.dumps(r.json(), indent=1), encoding="utf-8")
    _record(out, "NASA POWER daily point data (MERRA-2), public domain", POWER_URL,
            "&".join(f"{k}={v}" for k, v in params.items()))


# --- climate and resilience ------------------------------------------------------
CLIMATE_START, CLIMATE_END = "19810101", "20251231"   # full years available in NASA POWER daily
PVGIS_URL = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc"
PVGIS_LOSS_PCT = 14                                    # PVGIS default system loss


def fetch_power_climate() -> None:
    """45 years of daily temperature and rain at the parcel cluster (long-term trend)."""
    d = RAW / "power"
    d.mkdir(parents=True, exist_ok=True)
    lat, lon = CLUSTER_POINT
    params = {"parameters": "T2M,T2M_MAX,PRECTOTCORR", "community": "AG", "latitude": lat,
              "longitude": lon, "start": CLIMATE_START, "end": CLIMATE_END, "format": "JSON"}
    for i in range(4):
        r = requests.get(POWER_URL, params=params, headers=UA, timeout=300)
        if r.ok:
            break
        time.sleep(10 * (i + 1))
    r.raise_for_status()
    out = d / f"power_daily_{CLIMATE_START[:4]}-{CLIMATE_END[:4]}.json"
    out.write_text(json.dumps(r.json(), indent=None, separators=(",", ":")), encoding="utf-8")
    _record(out, "NASA POWER daily point data (MERRA-2), public domain", POWER_URL,
            "&".join(f"{k}={v}" for k, v in params.items()))


def fetch_pvgis() -> None:
    """JRC PVGIS monthly yield of 1 kWp at the parcel cluster (solar pumping potential)."""
    d = RAW / "pvgis"
    d.mkdir(parents=True, exist_ok=True)
    lat, lon = CLUSTER_POINT
    params = {"lat": lat, "lon": lon, "peakpower": 1, "loss": PVGIS_LOSS_PCT, "optimalangles": 1,
              "mountingplace": "free", "outputformat": "json"}
    r = requests.get(PVGIS_URL, params=params, headers=UA, timeout=120)
    r.raise_for_status()
    out = d / "pvgis_pvcalc_1kwp.json"
    out.write_text(json.dumps(r.json(), indent=1), encoding="utf-8")
    _record(out, "JRC PVGIS 5.3 PVcalc (European Commission), free reuse with attribution", PVGIS_URL,
            "&".join(f"{k}={v}" for k, v in params.items()))


def _save_log() -> None:
    path = RAW / "m1_downloads.json"
    old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    new_files = {e["file"] for e in log}
    merged = [e for e in old if e["file"] not in new_files] + log
    path.write_text(json.dumps(merged, indent=1), encoding="utf-8")


if __name__ == "__main__":
    import sys

    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "base"):
        fetch_osm()
        fetch_wapor()
    if what in ("all", "series"):
        fetch_power_temperature()
        fetch_wapor_series()
    if what in ("all", "climate"):
        fetch_power_climate()
        fetch_pvgis()
    _save_log()
    for e in log:
        print(e["file"], e["sha256"][:12])

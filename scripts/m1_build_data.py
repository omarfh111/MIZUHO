"""M1 - build the agriculture deliverables from the raw downloads only.

Run after scripts/m1_fetch_sources.py, from the repo root:
    .\\.venv\\Scripts\\python.exe scripts\\m1_build_data.py

Every output value is either copied from a source, computed from a source with
the formula written next to it, or null when no verified source exists.
"""
from __future__ import annotations

import csv
import json
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Geod
from shapely.geometry import Polygon, box, mapping
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
DATA = ROOT / "data"
GEOD = Geod(ellps="WGS84")
DEKAD = "2026-07-D2"
DEKAD_PERIOD = ("2026-07-11", "2026-07-20")

# Selection rule (executable, see select_parcels): among OSM landuse polygons whose
# centroid lies within SELECT_RADIUS_M of CLUSTER_POINT and whose area is at most
# 30 ha, keep the N_PARCELS with the highest WaPOR AETI for the dekad (most active
# water use, i.e. most likely irrigated). Same point as scripts/m1_fetch_sources.py.
CLUSTER_POINT = (36.617, 8.981)  # lat, lon
SELECT_RADIUS_M = 1500
MAX_AREA_M2 = 300_000
N_PARCELS = 5

LOCAL_FIELDS = ["farmer_id", "crop", "minimum_m3", "deadline_slot", "allowed_slots", "past_deferrals"]


def round_half_up(x: float) -> int:
    return int(Decimal(str(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def geodesic_area_m2(poly: Polygon) -> float:
    return abs(GEOD.geometry_area_perimeter(poly)[0])


def read_raster(mapset: str):
    path = RAW / "wapor" / f"WAPOR-3.{mapset}.{DEKAD}.tif"
    src = rasterio.open(path)
    a = src.read(1).astype(float)
    a[a == src.nodata] = np.nan
    return src, a * src.scales[0]


def area_weighted_mean(poly: Polygon, src, values) -> float | None:
    """Mean of the raster over the polygon, each pixel weighted by its overlapping area."""
    t = src.transform
    num = den = 0.0
    minx, miny, maxx, maxy = poly.bounds
    c0, r0 = ~t * (minx, maxy)
    c1, r1 = ~t * (maxx, miny)
    for r in range(max(0, int(r0)), min(values.shape[0], int(r1) + 1)):
        for c in range(max(0, int(c0)), min(values.shape[1], int(c1) + 1)):
            v = values[r, c]
            if np.isnan(v):
                continue
            x0, y0 = t * (c, r + 1)
            x1, y1 = t * (c + 1, r)
            inter = poly.intersection(box(x0, y0, x1, y1))
            if inter.is_empty:
                continue
            w = geodesic_area_m2(inter)
            num += w * v
            den += w
    return None if den == 0 else num / den


def select_parcels(ways: dict, aeti_src, aeti) -> list[tuple[int, Polygon, float]]:
    lat0, lon0 = CLUSTER_POINT
    cands = []
    for way_id, e in ways.items():
        pts = [(p["lon"], p["lat"]) for p in e.get("geometry", [])]
        if len(pts) < 4 or pts[0] != pts[-1]:
            continue
        poly = Polygon(pts)
        c = poly.centroid
        if GEOD.inv(lon0, lat0, c.x, c.y)[2] > SELECT_RADIUS_M or geodesic_area_m2(poly) > MAX_AREA_M2:
            continue
        eta = area_weighted_mean(poly, aeti_src, aeti)
        if eta is not None:
            cands.append((way_id, poly, eta))
    cands.sort(key=lambda t: (-t[2], t[0]))
    return sorted(cands[:N_PARCELS], key=lambda t: t[0])


def main() -> None:
    downloads = {e["file"]: e for e in json.loads((RAW / "m1_downloads.json").read_text(encoding="utf-8"))}
    osm = json.loads((RAW / "osm" / "jendouba_farmland.json").read_text(encoding="utf-8"))
    osm_base = osm["osm3s"]["timestamp_osm_base"]
    ways = {e["id"]: e for e in osm["elements"]}
    admin = {e["tags"].get("admin_level"): e for e in
             json.loads((RAW / "osm" / "is_in_cluster.json").read_text(encoding="utf-8"))["elements"]}

    aeti_src, aeti = read_raster("L2-AETI-D")
    pcp_src, pcp = read_raster("L1-PCP-D")
    ret_src, ret = read_raster("L1-RET-D")

    delegation = admin["5"]["tags"].get("name:fr") or admin["5"]["tags"].get("name")
    imada = admin["6"]["tags"].get("name:fr") or admin["6"]["tags"].get("name")
    slug = lambda t: re.sub(r"[^A-Z0-9]+", "", unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode().upper().replace("DELEGATION", ""))
    site_id = f"{admin['4']['tags'].get('ISO3166-2', 'TN')}-{slug(delegation)}-{slug(imada)}"

    features, rows, polys = [], [], []
    for i, (way_id, poly, eta) in enumerate(select_parcels(ways, aeti_src, aeti), start=1):
        e = ways[way_id]
        polys.append(poly)
        surface = round_half_up(geodesic_area_m2(poly))
        p = area_weighted_mean(poly, pcp_src, pcp)
        et0 = area_weighted_mean(poly, ret_src, ret)
        # Stored at 0.01 mm precision; the volume is computed from the stored value.
        need_mm = None if eta is None or p is None else round(max(0.0, eta - p), 2)
        demand_raw = None if need_mm is None else need_mm * surface / 1000
        props = {
            "plot_id": f"P-{i:02d}",
            "site_id": site_id,
            "farmer_id": None,
            "surface_m2": surface,
            "land_use": e["tags"]["landuse"],
            "crop": None,
            "eta_mm_day": None if eta is None else round(eta, 2),
            "precip_mm_day": None if p is None else round(p, 2),
            "ref_et_mm_day": None if et0 is None else round(et0, 2),
            "irrigation_need_mm_day": None if need_mm is None else round(need_mm, 2),
            "demand_m3_raw": None if demand_raw is None else round(demand_raw, 3),
            "demand_m3": None if demand_raw is None else round_half_up(demand_raw),
            "minimum_m3": None,
            "deadline_slot": None,
            "allowed_slots": None,
            "past_deferrals": None,
            "period": f"{DEKAD_PERIOD[0]}/{DEKAD_PERIOD[1]}",
            "source_id": "osm-jendouba-farmland",
            "need_source_id": "wapor3-l2-aeti-2026-07-d2",
            "osm_way_id": way_id,
            "osm_version": e.get("version"),
            "osm_last_edit": e.get("timestamp"),
            "status": {
                "geometry": "observed",
                "surface_m2": "computed",
                "demand_m3": "estimated",
                **{f: "local_data_required" for f in LOCAL_FIELDS},
            },
        }
        features.append({"type": "Feature", "geometry": mapping(poly), "properties": props})
        rows.append(props)

    hull = unary_union(polys).convex_hull
    lon, lat = hull.centroid.x, hull.centroid.y
    site = {
        "type": "Feature",
        "geometry": mapping(hull),
        "properties": {
            "site_id": site_id,
            "label": f"Parcelles OSM, {imada}, {delegation}, {admin['4']['tags'].get('name:fr')}",
            "governorate": admin["4"]["tags"].get("name:fr"),
            "governorate_iso": admin["4"]["tags"].get("ISO3166-2"),
            "delegation": delegation,
            "imada": imada,
            "osm_admin_area_ids": {k: v["id"] for k, v in admin.items()},
            "centroid_lon_lat": [round(lon, 6), round(lat, 6)],
            "selection_rule": f"top {N_PARCELS} OSM landuse polygons by WaPOR AETI {DEKAD}, centroid within {SELECT_RADIUS_M} m of {CLUSTER_POINT} (lat, lon), area <= {MAX_AREA_M2} m2",
            "plot_ids": [f["properties"]["plot_id"] for f in features],
            "quota_m3": None,
            "quota_status": "local_data_required",
            "geometry_rule": "convex hull of the selected OSM parcels",
            "source_id": "osm-jendouba-admin",
            "status": "observed",
        },
    }

    # WaPOR AETI pixel layer for the map (Leaflet), values in mm/day.
    t = aeti_src.transform
    pixels = []
    for r in range(aeti.shape[0]):
        for c in range(aeti.shape[1]):
            v = aeti[r, c]
            if np.isnan(v):
                continue
            x0, y0 = t * (c, r + 1)
            x1, y1 = t * (c + 1, r)
            pixels.append({"type": "Feature", "geometry": mapping(box(x0, y0, x1, y1)),
                           "properties": {"eta_mm_day": round(float(v), 1)}})
    layer = {
        "type": "FeatureCollection",
        "name": f"wapor3_l2_aeti_{DEKAD}",
        "metadata": {
            "source_id": "wapor3-l2-aeti-2026-07-d2",
            "variable": "Actual EvapoTranspiration and Interception (AETI)",
            "unit": "mm/day", "period": f"{DEKAD_PERIOD[0]}/{DEKAD_PERIOD[1]}",
            "resolution_deg": abs(t.a), "resolution_approx_m": 100,
            "extent_lon_lat": list(aeti_src.bounds), "status": "observed (satellite estimate)",
        },
        "features": pixels,
    }

    (DATA / "layers").mkdir(parents=True, exist_ok=True)
    (DATA / "agriculture").mkdir(parents=True, exist_ok=True)
    dump = lambda p, o: p.write_text(json.dumps(o, ensure_ascii=False, indent=1), encoding="utf-8")
    dump(DATA / "plots.geojson", {"type": "FeatureCollection", "features": features})
    dump(DATA / "sites.geojson", {"type": "FeatureCollection", "features": [site]})
    (DATA / "layers" / f"wapor_aeti_{DEKAD}.geojson").write_text(
        json.dumps(layer, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    cols = ["plot_id", "site_id", "land_use", "crop", "surface_m2", "period", "eta_mm_day",
            "precip_mm_day", "ref_et_mm_day", "irrigation_need_mm_day", "demand_m3_raw",
            "demand_m3", "minimum_m3", "deadline_slot", "source_id", "need_source_id"]
    with open(DATA / "agriculture" / "needs.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r[k] is None else r[k]) for k in cols})

    def dl(name):
        return downloads[f"data/raw/{name}"]

    manifest = {
        "version": "m1-0.1",
        "rounding_rule": "demand_m3 = round_half_up(irrigation_need_mm_day * surface_m2 / 1000); raw value kept in demand_m3_raw",
        "need_formula": "irrigation_need_mm_day = max(0, WaPOR AETI - WaPOR PCP), dekad mean; soil water storage and application efficiency not modelled",
        "datasets": [
            {
                "source_id": "osm-jendouba-farmland",
                "title": "OpenStreetMap landuse=farmland|orchard, Gouvernorat Jendouba",
                "organisation": "OpenStreetMap contributors", "license": "ODbL 1.0",
                "url": dl("osm/jendouba_farmland.json")["url"], "query": dl("osm/jendouba_farmland.json")["query"],
                "osm_snapshot": osm_base, "retrieved_at": dl("osm/jendouba_farmland.json")["retrieved_at"],
                "sha256": dl("osm/jendouba_farmland.json")["sha256"],
                "raw_file": "data/raw/osm/jendouba_farmland.json", "outputs": ["data/plots.geojson"],
                "crs": "EPSG:4326 (lon, lat)", "status": "observed",
                "limits": "Selected polygons were last edited in 2012; no crop tag; owners unknown.",
            },
            {
                "source_id": "osm-jendouba-admin",
                "title": "OpenStreetMap administrative areas containing the parcel cluster",
                "organisation": "OpenStreetMap contributors", "license": "ODbL 1.0",
                "url": dl("osm/is_in_cluster.json")["url"], "query": dl("osm/is_in_cluster.json")["query"],
                "retrieved_at": dl("osm/is_in_cluster.json")["retrieved_at"],
                "sha256": dl("osm/is_in_cluster.json")["sha256"],
                "raw_file": "data/raw/osm/is_in_cluster.json", "outputs": ["data/sites.geojson"],
                "status": "observed",
            },
            *[
                {
                    "source_id": sid,
                    "title": f"FAO WaPOR v3 {ms} {DEKAD}",
                    "organisation": "FAO", "license": "CC BY 4.0",
                    "url": dl(f"wapor/WAPOR-3.{ms}.{DEKAD}.tif")["url"],
                    "window": dl(f"wapor/WAPOR-3.{ms}.{DEKAD}.tif")["query"],
                    "retrieved_at": dl(f"wapor/WAPOR-3.{ms}.{DEKAD}.tif")["retrieved_at"],
                    "sha256": dl(f"wapor/WAPOR-3.{ms}.{DEKAD}.tif")["sha256"],
                    "raw_file": f"data/raw/wapor/WAPOR-3.{ms}.{DEKAD}.tif",
                    "period": f"{DEKAD_PERIOD[0]}/{DEKAD_PERIOD[1]}", "unit": "mm/day",
                    "resolution": res, "status": "observed (satellite estimate)",
                    "outputs": outs,
                }
                for sid, ms, res, outs in [
                    ("wapor3-l2-aeti-2026-07-d2", "L2-AETI-D", "100 m",
                     ["data/plots.geojson", "data/agriculture/needs.csv", f"data/layers/wapor_aeti_{DEKAD}.geojson"]),
                    ("wapor3-l1-pcp-2026-07-d2", "L1-PCP-D", "about 5 km", ["data/agriculture/needs.csv"]),
                    ("wapor3-l1-ret-2026-07-d2", "L1-RET-D", "about 30 km", ["data/agriculture/needs.csv"]),
                ]
            ],
            {
                "source_id": "cdc-v5-p8",
                "title": "Cahier des charges MIZU NEXUS Tunisie v5, cas miniature A/B",
                "organisation": "Équipe MIZU NEXUS", "file": "Cahier des charges MIZU NEXUS Tunisie v5.docx",
                "outputs": ["data/agriculture/mini_plots.json"], "status": "specification test case",
            },
        ],
    }
    dump(DATA / "manifest.json", manifest)
    for r in rows:
        print(r["plot_id"], r["land_use"], r["surface_m2"], "m2", "ETa", r["eta_mm_day"],
              "P", r["precip_mm_day"], "ET0", r["ref_et_mm_day"], "->", r["demand_m3_raw"], "m3/day")


if __name__ == "__main__":
    main()

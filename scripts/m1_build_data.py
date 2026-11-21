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
                "limits": f"Selected polygons last edited {min(r['osm_last_edit'] for r in rows)[:10]}; no crop tag; owners unknown.",
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
    if (RAW / "power").exists() and (RAW / "wapor_series").exists():
        manifest["datasets"] += build_temperature_effect(features, downloads, dump)
    dump(DATA / "manifest.json", manifest)
    for r in rows:
        print(r["plot_id"], r["land_use"], r["surface_m2"], "m2", "ETa", r["eta_mm_day"],
              "P", r["precip_mm_day"], "ET0", r["ref_et_mm_day"], "->", r["demand_m3_raw"], "m3/day")


def _dekad_days(code: str) -> tuple[int, int, int, int]:
    """'2026-07-D2' -> (2026, 7, 11, 20)."""
    import calendar
    y, m, d = int(code[:4]), int(code[5:7]), int(code[-1])
    start = {1: 1, 2: 11, 3: 21}[d]
    end = {1: 10, 2: 20, 3: calendar.monthrange(y, m)[1]}[d]
    return y, m, start, end


def _band_means(path: Path, polys: list[Polygon]) -> tuple[list[str], list[list[float | None]]]:
    """Area-weighted mean of every band for each polygon. Returns (dekad codes, values[poly][band])."""
    with rasterio.open(path) as src:
        codes = list(src.descriptions)
        data = src.read().astype(float)
        data[data == src.nodata] = np.nan
        data *= src.scales[0]
        t = src.transform
        out = []
        for poly in polys:
            weights = []
            for r in range(src.height):
                for c in range(src.width):
                    x0, y0 = t * (c, r + 1)
                    x1, y1 = t * (c + 1, r)
                    inter = poly.intersection(box(x0, y0, x1, y1))
                    if not inter.is_empty:
                        weights.append((r, c, geodesic_area_m2(inter)))
            vals = []
            for b in range(data.shape[0]):
                pts = [(data[b, r, c], w) for r, c, w in weights if not np.isnan(data[b, r, c])]
                den = sum(w for _, w in pts)
                vals.append(None if den == 0 else sum(v * w for v, w in pts) / den)
            out.append(vals)
    return codes, out


def build_temperature_effect(features: list[dict], downloads: dict, dump) -> list[dict]:
    import sys
    sys.path.insert(0, str(ROOT))
    from backend.temperature_effect import ALPHA, DRY_MONTHS, analyse, simple_effect

    power = json.loads((RAW / "power" / "power_daily_2018-2026.json").read_text(encoding="utf-8"))
    par = power["properties"]["parameter"]
    fill = power["header"]["fill_value"]

    def dekad_mean(name: str, code: str) -> float | None:
        y, m, a, b = _dekad_days(code)
        v = [par[name].get(f"{y}{m:02d}{d:02d}") for d in range(a, b + 1)]
        v = [x for x in v if x is not None and x != fill]
        return None if len(v) < (b - a + 1) * 0.8 else round(sum(v) / len(v), 2)

    aeti_path = next((RAW / "wapor_series").glob("WAPOR-3.L2-AETI-D.*.tif"))
    ret_path = next((RAW / "wapor_series").glob("WAPOR-3.L1-RET-D.*.tif"))
    polys = [Polygon(f["geometry"]["coordinates"][0]) for f in features]
    codes, aeti = _band_means(aeti_path, polys)
    ret_codes, ret = _band_means(ret_path, [unary_union(polys).convex_hull])
    ret_by = dict(zip(ret_codes, ret[0]))

    climate = {c: {"dekad": c, "month": int(c[5:7]), "tmax_c": dekad_mean("T2M_MAX", c),
                   "tmean_c": dekad_mean("T2M", c), "precip_mm_day": dekad_mean("PRECTOTCORR", c)}
               for c in codes}
    ret_series = [(climate[c]["tmax_c"], None if ret_by.get(c) is None else ret_by[c]) for c in codes]
    nan = lambda v: np.nan if v is None else v
    plots_out = []
    for f, vals in zip(features, aeti):
        p = f["properties"]
        series = [{**climate[c], "aeti_mm_day": None if v is None else round(v, 2),
                   "ret_mm_day": None if ret_by.get(c) is None else round(ret_by[c], 2)} for c, v in zip(codes, vals)]
        num = [{k: (nan(v) if k not in ("dekad", "month") else v) for k, v in s.items()} for s in series]
        plots_out.append({"plot_id": p["plot_id"], "surface_m2": p["surface_m2"],
                          "effect": analyse(num, p["surface_m2"]), "series": series})

    result = {
        "question": "Does air temperature change the water actually used (WaPOR AETI) by each parcel?",
        "period": f"{codes[0]}..{codes[-1]}", "n_dekads": len(codes),
        "temperature": "dekad mean of daily maximum air temperature at 2 m (NASA POWER, MERRA-2)",
        "water_use": "WaPOR v3 L2 AETI, area-weighted over the parcel, mm/day",
        "dry_season_months": list(DRY_MONTHS), "alpha": ALPHA,
        "methods": {
            "all_year": "linear regression AETI ~ Tmax over all dekads",
            "all_year_equal_rain": "multiple regression AETI ~ Tmax + rainfall; effect of Tmax at equal rainfall",
            "dry_season": "linear regression AETI ~ Tmax on June-September dekads only",
        },
        "climatic_demand": {"label": "WaPOR reference ET (RET) vs Tmax, site",
                            **simple_effect([nan(t) for t, _ in ret_series], [nan(r) for _, r in ret_series])},
        "limits": [
            "C'est une association observée, pas une preuve de cause : la saison, le stade des cultures et l'apport d'irrigation changent en même temps que la température.",
            "Les périodes de 10 jours se suivent et se ressemblent (autocorrélation) : les valeurs p sont donc optimistes.",
            "La température NASA POWER est une réanalyse sur une grille d'environ 50 km, pas une station à la parcelle.",
            "Les parcelles OSM ont été tracées en 2025 : l'occupation du sol a pu être différente les années précédentes.",
        ],
        "source_ids": ["wapor3-l2-aeti-series", "wapor3-l1-ret-series", "nasa-power-daily"],
        "plots": plots_out,
    }
    dump(DATA / "agriculture" / "temperature_effect.json", result)
    for po in plots_out:
        e = po["effect"]
        print("temp", po["plot_id"], {k: (v["slope"], v["p"], v["verdict"]) for k, v in e.items()})
    print("RET vs Tmax", result["climatic_demand"])

    def dl(path: Path) -> dict:
        return downloads[path.relative_to(ROOT).as_posix()]

    pw = RAW / "power" / "power_daily_2018-2026.json"
    return [
        {"source_id": "nasa-power-daily", "title": "NASA POWER daily T2M, T2M_MAX, PRECTOTCORR at the cluster point",
         "organisation": "NASA Langley Research Center (POWER project)", "license": "public, no restriction (NASA open data)",
         "url": dl(pw)["url"], "query": dl(pw)["query"], "retrieved_at": dl(pw)["retrieved_at"], "sha256": dl(pw)["sha256"],
         "raw_file": pw.relative_to(ROOT).as_posix(), "resolution": "0.5 x 0.625 degrees (MERRA-2)", "unit": "°C, mm/day",
         "status": "reanalysis", "outputs": ["data/agriculture/temperature_effect.json"]},
        *[{"source_id": sid, "title": f"FAO WaPOR v3 {ms}, all dekads {codes[0]}..{codes[-1]}", "organisation": "FAO",
           "license": "CC BY 4.0", "url": dl(p)["url"], "window": dl(p)["query"], "retrieved_at": dl(p)["retrieved_at"],
           "sha256": dl(p)["sha256"], "raw_file": p.relative_to(ROOT).as_posix(), "unit": "mm/day",
           "status": "observed (satellite estimate)", "outputs": ["data/agriculture/temperature_effect.json"]}
          for sid, ms, p in [("wapor3-l2-aeti-series", "L2-AETI-D", aeti_path), ("wapor3-l1-ret-series", "L1-RET-D", ret_path)]],
    ]


if __name__ == "__main__":
    main()

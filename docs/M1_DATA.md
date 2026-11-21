# M1 data: sources, method and limits

Rule followed: **no invented values**. Each value is either copied from a source, computed from a source with the formula below, or `null` with the status `local_data_required`.

## Rebuild from scratch

```powershell
.\.venv\Scripts\python.exe -m pip install requests rasterio pyproj shapely numpy pytest
.\.venv\Scripts\python.exe scripts\m1_fetch_sources.py   # downloads into data/raw/ + SHA-256 log
.\.venv\Scripts\python.exe scripts\m1_build_data.py      # builds the deliverables from data/raw/ only
.\.venv\Scripts\python.exe -m pytest tests\test_agriculture.py
```

## Test bench (frontend)

```powershell
.\.venv\Scripts\python.exe scripts\m1_test_server.py
```

Open http://127.0.0.1:8765. The page (`tools/m1_test_ui/index.html`) runs each step against the real `backend/agriculture.py`: source integrity (SHA-256), map of the parcels and the WaPOR layer, `load_plots`, the mm → m³ conversion, the coverage rate, the rejection cases and the full pytest suite. It uses only the standard library, separate from the M6 API. The base map needs Internet; the local layers work without it.

The demo itself reads only local files. `data/raw/m1_downloads.json` records the URL, query, retrieval time and SHA-256 of each raw file.

## Sources

| source_id | What | Licence |
|---|---|---|
| `osm-jendouba-farmland` | OpenStreetMap `landuse=farmland\|orchard` polygons, Gouvernorat Jendouba (Overpass API) | ODbL 1.0 |
| `osm-jendouba-admin` | OSM administrative areas containing the cluster (governorate, delegation, imada) | ODbL 1.0 |
| `wapor3-l2-aeti-2026-07-d2` | FAO WaPOR v3, actual evapotranspiration and interception, 100 m, 11–20 July 2026 | CC BY 4.0 |
| `wapor3-l1-pcp-2026-07-d2` | FAO WaPOR v3, precipitation, about 5 km, same dekad | CC BY 4.0 |
| `wapor3-l1-ret-2026-07-d2` | FAO WaPOR v3, reference ET, about 30 km, same dekad | CC BY 4.0 |
| `cdc-v5-p8` | Cahier des charges v5, A/B mini case (specification test case) | team |

The dekad 11–20 July 2026 includes the STEG outage notice of 19 July 2026 (cahier, ref. [1]).

## Method

1. **Parcel selection (executable rule in `scripts/m1_build_data.py`).** Among OSM polygons whose centroid is within 1.5 km of 36.617 N, 8.981 E and whose area is ≤ 30 ha, take the 5 with the highest WaPOR AETI for the dekad. High ET with no rain in July means active water use, so these are the parcels most likely irrigated.
2. **Surface.** Geodesic area of the OSM polygon on the WGS84 ellipsoid, rounded half up to 1 m².
3. **Satellite values per parcel.** Mean of each raster over the polygon, each pixel weighted by its overlapping area.
4. **Irrigation need (mm/day)** = max(0, AETI − precipitation), stored at 0.01 mm.
5. **Volume.** `demand_m3_raw = need_mm × surface_m2 / 1000`; `demand_m3 = round_half_up(demand_m3_raw)`. This is a daily volume, the mean over the dekad.
6. **Site.** Convex hull of the 5 parcels; names come from the OSM admin areas.

## Result (rebuilt 2026-11-21)

Site `TN-32-BALTABOUAWENE-ASSILA`: imada Assila, Délégation Balta Bouawene, Gouvernorat Jendouba. The OSM polygons were drawn on 2025-06-21.

| plot | surface m² | AETI mm/day | rain mm/day | ET0 mm/day | demand m³/day |
|---|---|---|---|---|---|
| P-01 | 47 851 | 1.25 | 0 | 8.70 | 60 |
| P-02 | 85 233 | 1.21 | 0 | 8.58 | 103 |
| P-03 | 99 796 | 3.26 | 0 | 8.70 | 325 |
| P-04 | 96 621 | 2.61 | 0 | 8.70 | 252 |
| P-05 | 46 389 | 3.09 | 0 | 8.70 | 143 |

## Does temperature change the water used?

`data/agriculture/temperature_effect.json`, built by `scripts/m1_build_data.py` with `backend/temperature_effect.py`. Raw series: `python scripts/m1_fetch_sources.py series`.

- **Water used:** WaPOR v3 L2 AETI for each parcel, every dekad from 2018-01-D1 to 2026-10-D3 (318 dekads, area-weighted).
- **Temperature and rain:** NASA POWER daily `T2M_MAX` and `PRECTOTCORR` at 36.617 N, 8.981 E (MERRA-2 reanalysis), averaged per dekad. Open-Meteo was tried first but refused requests (daily limit).
- **Tests (α = 0.05):** linear regression of AETI on Tmax over the whole year; the same at equal rainfall (multiple regression with rain); and over June–September only. Climatic demand: WaPOR reference ET against Tmax.

| plot | whole year, equal rain | dry season (Jun–Sep) |
|---|---|---|
| P-01 | no effect (p = 0.77) | no effect (p = 0.96) |
| P-02 | ↑ +0.016 mm/day per °C, +1.4 m³/day (p = 0.022) | no effect (p = 0.70) |
| P-03 | ↑ +0.027 mm/day per °C, +2.7 m³/day (p = 0.0002) | no effect (p = 0.73) |
| P-04 | ↑ +0.021 mm/day per °C, +2.1 m³/day (p = 0.002) | no effect (p = 0.84) |
| P-05 | ↑ +0.026 mm/day per °C, +1.2 m³/day (p = 0.0004) | no effect (p = 0.96) |

Reference ET rises by +0.24 mm/day per °C (r = 0.93), about 9 times the largest rise in water actually used. Reading: heat raises the demand strongly, but in summer the parcels do not get more water when it is hotter, so water supply, not temperature, limits their use.

Limits: an association, not a proof of cause; consecutive dekads are autocorrelated, so p-values are optimistic; the temperature grid is about 50 km wide; the OSM parcels were drawn in 2025 and land use may have differed in earlier years.

## Fields left `null` (no public source)

| Field | Why | Who can provide it |
|---|---|---|
| `farmer_id` | Owners are not in any open dataset | Groupement (GDA) register |
| `crop` | No OSM crop tag; WaPOR does not give crop type | Field survey or CRDA Jendouba |
| `minimum_m3`, `deadline_slot`, `allowed_slots`, `past_deferrals` | Water-turn rules of the groupement | Groupement / CRDA |
| `quota_m3` (site) | Allocation is not published per groupement | CRDA / DGRE |

`Plot.solver_ready` is `False` for these parcels until those fields are filled. Only the A/B mini case (values from the cahier) is solver-ready today.

## Limits

- AETI measures water actually evaporated and transpired, not the crop's full requirement. The ratio AETI/ET0 is ≤ 0.38 for all selected parcels, so the satellite shows these fields under-supplied, partly irrigated or partly fallow during this dekad. The demand is what was actually used, not what the crop would need without water stress.
- Soil water storage and irrigation efficiency are not modelled: there is no source for them at this site.
- Precipitation (5 km) and ET0 (30 km) are much coarser than the parcels.
- Across all 99 OSM farm polygons in Jendouba, the highest AETI for this dekad is 3.3 mm/day. Strongly irrigated fields exist in the WaPOR pixels (up to 11 mm/day) but are not mapped as OSM polygons.
- Daily volumes (60–325 m³) are far larger than the cahier's mini case (pump 10 m³/h). Site equipment (pump, tank) belongs to M4/M6 and has no public source either.

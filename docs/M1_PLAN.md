# M1 plan: geographic data, crop water needs and quota

> **Status (2026-11-21):** first version delivered, built only from verified sources (OSM, FAO WaPOR v3, cahier for A/B). The "fictional polygons" and "fictional quota" in the cahier were replaced by real data or `null`. Method, sources and limits: [M1_DATA.md](M1_DATA.md).

Lot 1 of MIZU NEXUS. Source: *Cahier des charges MIZU NEXUS Tunisie v5*, M1 section and the 3-slot test case.

**Goal:** deliver the parcels, their irrigation needs and the volume rules as local files, so the demo runs without any network call.

## Deliverables

| File | Content |
|---|---|
| `data/sites.geojson` | One fictional groupement in Jendouba: `site_id`, `label`, `source_id`, `status`, and the scenario's fictional quota. |
| `data/plots.geojson` | A and B from the 3-slot case, plus 5 fictional polygons drawn in QGIS. WGS84, longitude first. |
| `data/agriculture/needs.csv` | Per parcel: crop, irrigation mm, surface, raw m³, rounded m³, minimum, deadline, source, status. |
| `data/layers/wapor_jendouba.geojson` | Dated WaPOR ETa extract with extent, 10 m resolution and status (observed or simulated). |
| `data/manifest.json` | Version, source, period, resolution, unit, extent and status for each data file. |
| `backend/agriculture.py` | `load_plots(site_id)`, `mm_to_m3()`, validation. |
| `tests/test_agriculture.py` | Acceptance tests (see below). |

## Contract

`load_plots(site_id) -> list[Plot]`

Fields: `plot_id, farmer_id, surface_m2, crop, demand_m3, minimum_m3, deadline_slot, allowed_slots, past_deferrals, source_id`

- **Consumers:** M4/M5 (simulator, optimizer), M6 (`/api/scenarios`, `/api/sites`), M7 (map).
- **Schema owner:** the `Plot` model lives in `backend/models.py` (M6). M1 proposes the fields in the first hour; no duplicate definition.

## Data content

**A and B (3-slot case):** `minimum_m3 = demand_m3 = 10`, `allowed_slots = [1, 2]`, `deadline_slot = 2`, `past_deferrals = 0`. Due by H+1: every module tests against them.

**5 parcels for the 24-slot scenarios:**
- Typical Jendouba crops (e.g. tomato, potato, cereal, olive, fodder).
- Different needs and minimums so per-farmer coverage is clearly visible.
- At least one parcel with `past_deferrals > 0` (tests the solver's weighting).
- One parcel with `minimum_m3 = 0` (non-priority).
- Every value tagged `simulated`, or marked as needing a local opinion.
- Fictional identifiers only.

**Conversion and rounding:** m³ = mm × m² ÷ 1000. Keep the raw value; store an integer m³. Proposed rule: round half up, documented in the manifest. FAO-56 (Gabesi AIGuardian) is optional, only if data is available.

**Missing values** stay `null`, never 0.

## Validation and tests

From the cahier:
- 4 mm on 500 m² gives 2 m³.
- Duplicate `plot_id` is rejected.
- Parcel without a site, or with an unknown site, is rejected.
- `minimum_m3 > demand_m3` is rejected.
- Every layer opens locally.

Added checks:
- Slots between 0 and 23.
- `deadline_slot` is one of `allowed_slots`.
- All volumes are integers ≥ 0.
- Coordinates inside Tunisia, longitude first.
- Each `source_id` exists in `manifest.json`.
- Minimum 10 m³ with 5 m³ delivered on time shows 50% (shared with M4).

## Timeline

| When | M1 work |
|---|---|
| H+0 → H+1 | Agree Plot fields and rounding rule with M6. Commit A and B. |
| H+1 → H+4 | 5 parcels, `needs.csv`, `sites.geojson`, manifest, `agriculture.py`, tests. |
| H+4 → H+10 | Integration support: `/api/sites` and parcel layers on the M7 map. |
| After | WaPOR layer, data dictionary for `plots.geojson`, quota and source details. |

## Open points for the team

1. **File names differ.** Page 9 says `data/plots.json` and `tests/test_plot_inputs.py`; the M1 section says `plots.geojson` and `test_agriculture.py`. Proposal: use the M1 section's names.
2. **4 people, 5 lots.** With 4 members the cahier gives the 5 parcel sheets to lot 5. Proposal: M1 takes them; whoever does M6 should know.
3. **Quota in two places:** site file (M1) and `State.quota_remaining_m3` (M6). Proposal: M1 holds the starting value, the scenario reads it.
4. **Shared `manifest.json`.** M1 creates it; other lots add their own entries in separate commits to avoid merge conflicts.

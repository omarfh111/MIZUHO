# M1 climate and resilience

Step 9 of the test bench (« Climat et résilience ») tells one story in three parts, all computed from downloaded data:

1. **Jendouba summers are getting hotter, and the water gap follows the heat.**
2. **Water and energy together:** the sun is strongest when the crops need the most water, so solar pumping can keep water flowing during STEG power cuts (with the right installation).
3. **Building resilience every season:** each summer is reviewed per parcel, and the cause funnel and field feedback give the checklist for next season.

## Data

| source_id | What | Where |
|---|---|---|
| `nasa-power-daily-1981-2025` | NASA POWER daily T2M_MAX, T2M, PRECTOTCORR at the parcel cluster (36.617 N, 8.981 E), 1981-2025 | `data/raw/power/power_daily_1981-2025.json` |
| `jrc-pvgis-5.3` | JRC PVGIS 5.3 PVcalc: monthly yield of 1 kWp, free-standing, optimal angles (32°), 14 % system loss, radiation PVGIS-SARAH3 2005-2023 | `data/raw/pvgis/pvgis_pvcalc_1kwp.json` |
| `wapor3-l2-aeti-series`, `wapor3-l1-ret-series` | WaPOR v3 water used (AETI) and reference ET per parcel, 318 dekads 2018-2026 (already used in step 7) | `data/agriculture/temperature_effect.json` |

Download: `python scripts/m1_fetch_sources.py climate` (URL, query, date and SHA-256 go to `data/raw/m1_downloads.json`).
Build: `python scripts/m1_build_resilience.py` writes `data/agriculture/resilience.json` and records both sources in `data/manifest.json`.

## Method and results (built 2026-11-21)

**Heat.** For each summer (June-September), we compute the mean daily maximum and the number of days at or above 35 °C and 40 °C. Trend: linear regression on the 45 years, α = 0.05.

| Indicator | 1981-1990 | 2016-2025 | Trend per decade | p |
|---|---|---|---|---|
| Summer Tmax (°C) | 33.76 | 34.88 | +0.28 | 0.047 (significant) |
| Days ≥ 35 °C per summer | 48.5 | 61.8 | +3.4 | 0.018 (significant) |
| Days ≥ 40 °C per summer | 12.1 | 19.9 | +1.7 | 0.078 (not significant) |

The 5 summers with the most days ≥ 35 °C are all between 2021 and 2025.
Order of magnitude for demand: the observed slope of reference ET against Tmax (0.24 mm/day per °C, step 7) × 1.12 °C ≈ +0.27 mm/day. This applies a 2018-2026 association to 45 years: it is not a measurement of ET0 in 1981.

**Water and energy.** PVGIS gives 5.04 kWh per kWp per day in summer, with July the best month (5.34) and December the lowest. Month by month, PV output and the climatic demand go up and down together (r = 0.96, p < 0.001). The calculator converts kWh to m³ only with a **pumping energy in kWh/m³ entered by the user**: it depends on the lift and the pump and is not measured. During a STEG cut, a stand-alone solar pump (solar drive wired to the panels) or a hybrid system with backup keeps pumping in daytime. A grid-tied inverter without backup stops (anti-islanding). At night a tank filled in daytime or a battery is needed.

**Seasons.** For each parcel and each full summer 2018-2026: water used, climatic demand, ratio and gap (demand − water used) in mm/day and m³/day, the worst and best summer, and the last summer against the median of the previous ones. Over 9 summers, no parcel shows a significant trend in the gap. P-03 has the strongest link between hotter summers and a bigger gap (+0.33 mm/day per °C, r = 0.63, p = 0.07): suggestive, not significant.

**Priorities.** The same funnel as step 8 (agents included): first the retained causes, then the field causes, each with what to look for and the data to collect. Field feedback appears as « Ce que le terrain nous a appris ».

The assistant gets these results as `climat_et_resilience` in its context and answers questions such as « Les étés sont-ils plus chauds ? » or « Le solaire peut-il aider pendant les coupures ? ».

## Limits

- NASA POWER is a reanalysis on a grid of about 50 km, not a station at the parcel.
- WaPOR v3 starts in 2018: 9 summers are too few for a solid trend in the water gap.
- The gap (ET0 − AETI) is the water the crop could have used, not an irrigation volume to deliver: that would need the crop, soil and efficiency.
- PVGIS is a long-term average: a cloudy summer produces less.
- No STEG outage record beyond the 19 July 2026 notice is available, so the number of hours of cuts is not analysed.

# Regional irrigation replay

Korba, Chebika, Gafsa, Mateur, Sidi Bouzid and El Hajeb each have two archived local days, 15 January and 15 July 2025. These dates sample winter and summer and carry no statistical claim about a typical day. Each site file contains its reference coordinates, 24 hourly irradiation values per day, weather summaries, the original NASA query, the UTC retrieval time and a SHA-256 digest of the original response. [NASA POWER Hourly API](https://power.larc.nasa.gov/docs/services/api/temporal/hourly/) · [Study windows and land-cover sources](../field_zones/README.md)

## Reproduce the data

From the repository root, run the following command with the backend environment activated. The importer only needs the normal backend dependencies and public internet access. The API serves the saved files locally.

```shell
python -m tools.field_zones.refresh_replays --dates 2025-01-15 2025-07-15
```

The importer requests `ALLSKY_SFC_SW_DWN`, `T2M`, `T2MDEW`, `WS2M`, `PS` and `PRECTOTCORR` from the NASA POWER renewable-energy community at each zone's coordinates. The responses identify MERRA-2, SYN1DEG and POWER as inputs. The importer checks the units, location, UTC time standard and all 24 values. It includes the previous UTC date to capture midnight in `Africa/Tunis`. A missing solar hour aborts the import. If solar is complete but a meteorological input is missing, the day remains usable for manual planning and its weather-based estimate is unavailable. The file for each zone is replaced only after downloads for all days and zones validate. NASA can revise its product, so the original hashes and retrieval dates travel with each saved series.

## Regional weather and optional demand estimation

Each request uses the registered site's own coordinates. Two nearby coordinates can sample the same solar grid cell. For example, Chebika and Sidi Bouzid have identical hourly irradiation on both archived dates. Their meteorology differs. On 15 July their derived reference ET is 8.230 and 8.277 mm/day respectively. Equal equipment and hard constraints can also produce equal whole-m³ operating results in different places.

NASA supplies the gridded meteorological inputs. MIZUHO computes daily grass-reference evapotranspiration (ET₀) using FAO-56 daily Penman–Monteith. The calculation uses the minimum and maximum hourly temperatures, mean wind speed at 2 m, mean surface pressure and mean actual vapour pressure derived from hourly dewpoints. Hourly irradiation summed over the local day converts from Wh/m² to MJ/m² with a factor of 0.0036. Latitude, day of year and NASA grid elevation determine clear-sky radiation. The reference surface has albedo 0.23 and daily soil heat flux zero. Temperature shown in the interface is the arithmetic mean of the 24 gridded hourly estimates. The FAO equation uses the midpoint of the daily extrema. The importer reproduces FAO's Uccle example within 0.01 mm/day. [FAO-56 equations and worked example 18](https://www.fao.org/4/X0490E/x0490e08.htm)

`POST /api/sites/{site_id}/demand-estimate` accepts a replay `date` and four explicit assumptions for a single sector: `area_m2`, `crop_coefficient`, `effective_rain_fraction` and `application_efficiency`. Effective rain in mm is the day's corrected precipitation multiplied by the usable fraction. Net irrigation depth in mm is `max(0, Kc × ET₀ − effective rain)`. Gross volume in m³ is `net depth × area in m² / (1000 × efficiency)`. The response shows the unrounded volume and its ceiling in whole m³, the physical simulator's unit. To use it in the comparison, pass that integer as the sector demand and the complete original estimate request as `demand_basis.west` or `demand_basis.east`. The API recalculates and checks the value for the selected local date. Omitting the basis keeps a manually entered sector demand.

For example, Korba on 15 July has 7.207 mm of estimated reference ET and zero regional rainfall. Assuming 1,000 m², Kc 1.1 and application efficiency 0.8 gives 9.91 m³ gross and a 10 m³ simulation input. A different area, crop or efficiency changes the result. Field soil moisture, rooting depth, pumping records and crop identity are unavailable for these hypothetical sectors. The estimate represents one day's conditional replacement of water use. It excludes soil-water storage, stress coefficients, salinity leaching, runoff and the previous irrigation history.

These twelve weather records use NASA POWER. During verification Open-Meteo's public ERA5-Land API returned a daily-quota response and ECMWF's official ARCO endpoint required authentication. This archive makes no ERA5-Land weather claim. [Open-Meteo model and variable coverage](https://open-meteo.com/en/docs/historical-weather-api) · [ECMWF ERA5-Land catalogue](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-timeseries?tab=analysis_ready_data)

## Build and compare a scenario

`GET /api/sites/{site_id}/planning` returns the dates and source values, the local timezone, two map anchors and the local inputs still missing. The two anchors are reproducible cell centres within areas classified as cropland by WorldCover. They identify hypothetical delivery sectors. A land-cover classification cannot identify a legal parcel, grower, crop water requirement or right to irrigate.

`POST /api/sites/{site_id}/planning` accepts the selected date and an explicitly supplied set of station and demand assumptions. This example exercises an afternoon outage at `korba-cap-bon`.

```json
{
  "date": "2025-07-15",
  "tank_capacity_m3": 20,
  "initial_stock_m3": 1,
  "withdrawal_limit_m3": 16,
  "pump_flow_m3_h": 4,
  "pump_wh_per_m3": 500,
  "gravity_flow_m3_h": 4,
  "grid_cap_w": 2000,
  "pv_capacity_kwp": 3.2,
  "pv_performance_ratio": 0.8,
  "demand_west_m3": 10,
  "demand_east_m3": 10,
  "delivery_start_hour": 15,
  "delivery_end_hour": 18,
  "outage_hours": [15, 16]
}
```

The physical model uses hourly steps and integer cubic metres. Hour 15 represents 15:00–16:00 local time. The same-day delivery window includes its final hour. For each hour, the estimated horizontal PV array output in Wh equals the archived irradiation in Wh/m² multiplied by installed kWp and the assumed performance ratio, using standard irradiance of 1 kW/m². Array orientation, shading, inverter clipping, temperature and batteries would require a more detailed installation model. Grid outages disconnect the grid-tied pump and PV inverter. Gravity-fed delivery can continue from stored water.

The reference rotation alternates west and east during the chosen window. Its schedule requests enough pumping to cover that turn after using available tank stock. M4 replays those scheduled requests with the selected outages, storage, withdrawal limit, gravity flow and power constraints. M5 searches for a schedule under identical constraints and can pump ahead of the window. M4 independently rechecks its actions. The answer includes the full hourly comparison, per-sector coverage and final water and energy balances. The source link applies to the solar forcing. All actions, pumped volumes and delivered volumes are simulated.

The example yields 9 m³ delivered on time under the reference rotation, including 8 m³ withdrawn, and 16 m³ under the optimized plan, including 15 m³ withdrawn. These values depend on the stated assumptions. Official withdrawal permits, measured storage, a surveyed network, crop demands, canal turns and installation data are still needed for a field decision.

## Delivery CSVs for the site demonstration

In **Irrigation planning**, open **Check a recorded delivery day**. Select **Download simulated site CSV**, then import the file to see the deadline and shortfall for each sector. The `simulated_site` column travels with each row, including after a file rename. Real operator records use the six-column blank template. The browser reads both formats locally.

The [downloadable examples](../../frontend/src/assets/delivery-examples/) reproduce the fixed rotation in M4. For the six regional sites, the input date is 15 July 2025. Each site's own NASA POWER weather drives its modeled PV generation and FAO-56 water demand. Both sectors use an assumed crop coefficient of 1.1, an effective rainfall fraction of 0.8 and an irrigation efficiency of 0.8. The hypothetical west and east sectors cover 1,000 m² and 750 m² respectively. Their modeled gross daily water demands serve as the minimum commitments for this exercise.

The station assumptions are shared across the six sites. The 20 m³ tank starts with 1 m³, the withdrawal ceiling is 16 m³, and pumping and gravity delivery are limited to 4 m³/h. Pumping uses 500 Wh/m³. The grid limit is 500 W and the PV array is rated 2.5 kWp with a performance ratio of 0.8. Deliveries run from slot 08 through slot 15. A simulated outage covers slots 11 through 13. Locations with similar weather can produce the same rounded volumetric result. All delivery volumes are simulated.

Jendouba uses the committed fictional 24-hour normal-day scenario. Its CSV uses the same example calendar date for convenience. Assila has mapped parcel codes but lacks delivery commitments and meter records. Its template leaves all operational fields empty for the operator to complete.

To regenerate these files from the committed archives with the backend environment active, run `python -m tools.field_zones.delivery_examples` from the repository root.

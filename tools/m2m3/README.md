# MIZU NEXUS · M2 and M3

Standalone Python commands for photovoltaic comparison, 24-hour load forecasting, pump and water-balance checks, and J+1 solar scenario export. The bundled data supports an offline run once the Python dependencies are installed.

For a quick handoff, see the [team integration guide](INTEGRATION.md), [IoT data contract](M2-M3-IOT.md), and [workbench tab guide](WORKBENCH-TABS.md). The workbench lives under `tools/m2m3` and the Python package uses `mizu_m2m3`, so it can be tested alongside the team backend.

## Setup and run

Use Python 3.12. From `tools/m2m3` in PowerShell:

```powershell
python -m venv .venv
$python = ".\.venv\Scripts\python.exe"
& $python -m pip install -r requirements.txt
& $python -m mizu_energy solar --site jendouba-pilote --options toiture ombriere --load data/energy/load.csv --price 0.25
& $python -m mizu_energy forecast --site jendouba-pilote --telemetry data/telemetry/sample.csv --as-of 2026-11-20T18:00:00+01:00
& $python -m mizu_energy anomalies --telemetry data/telemetry/sample.csv --reference-kwh-per-m3 0.5
& $python -m mizu_energy weather --input data/weather/jplus1_demo.json --pair jplus1-demo
& $python -m pytest -q tests
```

On macOS or Linux, use `.venv/bin/python` in place of `& $python`. All four commands print JSON. Invalid input exits with status 2 and a message on standard error. A forecast with too little history reports `insufficient_history`. Anomaly diagnostics report `insufficient_data` when a reference or comparable readings are missing.

## Browser workbench

Run the local server from the project root with the same virtual environment:

```powershell
.\.venv\Scripts\python.exe -m mizu_m2m3.web
```

Open [the local workbench](http://127.0.0.1:8765) and choose a calculation in the sidebar. The browser calls the same Python functions as the CLI. The load and telemetry dropdowns select preloaded CSVs. **Routine irrigation** and **Stress test** use the same seed for comparable operating conditions, with scheduled faults in the stress test. **Custom file** lets an operator supply recorded CSV data. Charts include hourly value tables, and each current calculation result can be downloaded as JSON. Uploads are processed in memory on the local server. Pass `--port` to choose a different port.

### Station simulation and connected feed

The Simulation tab starts with a 24-hour routine replay of three simulated stations in Jendouba, Kairouan, and Gabès. Each station has a separate pump limit, demand, tank stock, and energy reference. The station cards show the latest reading and alert count. Choose a station to inspect its timeline or inject a fault. For the isolation demo, pick Kairouan, click **Pump inefficiency**, and observe that only Kairouan alerts after two elevated hours. **Reset** clears injected faults for the network while keeping the seed and scenario.

Choose **Stress test** and **Apply and reset** to show scheduled energy and water alerts. Load forecast and Anomaly checks use separate preloaded histories for the same three stations. The reference example and solar comparison cover Jendouba. Regenerate the bundled CSVs with `python -m scripts.seed_demo_data`.

For measured data, set `MIZU_TELEMETRY_URL` to an authorized station or gateway endpoint and restart the server. Set `MIZU_TELEMETRY_TOKEN` if the gateway uses bearer authentication. Select **Connected station**. The workbench polls every 10 seconds. Return a JSON object with a `records` array of up to 96 recent hourly readings, in the same units as the anomaly CSV. Use a Boolean for `grid_available` and `null` for missing values. Convert cumulative meters into hourly deltas at the gateway. The workbench evaluates up to 24 rows per `site_id`.

For multiple connected stations, include a `references` object of validated energy references in kWh/m³ keyed by `site_id`. When a station has no reference, its water-balance check can still run. For single-station gateways, `MIZU_TELEMETRY_REFERENCE` supplies the reference when the response omits it.

See [the M2/M3 IoT integration notes](M2-M3-IOT.md) for the virtual sensor contract, fault replay, and applying a PVGIS profile to the simulation.

See [the team integration guide](INTEGRATION.md) for runnable HTTP examples and the field mapping to the M4 and M6 models.

### Metric explanations with NVIDIA (optional)

After a calculation, click **Explain metrics** to get an explanation and the supporting backend evidence. The local explanation works offline. The LLM can add a short qualitative interpretation while the app displays its numbers from the calculation output.

Put your [NVIDIA Build API key](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b) in the local `.env` next to `requirements.txt`. On a fresh checkout, copy `.env.example` to `.env` first. These settings use the [OpenAI-compatible NVIDIA chat endpoint](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/apireference):

```dotenv
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b
```

The key stays on the Python server and `.env` is ignored by Git. A model request is sent only when you click **Explain metrics**. It includes a qualitative summary and references to calculated facts. The backend supplies the exact numbers shown in the evidence panel. Raw CSV files and meter rows stay local. If the endpoint is unavailable or the reply fails validation, the workbench displays the local explanation.

## PV comparison inputs

- `options.json` identifies the site and options and records PVGIS settings, the simulation date and source provenance. Use `--catalog` and `--profiles` to supply compatible alternatives. `--day` selects a local day covered by the profiles.
- `pv_profiles.csv` contains `site_id`, `option_id`, `timestamp` and `solar_wh`. The bundled 2023 data uses the [European Commission PVGIS 5.3 API](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en), with the SARAH3 radiation dataset and a common Jendouba coordinate for both 10 kWp configurations. Those are estimated production profiles. The raw files are in `data/energy/pvgis/`.
- `load.csv` contains `site_id`, `timestamp`, `load_wh`, and `grid_available` (`true`/`false`). This is eligible hourly electricity use supplied by the grid in the equivalent-service reference case. The bundled day is simulated and includes one outage. Omit `--load` for a production-only comparison.

Treat each PVGIS power sample as representative of its hour when converting W to Wh. Rebuild the CSV from the saved responses with `python scripts/prepare_pvgis.py`. The normal run selects a 24-hour local profile. Daily self-consumption and equivalent-service grid energy avoided use the lesser of hourly eligible load and generation when the grid is available. A grid outage makes usable solar zero for these grid-tied configurations.

`gross_savings_tnd` is for the selected day. Annual production requires full coverage of the UTC `series_year` in the catalog. Annual self-consumption and savings require an aligned annual load series, with the tariff also required for savings. Add `annual_extra_cost_tnd` for annual net savings and `investment_tnd` for simple payback. Payback requires positive net savings. Unavailable values are JSON `null`.

## Telemetry and J+1 inputs

Use timezone-aware timestamps on hourly boundaries. The default display timezone is `Africa/Tunis`. An empty reading means missing data. Mark confirmed outages with `grid_available=false`.

| Input | Fields and conventions |
| --- | --- |
| Load forecast telemetry | `site_id`, `timestamp`, `load_kw`, optional `temperature_c`, `grid_available`, and `provenance`. Default features use calendar and same-hour last-week measurements. Ridge regression and the same-hour-last-week baseline are compared on a chronological holdout using MAE in kW. Known outages are excluded from target training hours. |
| Optional forecast weather CSV | Pass `--weather` with `site_id`, target `timestamp`, `available_at`, and predicted `temperature_c`. Supply both archived and upcoming forecast temperatures to evaluate and use the feature. The evaluation uses the same daily cutoff hour as the requested forecast. |
| Anomaly telemetry | `site_id`, `timestamp`, `grid_available`, `pumped_m3`, `consumed_wh`, `water_in_m3`, `distributed_m3`, `tank_stock_m3`, and optional `provenance`. Stock is the end-of-hour value. The energy check requires a positive reference and compares consecutive valid grid-connected readings. The water check reports the unexplained balance with its sign. |
| J+1 weather JSON | A map of pair IDs to `central` and `adverse` profiles. Each has issue time, timezone, risk start, source and provenance, and slots H0–H23 in Wh. Both profiles match before the risk slot. |

The bundled telemetry is simulated. The reference example produces a 24-point load forecast, a 0.7 kWh/m³ energy alert and a 13 m³ unexplained water balance. The weather tab includes a seeded cloud-risk scenario and two fixed reference pairs. In `jplus1-demo`, H10 has 1,000 Wh in both profiles, the risk starts at H11, and H13 has 3,500 Wh central and 2,500 Wh adverse. In `jplus1-stable`, both H13 profiles have 3,500 Wh. The weather command delivers these inputs for pumping decisions made by the simulator and optimizer.

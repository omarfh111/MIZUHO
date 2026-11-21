# What the Jendouba pilot demonstrates

This audit covers `main` at `c2ac06b6af6480fd01b1254a02a9014cd8d1e324` against the locked V5 specification, including the M1–M8 contracts and the J+1 acceptance cases. That revision serves **24 governorate capitals, two field sites and one simulated irrigation group**. The working copy also contains three researched agricultural areas beyond that revision. Their footprints, data periods and local evidence are documented separately. [Baseline revision](https://github.com/omarfh111/MIZUHO/tree/c2ac06b6af6480fd01b1254a02a9014cd8d1e324) · [Regional sources](../data/field_zones/README.md)

| Decision | What runs on the audited revision | What would establish a field result |
| --- | --- | --- |
| 1. Keep delivering during power cuts | M4 models grid loss, pumped volume, available tank stock and gravity delivery. M5 can anticipate an announced outage or preserve completed actions and replan after a surprise. [Incident and recovery checks](../tests/test_operating_experiments.py) | A STEG notice or a timestamped local power reading would establish a particular outage. The application currently uses scenario events and operator inputs. |
| 2. Respect the withdrawal limit | Both schedules obey the same remaining quota, starting stock and equipment limits. DGRE groundwater figures supply historical national context. [Physical simulator](../backend/simulator.py) · [DGRE excerpt](evidence/dgre.md) | A local allocation signed by the water group, pumping meter and measured starting level would establish the entitlement and available water. |
| 3. Assess agricultural water use | Assila has five OSM parcel outlines, WaPOR actual evapotranspiration and rainfall estimates for 11–20 July 2026 at 100 m, and a temperature analysis. The UI reports missing crop, farmer and scheduling fields. [Survey checks](../tests/test_agriculture.py) | Crop stage, root-zone soil moisture, effective rain, efficiency and local records are needed to infer an irrigation requirement or verify heat stress. ET minus rainfall alone cannot determine either. |
| 4. Investigate unexplained losses | M3 projects virtual flow, storage and power readings from M4. A deliberately injected meter discrepancy produces a **13 m³** inspection alert. Missing readings remain missing. [Telemetry regressions](../tests/test_telemetry.py) | Time-aligned and calibrated inlet, outlet and storage readings are needed to distinguish a leak from meter error or another cause. The SONEDE document concerns national drinking-water distribution. |
| 5. Compare pumping energy and solar options | Two hypothetical 10 kWp installations use 2023 JRC PVGIS-SARAH3 hourly estimates at the Jendouba reference point. Simulated load determines eligible self-consumption and avoided grid kWh. An entered tariff enables a gross cost estimate. [PVGIS archive metadata](../tools/m2m3/data/energy/options.json) · [Calculation](../tools/m2m3/mizu_m2m3/solar.py) | Metered load, the applicable electricity tariff, a site survey and installation and operating costs would support a financial return. ANME supplies regional documentary context. |
| 6. Anticipate load and reserve | A 24-hour **electrical load** forecast uses scikit-learn Ridge, simulated history and a held-out comparison to the previous week. A separate CP-SAT calculation sizes the early reserve against central and adverse weather scenarios. [Forecast](../tools/m2m3/mizu_m2m3/forecast.py) · [Reserve](../backend/weather.py) | A field demand forecast needs dated local demand or load history and weather predictions available when the forecast was issued. There is no standalone ERA5-Land input. The PVGIS exports name ERA5 as upstream meteorology. |
| 7. Explore geographic priorities | The national atlas serves city locations, Copernicus surface relief and NASA POWER gridded climate. The site map distinguishes Assila survey layers from the fictional Jendouba layout. Wind is a study reference. [Atlas sources](../data/tunisia/README.md) · [Layer API checks](../tests/test_api.py) | A territorial irrigation priority ranking needs comparable local water availability, crop exposure, withdrawals and verified demand. City coordinates and relief establish geographic context only. |
| 8. Explain decisions with evidence | **One LangGraph agent** selects from seven tools across city and site contexts. OpenAI and NVIDIA are alternative answer providers. Qdrant dense retrieval and local BM25 search the same curated corpus. Local source cards remain available without provider keys. [Tool routing](../backend/assistant.py) · [Corpus manifest](../data/m8_corpus.json) | Documentary excerpts support their own claims. M4/M5 is the source of numerical plan results. Neither citations nor provider availability establish observed water savings. |

## Data and integration boundaries

The **Bouhertma FieldClimate archive** provides recorded hourly station solar radiation in W/m². The feed contains gaps and the publisher supplied no timezone. NASA POWER supplies **gridded estimates** for selected coordinates. OSM provides mapped geometry. The prototype receives no live pump, meter or groundwater telemetry. Its FastAPI replay works locally and needs no MQTT broker. STEG, INM, UTAP, JICA and the Global Solar Atlas are potential sources or background references, with no corresponding operational feed in the audited code. [Station archive and licence](../data/weather/BOUHERTMA.md) · [NASA POWER Daily API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/) · [Provenance registry](../data/sources.json)

The earlier description of M1, M2/M3 and replanning as isolated workbenches predates the merged integration. FastAPI serves the Assila survey, invokes the M2/M3 adapters and replays the physical ledger for the selectable 3D twin. Session approval records the operator's choice and expires on changed inputs. There is no device actuation. [Integration matrix and walkthrough](integration-v5.md) · [Digital twin](../frontend/src/components/DigitalTwin.tsx)

## Regional extension beyond the audited main revision

**Land & agriculture** opens the atlas, the survey and three regional 3D terrains. **Water & energy** compares study areas over matching archive periods and shows station records where available. **Irrigation planning** runs the same simulator and optimizer with each area's hourly sunlight. It can estimate one day's sector demand using FAO-56 reference ET, the actual archived meteorological inputs and explicit crop and equipment assumptions. A user selects whether to apply that estimate. M8 verifies the displayed schedule's fingerprint before explaining its sector volumes. [Reproduction and source limitations](../data/zone_planning/README.md)

With the same hypothetical solar-powered station and demand in all three windows, changing the archive produces the following optimized on-time volumes. These are controlled simulations. [Inputs and regression](../tests/test_zone_planning.py)

| Study area | 15 January 2025 | 15 July 2025 |
| --- | ---: | ---: |
| Korba, Cap Bon | 8 m³ | 31 m³ |
| Chebika, Kairouan Plain | 7 m³ | 31 m³ |
| Gafsa, El Ksar | 13 m³ | 25 m³ |

## Reproduce the key results

The complete backend test suite on the audited `main` checkout passed all 120 tests using the environment serving the local API.

1. Submit the [versioned A/B fixture](../data/fixtures/compare.json) to `POST /api/compare`. The local audited API returned **10/0 m³** for A/B in the fixed schedule and **5/5 m³** in the optimized schedule. The same 10 m³ of stock and zero remaining withdrawal quota yield minimum coverage of 0% and 50% respectively.
2. Run `python -m pytest -q tests/test_api.py -k day_ahead_acceptance_cases`. In the adverse example the engine advances 2 m³ and delivers 8 m³ on time versus 6 m³ under the nominal plan replayed on that same adverse day. The stable profile requires zero early pumping. The tighter 5 m³ quota leaves 2 m³ unserved.
3. Query `GET /api/assistant/index` on a configured instance. During this audit the local main service returned `available` with seven matching indexed passages. This checks the Qdrant index. A separate [browser walkthrough](../frontend/tests/m8-browser.mjs) exercises generation and source links.

## How a water group could validate the pilot

The next field test would ask one irrigation manager whether knowing the required reserve changes when they start the pump or which parcel they serve first. It would run alongside normal operation, with the manager retaining control of equipment. A test on an archived day can establish whether the simulator reproduces that day. Estimating the impact of adopting a different plan requires subsequent observations.

| Step | Evidence to collect or compare |
| --- | --- |
| Record the day | Use anonymous parcel IDs. Record the outage notice time, actual interruption, opening tank stock in m³, permitted withdrawals in m³, delivery windows and minima, and installed pump limits. Preserve timestamps, units, missing readings and meter precision. |
| Check the simulator | Replay the actions actually taken. Compare predicted tank stock and delivered volume with dated meter readings. Agree with the manager on acceptable discrepancies before looking at the results. Mark any outcome that lacks a measurement as unverified. |
| Compare decisions | Give the existing rotation, the manager’s usual rule for advance filling, and the optimizer the same starting stock, quota, equipment and information available at decision time. Record the assumed operating rule and when each plan would pump or deliver. |
| Report the trade-off | For each plan, show water delivered by the agreed deadlines in m³, the least-served parcel’s coverage of its minimum, withdrawals in m³, and grid and backup energy separately in kWh. Distinguish metered outcomes for the operating plan from simulated alternatives. Estimate operating cost only when a dated tariff or fuel cost is available. |
| Check usefulness | Ask which action the manager would change, at what time, and why. With permission, retain an anonymized response and the inputs needed to replay the decision. Record a decision to keep the original schedule as a valid outcome. |

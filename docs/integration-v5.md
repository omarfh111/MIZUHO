# MIZUHO V5 integration

The dashboard opens on the national map. Select a governorate capital to inspect its Copernicus relief and NASA POWER climate archive, then open a nearby registered site when available. The **Site map** also gives direct access to the fictional Jendouba irrigation group and the mapped Assila survey. The city archives, parcel survey, station observations, electricity forecast and irrigation scenarios refer to distinct places or periods. [National sources and refresh](../data/tunisia/README.md)

## Integration matrix

| Source at audit | Modules and evidence | Missing connection or contract conflict | Integration decision |
| --- | --- | --- | --- |
| M7 `0bd1432` | Canonical M4 simulator, M5 CP-SAT, M6 API, React terrain, M8, cinema and security CI. PR #5 merge on main `2c06f8a` had the same tree. | Map drew continuously flowing pipes independently of the selected schedule. | Branch from M7, target main for review, retain the existing simulator, optimizer and renderer. Apply each hourly ledger to the existing terrain. |
| M1 `9f2a0c2` | Mapped OSM parcels, WaPOR AETI and rainfall, parcel summaries, temperature analysis, M1 assistant. | Assila boundaries do not describe the fictional A–E farm. ET minus rain cannot supply crop demand, service windows or a quota. | Import dated survey artifacts with provenance, validate on catalogue load, expose a separate map site and a structured M8 tool. Keep missing inputs null and exclude these parcels from planning. |
| M2/M3 `1a9808a` | Python solar, load forecast, weather, sensor projection and anomaly modules plus archived PVGIS outputs. | Workbench has its own HTTP/UI contracts. PVGIS and synthetic profiles share option names but represent different configurations. Meter faults must not modify physical stock. | Reuse scientific modules and archived inputs behind M6 routes. Identify the PV source explicitly, project meters after physical replay, and show held-out errors alongside the forecast. |
| Planning `1040c4d` | Incident prefix replay, weather CSV reader, deterministic metrics, alternative planner and document assistant. | Its models and workbench diverged before M6. Replacing the planner would change the A/B and J+1 acceptance contracts. | Adapt prefix replay and station observations, extend canonical constraints and compare the recovery with the interrupted schedule. Retain the canonical metric calculations and M8 citation checks. |
| Already integrated branches | M6 `75598f4`, M8 `f60cd09`, cinema `f40b7a3` and `42776e0`, security `6552d0c`, README `392ca12`. | Their tips precede the integrated M7 baseline. | Preserve the accumulated changes via M7 ancestry. |

All three divergent source branches share merge base `239bb91` with M7. Their original standalone applications and history remain available on their source branches.

## Architecture and contracts

- **National atlas.** FastAPI serves the geographic catalogue and recalculates climate statistics from source days for the requested interval. Three.js builds a separate mesh from each city's elevation grid. The same city and interval scope the assistant's answers and session memory.

- **Survey.** The [importer](../tools/m1/import_survey.py) derives the local survey from the pinned M1 Git revision. The [survey adapter](../backend/agriculture.py) validates parcel IDs, geometry, source relationships and units. The map renders the WaPOR grid in one mesh. Polygon edits are mapped observations. Water-use estimates and rain-adjusted temperature associations carry their own periods and limitations.
- **Planning.** [Planning models](../backend/models.py) define the public contract. A comparison request selects a scenario, observed or simulated starting state, outages and optional operating constraints. [Scenario preparation](../backend/compare.py) applies those inputs for both candidates. In incident mode, M4 validates the previous schedule and replays completed actions to a checkpoint. M5 optimizes only the suffix. An optional previous action trace pins the schedule the operator actually viewed.
- **Digital twin.** The browser posts the exact actions from the current comparison. [M4](../backend/simulator.py) replays them under the same constraints. The [telemetry adapter](../backend/telemetry.py) emits physical frames, virtual measurements, alerts and events. Physics validation establishes feasibility. The original compare response carries the solver status. M3 meter faults operate on a copy of the physical ledger. The replay is local, bounded and requires no MQTT broker.
- **Energy.** The comparison panel distinguishes synthetic pilot profiles from the archived JRC estimate. The what-if editor can use an archived PVGIS day, or center/adverse weather assumptions. Data from the Bouhertma archive are reported in W/m². The forecast compares future load estimates with a same-hour-last-week baseline on held-out hours. Neither pipeline creates live weather or meter observations.
- **Assistant.** M8 can read the active survey and sensor selection alongside existing M6 facts and documentary evidence. A changed scenario, operating constraint or replay selection changes its numerical context. Without configured providers, the UI reports assistant availability and keeps maps, evidence metadata, planning and sensor playback accessible.

The running service publishes request schemas and examples of valid field types in [FastAPI docs](http://127.0.0.1:8000/docs). The [README API table](../README.md#api-reference) lists routes. See the [data manifest](../data/manifest.json) and [source registry](../data/sources.json) for provenance.

## Judge walkthrough

Start both services using the [local setup](../README.md#run-mizuho). After installation, these scenarios use files shipped with the repository.

| Demonstration | Operator action | What to inspect |
| --- | --- | --- |
| Normal operation | Choose **Normal day**, then **Calculate schedules**. Start the digital twin timeline and inspect a parcel or the reservoir. | End-of-slot stock, quota, pump use, PV and grid Wh, five parcel deliveries and cumulative minimum coverage. |
| Announced outage | Choose the announced outage scenario. Compare **Fixed schedule** with **Optimized plan** and scrub across the outage. | Pumping stops while the grid is unavailable. Gravity delivery draws from available stock. |
| Unexpected outage | Calculate a normal day. Open **Operating constraints and incidents**, choose **Unexpected grid outage**, choose a future connected hour and recalculate. | Completed actions and the checkpoint carry into both schedules. The recovery can move future pumping to restored slots. |
| Pump shutdown | Choose **Pump shutdown** and set its start and duration. | The grid can remain available while the pump is disabled. |
| Tank depletion | Choose **A/B demo**, calculate and play each schedule. | Both plans have 10 m³ and no further quota. The fixed plan gives A/B 10/0 m³. The optimized plan gives 5/5 m³. The reservoir reaches zero. |
| Missing measurement | Open **Virtual sensors and event injection** and select **Missing flow reading**. | The meter reads *Missing*. M4 stock and deliveries still match the unmodified physical trace. |
| Water-balance discrepancy | Select **Water-balance discrepancy** on the first replayed slot. | A simulated inlet-meter offset creates a 13 m³ residual. The event asks for investigation. It cannot establish a leak. |
| Recovery and reserve | Compare the previous schedule and recovery plan. Separately choose **Day-ahead weather reserve**. Edit the quota, calculate, approve, and edit again. | The adverse example pumps 2 m³ before 11:00 and delivers 8 m³ on time versus 6 m³ without reserve. Changed inputs invalidate approval. |

Select **Day-ahead load forecast** to inspect the simulated history replay. On the map, select Assila to inspect five real mapped boundaries, the dated WaPOR overlay, attribution and missing planning fields. No field actuation, inferred land ownership or real pumping entitlement is implied by the prototype.

## Verification

| V5 requirement | Implementation | Executable checks |
| --- | --- | --- |
| M1 survey attribution, water-use units and planning eligibility | Catalogue validates OSM/WaPOR inputs, retains missing fields and omits survey parcels from the optimizer. | [Survey contracts](../tests/test_agriculture.py), [survey browser flow](../frontend/tests/agriculture-browser.mjs) |
| M2 solar potential and M3 instrumentation | Archived PVGIS day, simulated outage curtailment, held-out forecast, virtual meter quality, water balance and pump efficiency. | [Energy, replay and sensor regressions](../tests/test_telemetry.py) |
| M4 water, quota and energy conservation | Fixed, optimized and incident actions pass through one physical ledger. | [Planning invariants](../tests/test_planning_integration.py), [M6 contract and J+1 reserve](../tests/test_api.py) |
| M5 fairness and recovery | Identical initial constraints, continuation of completed actions, CP-SAT recovery and explicit partial results. | [Operating experiments](../tests/test_operating_experiments.py), [incident browser flow](../frontend/tests/operating-browser.mjs) |
| M6 geography and service contracts | Survey, weather, solar, comparison and replay routes in the existing app. | [Station archive checks](../tests/test_weather_observations.py), [API tests](../tests/test_api.py) |
| M7 playback and approval | Selectable terrain, timeline, plan toggle and approval invalidation. | [Twin browser flow](../frontend/tests/twin-browser.mjs), [cinematic and GPU cleanup](../frontend/tests/cinematic-browser.mjs) |
| M8 evidence and explanations | One LangGraph assistant separates the M4 ledger, M1 estimates, simulated meters and documentary excerpts. | [Assistant regressions](../tests/test_assistant.py), [retrieval regressions](../tests/test_evidence.py), [live citation walkthrough](../frontend/tests/m8-browser.mjs) |

The [integration tests](../tests/) cover survey integrity, station parsing, energy limits, completed action replay, A/B fairness, J+1 reserve, sensor quality, fault isolation and M8 grounding. Browser checks compare the displayed readings with actual API responses on desktop and mobile. See [Checks](../README.md#checks) for commands. Solver optimality is time-limited, the survey lacks verified operating inputs, and the connected assistant depends on its external providers.

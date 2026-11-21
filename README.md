# Mizhuo · M6 API and M7 interface

Irrigation mapping and scheduling for the Jendouba pilot site.

## Getting started

Use Python 3.12 and Node.js 22.12 or later. From the repository root, start the API.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

In a second terminal, start the frontend.

```powershell
cd frontend
npm ci
npm run dev
```

Open the [connected interface](http://localhost:5173/) or the [offline demo](http://localhost:5173/?mode=demo). The bundled site, plots, solar profiles and scenarios are simulated. Connected mode sends calculations to the Python engine and labels the sample data as simulated. If WebGL is unavailable, use the area selector to inspect site layers.

## Demo walkthrough

1. Select a plot and open its data source. Turn on **Water anomalies** and select the distribution meter to see the simulated 13 m³ discrepancy.
2. Open **Compare solar options**, review the two 10 kWp profiles and use one in the simulation. Entering a tariff is optional. Calculations that need additional inputs display a dash.
3. Select **A/B demo** and calculate schedules. The fixed schedule supplies 10 m³ to A. The proposed plan supplies 5 m³ to each plot during the outage, bringing minimum coverage from 0% to 50%.
4. Approve the proposed plan and change the water stock. The previous result remains visible and requires recalculation before approval. In **Successive outages**, select H12 to inspect the grid restart.
5. Run **Day-ahead weather reserve**. The proposed plan pumps 2 m³ before 11:00 and increases on-time delivery from 6 to 8 m³. With a quota of 5 m³, the remaining shortfall is 2 m³. **Day-ahead reserve · Stable profile** requires 0 m³ of early pumping.

## API

[OpenAPI documentation](http://127.0.0.1:8000/docs) is available while the API runs.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/health` | `{"status":"ok"}` after catalog validation |
| GET | `/api/scenarios` | Six scenarios and their initial states |
| GET | `/api/sites` | WGS84 GeoJSON sites |
| GET | `/api/layers/{site_id}/{layer_id}` | Plot, solar, wind or anomaly layer |
| POST | `/api/solar/compare` | Option assumptions, profiles, grid savings and calculable financial metrics |
| POST | `/api/compare` | Replayed fixed schedule, verified CP-SAT plan and optional weather comparison |
| GET | `/api/evidence/{source_id}` | Source metadata or 404 |

The [versioned A/B example](data/fixtures/compare.json) includes the request and a recorded response. The response reports deliveries including observed history. Withdrawals and energy cover the remaining simulation horizon.

The solver optimizes fairness, weighted shortfall, useful service, grid peak, grid energy and withdrawals in order. It then replays every returned plan through the simulator. An interrupted solve can return a verified `FEASIBLE` plan, and `NO_SOLUTION` leaves the fixed schedule available. Request errors return HTTP 422 with the field path in `detail[].loc`.

At startup the frontend requests `GET /api/sites` and `GET /api/scenarios`. Vite proxies `/api` to `http://127.0.0.1:8000` in development. Set `MIZU_API_TARGET` in `frontend/.env.local` to change the target. In production, serve `frontend/dist` and route `/api` to M6 on the same origin.

Copy the root `.env.example` to `.env` to override the allowed CORS origins or the solver time budget. The optional `restart_grid_cap_w` limits grid power in the first hour of each restart. In nominal mode, selecting a solar option supplies its hourly profile. Weather mode uses the scenario's registered `weather_pair_id` for both profiles and reports total and additional early pumping separately.

If M6 is unavailable at startup, the frontend opens the local demo with a **Simulated data** badge. Set `VITE_DATA_MODE=live` to require a backend connection. The offline demo uses its existing heuristic. Connected mode uses the M4 simulator and M5 CP-SAT solver from [the irrigation-planning commit](https://github.com/omarfh111/MIZUHO/commit/c4d59e6).

The bundled Jendouba site opts into M7's simulated relief in both modes. Other sites render their API geometry on the interactive 3D grid. The [data manifest](data/manifest.json) records provenance and missing inputs. The solar comparison uses synthetic hourly generation and a simulated service profile. Annual generation, annual cost savings and payback depend on field data such as PVGIS profiles, actual load and costs. The planning engine supports one plot per grower, as in the pilot.

## M8 evidence assistant

Use **Ask Mizhuo** from the connected interface. The assistant can search verified excerpts, inspect the current site and solar options, run a quota what-if, and explain allocations using M6. It reads the current valid comparison when available and never changes or approves a plan. Calculated values are rendered from M6 facts. Click an evidence card for its excerpt, scope, and source link.

Follow-up questions use the latest six grounded answers in the open app session. The LangGraph store keeps public citation references, verified simulated facts, and the scenario last discussed. Raw messages, generated prose, credentials, and measured values stay out of server memory. Changing simulation inputs invalidates remembered figures while keeping public citations available. Earlier figures in the transcript are labeled historical. The transcript survives closing the panel, and a page reload starts a new session. Server memory expires after an hour of inactivity and clears when the API process restarts.

The server reads OpenAI and Qdrant credentials from the ignored root `.env`. The assistant uses `gpt-6-luna` and `text-embedding-3-small` with 1,536 dimensions. Set `QDRANT_COLLECTION` to select a collection. The default is `mizhuo_m8_evidence_v1` and it requires an unnamed cosine vector. M6 and the offline M7 demo remain available without assistant credentials.

To build or check the index from the repository root, run:

```powershell
.\.venv\Scripts\python.exe -m backend.evidence
.\.venv\Scripts\python.exe -m backend.evidence --check
```

The [corpus manifest](data/m8_corpus.json) links the [source registry](data/sources.json) to short verified quotations in [the evidence directory](docs/evidence). Ingestion reads the reviewed local files and makes no requests to publishers. Stable IDs and content hashes avoid re-embedding unchanged excerpts. Retrieval restricts results to current corpus IDs and resolves citation text and links from the local registry.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/api/assistant/chat` | Grounded explanation, verified facts, citations, and missing information |
| GET | `/api/assistant/health` | Configuration and active index readiness |
| GET | `/api/assistant/index` | Indexed counts and registered evidence gaps |
| POST | `/api/evidence/search` | Passage retrieval from the verified index |
| GET | `/api/evidence/{source_id}/passages` | Local verified excerpts for a source |

The index has regional publications and sample site context. It does not contain field records for the pilot borehole or measured PV yield. The API returns the available evidence and identifies those gaps.

## Local checks

```powershell
.\.venv\Scripts\python.exe -m pytest
cd frontend
npm test
.\node_modules\.bin\tsc.cmd --noEmit
npm run build
```

With Chrome, the frontend, and the configured backend running, run `npm run test:browser` from `frontend/` for the live assistant walkthrough. It sends three questions to the configured OpenAI model, including a follow-up about the previous citation. Set `MIZHUO_TEST_URL` if the frontend is served somewhere other than `http://127.0.0.1:5173/`.

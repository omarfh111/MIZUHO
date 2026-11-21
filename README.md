<div align="center">

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="docs/readme-hero-still.svg">
  <img src="docs/readme-hero.svg" alt="MIZUHO. An isometric map of Tunisia showing the Jendouba pilot, the Medjerda river, reservoirs, and renewable energy for irrigation." width="100%">
</picture>

<h1>MIZUHO</h1>

<p><em>Which parcels can receive their promised water on time today, and who needs an earlier turn when supplies fall short?</em></p>

[![M6 API and planning](https://img.shields.io/badge/M6-API_%26_CP--SAT_planning-62e3f0?style=for-the-badge&labelColor=0b1f1c)](#how-it-works)
[![M7 3D dashboard](https://img.shields.io/badge/M7-3D_dashboard-c9ef86?style=for-the-badge&labelColor=0b1f1c)](#how-it-works)
[![M8 Evidence assistant](https://img.shields.io/badge/M8-Evidence_assistant-f7ce76?style=for-the-badge&labelColor=0b1f1c)](#how-it-works)
[![Jendouba pilot](https://img.shields.io/badge/%F0%9F%93%8D_Pilot-Jendouba%2C_Tunisia-eef6ef?style=for-the-badge&labelColor=0b1f1c)](#reproduce-the-pilot)

[![CI on main](https://github.com/omarfh111/MIZUHO/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/omarfh111/MIZUHO/actions/workflows/ci.yml?query=branch%3Amain)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/API-FastAPI-009688?style=flat&logo=fastapi&logoColor=white)
![OR-Tools](https://img.shields.io/badge/OR--Tools-CP--SAT-4285F4?style=flat&logo=google&logoColor=white)
![LangGraph](https://img.shields.io/badge/LangGraph-1.0-1C3C3C?style=flat&logo=langchain&logoColor=white)
![Qdrant](https://img.shields.io/badge/Qdrant-dense_index-DC244C?style=flat)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=black)
![Three.js](https://img.shields.io/badge/Three.js-r187-000000?style=flat&logo=threedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-7-646CFF?style=flat&logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.12%2B-5FA04E?style=flat&logo=nodedotjs&logoColor=white)

[How it works](#how-it-works) · [Data and provenance](#data-and-provenance) · [Run MIZUHO](#run-mizuho) · [Reproduce the pilot](#reproduce-the-pilot) · [API reference](#api-reference) · [Checks](#checks)

</div>

---

## The decision facing a water group

Growers depend on the timing of their turn as well as the volume they receive. A group manager can have electricity throughout the day and still lack enough stored water or withdrawal allowance to meet every parcel's minimum. MIZUHO lets the manager try a rotation, see whose delivery would be late or short, and weigh the water and energy needed for an alternative.

Jendouba’s regional agricultural authority lists irrigated areas supplied by dams, hill reservoirs, watercourses, springs and wells. In 2026, a Tunisian irrigation programme supported by the World Bank identified service reliability and the capacity of local water-user groups and regional agricultural authorities as priorities. These sources describe the context. Daily delivery volumes in this prototype come from a simulation or an operator’s own records. [Jendouba CRDA inventory, 2018](https://catalog.data.gov.tn/dataset/les-perimetres-irrigues-jendouba/resource/07e85f98-d799-48c9-8c2d-9c42a0845081) · [World Bank programme, April 2026](https://www.banquemondiale.org/fr/news/press-release/2026/04/01/tunisia-major-push-to-strengthen-water-security-and-resilience)

The manager schedules deliveries and growers receive them. A regional authority can review simulated infrastructure options. The household calculator addresses a separate decision about electricity for essential loads during a power cut.

| Module | What you can reproduce |
| --- | --- |
| **M1 · Assila survey** | Explore five mapped parcels and dated WaPOR estimates with source metadata. Inspect missing farmer, demand, quota and scheduling data. |
| **M2/M3 · Energy and telemetry** | Use archived PVGIS profiles, inspect a held-out load forecast and replay virtual sensors with controlled faults. |
| **M6 · API and irrigation planning** | Load the site and scenarios, compare solar options, and run the M4 simulator and M5 CP-SAT optimizer through FastAPI. |
| **M7 · National map and 3D dashboard** | Zoom from Tunisia to one of its 24 governorate capitals. In **Site map**, compare three researched agricultural zones, the Assila survey, and the Jendouba planning pilot. |
| **M8 · Evidence assistant** | Search official passages with Qdrant dense retrieval and BM25. Ask about a city's archive or the current site simulation with the same LangGraph agent. |

## How it works

One browser app talks to one FastAPI service. The country map zooms to georeferenced city terrain. Known field sites connect that view to M1 profiles, M2 solar comparisons, M3 virtual telemetry and M4/M5 planning. M8 explains the evidence and results available in the active view.

```mermaid
flowchart TD
  accTitle: MIZUHO application architecture
  accDescr: The dashboard sends requests to FastAPI for M6 irrigation planning and M8 evidence-backed answers.
  subgraph M7["M7 · Browser"]
    intro["Cinematic intro"] --> dash["Dashboard<br/>Land &amp; agriculture · Water &amp; energy · Irrigation planning"]
  end

  subgraph M6["M6 · FastAPI"]
    api["/api routes"] --> compare["Compare schedules"]
    compare --> baseline["Fixed baseline"]
    compare --> cpsat["M5 · CP-SAT optimizer"]
    cpsat --> sim["M4 · Simulator replay"]
    api --> solar["Solar options"]
    api --> atlas["City terrain and date-filtered climate"]
    data[("Site layers · scenarios<br/>solar profiles · fixtures")]
  end

  subgraph M8["M8 · Evidence assistant"]
    agent["LangGraph agent"] --> tools["Tools"]
    tools --> search["Hybrid search<br/>dense + local BM25"]
  end

  dash -->|"/api"| api
  api -->|"/api/assistant/chat"| agent
  tools -->|"verified plan facts"| compare
  compare -.-> data
  solar -.-> data
  atlas --> archive[("GeoNames · geoBoundaries<br/>Copernicus DEM · NASA POWER")]
  tools --> atlas
  agent <--> llm["OpenAI or NVIDIA<br/>selectable answer provider"]
  search <--> qdrant[("Qdrant Cloud")]
```

<sub>Vite proxies <code>/api</code> to FastAPI on port 8000 in development. The dashboard distinguishes the simulated planning pilot from the Assila survey. The operational twin reads the M4 ledger and M3 virtual measurements through FastAPI.</sub>

### Planning through an outage (M6)

The fixed schedule and the optimized plan are computed from the same scenario, then both are replayed through the simulator so the dashboard compares like with like.

```mermaid
sequenceDiagram
  accTitle: Comparing irrigation schedules during an outage
  accDescr: FastAPI evaluates the fixed schedule first, then verifies an optimized plan when the solver finds one.
  autonumber
  actor You
  participant D as Dashboard
  participant A as FastAPI
  participant B as Fixed baseline
  participant O as CP-SAT optimizer
  participant S as Simulator

  You->>D: Calculate schedules
  D->>A: POST /api/compare
  A->>B: Build the fixed schedule
  B-->>A: Fixed schedule
  A->>S: Replay the fixed schedule
  S-->>A: Baseline delivery per plot
  A->>O: Optimize, fairness first, time-limited
  alt Feasible plan found
    O-->>A: Proposed schedule
    A->>S: Replay the proposed schedule
    S-->>A: Proposed delivery per plot
  else No verified plan
    O-->>A: NO_SOLUTION
  end
  A-->>D: Baseline and proposed results
  D-->>You: Minimum coverage 0% → 50%
  You->>D: Approve the simulated plan
```

<sub>In the A/B demo the fixed schedule delivers 10 m³ to A and 0 m³ to B during the outage. The proposed schedule delivers 5 m³ to each. When the solver returns no solution, the fixed schedule stays available.</sub>

### Answering with evidence (M8)

The assistant uses a single two-node LangGraph loop with OpenAI or NVIDIA for answer generation. It selects from seven tools across its city and site contexts. The city context exposes sourced terrain and climate plus documentary search. The site context adds the agricultural survey, M6 calculations and M3 replay measurements.

```mermaid
flowchart TD
  accTitle: M8 evidence assistant tool loop
  accDescr: LangGraph decides whether to call evidence or planning tools and returns grounded answers with verified citations.
  q(["Your question"]) --> think["Think<br/>OpenAI or NVIDIA"]
  think -->|"needs facts"| tools{{"Tools"}}
  tools --> t1["search_evidence<br/>cited official excerpts"]
  tools --> t2["get_site_data<br/>layers and solar options"]
  tools --> t3["get_simulation_results<br/>run M6 plans"]
  tools --> t4["explain_decision<br/>allocation and binding limits"]
  tools --> t5["get_agricultural_insights<br/>mapped parcels and WaPOR"]
  tools --> t6["get_sensor_anomalies<br/>virtual measurements"]
  tools --> t7["get_city_data<br/>dated climate and elevation"]
  t1 --> think
  t2 --> think
  t3 --> think
  t4 --> think
  t5 --> think
  t6 --> think
  t7 --> think
  think -->|"enough to answer"| a(["Grounded answer<br/>with citations"])
  a -.-> mem[("Verified facts and citations<br/>up to 6 answers · 1 h idle expiry")]
  mem -.-> think
```

### From sources to citations

Every citation resolves to a verified excerpt of a registered source. Stable IDs and content hashes let re-ingestion reuse unchanged embeddings.

```mermaid
flowchart TD
  accTitle: Evidence ingestion and hybrid retrieval
  accDescr: Verified excerpts and source metadata supply the Qdrant dense index and local BM25. Search fuses both rankings and checks provenance before citing passages.
  reg["data/sources.json<br/>source registry"] --> corpus["Verified local corpus"]
  ex["docs/evidence/<br/>verified excerpts"] --> corpus
  man["data/m8_corpus.json<br/>corpus manifest"] --> corpus
  corpus --> ingest["python -m backend.evidence"]
  ingest -->|"text-embedding-3-small<br/>1,536 dimensions"| qd[("Qdrant collection<br/>7 indexed passages")]
  qd --> dense["Dense search"]
  corpus --> bm25["Local BM25"]
  query["Evidence question"] --> dense
  query --> bm25
  dense --> fuse["Check passage provenance<br/>and fuse ranks"]
  bm25 --> fuse
  fuse --> cite["Citations in answers"]
```

<sub>The <a href="docs/m8-retrieval-benchmark.md">retrieval benchmark</a> compares dense and hybrid search on 36 English, French and Arabic questions.</sub>

## Data and provenance

| Data | What the application uses |
| --- | --- |
| Mapped geography | GeoNames governorate capitals, geoBoundaries administrative areas, and OpenStreetMap parcel boundaries for the Assila survey. |
| Archived regional estimates | Copernicus DEM surface elevations for city terrain, NASA POWER gridded daily climate, FAO WaPOR satellite-derived water use, and JRC PVGIS solar generation estimates. The date filter recalculates climate statistics from the archived daily values. |
| Archived instrument observations | The Bouhertma FieldClimate archive provides measured hourly solar radiation in W/m² at one station. |
| Simulated data | Jendouba planning scenarios, physical replay, virtual pump and flow readings, load history, and injected faults. The 13 m³ discrepancy is a demonstration case. |

City profiles show the source, coverage, and retrieval date. A city needs verified parcels, water allocation, equipment specifications, and starting conditions before it can be used for operational planning. The built-in planning pilot uses simulated conditions. [National data refresh and sources](data/tunisia/README.md) · [Data manifest](data/manifest.json)

The agricultural selector includes three georeferenced study windows at Korba, Chebika on the Kairouan plain and Gafsa–El Ksar. Inspect a location on its WorldCover and elevation surfaces. Each planner uses two archived local days of NASA POWER hourly irradiation and explicit assumptions for equipment, water and demand. Its playback shows simulated volumes at two hypothetical sectors anchored on classified cropland. [Zone studies](data/field_zones/README.md) · [Regional replay inputs and API example](data/zone_planning/README.md) · [V5 capability audit](docs/v5-capability-audit.md)

## Run MIZUHO

Use Git, Python **3.12** and Node.js **22.12 or later**. Once dependencies are installed, the local backend and frontend run the maps, optimizer, digital twin, forecast and event demonstrations without credentials or network access. Configure OpenAI and Qdrant in step 2 for conversational answers and indexed retrieval.

### 1. Clone and install

Run these commands from PowerShell. On macOS or Linux, use `.venv/bin/python` wherever the commands show `.\.venv\Scripts\python.exe`.
The clone opens the released `main` branch. To reproduce an unmerged review, switch to its published commit before installing.

```powershell
git clone https://github.com/omarfh111/MIZUHO.git
cd MIZUHO
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
npm --prefix frontend ci
Copy-Item .env.example .env
```

### 2. Configure the optional connected assistant

Open the root `.env` and fill in these three fields. The root file is loaded by the backend and ignored by Git.

| Field | Required value |
| --- | --- |
| `OPENAI_API_KEY` | The OpenAI project key. |
| `QDRANT_URL` | The HTTPS REST endpoint of your Qdrant Cloud cluster, for example `https://<cluster>.cloud.qdrant.io:6333`. Use the cluster URL without a dashboard or collection path. |
| `QDRANT_API_KEY` | The Qdrant API key for the evidence collection. |

To use NVIDIA for answer generation, set `LLM_API_KEY` to your NVIDIA API key and `LLM_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b` in the root `.env`. Restart FastAPI and select **NVIDIA · Nemotron 3.5 Lightning** under **Ask Mizhuo → Answer model**. The default is OpenAI. Both models use the same LangGraph tools, M6 calculations, OpenAI embeddings, Qdrant index and citation checks. Selecting NVIDIA sends the question and relevant verified context to NVIDIA's hosted API. Provider credentials stay on the server.

Keep the template's model settings, including the **1,536** embedding dimensions. Open the cluster's Web UI, enter your Qdrant key when prompted, and select **Console**. Run the request below if the collection does not exist. It uses one unnamed dense vector and cosine distance. If you choose a different name, update `QDRANT_COLLECTION` to match. [Qdrant Web UI guide](https://qdrant.tech/documentation/web-ui/)

```http
PUT /collections/mizhuo_m8_evidence_v1
{
  "vectors": { "size": 1536, "distance": "Cosine" }
}
```

From the repository root, ingest the reviewed excerpts and check that the index reports `"status": "available"` with **7 of 7** passages indexed.

```powershell
.\.venv\Scripts\python.exe -m backend.evidence
.\.venv\Scripts\python.exe -m backend.evidence --check
```

### 3. Start the backend and frontend

In one terminal at the repository root, start FastAPI.

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Create `frontend/.env.local` with this setting so Vite requires the backend connection. Keep the provider keys in the root `.env`.

```dotenv
VITE_DATA_MODE=live
```

In a second terminal at the repository root, start Vite.

```powershell
npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open **Land & agriculture → Site map** and select the Jendouba pilot to see **API · simulated site**. The API health route should report `ok`. With provider keys and the index configured, assistant health should report `available` with seven indexed passages. Ask what ANME says about photovoltaic potential in northwest Tunisia and open the cited excerpt. [Dashboard](http://127.0.0.1:5173/) · [API health](http://127.0.0.1:8000/api/health) · [Assistant health](http://127.0.0.1:8000/api/assistant/health)

Vite proxies `/api` to port 8000. For production, serve `frontend/dist` and route `/api` to FastAPI on the same origin.

## Reproduce the pilot

### Run a water turn with a working grid

Open **Irrigation planning** at Jendouba and choose **Normal day**. Select **Use stored water only** and **Calculate schedules**. With the default 12 m³ opening stock and zero additional withdrawals, both rules deliver 12 m³ on time and consume zero grid pumping energy. The fixed turn leaves three plots without water. The optimized plan raises the least-served parcel from **0% to 20%** of its minimum. Change the opening stock or quota and recalculate to test a different day.

Read the daily commitments for the selected plan. Open **Compare your own rotation** and try pumping 8 m³ and delivering 20 m³ to parcel A at 09:00 on that same day. The zero quota rules out pumping. The simulator shows how much of the requested delivery the stock and gravity flow can support. Omitted hours stay idle in the operator’s rotation.

To review a completed day, open **Check a recorded delivery day**, download the blank CSV and enter anonymous parcel commitments and metered volumes. The browser reports which recorded deadlines were met and how many parcels had a reading. Missing observations stay unknown. The file stays in browser memory and is cleared when you leave the planning view or change sites. [Field validation protocol](docs/v5-capability-audit.md#how-a-water-group-could-validate-the-pilot)

### Try the same decision in different places

| Location | What you can verify |
| --- | --- |
| Jendouba pilot | Compare five simulated parcel commitments, your own rotation, and a fair plan. Inspect virtual meters during replay. The separate Bouhertma instrument archive and the PVGIS equipment comparison belong to this area. |
| Korba, Chebika and Gafsa–El Ksar | Load or enter station assumptions. Compare rotations, test stored water only, and replay outages on each area's own terrain. The two delivery sectors are hypothetical. Their locations use WorldCover cropland cells and the solar input uses the selected day's NASA POWER archive. |
| Assila | Inspect five mapped parcel boundaries and dated WaPOR estimates. Review a recorded delivery day from a local CSV. A planning run requires field data on demand, equipment and authorized withdrawals. |
| 24 governorate capitals | Inspect local climate and relief. Test household electricity continuity with a user-specified circuit. A city link opens a nearby registered site when there is one unambiguous match. Otherwise the user chooses a site explicitly. |

For a controlled comparison, use the same 3.2 kWp array, initially empty 20 m³ tank, zero grid import, and 30 m³ demand per sector. With the remaining inputs in the [regional regression case](tests/test_zone_planning.py), optimized on-time deliveries on **15 January 2025** are **8 m³ at Korba, 7 m³ at Chebika and 13 m³ at Gafsa**. On **15 July 2025**, they are **31, 31 and 25 m³** respectively. These are modelled station outcomes using archived local irradiation. Actual service performance requires dated delivery readings.

For a judge walkthrough of the eight operating and sensor demonstrations, see the [integration matrix, architecture and replay guide](docs/integration-v5.md).
Start in **Land & agriculture → Tunisia**, select a city and inspect its climate period and elevation source. Select **Jendouba** to open the nearby simulated pilot, or choose a registered site in **Site map**. **Water & energy** shows the Bouhertma instrument archive and PVGIS comparison for Jendouba, the WaPOR survey for Assila, or regional climate for a study zone. [Judge validation report](docs/judge-validation.md)

1. On the **Site map**, enable **Water anomalies** and select the distribution meter to see the simulated **13 m³** discrepancy. Open **Compare solar options** to inspect the two 10 kWp profiles and their assumptions.
2. In **Irrigation planning**, select **A/B demo** and **Calculate schedules**. During the outage, the fixed schedule delivers **10 m³** to A and **0 m³** to B. The proposed schedule delivers **5 m³** to each plot, raising minimum coverage from **0%** to **50%**. Approve the proposed simulated plan.
3. With the A/B result current, open **Ask Mizhuo** and ask *Why did grower A receive only 5 m³ in the A/B demo?* The assistant can use M6's current comparison. Ask *What does ANME say about photovoltaic potential in northwest Tunisia?*, open the citation, then ask *Which official source did you just cite?* to check the session follow-up.
4. Change the water stock to see the result marked stale until recalculated. Select **Day-ahead weather reserve** to see the proposed plan pump **2 m³** before **11:00**, raising on-time delivery from **6 m³** to **8 m³**. With a quota of **5 m³**, the remaining shortfall is **2 m³**. **Day-ahead reserve · Stable profile** requires **0 m³** of early pumping.

### Replay an outage across the farm and the community

1. Open **Irrigation planning** on the Jendouba normal day. Select **Test outage resilience**, choose a coverage target and run the grid. A full day includes 16 combinations of outage start and duration. Open a cell to see the minimum water reserve the solver can verify and the first parcel to miss its deadline. Short pilot scenarios use their remaining time window.
2. Replay the selected hour in 3D. Switch between fixed turns, fair sharing and urgent-parcel priority. Compare the physical tank level with the virtual meter during a loss or a sensor error. The three-day heat test carries both stock and the unused withdrawal quota forward. The infrastructure comparison keeps the initial stock fixed when increasing tank capacity and accounts separately for backup electricity.
3. Choose **Community electricity** in the same case. Set the number of homes, their continuous and lighting loads, usable backup energy and island-capable output. The residential circuit has its own supply. A city without irrigation records can run the same household balance from the national atlas. [Household backup assumptions](https://www.energy.gov/cmei/systems/solar-and-resilience-basics)
4. Repeat the farm experiment at Korba, Chebika or Gafsa after supplying the station assumptions. The regional scenes use the local relief and satellite imagery. Modelled delivery sectors and pipes illustrate the scenario. The Assila survey displays its mapped parcels and remains outside the irrigation optimizer while equipment, quotas and demands are unknown. [Local footprints and provenance](data/field_zones/README.md) · [Weather and planning assumptions](data/zone_planning/README.md)

### How long can the irrigation group hold out?

Open **Irrigation planning** in Jendouba, choose **Test the limited-pump example** and select **Run outage grid**. The simulated station starts the day with 12 m³ in storage, a 65 m³ withdrawal quota and a 2 m³/h pump. Open the **11:00, 4 h** cell. The daily totals show the trade-off the manager faces.

| Sharing rule | Delivered on time | Water withdrawn | Grid electricity | Least-served plot's minimum covered on time |
| --- | ---: | ---: | ---: | ---: |
| Fixed turns | 18 m³ | 6 m³ | 3 kWh | 0% |
| Fair sharing | 46 m³ | 36 m³ | 18 kWh | 90% |

The fair plan delivers an additional **28 m³ on time** by withdrawing **30 m³ more water** and consuming **15 kWh more grid electricity**. The group needs at least **13 m³ already in the tank when the outage starts** to meet the selected 80% coverage target. Return to the grid and open **11:00, 8 h**. The best coverage drops to **70%**, the total shortfall against timely minimums rises from **4 to 12 m³**, and the 80% target becomes unreachable under these assumptions. [Solver regression](tests/test_resilience.py) · [Browser walkthrough](frontend/tests/outage-browser.mjs)

These are simulated operating results. A water group can check them against a dated outage using its opening stock, delivery and electricity meter readings, and the manager's original schedule. [Field validation protocol](docs/v5-capability-audit.md#how-a-water-group-could-validate-the-pilot)

### Replay the M6 API fixture

From the repository root with FastAPI running, send the request from the [versioned A/B fixture](data/fixtures/compare.json).

```powershell
$fixture = Get-Content data/fixtures/compare.json -Raw | ConvertFrom-Json
$plan = Invoke-RestMethod http://127.0.0.1:8000/api/compare -Method Post -ContentType application/json -Body ($fixture.request | ConvertTo-Json -Depth 10)
$plan.optimized.plot_results | Select-Object plot_id, delivered_on_time_m3, coverage_bp
```

Expected results are **5 m³** delivered on time and **5,000** coverage basis points for each plot. The backend optimizes fairness before other objectives and replays the returned plan through the simulator. A time-limited solve can return a verified `FEASIBLE` plan. When it returns `NO_SOLUTION`, the fixed schedule remains available.

### Reproduce the M8 retrieval benchmark

```powershell
.\.venv\Scripts\python.exe -m backend.retrieval_benchmark
```

The [benchmark](docs/m8-retrieval-benchmark.md) compares dense and hybrid retrieval for **36 English, French and Arabic questions** against the same seven passages. It uses live OpenAI embeddings and Qdrant queries. The [corpus manifest](data/m8_corpus.json) links the [source registry](data/sources.json) to [verified excerpts](docs/evidence/). Stable IDs and content hashes let repeated ingestion reuse unchanged embeddings.

The assistant keeps up to six grounded answers per app session. It retains public citations and verified tool results, clears stale facts when inputs change, and resets memory after one hour of inactivity or an API restart. Reloading the page starts a new session. The [data manifest](data/manifest.json) records the demonstration assumptions. The solar editor offers archived PVGIS estimates alongside the original simulated profiles. Borehole measurements, field electricity tariffs and installation quotes remain unavailable.

## API reference

The running backend serves [OpenAPI documentation](http://127.0.0.1:8000/docs).

| Purpose | Routes |
| --- | --- |
| Health and geography | `GET /api/health`, `GET /api/scenarios`, `GET /api/sites`, `GET /api/layers/{site_id}/{layer_id}` |
| National map and profiles | `GET /api/tunisia`, `GET /api/tunisia/cities/{id}` with optional inclusive `start` and `end` dates |
| Researched agricultural zones | `GET /api/sites/{site_id}/field-zone` returns land cover, terrain, climate and source metadata |
| Regional planning | `GET /api/sites/{site_id}/planning` lists archived days and cropland anchors. `POST` to the same route to compare schedules with explicit operating assumptions. |
| Regional demand estimate | `POST /api/sites/{site_id}/demand-estimate` applies crop coefficient, area, effective-rain fraction and efficiency to the archived day's FAO-56 reference ET and rainfall. |
| Agricultural survey and weather station | `GET /api/sites/{site_id}/agriculture`, `GET /api/weather/bouhertma?day=2026-05-08` |
| Archived solar comparison, hourly PV and planning weather | `POST /api/solar/compare-archive`, `POST /api/solar/profile`, `POST /api/weather` |
| Verified replay and virtual instrumentation | `POST /api/telemetry/replay`, `POST /api/telemetry/project`, `POST /api/telemetry/forecast` |
| Irrigation and solar | `POST /api/compare`, `POST /api/solar/compare` |
| Outage stress test | `POST /api/sites/{site_id}/resilience/grid` runs the coverage matrix. `POST /api/sites/{site_id}/resilience/case` returns the selected outage, candidate schedules, incident readings, heat replays and backup comparison. Both accept the same site planning inputs. |
| Operator rotation | `POST /api/sites/{site_id}/operator-rotation` accepts a nominal start-of-day site plan and up to 24 distinct hourly requests (`hour`, `pump_m3`, `plot_id`, `delivery_m3`). It returns the requested and physically feasible volumes, the replayed operator rotation and a solver plan under the same constraints. Unspecified hours are idle. |
| Household electricity | `POST /api/resilience/households` projects hourly demand, energy supplied, unmet load and remaining usable AC energy. The result includes the first shortfall, the energy required for the whole outage and peak island-capable output required. |
| Sources and retrieval | `GET /api/evidence/{source_id}`, `GET /api/evidence/{source_id}/passages`, `POST /api/evidence/search` |
| Evidence assistant | `POST /api/assistant/chat`, `GET /api/assistant/health`, `GET /api/assistant/index` |

## Checks

Run these from the repository root.

```powershell
.\.venv\Scripts\python.exe -m pytest -ra
Push-Location frontend
npm test
npm exec -- tsc --noEmit
npm run build
Pop-Location
```

With Chrome installed and both servers running, use `npm --prefix frontend run test:browser` to exercise the cinematic handoff, M6 schedule approval, and live M8 answers and citation follow-ups. Set `MIZHUO_TEST_URL` when testing a frontend served at a different URL.

Run `npm --prefix frontend run test:integration` against those same local servers for the national explorer, survey map, and desktop/mobile twin tests. These checks do not require provider credentials.

To repeat the live evidence walkthrough with Nemotron in PowerShell, set `$env:MIZHUO_TEST_PROVIDER='nvidia'` and run `node frontend/tests/m8-browser.mjs`. Clear the test setting with `Remove-Item Env:MIZHUO_TEST_PROVIDER` to return to the default walkthrough.

GitHub Actions runs backend and frontend checks. A browser job exercises the national explorer, survey, twin and incident workflows against the built dashboard and local API in desktop and mobile Chrome without provider keys. Security checks include CodeQL, Gitleaks and an OSV dependency comparison on pull requests that change dependency manifests. [CI workflow](.github/workflows/ci.yml) · [Security workflow](.github/workflows/security.yml)

Regenerate the animated and static banners from the repository root with `python docs/tools/readme_hero.py`. [Banner source](docs/tools/readme_hero.py)

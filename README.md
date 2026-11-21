<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="docs/readme-hero.svg#still">
  <img src="docs/readme-hero.svg" alt="MIZUHO. Water, land and sun meet at the Jendouba irrigation pilot." width="1280">
</picture>

# MIZUHO

Map the Jendouba pilot site, compare irrigation schedules during a power outage, and ask an evidence assistant to explain the result. One connected app brings together the FastAPI service, the 3D dashboard, and the LangGraph assistant.

[Run MIZUHO](#run-mizuho) · [Reproduce the pilot](#reproduce-the-pilot) · [API reference](#api-reference) · [Checks](#checks)

| Module | What you can reproduce |
| --- | --- |
| **M6 · API and irrigation planning** | Load the site and scenarios, compare solar options, and run the M4 simulator and M5 CP-SAT optimizer through FastAPI. |
| **M7 · 3D dashboard** | Inspect plots, solar potential and water anomalies. Compare schedules, approve a simulated plan, and replay the [cinematic introduction](frontend/src/experience/README.md). |
| **M8 · Evidence assistant** | Search the reviewed corpus with Qdrant dense retrieval and BM25, trace citations to their sources, and ask follow-up questions about the current simulation. |

## Run MIZUHO

Use Git, Python **3.12**, Node.js **22.12 or later**, an OpenAI project key with access to `gpt-6-luna` and `text-embedding-3-small`, and a Qdrant Cloud cluster with an API key that can read and write the evidence collection.

### 1. Clone and install

Run these commands from PowerShell. On macOS or Linux, use `.venv/bin/python` wherever the commands show `.\.venv\Scripts\python.exe`.

```powershell
git clone --branch feat/m7-carte-simulation https://github.com/omarfh111/MIZUHO.git
cd MIZUHO
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
npm --prefix frontend ci
Copy-Item .env.example .env
```

### 2. Configure credentials and index evidence

Open the root `.env` and fill in these three fields. The root file is loaded by the backend and ignored by Git.

| Field | Required value |
| --- | --- |
| `OPENAI_API_KEY` | The OpenAI project key. |
| `QDRANT_URL` | The HTTPS REST endpoint of your Qdrant Cloud cluster, for example `https://<cluster>.cloud.qdrant.io:6333`. Use the cluster URL without a dashboard or collection path. |
| `QDRANT_API_KEY` | The Qdrant API key for the evidence collection. |

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

Open the [dashboard](http://127.0.0.1:5173/). Check that the [API health route](http://127.0.0.1:8000/api/health) reports `ok`, the [assistant health route](http://127.0.0.1:8000/api/assistant/health) reports `available`, and the dashboard shows **API · simulated site**. Vite proxies `/api` to port 8000. For production, serve `frontend/dist` and route `/api` to FastAPI on the same origin.

## Reproduce the pilot

1. On the **Site map**, enable **Water anomalies** and select the distribution meter to see the simulated **13 m³** discrepancy. Open **Compare solar options** to inspect the two 10 kWp profiles and their assumptions.
2. In **Simulation**, select **A/B demo** and **Calculate schedules**. During the outage, the fixed schedule delivers **10 m³** to A and **0 m³** to B. The proposed schedule delivers **5 m³** to each plot, raising minimum coverage from **0%** to **50%**. Approve the proposed simulated plan.
3. With the A/B result current, open **Ask Mizhuo** and ask *Why did grower A receive only 5 m³ in the A/B demo?* The assistant can use M6's current comparison. Ask *What does ANME say about photovoltaic potential in northwest Tunisia?*, open the citation, then ask *Which official source did you just cite?* to check the session follow-up.
4. Change the water stock to see the result marked stale until recalculated. Select **Day-ahead weather reserve** to see the proposed plan pump **2 m³** before **11:00**, raising on-time delivery from **6 m³** to **8 m³**. With a quota of **5 m³**, the remaining shortfall is **2 m³**. **Day-ahead reserve · Stable profile** requires **0 m³** of early pumping.

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

The assistant keeps up to six grounded answers per app session. It retains public citations and verified simulated results, clears stale facts when inputs change, and resets memory after one hour of inactivity or an API restart. Reloading the page starts a new session. The [data manifest](data/manifest.json) records provenance. Jendouba's site layers, irrigation scenarios, and solar profiles are simulated. The evidence includes regional publications. Borehole measurements, site-specific PVGIS output, and annual cost inputs remain unavailable.

## API reference

The running backend serves [OpenAPI documentation](http://127.0.0.1:8000/docs).

| Purpose | Routes |
| --- | --- |
| Health and geography | `GET /api/health`, `GET /api/scenarios`, `GET /api/sites`, `GET /api/layers/{site_id}/{layer_id}` |
| Irrigation and solar | `POST /api/compare`, `POST /api/solar/compare` |
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

With Chrome installed and both servers running, use `npm --prefix frontend run test:browser` to exercise the cinematic handoff, M6 schedule approval, and the M8 citation follow-up. The test sends three chat questions to the live assistant. Set `MIZHUO_TEST_URL` when testing a frontend served at a different URL.

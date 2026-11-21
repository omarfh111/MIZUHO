# Mizhuo · M7

Irrigation mapping and scheduling for the Jendouba pilot site.

## Getting started

Use Node.js 22.12 or later.

```powershell
cd frontend
npm ci
npm run dev
```

Open the [local demo](http://localhost:5173/?mode=demo). The site, plots, solar profiles and scenarios are simulated. The 3D map works offline. If WebGL is unavailable, use the area selector to inspect site layers.

## Demo walkthrough

1. Select a plot and open its data source. Turn on **Water anomalies** and select the distribution meter to see the simulated 13 m³ discrepancy.
2. Open **Compare solar options**, review the two 10 kWp profiles and use one in the simulation. Entering a tariff is optional. Calculations that need additional inputs display a dash.
3. Select **A/B demo** and calculate schedules. The fixed schedule supplies 10 m³ to A. The proposed plan supplies 5 m³ to each plot during the outage, bringing minimum coverage from 0% to 50%.
4. Approve the proposed plan and change the water stock. The previous result remains visible and requires recalculation before approval. In **Successive outages**, select H12 to inspect the grid restart.
5. Run **Day-ahead weather reserve**. The proposed plan pumps 2 m³ before 11:00 and increases on-time delivery from 6 to 8 m³. With a quota of 5 m³, the remaining shortfall is 2 m³. **Day-ahead reserve · Stable profile** requires 0 m³ of early pumping.

## M6 integration

At startup the frontend requests `GET /api/sites` and `GET /api/scenarios`. Vite proxies `/api` to `http://127.0.0.1:8000` in development. Set `MIZU_API_TARGET` in `frontend/.env.local` to change the target. In production, serve `frontend/dist` and route `/api` to M6 on the same origin.

Layer IDs are `plots`, `solar`, `wind` and `anomalies`. The solar layer supplies an `option_id` for each configuration. The comparison and evidence endpoints are `POST /api/solar/compare`, `POST /api/compare` and `GET /api/evidence/{source_id}`. The optional `restart_grid_cap_w` field sets the restart cap in watts. Weather scenarios specify their pairing via `weather_pair_id`.

If M6 is unavailable at startup, the frontend opens the local demo with a **Simulated data** badge. Set `VITE_DATA_MODE=live` to keep the app in connected mode while diagnosing M6. The demo uses a repeatable scheduling heuristic. Connected mode delegates scheduling and operational data to M6 and requests English content.

Connected mode shows the API's site geometry on an interactive 3D grid. The demo uses simulated terrain.

## Local checks

```powershell
npm test
npm run build
```

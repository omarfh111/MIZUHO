# M1 cause funnel: from N candidate causes to the ones that matter

Decision support for the question **why is the water actually used in summer so far below the climatic demand?** The analysis starts from 10 candidate causes and narrows them stage by stage, using the data, three agents and the field manager's feedback.

```
10 candidate causes (backend/causal/catalog.py)
   │
   ├─ Stage 1  Data agent (no AI)        backend/causal/evidence.py
   │           tests each cause on WaPOR / NASA POWER series
   │           → supports / contradicts / neutral / untestable
   │           untestable causes go to the "field check" lane, never eliminated for lack of data
   │
   ├─ Stage 2  Judge agent (TypeSafe Jev) backend/causal/jev.py
   │           one request: a yes/no probability per remaining cause + the main cause (choice)
   │           keeps the top 3 with p ≥ 0.3
   │
   ├─ Stage 3  Critic agent (LLM, Nemotron) funnel.critic_agent
   │           reviews the kept causes, names the data that would decide, asks the field question;
   │           numbers in its text are checked against the facts; eliminates nothing
   │
   └─ Stage 4  Human feedback            data/feedback/causes_feedback.json (git-ignored)
               confirm / reject / unsure + note, per parcel and cause; notes are passed to Jev and the critic
```

Orchestrator: `backend/causal/funnel.py`, `run(plot_id)`. Test bench: step 8, routes `GET /api/causes/{plot_id}` and `POST /api/causes/feedback`.

## Score

Each cause's probability is `sigmoid(data + Jev + human)` in log-odds, so each stage's contribution stays visible:

| Source | Contribution |
|---|---|
| Data agent | +1 per strength point (0 to 2) if the data support the cause, −1 per point if they contradict it |
| Jev | logit(p_yes), capped at ±3 |
| Human | +4 confirm, −4 reject, 0 unsure (the last answer wins) |

## The 10 causes

| Cause | Test with current data |
|---|---|
| Insufficient irrigation supply | Summer ratio AETI/ET0 < 0.3, and AETI does not follow temperature while ET0 does |
| Crop heat stress | AETI falls significantly with temperature in summer |
| No summer rain | AETI follows rain over the year |
| Fallow or harvested crop | Summer AETI < 1 mm/day and spring/summer ratio > 2 |
| Power cuts stopping the pump | AETI for 11–20 July 2026 vs the 2018–2025 median for the same dekad |
| Satellite measurement error | Fewer than 4 WaPOR pixels on the parcel |
| Quota too low, network leaks, salinity, pump failure | No data: field check (quota, meters, conductivity, pump telemetry) |

## Result without feedback (2026-11-21)

All 5 parcels keep **insufficient irrigation supply** first: the summer ratio is between 0.21 and 0.26. Heat stress, rain and satellite error are contradicted by the data. Without the AI agents, P-01, P-02 and P-04 also keep **fallow / harvested crop** (summer AETI ≈ 1.3 mm/day, spring 1.7 to 2 times higher). With Jev on P-03, only insufficient supply remains (Jev p = 0.88; main-cause choice 100 %).

## Limits

- The rules and thresholds of the Data agent (0.3, 1 mm/day, 4 pixels…) are explicit choices, not calibrated values.
- Jev and the LLM only see the facts written by the Data agent; they can rank and criticise, not measure.
- Feedback is stored locally by the test bench; it is not shared between team members.

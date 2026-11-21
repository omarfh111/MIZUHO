# M1 assistant: explains the analyses, answers from sources, collects field feedback

A chat panel on the test bench (button « 💬 Assistant »). It talks with the group manager about one parcel, explains the analyses in plain French, cites reference documents, asks questions to understand the situation, and turns field information into a **suggested** feedback for the cause funnel.

## One message, five agents

```
user message
  │
  ├─ Intent agent (Jev)       question / field information / opinion on a cause, which cause, confirm or reject
  ├─ Retrieval (Qdrant)       5 most relevant passages, NVIDIA embeddings (nemotron-3-embed-1b)
  ├─ Context                  the parcel's analyses from the cause funnel (no raw series)
  ├─ Answer agent (Nemotron)  answers from CONTEXTE and SOURCES only, cites [S1]…, ends with one question
  └─ Verifier agent (Jev)     probability that the answer holds an unsupported claim or a wrong reasoning;
                              ≥ 0.6 → rewritten once; if doubt remains, the page shows a warning
       + number check         every number must appear in the context or the passages
```

Answers are formatted: the page renders a safe Markdown subset (titles, lists, tables, bold) and colour tags `{vert:…}`, `{orange:…}`, `{rouge:…}`, `{gris:…}`, `{bleu:…}`. Cause comparisons come as one table whose status is copied from `statut_des_causes` in the context (retenue / terrain / écartée), so the model cannot move a cause to the wrong lane.

When the intent is field information or an opinion on a cause (confidence ≥ 0.5), the page proposes « Enregistrer comme avis ». Nothing is stored until the user clicks; the funnel is then recomputed.

## Documents

`python scripts/m1_fetch_docs.py` downloads the documents into `data/rag/raw/` (git-ignored, third-party content) and writes `data/rag/sources.json` (URL, date, SHA-256). `python scripts/m1_ingest_docs.py` cuts them into passages of about 1,200 characters and loads them into Qdrant (226 passages).

| source_id | Document |
|---|---|
| fao56-ch1, ch2, ch5, ch8 | FAO-56 *Crop evapotranspiration*: introduction, Penman-Monteith, crop coefficient, water stress |
| wapor-data | FAO WaPOR data and products page |
| power-method | NASA POWER methodology |
| m1-data, m1-causes | This project's method and limits |
| cdc-v5 | The cahier des charges (local only, never committed) |

## Configuration

`.env` (see `.env.example`): `QDRANT_URL` and `QDRANT_API_KEY` for a Qdrant server or cloud; if empty, a local embedded Qdrant in `data/rag/qdrant_local/` (one process at a time: stop the test bench before re-ingesting). Embeddings use `LLM_API_KEY` on the NVIDIA endpoint unless `EMBED_*` is set.

## Tested on 2026-11-21 (P-03)

- « La chaleur est-elle la cause ? »: correct answer, 7/7 numbers found, Jev risk low.
- « Le CRDA a réduit notre quota… »: Jev intent = field information on *quota*, confirm (0.97); feedback suggested, then saved on click; the funnel then keeps *quota*.
- A first version stated "half the quota matches the 0.25 ratio" (wrong): Jev rated a similar answer 0.91 against 0.26 for a correct one, which is why the Verifier was added.

- Qdrant Cloud (eu-central-1): 226 passages ingested; « Comment le stress hydrique réduit-il l'évapotranspiration ? » retrieved FAO-56 chapter 8 in the top 3 passages (scores 0.53 to 0.58).

## Limits

- The Verifier lowers the risk of wrong claims, it does not remove it: an answer marked « à vérifier » must be checked against the tables.
- Conversations are kept in the page only (not saved); feedback is saved locally in `data/feedback/`.
- Retrieval is semantic: a question outside the documents gets an answer that says what is missing, not an outside source.

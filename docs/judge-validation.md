# Judge walkthrough validation

The final pass started from the merged PR #8 commit `6b9b20e`. Chrome exercised the production frontend with the real FastAPI service. The browser suite used OpenAI and NVIDIA for live answers, OpenAI embeddings and Qdrant for document retrieval, and controlled local response failures for retry checks.

## Reproduced issues

| Area | Reproduction | Regression |
| --- | --- | --- |
| Weather recommendation | In **Day-ahead weather reserve**, enter a remaining quota of **5 m³**. The engine scheduled zero early pumping and reported a **2 m³** deficit, while the headline said early pumping was unnecessary. | The [scenario browser suite](../frontend/tests/judge-scenarios-browser.mjs) checks the headline and deficit together and also checks the stable case with no deficit. |
| Replanning with edited demand | Resume a normal-day plan with 16 m³ already delivered against a demand increased to 18 m³. Validation used the original 14 m³ demand and rejected valid completed deliveries. | The [telemetry API tests](../tests/test_telemetry.py) and [assistant tests](../tests/test_assistant.py) check the changed demand through comparison, physical replay, and chat. |
| Telemetry limits | A valid offset on a year-boundary timestamp could overflow on conversion to UTC. Forecast dates outside the supported range could wrap to unrelated dates. Extremely small flow readings could also produce a nonfinite pumping-efficiency alert. | The [telemetry API tests](../tests/test_telemetry.py) verify field-level errors for out-of-range timestamps and insufficient data when the energy intensity cannot be represented. |
| Assistant provider failures | A malformed successful provider response could return HTTP 500 or discard already verified calculations. Invalid or repeated tool-call identifiers could enter the graph. | The [assistant tests](../tests/test_assistant.py) cover malformed replies, tool envelopes, and grounded fallback. |
| Assistant follow-ups and sources | Mixed answers could drop verified official passages. Provider failure could hide deterministic missing-data notices. Scenario lookup could prefer a previously discussed preset over the current selection. | The [assistant tests](../tests/test_assistant.py) check evidence retention, notices, and the scenario selected for a follow-up. |
| Archived solar selection | Choose an archived PVGIS option on the map, apply it, and ask the assistant about it before calculating schedules. The request previously lost the archive selection, and a live Nemotron site lookup could still omit the estimate when it skipped the optional solar comparison. | The [assistant tests](../tests/test_assistant.py) and [live browser test](../frontend/tests/m8-browser.mjs) compare the reported estimate against the archive endpoint. |
| Keyboard focus | Closing solar provenance or completing a delayed sensor fault replay could discard focus. A map marker outside the view was difficult to select using the keyboard. | The [survey walkthrough](../frontend/tests/agriculture-browser.mjs) and [twin walkthrough](../frontend/tests/twin-browser.mjs) cover nested dialogs, replay controls, and area selection. |
| Assila survey retry | A transient 503 on the Assila survey left the panel unavailable without an in-place retry. | The [survey walkthrough](../frontend/tests/agriculture-browser.mjs) retries the survey in the same visit. |

## Coverage

The scenarios include normal operation, A/B fairness, announced and successive outages, adverse and stable day-ahead reserves, unexpected grid failure, pump shutdown, tank depletion, missing meter readings, and a simulated 13 m³ water-balance discrepancy. The browser checks approval invalidation, loading and retry states, and the production dashboard’s display of the replay. The backend checks also cover constrained power, quota, gravity, and archived solar inputs.

The live retrieval benchmark found the expected source first on 35 of 36 English, French, and Arabic queries and in the top four on all 36. The Arabic aquifer question ranked the expected DGRE source second. The benchmark measures retrieval against the indexed excerpts.

## Results

- Python suite and frontend unit suite passed with 115 and 9 tests respectively. TypeScript and the production build passed.
- A backend sweep completed 99 comparisons and 194 physical replays across all six presets and edited operating conditions. The original M2/M3 solar, anomaly, forecast, and weather suites passed 16 tests against the integrated modules.
- The four integration browser scripts passed, including the desktop and mobile survey, twin, and incident walkthroughs. The cinematic browser suite passed replay, reduced motion, context recovery, and the WebGL fallback.
- Live Chrome walkthroughs passed with OpenAI and NVIDIA. The A/B API also calculated the expected 5/5 m³ schedule with provider credentials disabled.

See the [pilot walkthrough](integration-v5.md) for judge steps and [Checks](../README.md#checks) for the commands. Live assistant verification requires configured provider and retrieval credentials. The rest of the browser matrix also runs without them.

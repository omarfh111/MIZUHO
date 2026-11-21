# M8 evidence retrieval benchmark

Run `python -m backend.retrieval_benchmark` from the repository root with the project's Python environment and configured OpenAI and Qdrant credentials. The command prints per-language metrics and each query's ranked source IDs. It queries the live index and uses OpenAI embeddings. The benchmark makes no index writes or response-generation requests.

The [question set](../tests/fixtures/m8-retrieval.json) comprises 36 manually labeled questions, 12 each in English, French, and Arabic. It covers all seven indexed sources, including paraphrases, agency names, overlapping topics, and localized numbers. Each question has one expected source. The pre-change ranking from `ff42a4c` and the benchmark's dense baseline returned identical source lists for all 36 questions.

| Language | Questions | Dense first | Hybrid first | Dense top four | Hybrid top four | Dense MRR@4 | Hybrid MRR@4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| English | 12 | 12 | 12 | 12 | 12 | 1.0000 | 1.0000 |
| French | 12 | 12 | 12 | 12 | 12 | 1.0000 | 1.0000 |
| Arabic | 12 | 11 | 11 | 12 | 12 | 0.9583 | 0.9583 |
| All | 36 | 35 | 35 | 36 | 36 | 0.9861 | 0.9861 |

MRR@4 averages the reciprocal rank of the expected source, with a value of zero for misses. The lists changed on 14 questions, while the labeled source retained its rank on every question. On `ar-12`, both modes ranked the DGRE aquifer report second, behind SONEDE. Every expected source reached the four passages available to the assistant. This run therefore did not trigger a Jev test.

The hybrid search uses up to 12 candidates per path and returns four passages. Reciprocal rank fusion uses an offset of 2 and weights of 1.0 for dense and 0.6 for BM25. Qdrant supplies dense candidates. Local BM25 indexes the verified excerpts and multilingual search terms from the corpus manifest. A lexical-only candidate must also match the corresponding point's Qdrant provenance before it can be returned. The search terms do not appear in source excerpts or change existing embeddings.

The questions and search terms were authored from the same seven-document corpus. Performance on a larger index, unseen user questions, and unsupported topics remains unmeasured. The run observed median retrieval times of 540 ms for dense and 478 ms for hybrid. Both use remote providers and the dense call ran first in each pair, so the timing is descriptive.

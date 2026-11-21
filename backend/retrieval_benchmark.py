"""Compare the dense baseline and live hybrid evidence retrieval by language."""

import argparse
import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import median
from time import perf_counter

from dotenv import load_dotenv
from pydantic import TypeAdapter

from .catalog import DATA_DIR, load_catalog
from .evidence import RESULT_LIMIT, load_corpus, rank_evidence, search_dense
from .models import Citation
from .providers import Providers, ServiceError, Services

QUESTIONS = DATA_DIR.parent / "tests" / "fixtures" / "m8-retrieval.json"


def measure(search: Callable[[], list[Citation]]) -> tuple[list[str], float]:
    start = perf_counter()
    sources = [item.source_id for item in search()]
    return sources, (perf_counter() - start) * 1000


def source_rank(sources: list[str], expected: str) -> int | None:
    return sources.index(expected) + 1 if expected in sources else None


def metrics(rows: list[dict], mode: str) -> dict:
    ranks = [row[f"{mode}_rank"] for row in rows]
    return {
        "hit_at_1": ranks.count(1),
        f"hit_at_{RESULT_LIMIT}": sum(rank is not None for rank in ranks),
        f"mrr_at_{RESULT_LIMIT}": round(sum(1 / rank for rank in ranks if rank) / len(rows), 4),
        "median_ms": round(median(row[f"{mode}_ms"] for row in rows)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", type=Path, default=QUESTIONS, help="Labeled multilingual queries in JSON.")
    args = parser.parse_args()
    load_dotenv(DATA_DIR.parent / ".env")
    settings = Services.from_env()
    if settings is None:
        raise SystemExit("OpenAI and Qdrant configuration is required.")
    cases = TypeAdapter(list[dict[str, str]]).validate_json(args.questions.read_bytes())
    corpus = load_corpus(DATA_DIR, load_catalog().evidence)
    if not cases or any(not corpus.for_source(case["source"]) for case in cases):
        raise SystemExit("Benchmark queries must have a source in the local corpus.")
    providers = Providers(settings)

    def run(case: dict[str, str]) -> dict:
        query = case["query"]
        dense, dense_ms = measure(lambda: search_dense(corpus, providers, query))
        candidates, hybrid_ms = measure(lambda: rank_evidence(corpus, providers, query))
        hybrid = candidates[:RESULT_LIMIT]
        expected = case["source"]
        return {
            "id": case["id"], "language": case["language"], "expected": expected,
            "dense": dense, "dense_rank": source_rank(dense, expected), "dense_ms": dense_ms,
            "hybrid": hybrid, "hybrid_rank": source_rank(hybrid, expected), "hybrid_ms": hybrid_ms,
            "candidate_rank": source_rank(candidates, expected),
        }

    try:
        providers.verify_collection()
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(run, cases))
    except ServiceError as error:
        status = f" (HTTP {error.status})" if error.status is not None else ""
        raise SystemExit(f"{error}{status}") from None
    finally:
        providers.close()

    groups = {lang: [row for row in results if row["language"] == lang]
              for lang in sorted({row["language"] for row in results})}
    print(json.dumps({
        "summary": {
            language: {"questions": len(rows), **{mode: metrics(rows, mode) for mode in ("dense", "hybrid")}}
            for language, rows in {**groups, "all": results}.items()
        },
        "outside_context": [row["id"] for row in results if row["candidate_rank"] and row["hybrid_rank"] is None],
        "missing_candidates": [row["id"] for row in results if row["candidate_rank"] is None],
        "results": [
            {key: round(value) if key.endswith("_ms") else value for key, value in row.items()}
            for row in results
        ],
    }, indent=2))


if __name__ == "__main__":
    main()

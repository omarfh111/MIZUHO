"""Verified local excerpts and a collection-scoped, reproducible vector index."""

import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from time import monotonic
from uuid import NAMESPACE_URL, uuid5

from dotenv import load_dotenv
from pydantic import TypeAdapter

from .bm25 import BM25, fuse_ranks
from .catalog import DATA_DIR, load_catalog
from .models import Citation, Evidence, IndexStatus, PlanningModel
from .providers import EMBEDDING_MODEL, Providers, ServiceError, Services

CORPUS = "mizhuo-m8-v1"
BATCH_SIZE = 16
CANDIDATE_LIMIT = 12
RESULT_LIMIT = 4
POINT_PROVENANCE = ["digest", "embedding_model", "corpus"]


class SourceEntry(PlanningModel):
    source_id: str
    file: str | None = None
    section: str
    published_date: date | None = None
    unavailable_reason: str | None = None
    search_terms: tuple[str, ...] = ()


@dataclass(frozen=True)
class Chunk:
    citation: Citation
    digest: str

    @property
    def payload(self) -> dict:
        return {
            "corpus": CORPUS,
            "digest": self.digest,
            "embedding_model": EMBEDDING_MODEL,
            **self.citation.model_dump(mode="json"),
        }

    @property
    def embedding_text(self) -> str:
        cite = self.citation
        return f"{cite.organization} | {cite.title} | {cite.section}\n{cite.excerpt}"


@dataclass(frozen=True)
class Corpus:
    chunks: dict[str, Chunk]
    unavailable: dict[str, str]
    lexical: BM25 = field(default_factory=lambda: BM25({}), repr=False)

    @property
    def document_count(self):
        return len({chunk.citation.source_id for chunk in self.chunks.values()})

    def for_source(self, source_id: str) -> list[Citation]:
        return [chunk.citation for chunk in self.chunks.values() if chunk.citation.source_id == source_id]


def load_corpus(data_dir: Path, sources: dict[str, Evidence]) -> Corpus:
    manifest = data_dir / "m8_corpus.json"
    directory = data_dir.parent / "docs" / "evidence"
    entries = TypeAdapter(list[SourceEntry]).validate_json(manifest.read_bytes())
    chunks, unavailable, searchable = {}, {}, {}
    seen = set()
    for entry in entries:
        source = sources.get(entry.source_id)
        if source is None or entry.source_id in seen:
            raise ValueError("The M8 corpus contains an unknown or duplicate source.")
        seen.add(entry.source_id)
        if entry.unavailable_reason and not entry.file:
            unavailable[entry.source_id] = entry.unavailable_reason
            continue
        if entry.unavailable_reason or not entry.file or not re.fullmatch(r"[a-z0-9_-]+\.md", entry.file) or source.url is None:
            raise ValueError("A verified M8 excerpt requires a local file and a source URL.")
        markdown = (directory / entry.file).read_text(encoding="utf-8")
        excerpts = re.findall(r"(?m)^> (.+)$", markdown)
        if not excerpts or sum(len(text.split()) for text in excerpts) > 25:
            raise ValueError("An M8 source needs a verified excerpt within the quotation limit.")
        for number, excerpt in enumerate(excerpts):
            key = str(uuid5(NAMESPACE_URL, f"{CORPUS}/{entry.source_id}/{number}"))
            citation = Citation(
                id=key, source_id=entry.source_id, title=source.title, organization=source.organization,
                date=str(entry.published_date or source.date) if entry.published_date or source.date else None,
                page=source.page, url=source.url,
                section=entry.section, excerpt=excerpt.strip(), limitation=source.limitation,
            )
            digest = hashlib.sha256(citation.model_dump_json().encode("utf-8")).hexdigest()
            chunks[key] = Chunk(citation, digest)
            searchable[key] = " ".join((chunks[key].embedding_text, *entry.search_terms))
    return Corpus(chunks, unavailable, BM25(searchable))


def index_status(corpus: Corpus, providers: Providers | None) -> IndexStatus:
    matched = 0
    if providers is not None:
        providers.verify_collection()
        matched = len(indexed_ids(corpus, providers))
    return IndexStatus(
        status="unavailable" if providers is None else "available" if matched == len(corpus.chunks) and matched else "incomplete",
        documents=corpus.document_count, expected_chunks=len(corpus.chunks),
        indexed_chunks=matched if providers is not None else None, unavailable_sources=tuple(corpus.unavailable),
    )


def indexed_ids(corpus: Corpus, providers: Providers) -> set[str]:
    matched = set()
    keys = list(corpus.chunks)
    for start in range(0, len(keys), 64):
        matched.update(verify_point_ids(corpus, providers, keys[start:start + 64], timeout=8))
    return matched


def verify_point_ids(corpus: Corpus, providers: Providers, keys: list[str], *, timeout: float) -> set[str]:
    existing = providers.qdrant("POST", "/points", {
        "ids": keys, "with_payload": POINT_PROVENANCE, "with_vector": False,
    }, timeout=timeout)
    if not isinstance(existing, list):
        raise ServiceError("Qdrant point readback")
    return {chunk.citation.id for item in existing if (chunk := current_point(corpus, item))}


def current_point(corpus: Corpus, point: dict) -> Chunk | None:
    if not isinstance(point, dict):
        return None
    chunk = corpus.chunks.get(str(point.get("id")))
    payload = point.get("payload")
    if (chunk and isinstance(payload, dict) and payload.get("digest") == chunk.digest and payload.get("corpus") == CORPUS
            and payload.get("embedding_model") == EMBEDDING_MODEL):
        return chunk
    return None


def ingest(corpus: Corpus, providers: Providers) -> tuple[int, int]:
    providers.verify_collection()
    known = indexed_ids(corpus, providers)
    changed = [chunk for key, chunk in corpus.chunks.items() if key not in known]
    for offset in range(0, len(changed), BATCH_SIZE):
        batch = changed[offset:offset + BATCH_SIZE]
        vectors = providers.embeddings([chunk.embedding_text for chunk in batch], timeout=20)
        providers.qdrant("PUT", "/points?wait=true", {
            "points": [{"id": chunk.citation.id, "vector": vector, "payload": chunk.payload}
                       for chunk, vector in zip(batch, vectors, strict=True)],
        }, timeout=15)
    if len(indexed_ids(corpus, providers)) != len(corpus.chunks):
        raise ServiceError("Qdrant indexing readback")
    return len(changed), len(known)


def dense_points(corpus: Corpus, providers: Providers, vector: list[float], *, timeout: float, limit: int) -> list[Citation]:
    result = providers.qdrant("POST", "/points/query", {
        "query": vector, "limit": min(limit, len(corpus.chunks)), "with_vector": False,
        "with_payload": POINT_PROVENANCE,
        "filter": {"must": [{"has_id": list(corpus.chunks)}]},
        "score_threshold": 0.19,
    }, timeout=timeout)
    points = result.get("points") if isinstance(result, dict) else None
    if not isinstance(points, list):
        raise ServiceError("Qdrant evidence query")
    return [chunk.citation for item in points if (chunk := current_point(corpus, item))]


def search_dense(corpus: Corpus, providers: Providers, query: str, *, timeout: float = 8,
                 limit: int = RESULT_LIMIT) -> list[Citation]:
    """The original dense-only retrieval path, retained as an evaluation baseline."""
    if not corpus.chunks:
        return []
    vector, = providers.embeddings([query], timeout=timeout / 2)
    return dense_points(corpus, providers, vector, timeout=timeout / 2, limit=limit)


def rank_evidence(corpus: Corpus, providers: Providers, query: str, *, timeout: float = 8,
                  limit: int = RESULT_LIMIT) -> list[Citation]:
    """Rank the verified union before cutting it to the assistant's context size."""
    if not corpus.chunks:
        return []
    deadline = monotonic() + timeout
    vector, = providers.embeddings([query], timeout=timeout / 2)
    lexical = corpus.lexical.rank(query, CANDIDATE_LIMIT)
    dense = dense_points(corpus, providers, vector, timeout=timeout / 2, limit=max(limit, CANDIDATE_LIMIT))
    dense_ids = {citation.id for citation in dense}
    lexical_only = [key for key in lexical if key not in dense_ids]
    if lexical_only:
        available = deadline - monotonic()
        if available <= 0:
            raise ServiceError("Qdrant evidence verification")
        current = verify_point_ids(corpus, providers, lexical_only, timeout=available)
        lexical = [key for key in lexical if key in dense_ids or key in current]
    return [corpus.chunks[key].citation for key in fuse_ranks((item.id for item in dense), lexical)]


def search(corpus: Corpus, providers: Providers, query: str, *, timeout: float = 8,
           limit: int = RESULT_LIMIT) -> list[Citation]:
    return rank_evidence(corpus, providers, query, timeout=timeout, limit=limit)[:limit]


def main():
    parser = argparse.ArgumentParser(description="Index the verified Mizuho evidence corpus.")
    parser.add_argument("--check", action="store_true", help="Read index status without creating embeddings or writing points.")
    args = parser.parse_args()
    load_dotenv(DATA_DIR.parent / ".env")
    settings = Services.from_env()
    if settings is None:
        raise SystemExit("OpenAI and Qdrant configuration is required.")
    providers = Providers(settings)
    try:
        corpus = load_corpus(DATA_DIR, load_catalog().evidence)
        if args.check:
            print(index_status(corpus, providers).model_dump_json())
        else:
            updated, unchanged = ingest(corpus, providers)
            print(json.dumps({"documents": corpus.document_count, "indexed_chunks": len(corpus.chunks),
                              "embedded": updated, "unchanged": unchanged, "unavailable": list(corpus.unavailable)}))
    except (ServiceError, ValueError) as error:
        raise SystemExit(str(error)) from None
    finally:
        providers.close()


if __name__ == "__main__":
    main()

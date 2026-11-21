"""M1 - document retrieval for the assistant: NVIDIA embeddings + Qdrant.

Qdrant: QDRANT_URL (+ QDRANT_API_KEY) from .env, or, when QDRANT_URL is empty,
a local embedded Qdrant stored in data/rag/qdrant_local/ (git-ignored).
"""
from __future__ import annotations

import os
import time
import uuid
from functools import lru_cache
from pathlib import Path

import requests

from backend import llm

ROOT = Path(__file__).resolve().parents[1]
LOCAL_PATH = ROOT / "data" / "rag" / "qdrant_local"


class RAGError(RuntimeError):
    pass


def config() -> dict:
    llm._load_dotenv()
    return {
        "qdrant_url": os.environ.get("QDRANT_URL", "").strip(),
        "qdrant_api_key": os.environ.get("QDRANT_API_KEY", "").strip(),
        "collection": os.environ.get("QDRANT_COLLECTION", "mizu_m1_docs"),
        "embed_model": os.environ.get("EMBED_MODEL", "nvidia/nemotron-3-embed-1b"),
        "embed_base_url": os.environ.get("EMBED_BASE_URL", os.environ.get("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1")).rstrip("/"),
        "embed_api_key": os.environ.get("EMBED_API_KEY", os.environ.get("LLM_API_KEY", "")),
    }


def public_config() -> dict:
    c = config()
    return {"qdrant": c["qdrant_url"] or f"local ({LOCAL_PATH.relative_to(ROOT).as_posix()})",
            "collection": c["collection"], "embed_model": c["embed_model"], "embed_configured": bool(c["embed_api_key"])}


def embed(texts: list[str], kind: str = "passage", tries: int = 5) -> list[list[float]]:
    """kind: 'passage' for documents, 'query' for questions (asymmetric models)."""
    c = config()
    if not c["embed_api_key"]:
        raise RAGError("no embedding key (LLM_API_KEY or EMBED_API_KEY)")
    for i in range(tries):
        r = requests.post(f"{c['embed_base_url']}/embeddings", timeout=90,
                          headers={"Authorization": f"Bearer {c['embed_api_key']}"},
                          json={"model": c["embed_model"], "input": texts, "input_type": kind, "encoding_format": "float"})
        if r.ok:
            return [d["embedding"] for d in sorted(r.json()["data"], key=lambda d: d["index"])]
        if r.status_code not in (429, 500, 502, 503, 504):
            raise RAGError(f"embeddings HTTP {r.status_code}: {r.text[:200].replace(c['embed_api_key'], '***')}")
        time.sleep(2 * (i + 1))
    raise RAGError(f"embeddings unavailable (HTTP {r.status_code})")


@lru_cache(maxsize=1)
def client():
    from qdrant_client import QdrantClient
    c = config()
    if c["qdrant_url"]:
        return QdrantClient(url=c["qdrant_url"], api_key=c["qdrant_api_key"] or None, timeout=30)
    LOCAL_PATH.mkdir(parents=True, exist_ok=True)
    return QdrantClient(path=str(LOCAL_PATH))


def reset_collection(dim: int) -> None:
    from qdrant_client.models import Distance, VectorParams
    c = config()
    cl = client()
    if cl.collection_exists(c["collection"]):
        cl.delete_collection(c["collection"])
    cl.create_collection(c["collection"], vectors_config=VectorParams(size=dim, distance=Distance.COSINE))


def upsert(chunks: list[dict], vectors: list[list[float]]) -> None:
    from qdrant_client.models import PointStruct
    pts = [PointStruct(id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{ch['source_id']}#{ch['chunk']}")), vector=v, payload=ch)
           for ch, v in zip(chunks, vectors)]
    client().upsert(config()["collection"], points=pts)


def count() -> int:
    c = config()
    cl = client()
    if not cl.collection_exists(c["collection"]):
        return 0
    return cl.count(c["collection"]).count


def search(query: str, k: int = 5) -> list[dict]:
    c = config()
    cl = client()
    if not cl.collection_exists(c["collection"]):
        raise RAGError("collection is empty: run scripts/m1_ingest_docs.py")
    vec = embed([query], kind="query")[0]
    hits = cl.query_points(c["collection"], query=vec, limit=k, with_payload=True).points
    return [{**h.payload, "score": round(h.score, 3)} for h in hits]

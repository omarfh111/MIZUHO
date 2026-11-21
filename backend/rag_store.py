from collections import Counter
from dataclasses import dataclass
from hashlib import blake2s
from json import loads
from math import log1p
from os import environ
from pathlib import Path
import re
from unicodedata import combining, normalize

from dotenv import dotenv_values
import httpx


ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / ".rag" / "corpus.json"
COLLECTION = "mizuho_tunisie_public_v1"
VECTOR = "terms"
STOP_WORDS = set(
    "avec dans pour des une les aux du de la le en est au un par sur que qui quoi comment quelle quels quelles "
    "peut faire sont etre ces entre notre nous vous leur cette sous selon sans tunisie tunisien tunisienne "
    "the and for was are how what that can with from which about".split()
)


def config() -> dict:
    return {**dotenv_values(ROOT / ".env", encoding="utf-8-sig"), **environ}


def words(text: str) -> list[str]:
    folded = "".join(ch for ch in normalize("NFKD", text.casefold()) if not combining(ch))
    return [word for word in re.findall(r"[^\W\d_]{3,}", folded) if word not in STOP_WORDS]


def sparse_vector(text: str, *, query: bool = False) -> dict:
    counts = Counter(words(text))
    normalizer = 1.2 * (0.25 + 0.75 * counts.total() / 150)
    indices = {}
    for word, count in counts.items():
        index = int.from_bytes(blake2s(word.encode("utf-8"), digest_size=4).digest(), "big")
        value = 1.0 if query else (count * 2.2) / (count + normalizer)
        indices[index] = max(value, indices.get(index, 0))
    return {"indices": sorted(indices), "values": [indices[index] for index in sorted(indices)]}


@dataclass
class Qdrant:
    client: httpx.Client
    url: str
    key: str

    def call(self, method: str, path: str, body=None):
        return self.client.request(
            method, f"{self.url.rstrip('/')}/collections/{COLLECTION}{path}",
            headers={"api-key": self.key}, json=body,
        )

    def ensure_index(self) -> None:
        response = self.call("GET", "")
        schema = {}
        if response.status_code == 404:
            response = self.call("PUT", "", {
                "vectors": {}, "sparse_vectors": {VECTOR: {"modifier": "idf"}},
            })
        elif response.is_success:
            schema = response.json()["result"]["payload_schema"]
        response.raise_for_status()
        for field in ("corpus_id", "themes"):
            if field not in schema:
                self.call("PUT", "/index?wait=true", {
                    "field_name": field, "field_schema": "keyword",
                }).raise_for_status()

    def index(self, corpus_id: str, docs: list[dict]) -> None:
        self.ensure_index()
        for offset in range(0, len(docs), 64):
            points = [{
                "id": doc["id"], "vector": {VECTOR: sparse_vector(doc["text"])},
                "payload": {
                    "corpus_id": corpus_id, "themes": doc["themes"], "source_id": doc["source_id"],
                    "page": doc["page"], "sha256": doc["sha256"], "url": doc["url"], "text": doc["text"],
                },
            } for doc in docs[offset:offset + 64]]
            self.call("PUT", "/points?wait=true", {"points": points}).raise_for_status()

    def retrieve(self, corpus_id: str, text: str, theme: str) -> list[str]:
        vector = sparse_vector(text, query=True)
        if not vector["indices"]:
            return []
        conditions = [{"key": "corpus_id", "match": {"value": corpus_id}}]
        if theme != "general":
            conditions.append({"key": "themes", "match": {"value": theme}})
        response = self.call("POST", "/points/query", {
            "query": vector, "using": VECTOR, "filter": {"must": conditions},
            "limit": 18, "with_payload": False,
        })
        response.raise_for_status()
        return [point["id"] for point in response.json()["result"]["points"]]


def connect(client: httpx.Client, settings: dict) -> Qdrant | None:
    url, key = settings.get("QDRANT_URL"), settings.get("QDRANT_API_KEY")
    if url and key:
        return Qdrant(client, url, key)
    return None


def local_retrieve(docs: list[dict], text: str, theme: str) -> list[str]:
    query = set(words(text))
    if not query:
        return []
    by_id = {}
    frequencies = Counter()
    for doc in docs:
        if theme != "general" and theme not in doc["themes"]:
            continue
        counts = Counter(words(doc["text"]))
        shared = query & counts.keys()
        frequencies.update(shared)
        if shared:
            by_id[doc["id"]] = {term: counts[term] for term in shared}
    ranking = sorted(by_id, key=lambda id: -sum(
        log1p((len(docs) - frequencies[term] + 0.5) / (frequencies[term] + 0.5))
        * (count / (1 + count)) for term, count in by_id[id].items()
    ))
    return ranking[:18]


def read_corpus() -> dict:
    return loads(CORPUS.read_text(encoding="utf-8"))

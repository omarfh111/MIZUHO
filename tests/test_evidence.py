from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.assistant_api import AssistantRuntime
from backend.catalog import DATA_DIR, load_catalog
from backend.evidence import CORPUS, ingest, index_status, load_corpus, search
from backend.main import create_app
from backend.providers import DIMENSIONS, EMBEDDING_MODEL, ServiceError


@pytest.fixture(scope="module")
def corpus():
    return load_corpus(DATA_DIR, load_catalog().evidence)


class IndexDouble:
    def __init__(self):
        self.points = {}
        self.embedded = []

    def verify_collection(self):
        pass

    def embeddings(self, texts, *, timeout):
        self.embedded.extend(texts)
        return [[1.0] + [0.0] * (DIMENSIONS - 1)] * len(texts)

    def qdrant(self, method, path, body, **kwargs):
        if (method, path) == ("POST", "/points"):
            return [self.points[key] for key in body["ids"] if key in self.points]
        if (method, path) == ("PUT", "/points?wait=true"):
            for item in body["points"]:
                assert len(item["vector"]) == DIMENSIONS
                self.points[item["id"]] = item
            return {"status": "completed"}
        assert (method, path) == ("POST", "/points/query")
        assert len(body["query"]) == DIMENSIONS
        assert set(body["filter"]["must"][0]["has_id"]).issubset(self.points)
        return {"points": list(self.points.values())}


def test_curated_sources_have_authentic_content_and_provenance(corpus):
    assert corpus.document_count == len(corpus.chunks) == 7
    anme, = corpus.for_source("solar")
    assert anme.organization == "ANME"
    assert "1,450 kWh per kilowatt-peak" in anme.excerpt
    assert str(anme.url) == "https://anme.tn/en/content/solar-photovoltaic"
    assert "Regional context" in anme.limitation
    fao, = corpus.for_source("wapor")
    assert fao.date == "2026-04-03"
    ins, = corpus.for_source("ins-households")
    assert ins.page == 3 and str(ins.url).endswith("#page=3")
    dgre, = corpus.for_source("dgre-aquifers")
    assert dgre.page == 7 and str(dgre.url).endswith("#page=8")
    assert "DGRE" in dgre.organization and "134%" in dgre.excerpt
    assert set(corpus.unavailable) == {"jendouba-borehole", "site-pvgis"}
    assert not corpus.for_source("jendouba-borehole")


def test_indexing_reuses_hashes_and_reembeds_changed_passages(corpus):
    db = IndexDouble()
    assert ingest(corpus, db) == (7, 0)
    assert len(db.embedded) == 7
    assert ingest(corpus, db) == (0, 7)
    assert len(db.embedded) == 7
    identifier = next(iter(db.points))
    db.points[identifier]["payload"]["digest"] = "stale"
    assert index_status(corpus, db).indexed_chunks == 6
    assert ingest(corpus, db) == (1, 6)
    assert len(db.embedded) == 8


def test_retrieval_resolves_only_current_local_citations(corpus):
    db = IndexDouble()
    ingest(corpus, db)
    key = next(iter(corpus.chunks))
    db.points[key]["payload"]["excerpt"] = "Injected content"
    db.points[key]["payload"]["organization"] = "Forged organization"
    stale = list(corpus.chunks)[1]
    db.points[stale]["payload"]["digest"] = "stale"
    db.points["foreign"] = {"id": "foreign", "payload": {"corpus": CORPUS, "embedding_model": EMBEDDING_MODEL}}
    rows = search(corpus, db, "solar photovoltaic northwest")
    assert len(rows) == 6
    assert rows[0] == corpus.chunks[key].citation
    assert all(row.id not in (stale, "foreign") for row in rows)


def test_offline_maintains_m6_and_local_passage_routes():
    def factory(data_dir, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence), None, budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/assistant/health").json()["status"] == "unavailable"
        assert client.get("/api/assistant/index").json()["documents"] == 7
        passage, = client.get("/api/evidence/solar/passages").json()
        assert passage["organization"] == "ANME"
        assert client.get("/api/evidence/missing/passages").status_code == 404
        assert client.get("/api/evidence/jendouba-borehole/passages").json() == []
        assert client.post("/api/evidence/search", json={"query": "northwest solar"}).status_code == 503
        assert client.post("/api/assistant/chat", json={"question": "Solar evidence?", "site_id": "jendouba-pilote"}).status_code == 503


def test_evidence_provider_failure_is_reported_as_unavailable():
    def failure(*args, **kwargs):
        raise ServiceError("Qdrant", 403)

    def factory(data_dir, catalog, budget):
        provider = SimpleNamespace(verify_collection=failure, embeddings=failure, close=lambda: None)
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence), provider, budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        assert client.get("/api/assistant/health").json()["status"] == "unavailable"
        result = client.post("/api/evidence/search", json={"query": "ANME"})
        assert result.status_code == 503
        assert result.json() == {"detail": "Qdrant could not complete the request."}

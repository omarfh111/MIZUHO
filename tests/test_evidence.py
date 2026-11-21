from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.assistant_api import AssistantRuntime
from backend.bm25 import BM25, fuse_ranks, tokenize
from backend.catalog import DATA_DIR, load_catalog
from backend.evidence import CORPUS, ingest, index_status, load_corpus, search, search_dense
from backend.main import create_app
from backend.providers import DIMENSIONS, EMBEDDING_MODEL, ServiceError


@pytest.fixture(scope="module")
def corpus():
    return load_corpus(DATA_DIR, load_catalog().evidence)


class IndexDouble:
    def __init__(self):
        self.points = {}
        self.embedded = []
        self.dense_ids = None
        self.readback_ids = []
        self.dense_requests = []

    def verify_collection(self):
        pass

    def embeddings(self, texts, *, timeout):
        self.embedded.extend(texts)
        return [[1.0] + [0.0] * (DIMENSIONS - 1)] * len(texts)

    def qdrant(self, method, path, body, **kwargs):
        if (method, path) == ("POST", "/points"):
            self.readback_ids.append(body["ids"])
            return [self.points[key] for key in body["ids"] if key in self.points]
        if (method, path) == ("PUT", "/points?wait=true"):
            for item in body["points"]:
                assert len(item["vector"]) == DIMENSIONS
                self.points[item["id"]] = item
            return {"status": "completed"}
        assert (method, path) == ("POST", "/points/query")
        assert len(body["query"]) == DIMENSIONS
        assert body["filter"]["must"][0]["has_id"]
        self.dense_requests.append(body)
        candidates = self.points if self.dense_ids is None else self.dense_ids
        return {"points": [self.points[key] for key in candidates][:body["limit"]]}


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
    rows = search(corpus, db, "solar photovoltaic northwest", limit=7)
    assert len(rows) == 6
    assert rows[0] == corpus.chunks[key].citation
    assert all(row.id not in (stale, "foreign") for row in rows)


def test_bm25_matches_accented_french_and_arabic_decimals():
    assert tokenize("KÉBILI 1,450 667,9") == ["kebili", "1450", "667.9"]
    assert tokenize("الطَّاقة ٦٦٧٫٩ ١٬٤٥٠ ۲۰۲۳") == ["طاقة", "667.9", "1450", "2023"]
    index = BM25({"aquifers": "Nappes profondes de Kébili", "solar": "الطاقة 667.9"})
    assert index.rank("kebili", 4) == ["aquifers"]
    assert index.rank("طاقَة ٦٦٧٫٩", 4) == ["solar"]
    assert index.rank("quartz", 4) == []


def test_fusion_boosts_agreement_and_preserves_unique_candidates():
    assert fuse_ranks(["a", "b", "b"], ["b", "c"]) == ["b", "a", "c"]
    assert fuse_ranks(["a", "b"], []) == ["a", "b"]
    assert fuse_ranks([], ["b", "a"]) == ["b", "a"]


@pytest.mark.parametrize("solar_state", ["current", "stale", "missing"])
def test_lexical_only_hits_require_matching_qdrant_provenance(corpus, solar_state):
    db = IndexDouble()
    ingest(corpus, db)
    solar, = corpus.for_source("solar")
    dense_ids = [key for key in db.points if key != solar.id][:4]
    db.dense_ids = dense_ids
    if solar_state == "stale":
        db.points[solar.id]["payload"]["digest"] = "stale"
    if solar_state == "missing":
        del db.points[solar.id]
    db.readback_ids.clear()
    db.embedded.clear()
    query = "الكهروضوئية كيلوواط ذروة"
    dense = search_dense(corpus, db, query)
    assert [item.id for item in dense] == dense_ids
    assert db.dense_requests[-1]["limit"] == 4
    assert db.dense_requests[-1]["score_threshold"] == 0.19
    rows = search(corpus, db, query)
    assert rows == ([*dense[:3], solar] if solar_state == "current" else dense)
    assert db.readback_ids == [[solar.id]]
    assert db.embedded == [query, query]


def test_hybrid_returns_only_the_requested_context_size(corpus):
    db = IndexDouble()
    ingest(corpus, db)
    db.readback_ids.clear()
    rows = search(corpus, db, "quartz")
    assert len(rows) == 4
    assert db.dense_requests[-1]["limit"] == 7
    assert db.readback_ids == []


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

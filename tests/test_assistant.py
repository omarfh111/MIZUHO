import json
from time import monotonic
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.assistant import MAX_ROUNDS, finalize, run_assistant
from backend.assistant_api import AssistantRuntime
from backend.assistant_tools import Turn
from backend.catalog import DATA_DIR, load_catalog
from backend.evidence import load_corpus
from backend.main import create_app
from backend.models import AssistantRequest, Provenance
from backend.providers import DIMENSIONS, ServiceError


@pytest.fixture(scope="module")
def context():
    catalog = load_catalog()
    return catalog, load_corpus(DATA_DIR, catalog.evidence)


def response(*items):
    return {"output": items}


def call(name, arguments, identifier="call_1"):
    return {"type": "function_call", "call_id": identifier, "name": name, "arguments": json.dumps(arguments)}


def complete(paragraphs=(), missing=()):
    answer = json.dumps({"paragraphs": list(paragraphs), "missing_information": list(missing)})
    return response({"type": "message", "content": [{"type": "output_text", "text": answer}]})


def paragraphs_from_tool(body: dict) -> dict:
    facts = json.loads(body["input"][-1]["output"])["facts"]
    plot = next(item for item in facts if item["text"].startswith("Plot A "))
    summary = next(item for item in facts if item["text"].startswith("Proposed schedule:"))
    return complete([{"text": "The optimizer protected minimum coverage during the outage.",
                      "fact_ids": [plot["id"], summary["id"]], "citation_ids": []}])


def test_langgraph_uses_real_m6_for_farmer_a(context):
    catalog, corpus = context
    turns = []

    def respond(body, *, timeout):
        turns.append(body)
        assert {item["name"] for item in body["tools"]} == {
            "search_evidence", "get_site_data", "get_simulation_results", "explain_decision",
        }
        if len(turns) == 1:
            return response(call("explain_decision", {"scenario_id": "mini", "quota_m3": None}))
        return paragraphs_from_tool(body)

    request = AssistantRequest(site_id="jendouba-pilote", question="Why did farmer A receive only 5 m³?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert len(turns) == 2 and answer.tools_used == ("explain_decision",)
    assert any("Plot A (EXP-01): 5 m³" in item.text for item in answer.facts)
    assert any("minimum coverage 50%" in item.text for item in answer.facts)
    assert {item.provenance for item in answer.facts} == {Provenance.SIMULATED}


def test_what_if_uses_original_and_reduced_quota_and_never_edits_state(context):
    catalog, corpus = context
    outputs = []

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("get_simulation_results", {"scenario_id": "jplus1", "quota_m3": 5}))
        tool = json.loads(body["input"][-1]["output"])
        outputs.extend(item["text"] for item in tool["facts"])
        return complete()

    scenario = catalog.scenarios["jplus1"]
    original = scenario.state.model_dump_json()
    request = AssistantRequest(site_id="jendouba-pilote", question="What if the weather scenario quota is reduced to 5 m³?")
    run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert any("Proposed schedule: 6 m³ delivered" in item for item in outputs)
    assert any("before the quota reduction: 8 m³" in item for item in outputs)
    assert scenario.state.model_dump_json() == original


def test_citations_and_missing_data_follow_tool_results(context):
    catalog, corpus = context
    chunk = next(chunk for chunk in corpus.chunks.values() if chunk.citation.source_id == "solar")

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("search_evidence", {"query": "ANME northwest solar yield"}))
        return complete([{"text": "ANME's figure is a regional reference.", "citation_ids": [chunk.citation.id],
                          "fact_ids": []}], ["A site-specific yield estimate is missing."])

    provider = SimpleNamespace(
        respond=respond, embeddings=lambda inputs, **kwargs: [[0.0] * DIMENSIONS],
        qdrant=lambda *args, **kwargs: {"points": [{"id": chunk.citation.id, "payload": chunk.payload}]},
    )
    request = AssistantRequest(site_id="jendouba-pilote", question="What is the PV potential?")
    answer = run_assistant(request, catalog, corpus, provider, 5)
    assert answer.citations == (chunk.citation,)
    assert answer.missing_information == ("A site-specific yield estimate is missing.",)


def test_invented_figures_and_references_cannot_be_rendered(context):
    catalog, corpus = context
    request = AssistantRequest(site_id="jendouba-pilote", question="Make up a number.")
    turn = Turn(request, catalog, corpus, None, monotonic() + 5, 5)
    allowed = turn.fact("The simulated plan delivered 5 m³.", Provenance.SIMULATED)
    answer = finalize(turn, {"paragraphs": [
        {"text": "It delivered 9000 m³.", "citation_ids": [], "fact_ids": [allowed.id]},
        {"text": "It delivered six cubic meters.", "citation_ids": [], "fact_ids": [allowed.id]},
        {"text": "The source confirms the result.", "citation_ids": ["invented"], "fact_ids": [allowed.id]},
        {"text": "The result comes from the simulated plan.", "citation_ids": [], "fact_ids": [allowed.id]},
        {"text": "This unsupported claim has no grounding.", "citation_ids": [], "fact_ids": []},
    ], "missing_information": ["Unexpected reading of 9000 cubic meters.", "Pipe measurements are unavailable."]})
    assert [paragraph.text for paragraph in answer.paragraphs] == ["The result comes from the simulated plan."]
    assert answer.facts == (allowed,) and not answer.citations
    assert answer.missing_information == ("Pipe measurements are unavailable.",)


def test_verified_citation_survives_rejected_numerical_prose(context):
    catalog, corpus = context
    request = AssistantRequest(site_id="jendouba-pilote", question="What does ANME report?")
    turn = Turn(request, catalog, corpus, None, monotonic() + 5, 5)
    solar, = corpus.for_source("solar")
    wapor, = corpus.for_source("wapor")
    turn.citations.update({solar.id: solar, wapor.id: wapor})
    answer = finalize(turn, {"paragraphs": [
        {"text": "ANME measured 9000 kWh at the pilot.", "citation_ids": [solar.id], "fact_ids": []},
        {"text": "FAO counted 800 farms.", "citation_ids": [wapor.id, "invented"], "fact_ids": []},
    ]})
    assert not answer.paragraphs
    assert answer.citations == (solar,)
    assert not answer.missing_information


def test_explicitly_requested_allocation_is_preserved_when_prose_is_rejected(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("explain_decision", {"scenario_id": "mini", "quota_m3": None}))
        return complete([{"text": "Plot A received 999 m³.", "citation_ids": [], "fact_ids": ["f1"]}])

    request = AssistantRequest(site_id="jendouba-pilote", question="Why did grower A receive only 5 m³?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert not answer.paragraphs
    assert len(answer.facts) == 1
    assert "Plot A (EXP-01): 5 m³" in answer.facts[0].text


def test_agent_budget_bounds_tools(context):
    catalog, corpus = context
    calls = 0

    def respond(body, *, timeout):
        nonlocal calls
        calls += 1
        return response(call("get_site_data", {"include_solar": False}, f"call_{calls}"))

    request = AssistantRequest(site_id="jendouba-pilote", question="Which data are simulated?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert calls == MAX_ROUNDS
    assert any("budget" in gap for gap in answer.missing_information)


def test_chat_api_validates_inputs_and_handles_provider_failure():
    def complete_failure(*args, **kwargs):
        raise ServiceError("OpenAI Responses", 429)

    def factory(data_dir, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence),
                                SimpleNamespace(respond=complete_failure, close=lambda: None), budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        response = client.post("/api/assistant/chat", json={"question": "    ", "site_id": "jendouba-pilote"})
        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body", "question"]
        response = client.post("/api/assistant/chat", json={"question": "Evidence?", "site_id": "unknown"})
        assert response.status_code == 422
        assert response.json()["detail"][0]["loc"] == ["body", "site_id"]
        response = client.post("/api/assistant/chat", json={"question": "Evidence?", "site_id": "jendouba-pilote"})
        assert response.status_code == 503
        assert response.json() == {"detail": "OpenAI Responses could not complete the request."}

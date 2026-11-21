import json
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.assistant import MAX_ROUNDS, finalize, run_assistant
from backend.assistant_api import AssistantRuntime
from backend.assistant_memory import NAMESPACE
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
            "get_agricultural_insights", "get_sensor_anomalies",
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
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert any("Proposed schedule: 6 m³ delivered" in item for item in outputs)
    assert any("before the quota reduction: 8 m³" in item for item in outputs)
    assert "lower withdrawal quota" in answer.paragraphs[0].text
    assert any("2 m³ minimum delivery shortfall" in fact.text for fact in answer.facts)
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
    assert answer.paragraphs[0].citation_ids == (solar.id,)
    assert "9000" not in answer.paragraphs[0].text
    assert answer.citations == (solar,)
    assert not answer.missing_information


def test_official_attribution_and_application_facts_are_separated(context):
    catalog, corpus = context
    solar, = corpus.for_source("solar")

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("get_site_data", {"include_solar": True}),
                            call("search_evidence", {"query": "ANME solar yield"}, "publisher"))
        site = json.loads(body["input"][-2]["output"])
        official = json.loads(body["input"][-1]["output"])["verified_passages"][0]
        assert official["excerpt"] == solar.excerpt and "limitation" not in official
        canopy = next(fact for fact in site["facts"] if "Solar canopy" in fact["text"])
        return complete([{"text": "ANME says the canopy is synthetic and needs a site survey.",
                          "fact_ids": [canopy["id"]], "citation_ids": [solar.id]}])

    provider = SimpleNamespace(
        respond=respond, embeddings=lambda *args, **kwargs: [[0.0] * DIMENSIONS],
        qdrant=lambda *args, **kwargs: {"points": [{"id": solar.id, "payload": corpus.chunks[solar.id].payload}]},
    )
    request = AssistantRequest(site_id="jendouba-pilote", question="What can I conclude from ANME and the pilot model?")
    answer = run_assistant(request, catalog, corpus, provider, 5)
    model, source = answer.paragraphs
    assert "modeled generation and avoided grid energy" in model.text
    assert model.fact_ids and not model.citation_ids
    assert source.citation_ids == (solar.id,) and not source.fact_ids
    assert "from ANME" in source.text and "synthetic" not in source.text
    assert answer.citations == (solar,)


def test_explicitly_requested_allocation_is_preserved_when_prose_is_rejected(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("explain_decision", {"scenario_id": "mini", "quota_m3": None}))
        return complete([{"text": "Plot A received 999 m³.", "citation_ids": [], "fact_ids": ["f1"]}])

    request = AssistantRequest(site_id="jendouba-pilote", question="Why did grower A receive only 5 m³?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert "maximizes the worst priority coverage" in answer.paragraphs[0].text
    assert "available withdrawal quota" in answer.paragraphs[0].text
    assert "999" not in answer.model_dump_json()
    assert any("Plot A (EXP-01): 5 m³" in fact.text for fact in answer.facts)


def test_provider_failure_after_calculation_keeps_verified_explanation(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("get_simulation_results", {"scenario_id": "jplus1", "quota_m3": 5}))
        raise ServiceError("OpenAI Responses")

    request = AssistantRequest(site_id="jendouba-pilote", question="What if the quota is reduced to 5 m³?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert "lower withdrawal quota" in answer.paragraphs[0].text
    assert any("2 m³ minimum delivery shortfall" in fact.text for fact in answer.facts)
    assert "OpenAI Responses could not complete" in answer.missing_information[0]


def test_retrieval_failure_explains_unavailability_without_inventing_citations(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("search_evidence", {"query": "ANME regional solar potential"}))
        return complete()

    def unavailable(*args, **kwargs):
        raise ServiceError("Qdrant")

    request = AssistantRequest(site_id="jendouba-pilote", question="What does ANME report?")
    provider = SimpleNamespace(respond=respond, qdrant=unavailable,
                               embeddings=lambda *args, **kwargs: [[0.0] * DIMENSIONS])
    answer = run_assistant(request, catalog, corpus, provider, 5)
    assert "Qdrant is unavailable" in answer.paragraphs[0].text
    assert not answer.citations and not answer.facts


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


@pytest.fixture
def memory_chat(context):
    _, corpus = context
    citation, = corpus.for_source("solar")
    prompts = []
    quota_args = {"scenario_id": "mini", "quota_m3": None}

    def respond(body, *, timeout):
        messages = body["input"]
        prompt = json.loads(messages[0]["content"])
        question = prompt["question"]
        if len(messages) == 1:
            prompts.append(prompt)
            if "seed" in question:
                return response(call("explain_decision", quota_args),
                                call("search_evidence", {"query": "ANME photovoltaic"}, "call_2"))
            if question == "Run the same scenario again.":
                return response(call("get_simulation_results", {**quota_args, "scenario_id": None}))
            if question == "Provider failure.":
                raise ServiceError("OpenAI Responses")
            if prompt["prior_answers"]:
                prior = prompt["prior_answers"][-1]
                return complete([{
                    "text": "Here is the earlier verified context.",
                    "fact_ids": [item["id"] for item in prior["facts"]],
                    "citation_ids": [],
                }, {
                    "text": "The official excerpt is below.", "fact_ids": [],
                    "citation_ids": [item["id"] for item in prior["citations"]],
                }])
            return complete()
        output = json.loads(messages[-1]["output"])
        if "error" in output:
            return complete()
        if "seed" in question:
            facts = json.loads(messages[-2]["output"])["facts"]
            plot = next(item for item in facts if item["text"].startswith("Plot A "))
            inputs = next(item for item in facts if "starting stock" in item["text"])
            return complete([{"text": "The optimizer protected minimum coverage during the outage.",
                              "fact_ids": [plot["id"], inputs["id"]], "citation_ids": []},
                             {"text": "The official excerpt is below.", "fact_ids": [], "citation_ids": [citation.id]}])
        return paragraphs_from_tool(body)

    def factory(data_dir, catalog, budget):
        def qdrant(method, path, body, **kwargs):
            item = {"id": citation.id, "payload": corpus.chunks[citation.id].payload}
            return {"points": [item]} if path == "/points/query" else [item]

        provider = SimpleNamespace(respond=respond, close=lambda: None, qdrant=qdrant,
                                   embeddings=lambda *args, **kwargs: [[0.0] * DIMENSIONS])
        return AssistantRuntime(catalog, corpus, provider, budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        def chat(question, session_id=None, **kwargs):
            return client.post("/api/assistant/chat", json={
                "site_id": "jendouba-pilote", "question": question,
                "session_id": str(session_id) if session_id else None, **kwargs,
            })

        yield client, chat, prompts


def test_session_reuses_verified_citations_facts_and_scenario_without_replaying_private_text(memory_chat):
    client, chat, prompts = memory_chat
    session = uuid4()
    marker = "private fixture token that should never be stored"
    first = chat(f"Please seed the conversation. {marker}", session)
    assert first.status_code == 200
    assert first.json()["citations"][0]["organization"] == "ANME"
    assert "Plot A (EXP-01): 5 m³" in first.json()["facts"][0]["text"]
    item = client.app.state.assistant.memory.store.get(NAMESPACE, str(session))
    assert marker not in json.dumps(item.value)
    assert first.json()["paragraphs"][0]["text"] not in json.dumps(item.value)
    assert "starting stock" not in json.dumps(item.value)
    second = chat("Which figure and source did you just give me?", session)
    assert second.status_code == 200
    assert second.json()["citations"] == first.json()["citations"]
    assert len(second.json()["facts"]) == 1
    for key in ("text", "provenance"):
        assert second.json()["facts"][0][key] == first.json()["facts"][0][key]
    assert second.json()["paragraphs"][0]["fact_ids"] == [second.json()["facts"][0]["id"]]
    assert second.json()["paragraphs"][1]["citation_ids"] == [second.json()["citations"][0]["id"]]
    assert "from ANME" in second.json()["paragraphs"][1]["text"]
    assert second.json()["tools_used"] == []
    assert prompts[-1]["previous_scenario"] == "mini"
    assert marker not in json.dumps(prompts[-1])
    assert "limitation" not in prompts[-1]["prior_answers"][0]["citations"][0]
    recalculate = chat("Run the same scenario again.", session)
    assert recalculate.status_code == 200
    assert recalculate.json()["tools_used"] == ["get_simulation_results"]
    assert any("Plot A (EXP-01): 5 m³" in fact["text"] for fact in recalculate.json()["facts"])


def test_session_memory_is_isolated_and_legacy_requests_are_stateless(memory_chat):
    client, chat, prompts = memory_chat
    session = uuid4()
    assert chat("Please seed the conversation.", session).status_code == 200
    for isolated in (uuid4(), None):
        answer = chat("What did I just ask you?", isolated)
        assert answer.status_code == 200
        assert answer.json()["facts"] == answer.json()["citations"] == []
        assert prompts[-1]["prior_answers"] == []
        assert prompts[-1]["previous_scenario"] is None
    with client.app.state.assistant.memory.session(session):
        assert chat("A concurrent question.", session).status_code == 409
    assert chat("An invalid session.", "not-a-session").status_code == 422


def test_stale_simulation_clears_facts_even_if_the_next_request_fails(memory_chat):
    _, chat, prompts = memory_chat
    session = uuid4()
    initial = dict(selected_scenario_id="mini", simulation_revision=0)
    edited = dict(selected_scenario_id="mini", simulation_revision=1, simulation_pending=True)
    assert chat("Please seed the conversation.", session, **initial).status_code == 200
    followup = chat("Run the same scenario again.", session, **edited)
    assert followup.status_code == 200
    assert followup.json()["facts"] == []
    assert "inputs changed" in " ".join(followup.json()["missing_information"])
    assert prompts[-1]["prior_answers"][0]["facts"] == []
    assert prompts[-1]["previous_scenario"] is None
    assert chat("Please seed the conversation.", session, **initial).status_code == 200
    assert chat("Provider failure.", session, **edited).status_code == 503
    answer = chat("Which figure and source did you just give me?", session, **initial).json()
    assert answer["facts"] == []
    assert answer["citations"][0]["organization"] == "ANME"
    assert answer["paragraphs"][0]["citation_ids"] == [answer["citations"][0]["id"]]


def test_changing_comparison_inputs_invalidates_memory_without_a_revision(memory_chat, context):
    _, chat, prompts = memory_chat
    catalog, _ = context
    scenario = catalog.scenarios["mini"]
    session = uuid4()
    comparison = {
        "scenario_id": scenario.id, "state": scenario.state.model_dump(mode="json"),
        "outage_slots": [slot.slot for slot in scenario.slots if not slot.grid_available],
        "solar_option_id": None,
    }
    assert chat("Please seed the conversation.", session, comparison=comparison).status_code == 200
    updated = {**comparison, "state": {**comparison["state"], "tank_stock_m3": 9}}
    answer = chat("Which figure and source did you just give me?", session, comparison=updated)
    assert answer.status_code == 200
    assert answer.json()["facts"] == []
    assert answer.json()["citations"][0]["organization"] == "ANME"
    assert prompts[-1]["active_scenario"] == "mini"
    assert prompts[-1]["previous_scenario"] is None


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

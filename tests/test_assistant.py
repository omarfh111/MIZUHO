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
    return {"output": list(items)}


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
    assert "maximizes the worst priority coverage" in answer.paragraphs[0].text
    assert any("Plot A (EXP-01): 5 m³" in item.text for item in answer.facts)
    assert any("minimum coverage 50%" in item.text for item in answer.facts)
    assert {item.provenance for item in answer.facts} == {Provenance.SIMULATED}


def test_japanese_reply_preserves_solver_values_and_original_evidence(context):
    catalog, corpus = context
    source = next(chunk for chunk in corpus.chunks.values() if chunk.citation.source_id == "solar")

    def respond(body, *, timeout):
        assert "in Japanese" in body["instructions"]
        if len(body["input"]) == 1:
            return response(call("explain_decision", {"scenario_id": "mini", "quota_m3": None}),
                            call("search_evidence", {"query": "ANME photovoltaic Tunisia"}, "source"))
        return complete()

    def retrieve(method, path, body, **kwargs):
        point = {"id": source.citation.id, "payload": source.payload}
        return {"points": [point]} if path == "/points/query" else []

    providers = SimpleNamespace(respond=respond, embeddings=lambda *args, **kwargs: [[0.] * DIMENSIONS],
                                qdrant=retrieve)
    result = run_assistant(AssistantRequest(site_id="jendouba-pilote", language="ja",
                           question="なぜ区画Aへの配水量が制限されたのですか？"), catalog, corpus, providers, 5)
    assert "最適化では" in result.paragraphs[0].text
    assert any(fact.text.startswith("Plot A (EXP-01): 5 m³") for fact in result.facts)
    assert result.citations == (source.citation,)
    assert any("の原文" in paragraph.text for paragraph in result.paragraphs)


def test_city_assistant_uses_the_same_public_profile_and_isolates_city_facts():
    prompts = []

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            prompts.append(json.loads(body["input"][0]["content"]))
            assert {tool["name"] for tool in body["tools"]} == {"get_city_data", "search_evidence"}
            return response(call("get_city_data", {}), call("explain_decision", {"scenario_id": "mini"}, "out-of-scope"))
        assert "unavailable for the active location" in body["input"][-1]["output"]
        return complete()

    def factory(data_dir, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence),
                                SimpleNamespace(respond=respond, close=lambda: None), budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        session_id = str(uuid4())
        catalogue = client.get("/api/tunisia").json()
        first, second = catalogue["cities"][:2]
        for city, period in ((first, None), (first, {"start": "2025-07-01", "end": "2025-07-07"}), (second, None)):
            profile = client.get(f"/api/tunisia/cities/{city['id']}", params=period or {}).json()
            request = {"city_id": city["id"], "city_period": period, "question": "What does the climate archive say?",
                       "session_id": session_id}
            reply = client.post("/api/assistant/chat", json=request)
            assert reply.status_code == 200
            answer = reply.json()
            assert answer["tools_used"] == ["get_city_data"]
            climate = profile["climate"]
            assert any(fact["provenance"] == "estimated" and fact["source_url"] == climate["source"]["url"]
                       and f"{climate['temperature_mean_c']:g} °C" in fact["text"] for fact in answer["facts"])
            assert all(fact["text"].startswith(city["name"]) for fact in answer["facts"])
            assert any("validated farm demand" in gap for gap in answer["missing_information"])
        assert all(not prompt["prior_answers"] for prompt in prompts)
        assert client.post("/api/assistant/chat", json={**request, "site_id": "jendouba-pilote"}).status_code == 422
        assert client.post("/api/assistant/chat", json={
            **request, "city_period": {"start": "1970-01-01", "end": "1970-01-04"},
        }).status_code == 422


def test_researched_site_assistant_uses_registered_cover_and_source_links(context):
    catalog, corpus = context
    zone = catalog.field_zones["korba-cap-bon"]
    counts = zone.land_cover.pixel_counts

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("get_site_data", {"include_solar": False}))
        return complete()

    request = AssistantRequest(site_id="korba-cap-bon", question="How does this zone compare on farmland and terrain?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    cover = next(fact for fact in answer.facts if fact.source_url == zone.land_cover.source.url)
    assert f"{100 * counts[40] / sum(counts.values()):.2f}%" in cover.text
    assert cover.provenance == Provenance.ESTIMATED
    assert set(zone.missing_inputs) <= set(answer.missing_information)


def test_regional_assistant_checks_displayed_plan_and_expires_earlier_allocations():
    prompts = []

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            prompts.append(json.loads(body["input"][0]["content"]))
            return response(call("explain_decision", {"scenario_id": None, "quota_m3": None}))
        return complete()

    def factory(data_dir, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence),
                                SimpleNamespace(respond=respond, close=lambda: None), budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        site = "korba-cap-bon"
        assumptions = dict(date="2025-07-15", tank_capacity_m3=10, initial_stock_m3=6, withdrawal_limit_m3=0,
                           pump_flow_m3_h=3, pump_wh_per_m3=500, gravity_flow_m3_h=4, grid_cap_w=2000,
                           pv_capacity_kwp=3, pv_performance_ratio=.8, demand_west_m3=6, demand_east_m3=6,
                           delivery_start_hour=8, delivery_end_hour=10, outage_hours=[8, 9])
        basis = dict(date=assumptions["date"], area_m2=600, crop_coefficient=.9,
                     effective_rain_fraction=.5, application_efficiency=.8)
        estimate = client.post(f"/api/sites/{site}/demand-estimate", json=basis).json()
        assumptions.update(demand_west_m3=estimate["demand_m3"], demand_basis={"west": basis})
        computed = client.post(f"/api/sites/{site}/planning", json=assumptions).json()
        receipt = {"inputs": assumptions, "comparison_id": computed["comparison_id"]}
        message = {"site_id": site, "session_id": str(uuid4()), "question": "Why did the west sector get that volume?"}
        reply = client.post("/api/assistant/chat", json={**message, "zone_plan": receipt})
        assert reply.status_code == 200
        answer = reply.json()
        assert answer["tools_used"] == ["explain_decision"]
        for plot in computed["comparison"]["optimized"]["plot_results"]:
            assert any(f"Hypothetical {plot['plot_id']} sector: {plot['delivered_on_time_m3']} m³" in item["text"]
                       and item["provenance"] == "simulated" and not item["source_url"] for item in answer["facts"])
        assert any(item["source_url"] == computed["source"]["url"] and item["provenance"] == "estimated"
                   for item in answer["facts"])
        assert any("MIZUHO derived" in item["text"] and not item["source_url"] for item in answer["facts"])
        assert any(f"west sector demand of {estimate['demand_m3']} m³" in item["text"]
                   and item["provenance"] == "simulated" for item in answer["facts"])
        assert all(not item["citation_ids"] for item in answer["paragraphs"])
        pending = client.post("/api/assistant/chat", json=message).json()
        assert not pending["facts"] and not prompts[-1]["prior_answers"]
        assert any("Run the regional comparison" in gap for gap in pending["missing_information"])
        mismatched = {**receipt, "comparison_id": "0" * 64}
        stale = client.post("/api/assistant/chat", json={**message, "zone_plan": mismatched}).json()
        assert not stale["facts"] and any("reproduce the displayed schedule" in gap for gap in stale["missing_information"])
        assert client.post("/api/assistant/chat", json={**message, "site_id": "jendouba-pilote", "zone_plan": receipt}).status_code == 422


def test_regional_assistant_refuses_a_receipt_from_another_site_day_or_station(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("explain_decision", {"scenario_id": None, "quota_m3": None}))
        return complete()

    def factory(*_):
        return AssistantRuntime(catalog, corpus, SimpleNamespace(respond=respond, close=lambda: None), 2)

    with TestClient(create_app(assistant_factory=factory)) as client:
        inputs = dict(date="2025-07-15", tank_capacity_m3=20, initial_stock_m3=10, withdrawal_limit_m3=0,
                      pump_flow_m3_h=4, pump_wh_per_m3=500, gravity_flow_m3_h=4, grid_cap_w=0,
                      pv_capacity_kwp=0, pv_performance_ratio=.8, demand_west_m3=8, demand_east_m3=8,
                      delivery_start_hour=8, delivery_end_hour=19, outage_hours=[])
        original = client.post("/api/sites/korba-cap-bon/planning", json=inputs).json()
        for site_id, changed_inputs in (("gafsa-oasis", inputs), ("kairouan-chebika", inputs),
                                        ("korba-cap-bon", {**inputs, "date": "2025-01-15"}),
                                        ("korba-cap-bon", {**inputs, "tank_capacity_m3": 25})):
            updated = client.post(f"/api/sites/{site_id}/planning", json=changed_inputs).json()
            assert updated["comparison"] == original["comparison"]
            assert updated["comparison_id"] != original["comparison_id"]
            receipt = {"inputs": changed_inputs, "comparison_id": original["comparison_id"]}
            reply = client.post("/api/assistant/chat", json={"site_id": site_id, "zone_plan": receipt,
                                "question": "Explain the displayed allocation."})
            assert reply.status_code == 200
            assert not reply.json()["facts"]
            assert any("reproduce the displayed schedule" in gap for gap in reply.json()["missing_information"])


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
    assert any("Field measurements are needed" in gap for gap in answer.missing_information)


def test_malformed_completion_after_calculation_keeps_verified_explanation(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("explain_decision", {"scenario_id": "mini", "quota_m3": None}))
        return response({"type": "message", "content": None})

    request = AssistantRequest(site_id="jendouba-pilote", question="Why did grower A receive only 5 m³?")
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert any("Plot A (EXP-01): 5 m³" in fact.text for fact in answer.facts)
    assert any("OpenAI Responses could not complete" in gap for gap in answer.missing_information)


def test_retrieved_evidence_survives_an_answer_with_app_facts_only(context):
    catalog, corpus = context
    solar, = corpus.for_source("solar")

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("get_site_data", {"include_solar": True}),
                            call("search_evidence", {"query": "ANME solar yield"}, "publisher"))
        facts = json.loads(body["input"][-2]["output"])["facts"]
        return complete([{"text": "The canopy comparison uses a modeled profile.",
                          "fact_ids": [facts[-1]["id"]], "citation_ids": []}])

    provider = SimpleNamespace(
        respond=respond, embeddings=lambda *args, **kwargs: [[0.0] * DIMENSIONS],
        qdrant=lambda *args, **kwargs: {"points": [{"id": solar.id, "payload": corpus.chunks[solar.id].payload}]},
    )
    request = AssistantRequest(site_id="jendouba-pilote", question="What can I conclude from ANME and the pilot model?")
    answer = run_assistant(request, catalog, corpus, provider, 5)
    model, source = answer.paragraphs
    assert model.fact_ids and not model.citation_ids
    assert source.citation_ids == (solar.id,) and not source.fact_ids


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


def test_null_scenario_uses_the_current_selection_before_an_alternate_preset(memory_chat):
    _, chat, prompts = memory_chat
    session = uuid4()
    assert chat("Please seed the conversation.", session, selected_scenario_id="jplus1").status_code == 200
    response = chat("Run the same scenario again.", session, selected_scenario_id="jplus1")
    assert response.status_code == 200
    assert prompts[-1]["previous_scenario"] == "mini"
    assert any("Proposed schedule: 8 m³ delivered" in fact["text"] for fact in response.json()["facts"])


@pytest.mark.parametrize("output", [
    [{"type": "message", "content": [None]}],
    [{"type": "function_call", "name": "get_site_data", "call_id": "call_1"}],
    [{"type": "function_call", "name": "get_site_data", "call_id": "call_1", "arguments": "{}"}] * 2,
])
def test_invalid_provider_payload_fails_cleanly_and_releases_chat_capacity(output):
    def respond(body, *, timeout):
        return complete() if "Retry" in body["input"][0]["content"] else response(*output)

    def factory(data_dir, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence),
                                SimpleNamespace(respond=respond, close=lambda: None), budget)

    with TestClient(create_app(assistant_factory=factory), raise_server_exceptions=False) as client:
        body = {"site_id": "jendouba-pilote", "question": "What evidence do we have?", "session_id": str(uuid4())}
        for _ in range(3):
            failure = client.post("/api/assistant/chat", json=body)
            assert failure.status_code == 503
            assert failure.json() == {"detail": "OpenAI Responses could not complete the request."}
        assert client.post("/api/assistant/chat", json={**body, "question": "Retry evidence."}).status_code == 200


def test_selected_archive_uses_pvgis_output_before_plan_calculation():
    prompts = []

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            prompt = json.loads(body["input"][0]["content"])
            prompts.append(prompt)
            return response(call("get_site_data", {"include_solar": not bool(prompt["selected_pvgis"])}))
        if prompts[-1]["selected_pvgis"]:
            site = json.loads(body["input"][-1]["output"])["facts"][0]
            return complete([{"text": "The site is simulated.", "fact_ids": [site["id"]], "citation_ids": []}])
        return complete()

    def factory(data_dir, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(data_dir, catalog.evidence),
                                SimpleNamespace(respond=respond, close=lambda: None), budget)

    with TestClient(create_app(assistant_factory=factory)) as client:
        expected = client.post("/api/solar/compare-archive", json={
            "site_id": "jendouba-pilote", "option_ids": ["ombriere", "toiture"],
        })
        assert expected.status_code == 200
        archive = expected.json()["options"][0]
        body = {"site_id": "jendouba-pilote", "question": "What does the selected PVGIS canopy produce?",
                "session_id": str(uuid4()), "pvgis_option_id": "ombriere",
                "selected_scenario_id": "mini", "simulation_pending": True}
        result = client.post("/api/assistant/chat", json=body)
        assert result.status_code == 200
        facts = result.json()["facts"]
        assert any(fact["provenance"] == "estimated"
                   and f"{archive['production_kwh']:g} kWh estimated production" in fact["text"]
                   and "Solar canopy (selected" in fact["text"] for fact in facts)
        assert not any("on the modeled day" in fact["text"] for fact in facts)

        active = {key: value for key, value in body.items() if key != "pvgis_option_id"}
        result = client.post("/api/assistant/chat", json={**active, "solar_option_id": "ombriere"})
        assert result.status_code == 200
        assert prompts[-1]["prior_answers"] == []
        assert any("on the modeled day" in fact["text"] for fact in result.json()["facts"])
        assert client.post("/api/assistant/chat", json={**body, "solar_option_id": "ombriere"}).status_code == 422


def test_assistant_accepts_completed_deliveries_under_changed_demand(context):
    catalog, corpus = context

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return response(call("get_simulation_results", {"scenario_id": None, "quota_m3": None}))
        return complete()

    scenario = catalog.scenarios["normal"]
    request = AssistantRequest(site_id=scenario.site_id, question="Show the current schedule.", comparison={
        "scenario_id": scenario.id,
        "state": {
            "current_slot": 9, "tank_stock_m3": 12, "quota_remaining_m3": 49,
            "delivered_by_plot_m3": {"A": 16}, "delivered_on_time_by_plot_m3": {"A": 16},
        },
        "outage_slots": [], "solar_option_id": None, "overrides": {"demand_by_plot_m3": {"A": 18}},
    })
    answer = run_assistant(request, catalog, corpus, SimpleNamespace(respond=respond), 5)
    assert answer.tools_used == ("get_simulation_results",)
    assert any(fact.text.startswith("Proposed schedule:") for fact in answer.facts)


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

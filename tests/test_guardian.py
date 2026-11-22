"""Exercise the Guardian's real socket, physical replay, optimizer and local M8 passages."""

import asyncio
import base64
import json
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.assistant_api import AssistantRuntime
from backend.catalog import DATA_DIR
from backend.evidence import load_corpus
from backend.guardian_provider import GuardianProvider, GuardianProviderError
from backend.main import create_app
from backend.providers import DIMENSIONS, ServiceError


@pytest.fixture(scope="module")
def client():
    def offline(directory, catalog, budget):
        return AssistantRuntime(catalog, load_corpus(directory, catalog.evidence), None, budget)
    app = create_app(assistant_factory=offline)
    app.state.guardian_provider = lambda: GuardianProvider(key="")
    app.state.guardian_manager_code = b""
    with TestClient(app) as connection:
        yield connection


def connect(client, origin="http://testserver"):
    return client.websocket_connect("/api/guardian/call", headers={"origin": origin})


def exchange(ws, **frame):
    ws.send_json(frame)
    return ws.receive_json()


def context(scenario="mini", **changes):
    data = json.loads((DATA_DIR / "scenarios" / f"{scenario}.json").read_text(encoding="utf-8"))
    comparison = {"scenario_id": scenario, "state": data["state"], "solar_option_id": None,
                  "outage_slots": [slot["slot"] for slot in data["slots"] if not slot["grid_available"]]}
    if scenario == "jplus1":
        comparison.update(planning_mode="weather_buffer", weather_pair_id="jplus1-demo")
    else:
        comparison["state"]["quota_remaining_m3"] = 6
    return {"type": "start", "reason": "accessibility", "site_id": data["site_id"], "comparison": comparison, **changes}


def selection(client, start, plan="optimized", **injections):
    response = client.post("/api/compare", json=start["comparison"])
    assert response.is_success, response.text
    calculated = response.json()
    weather = calculated["weather_comparison"]
    selected = weather["buffer_on_adverse" if plan == "optimized" else "reference_on_adverse"] if weather else calculated[plan]
    actions = [{key: row[key] for key in ("slot", "pump_m3", "deliveries")} for row in selected["actions"]]
    return {"plan": plan, "weather_profile": "adverse" if weather else "central", "actions": actions,
            "selected_slot": actions[0]["slot"], **injections}


def test_verified_emergency_prioritizes_discrepancy_over_concurrent_grid_outage(client):
    start = context(reason="emergency")
    start["telemetry"] = selection(client, start, balance_anomaly_slots=[1], plan="baseline")
    with connect(client) as ws:
        incoming = exchange(ws, **start)
        assert incoming["type"] == "ready"
        assert incoming["trigger"]["type"] == "unexplained_water"
        assert incoming["trigger"]["simulation_slot"] == 1 and incoming["trigger"]["source"] == "virtual_sensor"
        assert "01:00 heure de Tunis" in incoming["text"]
        assert "13 m³" in incoming["text"] and "avant de conclure à une fuite" in incoming["text"]
        assert "0 m³" in exchange(ws, type="message", text="réservoir")["text"]
    start["telemetry"]["selected_slot"] = 2
    with connect(client) as ws:
        assert exchange(ws, **start)["code"] == "invalid_context"
    start["telemetry"]["selected_slot"] = 1
    start["telemetry"]["actions"][0]["pump_m3"] = 9
    with connect(client) as ws:
        assert exchange(ws, **start)["code"] == "invalid_context"


def test_missing_flow_record_and_call_isolation(client):
    start = context(reason="clarification")
    start["telemetry"] = selection(client, start, plan="baseline", selected_slot=2, missing_flow_slots=[2])
    with connect(client) as ws, connect(client) as other:
        assert "absence de lecture" in exchange(ws, **start)["text"]
        note = "Le compteur local est illisible."
        assert note in exchange(ws, type="observation", text=note)["text"]
        assert note in exchange(ws, type="message", text="Mon observation ?")["text"]
        exchange(other, **start)
        assert note not in exchange(other, type="message", text="Mon observation ?")["text"]
        assert "écart" not in exchange(ws, type="message", text="résume l’alerte")["text"]


def test_explicit_one_time_confirmation_revalidates_scope(client):
    start = context()
    with connect(client) as ws, connect(client) as other:
        exchange(ws, **start)
        exchange(other, **start)
        assert exchange(ws, type="propose", quota_m3=7)["code"] == "invalid_proposal"
        one = exchange(ws, type="propose", quota_m3=4)["proposal"]
        assert exchange(other, type="confirm", id=one["id"])["code"] == "stale_proposal"
        two = exchange(ws, type="propose", quota_m3=3)["proposal"]
        assert exchange(ws, type="confirm", id=one["id"])["code"] == "stale_proposal"
        exchange(ws, type="observation", text="Le niveau est en cours de vérification.")
        assert exchange(ws, type="confirm", id=two["id"])["code"] == "stale_proposal"
        proposed = exchange(ws, type="propose", quota_m3=3)
        assert "comparison" not in proposed and "result" not in proposed
        assert exchange(ws, type="message", text="Oui je confirme")["type"] == "reply"
        changed = exchange(ws, type="confirm", id=proposed["proposal"]["id"])
        assert changed["type"] == "confirmed"
        assert changed["comparison"]["state"]["quota_remaining_m3"] == 3
        assert changed["result"] == client.post("/api/compare", json=changed["comparison"]).json()
        assert exchange(ws, type="confirm", id=proposed["proposal"]["id"])["code"] == "stale_proposal"
        assert exchange(ws, type="propose", quota_m3=4)["code"] == "invalid_proposal"


def test_manager_code_never_enters_chat_and_limits_failed_confirmations(client, monkeypatch):
    monkeypatch.setitem(client.app.state._state, "guardian_manager_code", b"demo-for-test")
    with connect(client) as ws:
        assert exchange(ws, **context())["requires_manager_code"]
        preview = exchange(ws, type="propose", quota_m3=3)["proposal"]
        invalid = exchange(ws, type="confirm", id=preview["id"], manager_code="wrong")
        assert invalid["code"] == "manager_code" and "wrong" not in invalid["text"]
        approved = exchange(ws, type="confirm", id=preview["id"], manager_code="demo-for-test")
        assert approved["type"] == "confirmed" and "demo-for-test" not in json.dumps(approved)
    with connect(client) as ws:
        exchange(ws, **context())
        preview = exchange(ws, type="propose", quota_m3=1)["proposal"]
        for _ in range(3):
            assert exchange(ws, type="confirm", id=preview["id"])["code"] == "manager_code"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1008


def test_adverse_metrics_match_m5_buffer_and_reference_including_new_proposal(client):
    start = context("jplus1")
    start["telemetry"] = selection(client, start)
    expected = client.post("/api/compare", json=start["comparison"]).json()["weather_comparison"]
    with connect(client) as ws:
        assert exchange(ws, **start)["type"] == "ready"
        msg = exchange(ws, type="message", text="Compare les plans")["text"]
        for label in ("reference_on_adverse", "buffer_on_adverse"):
            assert f'{expected[label]["metrics"]["delivered_on_time_m3"]} m³' in msg
        assert "défavorable" in msg
        preview = exchange(ws, type="propose", quota_m3=5)["proposal"]
        result = exchange(ws, type="confirm", id=preview["id"])["result"]["weather_comparison"]
        assert preview["delivered_on_time_m3"] == result["buffer_on_adverse"]["metrics"]["delivered_on_time_m3"]


def test_region_compares_actual_plans_and_rejects_stale_receipts(client):
    site = "korba-cap-bon"
    inputs = {"date": "2025-07-15", "tank_capacity_m3": 20, "initial_stock_m3": 1,
              "withdrawal_limit_m3": 16, "pump_flow_m3_h": 4, "pump_wh_per_m3": 500,
              "gravity_flow_m3_h": 4, "grid_cap_w": 2000, "pv_capacity_kwp": 3.2,
              "pv_performance_ratio": 0.8, "demand_west_m3": 10, "demand_east_m3": 10,
              "delivery_start_hour": 15, "delivery_end_hour": 18, "outage_hours": [15, 16]}
    path = f"/api/sites/{site}/planning"
    receipt = client.post(path, json=inputs).json()["comparison_id"]
    start = {"type": "start", "site_id": site, "language": "en", "reason": "accessibility",
             "zone_plan": {"inputs": inputs, "comparison_id": receipt}}
    with connect(client) as ws:
        assert exchange(ws, **start)["type"] == "ready"
        climate = exchange(ws, type="message", text="Tell me about local weather")
        assert "mm" in climate["text"] and climate["citations"]
        proposal = exchange(ws, type="propose", quota_m3=9)["proposal"]
        result = exchange(ws, type="confirm", id=proposal["id"])
        assert result["zone_inputs"]["withdrawal_limit_m3"] == 9
        assert result["zone_result"] == client.post(path, json=result["zone_inputs"]).json()
    start["zone_plan"]["inputs"]["date"] = "2025-01-15"
    with connect(client) as ws:
        assert exchange(ws, **start)["code"] == "invalid_context"


def test_archive_and_verified_evidence_without_station(client):
    city = client.get("/api/tunisia").json()["cities"][0]
    path = f'/api/tunisia/cities/{city["id"]}'
    first = client.get(path).json()["climate"]["start"]
    start = {"type": "start", "reason": "accessibility", "city_id": city["id"], "language": "en",
             "city_period": {"start": first, "end": first}}
    with connect(client) as ws:
        assert city["name"] in exchange(ws, **start)["text"]
        climate = exchange(ws, type="message", text="Rain chart")
        expected = client.get(path, params={"start": first, "end": first}).json()["climate"]
        assert str(expected["precipitation_mm"]) in climate["text"]
        assert climate["citations"][0]["url"] == expected["source"]["url"]
        source = exchange(ws, type="message", text="source ANME photovoltaïque")
        excerpts = {c.citation.excerpt: str(c.citation.url) for c in client.app.state.assistant.corpus.chunks.values()}
        for citation in source["citations"]:
            assert excerpts[citation["excerpt"]] == citation["url"]
        assert source["citations"][0]["excerpt"] in source["text"]
        assert exchange(ws, type="propose", quota_m3=2)["code"] == "invalid_proposal"
    with connect(client) as ws:
        assert exchange(ws, **{**start, "reason": "emergency"})["code"] == "invalid_context"
    with connect(client) as ws:
        assert exchange(ws, **context(site_id="korba-cap-bon"))["code"] == "invalid_context"


def test_audio_turn_tool_errors_and_tts_do_not_disclose_inputs(client, monkeypatch):
    class Voice:
        capabilities = {"llm": True, "stt": True, "tts": True}
        text_backend = "vultr"
        def capabilities_for(self, language):
            return self.capabilities
        async def transcribe(self, data, mime, language):
            assert data == b"media" and mime == "audio/webm" and language == "fr"
            return "Explique le plan"
        async def choose_tool(self, messages, tools):
            assert any(t["function"]["name"] == "explain_plan" for t in tools)
            return "explain_plan", {}
        async def speak(self, text, language):
            assert "Volume simulé" in text
            raise GuardianProviderError("tts", 403)

    monkeypatch.setitem(client.app.state._state, "guardian_provider", Voice)
    with connect(client) as ws:
        assert all(exchange(ws, **context())["voice"].values())
        transcript = exchange(ws, type="audio", mime="audio/webm;codecs=opus", data=base64.b64encode(b"media").decode())
        assert transcript == {"type": "transcript", "text": "Explique le plan"}
        reply = ws.receive_json()
        assert reply["mode"] == "vultr_tools" and "Volume simulé" in reply["text"]
        assert "0 % puis 50 %" in reply["text"]
        assert "Parcelle A : 10 puis 5 m³" in reply["text"] and "Parcelle B : 0 puis 5 m³" in reply["text"]
        error = exchange(ws, type="speak")
        assert error["code"] == "voice_unavailable" and error["request_type"] == "speak"
        assert exchange(ws, type="audio", mime="audio/webm", data="***")["code"] == "invalid_input"
        assert exchange(ws, type="message", text="encore")["type"] == "reply"


def test_cross_origin_and_unregistered_context_denied(client):
    with pytest.raises(WebSocketDisconnect) as denied:
        with connect(client, "https://unrelated.example"):
            pass
    assert denied.value.code == 1008
    with connect(client) as ws:
        assert exchange(ws, **context(site_id="absent"))["code"] == "invalid_context"


@pytest.mark.parametrize(("language", "native_word"), [("en", "grower"), ("ja", "農家"), ("aeb", "الفلّاح")])
def test_presentation_uses_the_current_simulation_in_all_languages(client, language, native_word):
    with connect(client) as ws:
        exchange(ws, **context(language=language))
        speech = exchange(ws, type="message", mode="present", text="")
        assert speech["activity"] == "present" and speech["language"] == language and native_word in speech["text"]
        assert "50" in speech["text"] and "A" in speech["text"] and "B" in speech["text"]
        assert speech["speech_available"] is False and "proposal" not in speech
        note = "عدّاد القطعة واقف"
        exchange(ws, type="observation", text=note)
        receipt = exchange(ws, type="propose", quota_m3=3)["proposal"]["id"]
        changed = exchange(ws, type="language", language="aeb")
        assert changed["type"] == "language" and changed["language"] == "aeb"
        assert note in exchange(ws, type="message", text="شنوة ملاحظتي؟")["text"]
        assert exchange(ws, type="confirm", id=receipt)["type"] == "confirmed"


def test_translation_uses_target_voice_and_rejects_changed_quantities(client, monkeypatch):
    class Voice:
        capabilities = {"llm": True, "stt": True, "tts": True}
        text_backend = "vultr"
        output = "المخزون ٨ m³ والحصّة ٥ m³."

        def capabilities_for(self, language):
            return self.capabilities

        async def translate(self, text, source, target):
            assert (source, target) == ("ja", "aeb") and "8" in text
            return self.output

        async def speak(self, text, language):
            assert text == self.output and language == "aeb"
            return b"translated speech", "audio/mpeg"

    monkeypatch.setitem(client.app.state._state, "guardian_provider", Voice)
    turn = {"type": "message", "mode": "translate", "target_language": "aeb", "text": "貯水量は8 m³、取水枠は5 m³です。"}
    with connect(client) as ws:
        exchange(ws, **context(language="ja"))
        translated = exchange(ws, **turn)
        assert translated["activity"] == "translate" and translated["language"] == "aeb"
        assert translated["text"] == Voice.output and translated["citations"] == []
        assert exchange(ws, type="speak")["data"] == base64.b64encode(b"translated speech").decode()
        for changed in ["المخزون ٥ m³ والحصّة ٨ m³.", "المخزون ٨ kWh والحصّة ٥ m³.", "المخزون ٥٠٠ m³.", ""]:
            Voice.output = changed
            assert exchange(ws, **turn)["code"] in {"translation_unverified", "translation_unavailable"}
        assert exchange(ws, **{**turn, "target_language": "unk"})["code"] == "invalid_input"
        assert exchange(ws, type="language", language="unregistered")["code"] == "invalid_input"
        assert exchange(ws, type="language", language="en")["type"] == "language"
        assert exchange(ws, type="speak")["code"] == "tts_unavailable"


def test_translation_preserves_dashboard_dimensions_and_order():
    from backend.guardian import quantities
    assert quantities("Flow: ٨ m³/h; stored water: ١٣ m³") == quantities("流量8立方メートル毎時、貯水量13立方メートル")
    assert quantities("Rainfall: 12 mm") != quantities("12 °C")
    assert quantities("Grid supply: 5 kW") != quantities("5 kWh")


def test_guided_presentation_and_failed_translation_do_not_mutate_a_plan(client):
    with connect(client) as ws:
        exchange(ws, **context(language="aeb"))
        response = exchange(ws, type="message", mode="translate", target_language="ja", text="هبّط الحصّة لـ 3 m³")
        assert response["code"] == "translation_unavailable" and "الترجمة" in response["text"]
        assert exchange(ws, type="message", mode="ask", text="نحب نحضّر العرض")["activity"] == "present"
        assert exchange(ws, type="confirm", id="3")["code"] == "stale_proposal"


def test_presentation_honors_topic_and_translation_text_cannot_start_a_replan(client, monkeypatch):
    class BusyModel(GuardianProvider):
        async def presentation_opener(self, brief, language, topic):
            raise GuardianProviderError("llm")

        async def choose_tool(self, messages, tools):
            if any(t["function"]["name"] == "propose_quota" for t in tools):
                return "propose_quota", {"quota_m3": 4}
            raise GuardianProviderError("llm")

        async def transcribe(self, data, mime_type, language):
            raise AssertionError("An invalid translation request must be rejected before transcription")

        async def translate(self, text, source_language, target_language):
            raise TimeoutError

    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: BusyModel(key="fixture"))
    start = context(language="en", reason="emergency")
    start["telemetry"] = selection(client, start, balance_anomaly_slots=[1], plan="baseline")
    with connect(client) as ws:
        exchange(ws, **start)
        focus = exchange(ws, type="message", mode="present", text="For this slide present the allocation between growers.")
        assert focus["activity"] == "present" and focus["mode"] == "guided"
        assert "50%" in focus["text"] and "13 m³" not in focus["text"]
        result = exchange(ws, type="message", text="Translate 'set the quota to 4 m³' into Japanese.")
        assert "say: Translate into Japanese" in result["text"] and "proposal" not in result
        assert exchange(ws, type="audio", mode="translate", target_language="bad", mime="audio/webm", data="YQ==")["code"] == "invalid_input"
        timed_out = exchange(ws, type="message", mode="translate", target_language="ja", text="Hello")
        assert timed_out["code"] == "turn_timeout"
        assert exchange(ws, type="observation", text="Meter check pending")["type"] == "recorded"


@pytest.mark.parametrize(("lang", "good", "unsafe"), [
    ("en", "What would you check before sharing water?", "What if the pump saved 38 kWh?"),
    ("ja", "皆さんなら、どの畑を先に見ますか？", "どの畑の灌漑費用が半減したのでしょうか？"),
    ("aeb", "شنوّة أوّل حاجة تحبّ تثبّت فيها؟", "شنوّة سبب التسرّب المؤكّد في الخزّان؟"),
])
def test_llm_opener_can_adapt_the_delivery_but_cannot_rewrite_the_facts(client, monkeypatch, lang, good, unsafe):
    briefs = []

    class Coach(GuardianProvider):
        async def presentation_opener(self, brief, language, topic):
            assert language == lang and topic == "plan"
            briefs.append(brief)
            return good if len(briefs) == 1 else unsafe

    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: Coach(key="fixture"))
    with connect(client) as ws:
        exchange(ws, **context(language=lang))
        original = exchange(ws, type="message", mode="present")["text"]
        result = exchange(ws, type="message", mode="present", text="Make the introduction accessible to children.")
        assert result["mode"] == "vultr_presentation" and result["text"].startswith(good)
        assert "50" in result["text"] and original.endswith(result["text"][len(good):])
        fallback = exchange(ws, type="message", mode="present", text="Use a shorter opener.")
        assert "accessible to children" in briefs[-1] and "shorter opener" in briefs[-1]
        assert fallback["text"] == original and fallback["mode"] == "guided"


def graph_tools(*calls):
    return {"output": [{"type": "function_call", "call_id": str(i), "name": name, "arguments": json.dumps(arguments)}
                       for i, (name, arguments) in enumerate(calls)]}


def graph_done(*paragraphs):
    text = json.dumps({"paragraphs": list(paragraphs), "missing_information": []})
    return {"output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}


def test_voice_ask_uses_read_only_graph_verified_facts_and_per_call_memory(client, monkeypatch):
    service = client.app.state.assistant
    source = next(chunk for chunk in service.corpus.chunks.values() if chunk.citation.source_id == "solar")
    scopes = []

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            scope = json.loads(body["input"][0]["content"])
            scopes.append(scope)
            if scope["prior_answers"] and scope["prior_answers"][-1]["facts"]:
                fact = next(f for f in scope["prior_answers"][-1]["facts"] if f["text"].startswith("Plot A "))
                return graph_done({"text": "That is the verified allocation.", "fact_ids": [fact["id"]], "citation_ids": []})
            return graph_tools(("explain_decision", {"scenario_id": None, "quota_m3": None}),
                               ("search_evidence", {"query": "ANME photovoltaic Tunisia"}))
        return graph_done({"text": "Fake figure 314159 with an invalid citation.", "fact_ids": [], "citation_ids": ["fake"]})

    def qdrant(method, path, body, **kwargs):
        return {"points": [{"id": source.citation.id, "payload": source.payload}]} if path == "/points/query" else []

    provider = SimpleNamespace(nvidia_model="configured", respond_nvidia=respond, embeddings=lambda *a, **kw: [[0.] * DIMENSIONS], qdrant=qdrant)
    monkeypatch.setattr(service, "providers", provider)
    with connect(client) as ws, connect(client) as other:
        start = context(language="aeb")
        assert exchange(ws, **start)["rag_available"]
        result = exchange(ws, type="message", turn_id=1, text="علاش القطعة A خذات كان 5 m³؟ وشنوة مصدر الطاقة الشمسية؟")
        assert result["mode"] == "langgraph" and result["turn_id"] == 1
        assert result["tools_used"] == ["explain_decision", "search_evidence"]
        assert "القطعة A يوصلها 5 m³" in result["text"] and "314159" not in result["text"]
        assert result["citations"] == [source.citation.model_dump(mode="json")]
        assert any(f["text"].startswith("Plot A") and f["provenance"] == "simulated" for f in result["facts"])
        assert scopes[-1]["active_scenario"] == "mini" and not scopes[-1]["prior_answers"]
        again = exchange(ws, type="message", turn_id=2, text="تنجّم تعاود تفسّرها؟")
        assert again["mode"] == "langgraph" and again["facts"][0]["text"].startswith("Plot A ")
        assert scopes[-1]["prior_answers"] and len(scopes[-1]["recent_questions"]) == 1
        proposed = exchange(ws, type="propose", quota_m3=3)["proposal"]
        assert exchange(ws, type="confirm", id=proposed["id"])["type"] == "confirmed"
        exchange(ws, type="message", text="What about that plot now?")
        assert not scopes[-1]["recent_questions"]
        assert not any(prior["facts"] for prior in scopes[-1]["prior_answers"])
        exchange(other, **start)
        exchange(other, type="message", text="علاش القطعة A؟")
        assert not scopes[-1]["prior_answers"] and not scopes[-1]["recent_questions"]


def test_voice_atlas_can_only_retrieve_documentary_evidence(client, monkeypatch):
    observed = []
    def respond(body, *, timeout):
        observed.append([tool["name"] for tool in body["tools"]])
        if len(body["input"]) == 1:
            return graph_tools(("explain_decision", {"scenario_id": "mini", "quota_m3": None}))
        assert "unavailable for the active location" in body["input"][-1]["output"]
        return graph_done()
    monkeypatch.setattr(client.app.state.assistant, "providers", SimpleNamespace(respond=respond))
    with connect(client) as ws:
        exchange(ws, type="start", reason="accessibility", language="en")
        reply = exchange(ws, type="message", text="How much water did that plot receive?")
        assert reply["mode"] == "langgraph" and not reply["facts"] and not reply["tools_used"]
        assert observed == [["search_evidence"], ["search_evidence"]]


def test_voice_rag_outage_falls_back_to_verified_local_data_and_recovers(client, monkeypatch):
    def offline(*args, **kwargs):
        raise ServiceError("model", 503)
    provider = SimpleNamespace(respond=offline)
    monkeypatch.setattr(client.app.state.assistant, "providers", provider)
    with connect(client) as ws:
        exchange(ws, **context(language="en"))
        fail = exchange(ws, type="message", text="Explain the calculated plan")
        assert fail["rag_status"] == "unavailable" and fail["mode"] == "guided"
        assert "unavailable" in fail["text"] and "50%" in fail["text"]
        provider.respond = lambda body, **kwargs: graph_done()
        assert exchange(ws, type="message", text="Any field measurements for this?")["mode"] == "langgraph"


def test_barge_in_discards_cancelled_graph_and_spent_requests_release_capacity(client, monkeypatch):
    entered, release, finished = Event(), Event(), Event()
    scopes = []
    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            scope = json.loads(body["input"][0]["content"])
            scopes.append(scope)
            if "first" in scope["question"]:
                return graph_tools(("explain_decision", {"scenario_id": "mini", "quota_m3": None}))
        elif not entered.is_set():
            entered.set()
            assert release.wait(5)
            finished.set()
        return graph_done()
    service = client.app.state.assistant
    monkeypatch.setattr(service, "providers", SimpleNamespace(respond=respond))
    with connect(client) as ws:
        exchange(ws, **context(language="en"))
        ws.send_json({"type": "message", "turn_id": 1, "text": "Explain the first allocation to plot A"})
        try:
            assert entered.wait(5)
            ws.send_json({"type": "cancel", "turn_id": 1})
            reply = exchange(ws, type="message", turn_id=2, text="My new question")
            assert reply["turn_id"] == 2 and not scopes[-1]["prior_answers"]
            assert not scopes[-1]["recent_questions"]
            assert exchange(ws, type="speak", turn_id=1)["code"] == "stale_turn"
        finally:
            release.set()
        assert finished.wait(5)
        assert exchange(ws, type="message", turn_id=3, text="Which plot?")["turn_id"] == 3
        assert not scopes[-1]["prior_answers"]
        assert scopes[-1]["recent_questions"] == ["My new question"]


def test_barge_in_stops_transcription_and_synthesis_without_late_audio(client, monkeypatch):
    stt_started, tts_started = Event(), Event()
    stt_cancelled, tts_cancelled = Event(), Event()

    class Voice(GuardianProvider):
        async def transcribe(self, *args):
            stt_started.set()
            try:
                await asyncio.sleep(20)
            finally:
                stt_cancelled.set()

        async def speak(self, *args):
            tts_started.set()
            try:
                await asyncio.sleep(20)
            finally:
                tts_cancelled.set()

    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: Voice(key="local-fixture", llm=""))
    with connect(client) as ws:
        exchange(ws, **context(language="en"))
        ws.send_json({"type": "audio", "turn_id": 1, "mime": "audio/webm", "data": "YQ=="})
        assert stt_started.wait(5)
        ws.send_json({"type": "cancel", "turn_id": 1})
        assert exchange(ws, type="message", turn_id=2, text="Explain the plan")["turn_id"] == 2
        assert stt_cancelled.wait(5)
        ws.send_json({"type": "speak", "turn_id": 2})
        assert tts_started.wait(5)
        ws.send_json({"type": "cancel", "turn_id": 2})
        new = exchange(ws, type="message", turn_id=3, text="What about this site?")
        assert new["type"] == "reply" and new["turn_id"] == 3 and tts_cancelled.wait(5)
        assert exchange(ws, type="message", turn_id=2, text="Late old turn")["code"] == "stale_turn"
        assert exchange(ws, type="confirm", turn_id=3, id="bad")["code"] == "invalid_input"


def test_tagged_voice_can_translate_without_leaving_ask_mode(client, monkeypatch):
    class Translator(GuardianProvider):
        async def transcribe(self, audio, mime, language):
            return "Translate into Japanese: the tank holds 13 m³."

        async def choose_tool(self, messages, tools):
            return "translate_passage", {"target_language": "ja", "passage": "the tank holds 13 m³."}

        async def translate(self, passage, source, target):
            assert source == "en" and target == "ja" and "13 m³" in passage
            return "貯水量は13 m³です。"

    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: Translator(key="local-fixture"))
    with connect(client) as ws:
        exchange(ws, **context(language="en"))
        first = exchange(ws, type="audio", mode="ask", mime="audio/webm", data="YQ==", turn_id=1)
        assert first["type"] == "transcript" and first["turn_id"] == 1
        result = ws.receive_json()
        assert (result["type"], result["turn_id"], result["language"], result["activity"]) == ("reply", 1, "ja", "translate")
        assert result["text"] == "貯水量は13 m³です。" and "proposal" not in result


def test_voice_scope_matches_selected_solar_and_excludes_stale_plan(client, monkeypatch):
    scopes = []
    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            scopes.append(json.loads(body["input"][0]["content"]))
            return graph_tools(("get_simulation_results", {"scenario_id": "mini", "quota_m3": None}))
        return graph_done()
    monkeypatch.setattr(client.app.state.assistant, "providers", SimpleNamespace(respond=respond))
    with connect(client) as ws:
        ready = exchange(ws, type="start", reason="accessibility", language="ja", site_id="jendouba-pilote",
                         selected_scenario_id="mini", simulation_pending=True, pvgis_option_id="ombriere")
        assert ready["type"] == "ready"
        answer = exchange(ws, type="message", turn_id=1, text="なぜ")
        assert answer["mode"] == "langgraph" and not answer["facts"]
        assert scopes[0]["selected_pvgis"] == "ombriere" and scopes[0]["simulation_pending"]
        assert scopes[0]["active_scenario"] is None
    with connect(client) as ws:
        assert exchange(ws, **context(simulation_pending=True))["code"] == "invalid_context"


def test_spoken_allocation_names_the_requested_grower_when_multiple_facts_are_verified(client):
    from backend.guardian_dialogue import CallStart, Dialogue
    from backend.guardian_rag import spoken_answer
    from backend.models import AssistantAnswer
    call = Dialogue(CallStart.model_validate(context(language="ja")), client.app.state.assistant)
    facts = [{"id": f"f{i}", "text": f"Plot {plot} (EXP-0{i}): {volume} m³ by its deadline, 3 m³ minimum and 10 m³ total demand.",
              "provenance": "simulated"} for i, (plot, volume) in enumerate([("A", 5), ("B", 4)], 1)]
    answer = AssistantAnswer(paragraphs=[], facts=facts, citations=[], tools_used=["explain_decision"], missing_information=[])
    spoken = spoken_answer(call, answer, "区画Bの配水量は？")
    assert "区画Bには期限までに4 m³" in spoken and "区画A" not in spoken


@pytest.mark.parametrize(("reason", "selection_args", "question", "expected"), [
    ("emergency", {"balance_anomaly_slots": [1]}, "What is happening in this virtual replay?", "13 m³"),
    ("clarification", {"missing_flow_slots": [2], "selected_slot": 2}, "Why is this flow measurement blank?", "The flow reading is missing."),
])
def test_live_voice_starts_verified_audio_before_graph_finishes_and_skips_repeated_values(
        client, monkeypatch, reason, selection_args, question, expected):
    waiting, finish = Event(), Event()
    spoken = []
    class Voice(GuardianProvider):
        async def transcribe(self, *args):
            return question

        async def stream_speech(self, text, language):
            spoken.append(text)
            yield b"\x00\x01"

        async def speak(self, *args):
            pytest.fail("Successful PCM must not generate another MP3")

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return graph_tools(("get_sensor_anomalies", {}))
        waiting.set()
        assert finish.wait(6)
        return graph_done()

    monkeypatch.setattr(client.app.state.assistant, "providers", SimpleNamespace(respond=respond))
    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: Voice(key="local-fixture", llm=""))
    start = context(language="en", reason=reason)
    start["telemetry"] = selection(client, start, plan="baseline", **selection_args)
    with connect(client) as ws:
        exchange(ws, **start)
        transcript = exchange(ws, type="audio", mode="ask", turn_id=1, mime="audio/webm", data="YQ==",
                              progress_audio=True, stream_audio=True)
        try:
            assert transcript["type"] == "transcript"
            lead, chunk, end = ws.receive_json(), ws.receive_json(), ws.receive_json()
            assert lead["type"] == "progress" and expected in lead["text"]
            assert chunk["type"] == "audio_chunk" and chunk["phase"] == "preview" and chunk["sample_rate"] == 24000
            assert end == {"type": "audio_end", "phase": "preview", "turn_id": 1} and waiting.wait(5)
        finally:
            finish.set()
        final = ws.receive_json()
        assert final["mode"] == "langgraph" and final["tools_used"] == ["get_sensor_anomalies"]
        assert expected in final["text"] and final["speech_available"]
        final_chunk = exchange(ws, type="speak", turn_id=1, stream_audio=True)
        assert final_chunk["type"] == "audio_chunk" and final_chunk["phase"] == "final"
        assert ws.receive_json()["type"] == "audio_end"
        assert expected in spoken[0] and expected not in spoken[1] and "meter" in spoken[1]


def test_documentary_preview_uses_completed_retrieval_and_skips_unrelated_active_alert(client, monkeypatch):
    source = next(c for c in client.app.state.assistant.corpus.chunks.values() if c.citation.source_id == "solar")
    retrieved, release = Event(), Event()
    class Voice(GuardianProvider):
        async def stream_speech(self, text, language):
            assert retrieved.is_set() and "ANME" in text and "13 m³" not in text
            yield b"\x00\x01"

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            return graph_tools(("search_evidence", {"query": "ANME solar photovoltaic Tunisia"}))
        assert release.wait(5)
        return graph_done()

    def qdrant(method, path, body, **kwargs):
        retrieved.set()
        return {"points": [{"id": source.citation.id, "payload": source.payload}]} if path == "/points/query" else []

    monkeypatch.setattr(client.app.state.assistant, "providers", SimpleNamespace(
        respond=respond, embeddings=lambda *a, **kw: [[0.] * DIMENSIONS], qdrant=qdrant))
    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: Voice(key="local-fixture", llm=""))
    start = context(language="en", reason="emergency")
    start["telemetry"] = selection(client, start, balance_anomaly_slots=[1], plan="baseline")
    with connect(client) as ws:
        exchange(ws, **start)
        try:
            lead = exchange(ws, type="message", turn_id=2, progress_audio=True, stream_audio=True,
                            text="Which official source describes solar potential?")
            assert lead["type"] == "progress" and source.citation.section in lead["text"]
            assert ws.receive_json()["type"] == "audio_chunk"
            assert ws.receive_json()["type"] == "audio_end"
        finally:
            release.set()
        result = ws.receive_json()
        assert result["mode"] == "langgraph" and result["citations"] == [source.citation.model_dump(mode="json")]


@pytest.mark.parametrize("after_bytes", [True, False])
def test_broken_pcm_only_falls_back_to_mp3_before_first_audio(after_bytes):
    from backend.guardian_progress import send_speech
    output = []
    class Voice:
        async def stream_speech(self, text, language):
            if after_bytes:
                yield b"\x12\x34"
            raise GuardianProviderError("tts")

        async def speak(self, text, language):
            assert not after_bytes
            return b"fixture mp3", "audio/mpeg"

    async def send(frame):
        output.append(frame)

    asyncio.run(send_speech(send, Voice(), "Verified", "en", turn_id=1, stream=True, phase="final"))
    if after_bytes:
        assert [frame["type"] for frame in output] == ["audio_chunk", "audio_end"]
        assert output[-1]["partial"] is True
    else:
        assert output == [{"type": "audio", "turn_id": 1, "phase": "final", "mime": "audio/mpeg",
                           "data": base64.b64encode(b"fixture mp3").decode("ascii")}]


def test_barge_in_during_streamed_preview_releases_audio_without_publishing_the_cancelled_reply(client, monkeypatch):
    speaking, closed, graph_finished = Event(), Event(), Event()
    class Voice(GuardianProvider):
        async def stream_speech(self, text, language):
            try:
                speaking.set()
                yield b"\x00\x01"
                await asyncio.sleep(20)
            finally:
                closed.set()

    def respond(body, *, timeout):
        if len(body["input"]) == 1:
            scope = json.loads(body["input"][0]["content"])
            if "first" in scope["question"]:
                return graph_tools(("get_sensor_anomalies", {}))
            assert not scope["recent_questions"] and not scope["prior_answers"]
        else:
            assert graph_finished.wait(6)
        return graph_done()

    monkeypatch.setattr(client.app.state.assistant, "providers", SimpleNamespace(respond=respond))
    monkeypatch.setitem(client.app.state._state, "guardian_provider", lambda: Voice(key="local-fixture", llm=""))
    start = context(language="en", reason="emergency")
    start["telemetry"] = selection(client, start, balance_anomaly_slots=[1], plan="baseline")
    with connect(client) as ws:
        exchange(ws, **start)
        try:
            progress = exchange(ws, type="message", turn_id=1, progress_audio=True, stream_audio=True, text="My first question about the alert.")
            assert progress["type"] == "progress" and ws.receive_json()["type"] == "audio_chunk"
            assert speaking.is_set()
            ws.send_json({"type": "cancel", "turn_id": 1})
            next_reply = exchange(ws, type="message", turn_id=2, text="Let us discuss another topic.")
            assert next_reply["turn_id"] == 2 and next_reply["type"] == "reply" and closed.is_set()
        finally:
            graph_finished.set()

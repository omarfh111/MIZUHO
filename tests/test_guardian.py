"""Exercise the Guardian's real socket, physical replay, optimizer and local M8 passages."""

import base64
import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.assistant_api import AssistantRuntime
from backend.catalog import DATA_DIR
from backend.evidence import load_corpus
from backend.guardian_provider import GuardianProvider, GuardianProviderError
from backend.main import create_app


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

from datetime import datetime
from time import monotonic

import pytest
from fastapi.testclient import TestClient

from backend.assistant_memory import planning_scope
from backend.assistant_tools import Turn, run_tool
from backend.catalog import load_catalog
from backend.main import create_app
from backend.models import AssistantRequest
from backend.energy_profiles import archived_profile_wh

SITE = "jendouba-pilote"


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as connection:
        yield connection


def replay_request(client, scenario_id="mini", plan="optimized", **changes):
    scenario = next(row for row in client.get("/api/scenarios").json() if row["id"] == scenario_id)
    comparison = {"scenario_id": scenario_id, "state": scenario["state"], "solar_option_id": None,
                  "outage_slots": [s["slot"] for s in scenario["slots"] if not s["grid_available"]], **changes}
    response = client.post("/api/compare", json=comparison)
    assert response.status_code == 200, response.text
    calculated = response.json()
    if comparison.get("weather_pair_id"):
        actions = calculated["weather_comparison"]["buffer_on_adverse"]["actions"]
    else:
        actions = calculated[plan]["actions"]
    return {"comparison": comparison, "plan": plan, "actions": [
        {key: a[key] for key in ("slot", "pump_m3", "deliveries")} for a in actions
    ]}


def replay(client, payload):
    response = client.post("/api/telemetry/replay", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize(("plan", "allocations"), [("baseline", [10, 0]), ("optimized", [5, 5])])
def test_twin_replays_the_actual_m4_ledger(client, plan, allocations):
    payload = replay_request(client, plan=plan)
    result = replay(client, payload)
    frames = result["frames"]
    assert result["physical_source"] == "m4_replay"
    assert result["validation"] == "physical_feasibility_of_submitted_actions"
    assert [p["delivered_on_time_m3"] for p in frames[-1]["parcels"]] == allocations
    assert [p["coverage_bp"] for p in frames[-1]["parcels"]] == [v * 1000 for v in allocations]
    assert sum(f["delivered_m3"] for f in frames) == 10
    assert frames[-1]["tank_stock_m3"] == 0
    assert all(not f["grid_available"] and f["grid_wh"] == f["pump_m3"] == 0 for f in frames)
    for index, f in enumerate(frames):
        meters = {m["metric"]: m for m in result["measurements"] if m["simulation_slot"] == f["slot"]}
        assert len(meters) == 10
        assert meters["tank_volume"]["value"] == f["tank_stock_m3"]
        assert meters["distributed_flow"]["value"] == f["delivered_m3"]
        assert meters["solar_self_consumption"]["value"] == f["solar_wh"]
        assert meters["grid_import_for_pumping"]["value"] == f["grid_wh"]
        assert meters["solar_generation"]["value"] == 0
        assert datetime.fromisoformat(f["timestamp"]) == datetime.fromisoformat(result["records"][index]["timestamp"])
    assert {"grid_outage", "tank_empty"} <= {event["type"] for event in result["events"]}
    assert result["alerts"] == []


def test_replanning_and_replay_validate_completed_deliveries_against_overridden_demand(client):
    state = {"current_slot": 9, "tank_stock_m3": 12, "quota_remaining_m3": 49,
             "delivered_by_plot_m3": {"A": 16}, "delivered_on_time_by_plot_m3": {"A": 16}}
    payload = replay_request(client, "normal", state=state, overrides={"demand_by_plot_m3": {"A": 18}})
    result = replay(client, payload)
    assert result["frames"][0]["slot"] == 9
    parcel = next(p for p in result["frames"][-1]["parcels"] if p["plot_id"] == "A")
    assert parcel["demand_m3"] == parcel["delivered_on_time_m3"] == 18

    invalid = {**payload["comparison"], "overrides": {"demand_by_plot_m3": {"A": 15}}}
    response = client.post("/api/compare", json=invalid)
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "overrides", "demand_by_plot_m3", "A"]


def test_missing_sensor_and_fictitious_meter_offset_change_only_observations(client):
    payload = replay_request(client)
    original = replay(client, payload)
    result = replay(client, {**payload, "missing_flow_slots": [1], "balance_anomaly_slots": [1]})
    assert result["frames"] == original["frames"]
    meter, following = [m for m in result["measurements"] if m["sensor_id"] == "pump-flow-01"]
    assert (meter["quality"], meter["value"]) == ("missing", None)
    assert (following["quality"], following["value"]) == ("valid", 0)
    assert result["records"][0]["water_in_m3"] == 13 and result["frames"][0]["pump_m3"] == 0
    alert, = result["alerts"]
    assert (alert["type"], alert["simulation_slot"], alert["value"], alert["unit"]) == ("unexplained_water", 1, 13, "m³")
    assert "inspect" in alert["message"].lower() and "leak" not in alert["message"].lower()
    for event in [*result["events"], *result["alerts"], *result["measurements"]]:
        assert all(key in event for key in ("timestamp", "unit", "quality", "equipment_id", "provenance", "site_id"))
        assert event["provenance"] == "simulated" and event["site_id"] == SITE


def test_invalid_trace_unknown_hour_and_unavailable_adverse_profile_are_rejected(client):
    req = replay_request(client)
    for change in ({"actions": req["actions"][1:]}, {"balance_anomaly_slots": [0]}, {"missing_flow_slots": [1, 1]},
                   {"weather_profile": "adverse"},
                   {"actions": [{**req["actions"][0], "pump_m3": 1}, req["actions"][1]]}):
        assert client.post("/api/telemetry/replay", json={**req, **change}).status_code == 422


@pytest.mark.parametrize(("kind", "stopped", "recovered"), [
    ("pump_shutdown", "pump_shutdown", "pump_recovery"),
    ("unexpected_outage", "grid_outage", "grid_recovery"),
])
def test_replay_carries_incident_and_recovery_transitions(client, kind, stopped, recovered):
    req = replay_request(client, "normal", incident={"kind": kind, "start_slot": 9, "duration_slots": 2})
    result = replay(client, req)
    for event_type, slot in ((stopped, 9), (recovered, 11)):
        transition, = [e for e in result["events"] if e["type"] == event_type]
        assert transition["simulation_slot"] == slot
    affected = [f for f in result["frames"] if f["slot"] in (9, 10)]
    assert len(affected) == 2 and all(f["pump_m3"] == 0 for f in affected)


def test_adverse_twin_uses_the_same_weather_and_early_reserve_as_m5(client):
    req = replay_request(client, "jplus1", planning_mode="weather_buffer", weather_pair_id="jplus1-demo")
    result = replay(client, {**req, "weather_profile": "adverse"})
    weather = client.post("/api/weather", json={"pair_id": "jplus1-demo"}).json()
    assert sum(f["pump_m3"] for f in result["frames"] if f["slot"] < weather["risk_start_slot"]) == 2
    assert sum(f["delivered_m3"] for f in result["frames"]) == 8
    assert result["frames"][0]["timestamp"][:10] == weather["valid_date"]
    for frame in result["frames"]:
        assert frame["solar_potential_wh"] == weather["adverse"]["slots"][frame["slot"]]["solar_wh"]


def test_energy_anomaly_requires_consecutive_valid_readings(client):
    rows = [
        {"site_id": SITE, "timestamp": f"2026-11-21T0{hour}:00:00+01:00", "simulation_slot": hour,
         "tank_stock_m3": 4.5, "pumped_m3": 2.5, "water_in_m3": 2.5, "distributed_m3": 2.5,
         "consumed_wh": 1900, "solar_wh": None, "grid_available": True} for hour in range(3)
    ]
    def project(missing):
        response = client.post("/api/telemetry/project", json={"states": rows, "reference": 0.5, "missing_flow_slots": missing})
        assert response.status_code == 200, response.text
        return response.json()
    alert, = project([])["alerts"]
    assert (alert["type"], alert["value"], alert["unit"]) == ("high_pump_energy_intensity", 0.76, "kWh/m³")
    result = project([1])
    assert result["diagnostics"][0]["pump_energy_intensity"] == "insufficient_data"
    assert result["alerts"] == []
    sun = next(m for m in result["measurements"] if m["metric"] == "solar_generation")
    assert sun["quality"] == "unavailable" and sun["value"] is None


@pytest.mark.parametrize("timestamp", ["0001-01-01T00:00:00+01:00", "9999-12-31T23:00:00Z"])
def test_projection_rejects_utc_hour_boundary_overflow(client, timestamp):
    state = {"site_id": SITE, "timestamp": timestamp, "simulation_slot": 0, "tank_stock_m3": 0,
             "pumped_m3": 0, "water_in_m3": 0, "distributed_m3": 0, "consumed_wh": 0, "grid_available": True}
    response = client.post("/api/telemetry/project", json={"states": [state]})
    assert response.status_code == 422
    detail, = response.json()["detail"]
    assert detail["loc"] == ["body", "states"]
    assert "UTC datetime range" in detail["msg"]


def test_projection_does_not_publish_nonfinite_energy_intensity(client):
    states = [
        {"site_id": SITE, "timestamp": f"2026-11-21T0{slot}:00:00+01:00", "simulation_slot": slot,
         "tank_stock_m3": 0, "pumped_m3": 1e-310, "water_in_m3": 0, "distributed_m3": 0,
         "consumed_wh": 1e9, "grid_available": True}
        for slot in range(2)
    ]
    response = client.post("/api/telemetry/project", json={"states": states, "reference": 0.5})
    assert response.status_code == 200, response.text
    assert response.json()["alerts"] == []
    assert response.json()["diagnostics"][0]["pump_energy_intensity"] == "insufficient_data"


def test_archived_profiles_feed_planning_and_have_traceable_options(client):
    for option, azimuth in (("toiture", 145), ("ombriere", 180)):
        response = client.post("/api/solar/profile", json={"site_id": SITE, "option_id": option})
        assert response.status_code == 200
        profile = response.json()
        assert profile["provenance"] == "estimated" and profile["compass_azimuth_deg"] == azimuth
        assert profile["source_url"].startswith("https://re.jrc.ec.europa.eu/api/")
        assert client.get("/api/evidence/" + profile["source_id"]).status_code == 200
        assert [s["slot"] for s in profile["slots"]] == list(range(24))
        power = [s["solar_wh"] for s in profile["slots"]]
        assert tuple(power) == archived_profile_wh(SITE, option) and sum(power) > 0
        req = replay_request(client, "normal", overrides={"pvgis_option_id": option})
        assert [f["solar_potential_wh"] for f in replay(client, req)["frames"]] == power
    assert client.post("/api/solar/profile", json={"site_id": SITE, "option_id": "toiture", "day": "2027-01-02"}).status_code == 422


def test_demand_forecast_uses_only_archived_history_and_clear_cutoff(client):
    def forecast(cutoff):
        response = client.post("/api/telemetry/forecast", json={"site_id": SITE, "as_of": cutoff})
        assert response.status_code == 200, response.text
        return response.json()
    current = forecast("2026-11-20T18:00:00+01:00")
    assert current["provenance"] == "simulated" and current["status"] == "ok"
    assert len(current["points"]) == 24 and current["test"]["hours"] >= 24
    assert current["test"]["regression_mae_kw"] >= 0
    assert current["test"]["same_hour_last_week_mae_kw"] >= 0
    assert datetime.fromisoformat(current["test"]["through"]) <= datetime.fromisoformat(current["as_of"])
    assert datetime.fromisoformat(current["points"][0]["timestamp"]) > datetime.fromisoformat(current["as_of"])
    for cutoff in ("2026-10-17T12:00:00+01:00", "2099-01-01T00:00:00+01:00"):
        limited = forecast(cutoff)
        assert limited["status"] == "insufficient_history" and limited["points"] == []


@pytest.mark.parametrize("cutoff", [
    "0001-01-01T00:00:00+01:00", "9999-12-31T19:00:00-05:00", "9999-12-31T23:00:00Z",
])
def test_forecast_rejects_cutoffs_outside_utc_or_local_range(client, cutoff):
    response = client.post("/api/telemetry/forecast", json={"site_id": SITE, "as_of": cutoff})
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "as_of"]


def test_archived_comparison_reports_only_costs_supported_by_simulated_load(client):
    request = {"site_id": SITE, "option_ids": ["toiture", "ombriere"], "price_tnd_per_kwh": 0.34}
    response = client.post("/api/solar/compare-archive", json=request)
    assert response.status_code == 200, response.text
    comparison = response.json()
    assert comparison["load_provenance"] == "simulated"
    for option in comparison["options"]:
        assert option["provenance"] == "estimated" and len(option["profile_wh"]) == 24
        assert 0 < option["self_consumed_kwh"] == option["grid_avoided_kwh"] <= option["production_kwh"]
        assert option["gross_savings_tnd"] == pytest.approx(0.34 * option["grid_avoided_kwh"])
        assert option["annual_production_kwh"] > option["production_kwh"]
        assert all(option[k] is None for k in ("annual_self_consumed_kwh", "net_savings_tnd", "payback_years"))
    other_day = client.post("/api/solar/compare-archive", json={**request, "day": "2023-06-22"}).json()
    assert all(o["self_consumed_kwh"] is None and o["gross_savings_tnd"] is None for o in other_day["options"])
    assert client.post("/api/solar/compare-archive", json={**request, "option_ids": ["toiture", "toiture"]}).status_code == 422


def test_agent_reports_only_current_meter_evidence_and_invalidates_stale_facts(client):
    req = replay_request(client)
    comparison = req.pop("comparison")
    def turn(hour, inject):
        selection = {**req, "selected_slot": hour, "balance_anomaly_slots": [1] if inject else []}
        question = AssistantRequest(site_id=SITE, question="Explain the water balance.", comparison=comparison, telemetry=selection)
        return Turn(question, load_catalog(), None, None, monotonic() + 5, 2)
    affected = turn(1, True)
    tool = run_tool(affected, "get_sensor_anomalies", "{}")
    assert any("13.0 m³" in fact["text"] for fact in tool["facts"])
    assert all(fact["provenance"] == "simulated" for fact in tool["facts"])
    for scoped in (turn(2, True), turn(1, False)):
        assert planning_scope(affected.request) != planning_scope(scoped.request)
        assert not any("13.0 m³" in f["text"] for f in run_tool(scoped, "get_sensor_anomalies", "{}")["facts"])

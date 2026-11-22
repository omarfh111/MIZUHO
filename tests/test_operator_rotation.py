from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app


URL = "/api/sites/jendouba-pilote/operator-rotation"


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app(assistant_factory=lambda *_: SimpleNamespace(close=lambda: None))) as session:
        yield session


def mini():
    return {"scenario_id": "mini", "state": {"current_slot": 0, "tank_stock_m3": 10,
            "quota_remaining_m3": 0}, "outage_slots": [1, 2], "solar_option_id": None}


def hour(slot, plot=None, delivery=0, pump=0):
    return {"hour": slot, "plot_id": plot, "delivery_m3": delivery, "pump_m3": pump}


def test_operator_plan_replays_only_requested_hours_and_bounds_withdrawals(client):
    response = client.post(URL, json={"plan": mini(), "hours": [hour(2, "B", 9), hour(1, "A", 7, 6)]})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["provenance"] == "simulated"
    assert body["hours"] == [{**hour(1, "A", 7, 6), "feasible_pump_m3": 0, "feasible_delivery_m3": 7},
                             {**hour(2, "B", 9), "feasible_pump_m3": 0, "feasible_delivery_m3": 3}]
    assert body["operator"]["actions"][0]["pump_m3"] == 0
    assert body["operator"]["metrics"]["worst_coverage_bp"] == 3000
    assert body["optimized"]["metrics"]["worst_coverage_bp"] == 5000
    assert body["optimized"]["metrics"] == client.post("/api/compare", json=mini()).json()["optimized"]["metrics"]


@pytest.mark.parametrize("hours", [[], [hour(1), hour(1)], [hour(3)], [hour(24)], [hour(0, "unknown")],
                                   [hour(0, delivery=1)], [hour(0, pump=-1)], [hour(0, pump=1.5)],
                                   [hour(0, "A", 100001)], [hour(0, pump=True)], [hour(0)] * 25])
def test_invalid_hourly_requests_are_rejected(client, hours):
    assert client.post(URL, json={"plan": mini(), "hours": hours}).status_code == 422


def test_reject_scope_changes_history_and_unmodelled_site(client):
    plan = mini()
    plans = [dict(plan, planning_mode="weather_buffer"),
             dict(plan, state={**plan["state"], "current_slot": 1}),
             dict(plan, state={**plan["state"], "delivered_by_plot_m3": {"A": 1}}),
             dict(plan, incident={"kind": "pump_shutdown", "start_slot": 1, "duration_slots": 1})]
    for invalid in plans:
        assert client.post(URL, json={"plan": invalid, "hours": [hour(0)]}).status_code == 422
    assert client.post(URL.replace("jendouba-pilote", "korba-cap-bon"),
                       json={"plan": plan, "hours": [hour(0)]}).status_code == 422


def test_regional_replay_uses_same_weather_window_and_follows_optimizer(client):
    site = "/api/sites/korba-cap-bon"
    plan = {"date": "2025-07-15", "tank_capacity_m3": 12, "initial_stock_m3": 2,
            "withdrawal_limit_m3": 3, "pump_flow_m3_h": 3, "pump_wh_per_m3": 500,
            "gravity_flow_m3_h": 3, "grid_cap_w": 2000, "pv_capacity_kwp": 0,
            "pv_performance_ratio": .8, "demand_west_m3": 5, "demand_east_m3": 5,
            "delivery_start_hour": 1, "delivery_end_hour": 2, "outage_hours": [1]}
    comparison = client.post(site + "/planning", json=plan).json()
    response = client.post(site + "/operator-rotation", json={"plan": plan,
                           "hours": [hour(0, "west", 2, 4), hour(1, "east", 4, 3)]})
    assert response.status_code == 200
    result = response.json()
    assert [(r["feasible_pump_m3"], r["feasible_delivery_m3"]) for r in result["hours"]] == [(3, 0), (0, 3)]
    assert result["optimized"]["metrics"] == comparison["comparison"]["optimized"]["metrics"]


def test_unverified_solver_keeps_operator_result_separate():
    with TestClient(create_app(solver_timeout=0, assistant_factory=lambda *_: SimpleNamespace(close=lambda: None))) as session:
        result = session.post(URL, json={"plan": mini(), "hours": [hour(2, "B", 10)]}).json()
    assert result["operator"]["metrics"]["delivered_on_time_m3"] == 10
    assert result["optimized"]["status"] == "NO_SOLUTION" and result["optimized"]["metrics"] is None

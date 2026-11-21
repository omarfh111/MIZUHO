from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from ortools.sat.python import cp_model

from backend.catalog import load_catalog
from backend.main import create_app
from backend.models import Slot, ZonePlanRequest
from backend.optimizer import add_horizon
from backend.simulator import available_power, simulate
from backend.zone_planning import zone_scenario


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app(assistant_factory=lambda *_: SimpleNamespace(close=lambda: None))) as session:
        yield session


def pilot(client, name="mini", **state):
    scenario = next(s for s in client.get("/api/scenarios").json() if s["id"] == name)
    return {"scenario_id": name, "state": {**scenario["state"], **state}, "solar_option_id": None,
            "outage_slots": [slot["slot"] for slot in scenario["slots"] if not slot["grid_available"]]}


def regional(**updates):
    return {"date": "2025-07-15", "tank_capacity_m3": 20, "initial_stock_m3": 10,
            "withdrawal_limit_m3": 0, "pump_flow_m3_h": 4, "pump_wh_per_m3": 500,
            "gravity_flow_m3_h": 4, "grid_cap_w": 2000, "pv_capacity_kwp": 3.2,
            "pv_performance_ratio": 0.8, "demand_west_m3": 2, "demand_east_m3": 2,
            "delivery_start_hour": 0, "delivery_end_hour": 1, "outage_hours": [], **updates}


PILOT = "/api/sites/jendouba-pilote/resilience/"
REGION = "/api/sites/korba-cap-bon/resilience/"


def test_matrix_queries_every_pair_and_replays_selected_case(client):
    body = {"plan": pilot(client, "normal"), "target_percent": 80}
    grid = client.post(PILOT + "grid", json=body).json()
    assert len(grid["cells"]) == 16
    assert {(c["start"], c["duration"]) for c in grid["cells"]} == {
        (s, d) for s in grid["starts"] for d in grid["durations"]}
    cell = next(c for c in grid["cells"] if c["start"] == 6 and c["duration"] == 8)
    assert cell["reserve_status"] == "minimum" and cell["reserve_m3"] == 16
    case = client.post(PILOT + "case", json={**body, "start": 6, "duration": 8}).json()
    fair = case["rules"]["fair"]
    assert case["reserve_m3"] == cell["reserve_m3"] and case["outage_slots"] == list(range(6, 14))
    assert fair["metrics"]["worst_coverage_bp"] == cell["coverage_bp"]
    assert sum(p["deficit_m3"] for p in fair["plot_results"]) == cell["deficit_m3"]
    for plan in [*case["rules"].values(), case["without_prefill"]]:
        assert all(a["pump_m3"] == a["grid_wh"] == 0 for a in plan["actions"] if a["slot"] in case["outage_slots"])
    assert fair["metrics"]["delivered_on_time_m3"] >= case["without_prefill"]["metrics"]["delivered_on_time_m3"]


def test_reserve_minimizes_stock_needed_rather_than_returning_the_current_stock(client):
    body = {"plan": regional(), "target_percent": 50, "starts": [0], "durations": [2]}
    cell, = client.post(REGION + "grid", json=body).json()["cells"]
    # 10 m³ initially, no withdrawal quota. Two sectors each need 1 m³ to reach 50%.
    assert (cell["reserve_status"], cell["reserve_m3"], cell["coverage_bp"]) == ("minimum", 2, 10000)
    body["plan"]["initial_stock_m3"] = 1
    limited, = client.post(REGION + "grid", json=body).json()["cells"]
    assert limited["reserve_status"] == "unreachable" and limited["reserve_m3"] is None
    body["plan"].update(demand_west_m3=0, demand_east_m3=0)
    empty, = client.post(REGION + "grid", json=body).json()["cells"]
    assert empty["reserve_status"] == "no_target" and empty["coverage_bp"] is None


def test_jendouba_pump_limited_case_distinguishes_four_and_eight_hour_outages(client):
    plan = pilot(client, "normal")
    plan.update(overrides={"pump_max_m3_per_slot": 2}, restart_grid_cap_w=3000)
    grid = client.post(PILOT + "grid", json={"plan": plan, "target_percent": 80, "starts": [11], "durations": [4, 8]})
    assert grid.status_code == 200
    four, eight = grid.json()["cells"]
    assert (four["coverage_bp"], four["deficit_m3"], four["reserve_m3"], four["reserve_status"]) == (9000, 4, 13, "minimum")
    assert (eight["coverage_bp"], eight["deficit_m3"], eight["reserve_m3"], eight["reserve_status"]) == (7000, 12, None, "unreachable")


def test_fixed_fair_and_priority_are_distinct_at_equal_resources(client):
    case = client.post(PILOT + "case", json={"plan": pilot(client), "start": 1, "duration": 2,
                                            "target_percent": 50, "urgent_plot_id": "B"}).json()
    volumes = {rule: [p["delivered_on_time_m3"] for p in plan["plot_results"]] for rule, plan in case["rules"].items()}
    assert volumes == {"fixed": [10, 0], "fair": [5, 5], "urgent": [0, 10]}
    assert all(p["metrics"]["withdrawn_m3"] == 0 for p in case["rules"].values())
    assert case["reserve_m3"] == 10 and case["heat_days"] == []
    assert case["outage_slots"] == [1, 2]


def test_loss_enters_mass_balance_and_meter_error_leaves_the_ledger_intact(client):
    body = {"plan": pilot(client), "start": 1, "duration": 2, "loss_m3": 3}
    case = client.post(PILOT + "case", json=body).json()
    leak, meter = case["incidents"]
    assert leak["kind"] == "physical_loss" and meter["kind"] == "meter_error"
    assert meter["plan"] == case["rules"]["fair"]
    assert leak["plan"]["metrics"]["delivered_m3"] == 7
    assert meter["plan"]["metrics"]["delivered_m3"] == 10
    for incident in (leak, meter):
        opening = 10
        for reading, action in zip(incident["readings"], incident["plan"]["actions"], strict=True):
            delivered = sum(d["delivered_m3"] for d in action["deliveries"])
            opening += action["pump_m3"] - reading["physical_loss_m3"] - delivered
            assert opening == reading["physical_stock_m3"] == action["tank_stock_m3"] >= 0
    first = meter["readings"][0]
    assert first["reported_stock_m3"] == first["physical_stock_m3"] - 3
    clipped = client.post(PILOT + "case", json={**body, "loss_m3": 100}).json()["incidents"][0]
    assert clipped["readings"][0]["physical_loss_m3"] == 10
    assert clipped["plan"]["metrics"]["delivered_m3"] == 0


def test_generator_can_power_pump_and_no_spurious_grid_or_pv_is_created(client):
    body = {"plan": regional(initial_stock_m3=0, withdrawal_limit_m3=4),
            "start": 0, "duration": 2, "backup_w": 1000, "extra_tank_m3": 30}
    current, bigger, generator = client.post(REGION + "case", json=body).json()["upgrades"]
    assert [u["id"] for u in (current, bigger, generator)] == ["current", "larger_tank", "backup"]
    assert current["plan"]["metrics"]["delivered_on_time_m3"] == bigger["plan"]["metrics"]["delivered_on_time_m3"] == 0
    assert generator["plan"]["metrics"]["delivered_on_time_m3"] == 4
    assert generator["backup_wh"] == generator["plan"]["metrics"]["pump_wh"] == 2000
    assert generator["plan"]["metrics"]["grid_wh"] == 0
    assert all(a["pump_m3"] <= 2 and a["grid_wh"] == 0 for a in generator["plan"]["actions"][:2])
    assert generator["plan"]["metrics"]["quota_remaining_m3"] == 0
    slot = Slot(slot=0, grid_available=False, solar_wh=10000, grid_cap_w=20000)
    assert available_power(slot) == (0, 0)
    assert available_power(slot.model_copy(update={"island_backup_w": 1000})) == (0, 1000)


def test_hot_days_carry_stock_and_quota_and_never_replenish_at_midnight(client):
    plan = regional(initial_stock_m3=4, withdrawal_limit_m3=2, delivery_start_hour=14, delivery_end_hour=17)
    case = client.post(REGION + "case", json={"plan": plan, "start": 0, "duration": 1, "heat_percent": 150}).json()
    d1, d2, d3 = case["heat_days"]
    for first, next_day in ((d1, d2), (d2, d3)):
        assert first["end_stock_m3"] == next_day["initial_stock_m3"]
        assert first["end_quota_m3"] == next_day["initial_quota_m3"]
    assert d1["initial_quota_m3"] == 2 and d1["initial_stock_m3"] == 4
    assert [d["deficit_m3"] for d in (d1, d2, d3)] == [0, 6, 6]
    paced = case["heat_reserved_days"]
    assert [d["deficit_m3"] for d in paced] == [2, 5, 5]
    assert [d["end_quota_m3"] for d in paced] == [2, 1, 0]
    for d in paced:
        assert d["plan"]["actions"][-1]["quota_remaining_m3"] == d["end_quota_m3"]


def test_larger_tank_and_advance_pumping_each_have_a_distinct_effect_at_equal_quota(client):
    plan = regional(tank_capacity_m3=2, initial_stock_m3=0, withdrawal_limit_m3=4,
                    delivery_start_hour=1, delivery_end_hour=2)
    case = client.post(REGION + "case", json={"plan": plan, "start": 1, "duration": 2, "extra_tank_m3": 2}).json()
    current, larger, _ = case["upgrades"]
    assert case["without_prefill"]["metrics"]["delivered_on_time_m3"] == 0
    assert current["plan"]["metrics"]["delivered_on_time_m3"] == 2
    assert larger["plan"]["metrics"]["delivered_on_time_m3"] == 4
    for trial, pumped in ((current, 2), (larger, 4)):
        first = trial["plan"]["actions"][0]
        assert first["pump_m3"] == first["tank_stock_m3"] == pumped
        assert first["quota_remaining_m3"] == 4 - pumped


def test_canonical_solver_energy_objectives_equal_physical_grid_and_backup_ledgers():
    profile = load_catalog().zone_planning["korba-cap-bon"]
    scenario, state, _ = zone_scenario(profile, ZonePlanRequest(**regional(
        initial_stock_m3=0, withdrawal_limit_m3=6, pv_capacity_kwp=0, outage_hours=[0])))
    scenario = scenario.model_copy(update={"slots": (scenario.slots[0].model_copy(update={"island_backup_w": 2000}),
                                                     *scenario.slots[1:])})
    model = cp_model.CpModel()
    horizon = add_horizon(model, scenario, state, "test")
    model.add(horizon.pumps[0] == 4)
    model.add(horizon.pumps[1] == 2)
    model.minimize(horizon.grid)
    solver = cp_model.CpSolver()
    assert solver.solve(model) == cp_model.OPTIMAL
    ledger = simulate(scenario, state, horizon.actions(solver))
    assert ledger.metrics.grid_wh == solver.value(horizon.grid) == 1000
    assert ledger.metrics.peak_grid_w == solver.value(horizon.peak) == 1000
    assert sum(slot.backup_wh for slot in ledger.slots) == solver.value(horizon.backup) == 2000


def test_validation_short_horizons_and_site_isolation(client):
    plan = pilot(client)
    grid = client.post(PILOT + "grid", json={"plan": plan}).json()
    assert len(grid["cells"]) < 16 and all(1 <= c["start"] < c["start"] + c["duration"] <= 3 for c in grid["cells"])
    for path, body in [
        (PILOT + "grid", {"plan": plan, "starts": [1, 1]}),
        (PILOT + "case", {"plan": plan, "start": 2, "duration": 2}),
        (PILOT + "case", {"plan": plan, "start": 1, "duration": 1, "urgent_plot_id": "west"}),
        (REGION + "grid", {"plan": plan}),
        (PILOT + "grid", {"plan": regional()}),
        (PILOT + "grid", {"plan": plan, "target_percent": 0}),
    ]:
        assert client.post(path, json=body).status_code == 422


def test_time_budget_does_not_turn_unknowns_into_physical_zeros():
    with TestClient(create_app(solver_timeout=0, assistant_factory=lambda *_: SimpleNamespace(close=lambda: None))) as client:
        body = {"plan": regional(), "starts": [0], "durations": [1]}
        cell, = client.post(REGION + "grid", json=body).json()["cells"]
        assert cell["status"] == "NO_SOLUTION" and cell["reserve_status"] == "unknown"
        assert cell["coverage_bp"] is cell["reserve_m3"] is cell["deficit_m3"] is None

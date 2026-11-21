import pytest

from backend.catalog import load_catalog
from backend.compare import InputError, compare, effective_scenario
from backend.models import CompareRequest


@pytest.fixture(scope="module")
def catalog():
    return load_catalog()


def experiment(catalog, scenario="mini", **options):
    original = catalog.scenarios[scenario]
    body = {"scenario_id": scenario, "state": original.state, "solar_option_id": None,
            "outage_slots": [s.slot for s in original.slots if not s.grid_available], **options}
    return CompareRequest.model_validate(body)


def test_customer_constraints_apply_to_both_schedules(catalog):
    original = catalog.scenarios["mini"]
    state = original.state.model_copy(update={"tank_stock_m3": 0, "quota_remaining_m3": 10})
    request = experiment(catalog, state=state, outage_slots=[1], overrides={
        "pump_max_m3_per_slot": 5, "grid_cap_w": 1500, "solar_percent": 0, "demand_by_plot_m3": {"B": 15}})
    result = compare(catalog, request, 2)
    for plan in (result.baseline, result.optimized):
        assert [a.pump_m3 for a in plan.actions] == [0, 3]
        assert plan.metrics.withdrawn_m3 == 3 and plan.metrics.grid_wh == 1500
        assert {p.plot_id: p.demand_m3 for p in plan.plot_results} == {"A": 10, "B": 15}
        assert plan.metrics.delivered_on_time_m3 == 3
    assert original.site.pump_max_m3_per_slot == 10 and original.plots[1].demand_m3 == 10


def test_closed_distribution_blocks_fixed_and_optimized_gravity(catalog):
    request = experiment(catalog, overrides={"gravity_available": False})
    result = compare(catalog, request, 2)
    for plan in (result.baseline, result.optimized):
        assert plan.metrics.delivered_m3 == 0 and plan.metrics.tank_stock_m3 == 10
        assert "gravity_capacity_below_minimum" in {warning.type for warning in plan.warnings}


def test_motor_power_ceiling_includes_solar_and_grid(catalog):
    state = catalog.scenarios["mini"].state.model_copy(update={"tank_stock_m3": 0, "quota_remaining_m3": 10, "current_slot": 0})
    request = experiment(catalog, state=state, overrides={"pump_power_cap_w": 1200}, outage_slots=[1, 2])
    result = compare(catalog, request, 2)
    assert result.optimized.actions[0].pump_m3 == 2
    assert result.optimized.metrics.pump_wh == 1000 and result.optimized.metrics.grid_wh == 0


@pytest.mark.parametrize("kind", ["pump_shutdown", "unexpected_outage"])
def test_recovery_preserves_executed_actions_and_pump_constraints(catalog, kind):
    # Preserve a deliberately uneven previous plan. Regenerating its history would change A's delivery.
    previous = [{"slot": 1, "pump_m3": 0, "deliveries": [{"plot_id": "A", "delivered_m3": 7}]},
                {"slot": 2, "pump_m3": 5, "deliveries": [{"plot_id": "B", "delivered_m3": 8}]}]
    state = catalog.scenarios["mini"].state.model_copy(update={"quota_remaining_m3": 8})
    request = experiment(catalog, state=state, outage_slots=[], incident={
        "kind": kind, "start_slot": 2, "duration_slots": 1, "previous_actions": previous})
    disrupted = effective_scenario(catalog, request)
    assert disrupted.slots[2].grid_available == (kind == "pump_shutdown")
    result = compare(catalog, request, 2)
    checkpoint = result.incident_checkpoint
    assert checkpoint.current_slot == 2 and checkpoint.tank_stock_m3 == 3 and checkpoint.quota_remaining_m3 == 8
    assert checkpoint.delivered_by_plot_m3["A"] == 7
    assert result.baseline.actions[0] == result.optimized.actions[0]
    for plan in (result.baseline, result.optimized):
        assert [a.pump_m3 for a in plan.actions] == [0, 0]
        assert [a.deliveries[0].delivered_m3 for a in plan.actions] == [7, 3]
        assert plan.metrics.delivered_on_time_m3 == 10 and plan.metrics.tank_stock_m3 == 0
        assert plan.metrics.quota_remaining_m3 == 8 and plan.metrics.withdrawn_m3 == 0


def test_recovery_can_build_the_initial_plan_without_a_supplied_schedule(catalog):
    request = experiment(catalog, incident={"kind": "pump_shutdown", "start_slot": 2, "duration_slots": 1})
    result = compare(catalog, request, 2)
    assert result.incident_checkpoint.tank_stock_m3 == 5
    assert [a.deliveries[0].delivered_m3 for a in result.optimized.actions] == [5, 5]


def test_recovery_moves_lost_pumping_into_a_restored_slot(catalog):
    state = catalog.scenarios["mini"].state.model_copy(update={"current_slot": 0, "tank_stock_m3": 0, "quota_remaining_m3": 10})
    previous = [{"slot": 0}, {"slot": 1, "pump_m3": 10, "deliveries": [{"plot_id": "A", "delivered_m3": 5}]},
                {"slot": 2, "deliveries": [{"plot_id": "B", "delivered_m3": 5}]}]
    request = experiment(catalog, state=state, outage_slots=[], incident={
        "kind": "unexpected_outage", "start_slot": 1, "duration_slots": 1, "previous_actions": previous})
    result = compare(catalog, request, 2)
    assert result.baseline.metrics.delivered_m3 == 0
    assert result.optimized.metrics.delivered_on_time_m3 == 10
    assert [a.pump_m3 for a in result.optimized.actions] == [0, 0, 10]
    assert result.optimized.metrics.quota_remaining_m3 == 0


@pytest.mark.parametrize("options", [
    {"incident": {"kind": "pump_shutdown", "start_slot": 2, "duration_slots": 2}},
    {"incident": {"kind": "unexpected_outage", "start_slot": 1, "duration_slots": 1}},
    {"incident": {"kind": "pump_shutdown", "start_slot": 2, "duration_slots": 1, "previous_actions": [{"slot": 2}]}},
    {"incident": {"kind": "pump_shutdown", "start_slot": 2, "duration_slots": 1,
                  "previous_actions": [{"slot": 1, "pump_m3": 100}, {"slot": 2}]}},
    {"overrides": {"demand_by_plot_m3": {"unknown": 20}}},
    {"overrides": {"demand_by_plot_m3": {"A": 9}}},
])
def test_rejects_inconsistent_inputs(catalog, options):
    with pytest.raises(InputError):
        compare(catalog, experiment(catalog, **options), 2)


def test_archived_reference_day_and_weather_profiles_stay_distinct(catalog):
    request = experiment(catalog, "normal", overrides={"pvgis_option_id": "toiture", "solar_percent": 50})
    source = effective_scenario(catalog, experiment(catalog, "normal", overrides={"pvgis_option_id": "toiture"}))
    reduced = effective_scenario(catalog, request)
    assert sum(s.solar_wh for s in source.slots) > 0
    assert [s.solar_wh for s in reduced.slots] == [s.solar_wh // 2 for s in source.slots]
    weather = catalog.scenarios["jplus1"]
    with pytest.raises(InputError):
        compare(catalog, experiment(catalog, "jplus1", planning_mode="weather_buffer",
                weather_pair_id=weather.weather_pair_id, overrides={"pvgis_option_id": "toiture"}), 2)

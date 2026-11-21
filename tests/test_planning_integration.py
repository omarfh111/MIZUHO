from backend.catalog import load_catalog
from backend.compare import efficiency_warning
from backend.models import Action, Delivery, EfficiencyReadings, EfficiencySample
from backend.simulator import simulate
from backend.solar import compare_option


def test_simulator_rejects_delivery_without_gravity():
    mini = load_catalog().scenarios["mini"]
    action = Action(slot=1, deliveries=(Delivery(plot_id="A", delivered_m3=5),))
    result = simulate(mini, mini.state, (action,))
    assert result.slots[0].tank_stock_m3 == 5
    assert result.slots[0].pump_wh == 0
    blocked = mini.model_copy(update={"site": mini.site.model_copy(update={"gravity_max_m3_per_slot": 0})})
    assert simulate(blocked, mini.state, (action,)).violations[0].constraint == "gravity_flow"


def test_efficiency_gap_breaks_consecutive_alert():
    readings = EfficiencyReadings(source_id="telemetry", reference_wh_per_m3=500, samples=(
        EfficiencySample(slot=1, pumped_m3=10, consumed_wh=7000),
        EfficiencySample(slot=2, pumped_m3=None, consumed_wh=7000),
        EfficiencySample(slot=3, pumped_m3=10, consumed_wh=7000),
    ))
    assert efficiency_warning(readings)[0].type == "insufficient"


def test_five_kwh_solar_supplies_only_three_kwh_of_connected_load():
    site = load_catalog().solar["jendouba-pilote"]
    option = site.options[0].model_copy(update={"profile_wh": (5000, 5000) + (0,) * 22})
    site = site.model_copy(update={"demand_wh": (3000, 3000) + (0,) * 22, "grid_available": (True,) + (False,) * 23})
    result = compare_option(site, option, 0.25)
    assert result.production_kwh == 10
    assert result.grid_avoided_kwh == result.self_consumed_kwh == 3
    assert result.gross_savings_tnd == 0.75

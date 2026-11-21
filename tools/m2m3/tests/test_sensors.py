import pytest

from mizu_m2m3.sensors import project_telemetry
from mizu_m2m3.simulation import demo_snapshot, station_day, START
from mizu_m2m3.solar import simulation_solar_profile
from mizu_m2m3.web import _project_sensors


def test_projects_physical_states_without_altering_them():
    states = station_day(21, START, {})[:2]
    for slot, row in enumerate(states):
        row.update(simulation_slot=slot, solar_wh=1000)
    data = _project_sensors({"states": states, "reference": 0.5, "missing_flow_slots": [1]})
    meters = {(item["simulation_slot"], item["sensor_id"]): item for item in data["measurements"]}
    first = meters[0, "tank-level-01"]
    assert first["equipment_id"] == "tank-01" and first["value"] == states[0]["tank_stock_m3"]
    assert first["timestamp"].endswith("Z") and first["source"] == "virtual_sensor"
    missing = meters[1, "pump-flow-01"]
    assert missing["quality"] == "missing" and missing["value"] is None
    assert states[1]["pumped_m3"] > 0
    assert data["records"][1]["pump_energy_total_kwh"] == sum(state["consumed_wh"] for state in states) / 1000
    assert data["diagnostics"][0]["pump_energy_intensity"] == "insufficient_data"


def test_missing_flow_breaks_comparable_hours_without_changing_stock():
    baseline = demo_snapshot(10)
    dropout = demo_snapshot(10, [{"kind": "sensor_dropout", "hour": 9}])
    assert baseline["alerts"][0]["value"] == 0.7
    assert dropout["alerts"] == []
    assert [row["tank_stock_m3"] for row in baseline["records"]] == [row["tank_stock_m3"] for row in dropout["records"]]
    assert dropout["records"][9]["pumped_m3"] is None


def test_applied_pv_changes_telemetry_and_grid_outage_disables_grid_tied_solar():
    roof = simulation_solar_profile("jendouba-pilote", "toiture")
    canopy = simulation_solar_profile("jendouba-pilote", "ombriere")
    first = demo_snapshot(13, solar_profile=roof)["records"]
    second = demo_snapshot(13, solar_profile=canopy)["records"]
    assert len(canopy["slots"]) == 24
    assert [row["grid_import_wh"] for row in first] != [row["grid_import_wh"] for row in second]
    outage = demo_snapshot(13, [{"kind": "outage", "hour": 13}], solar_profile=canopy)["records"][-1]
    assert outage["solar_wh"] > 0
    assert outage["solar_generated_wh"] == outage["solar_used_wh"] == outage["grid_import_wh"] == 0
    assert outage["pumped_m3"] == 0 and outage["distributed_m3"] > 0


def test_grid_tied_physical_input_cannot_pump_during_outage():
    row = {**station_day(21, START, {})[0], "simulation_slot": 0, "grid_available": False}
    with pytest.raises(ValueError, match="must stop"):
        project_telemetry([row], 0.5)

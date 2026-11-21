import pytest

from mizu_m2m3.anomalies import analyze_telemetry, detect_anomalies
from mizu_m2m3.inputs import DATA
from mizu_m2m3.telemetry import read_telemetry


def test_bundled_water_and_energy_alerts():
    alerts = detect_anomalies(read_telemetry(DATA / "telemetry/sample.csv"), 0.5)
    assert [(alert["type"], alert["value"]) for alert in alerts] == [
        ("high_pump_energy_intensity", 0.7), ("unexplained_water", 13),
    ]
    assert all(alert["provenance"] == "simulated" for alert in alerts)


@pytest.mark.parametrize("middle", [None, 0, 10])
def test_missing_zero_and_threshold_readings_break_sequence(middle):
    rows = [
        {"site_id": "x", "timestamp": f"2026-11-20T{hour:02d}:00:00Z", "grid_available": True,
         "pumped_m3": volume, "consumed_wh": energy}
        for hour, volume, energy in [(1, 10, 7000), (2, middle, 6000), (3, 10, 7000)]
    ]
    assert detect_anomalies(rows, 0.5) == []


def test_gaps_and_outages_break_sequence():
    rows = [
        {"site_id": "x", "timestamp": f"2026-11-20T{hour:02d}:00:00Z", "grid_available": grid,
         "pumped_m3": 10, "consumed_wh": 7000}
        for hour, grid in [(1, True), (3, True), (4, False), (5, True)]
    ]
    result = analyze_telemetry(rows, 0.5)
    assert result["alerts"] == []
    assert result["diagnostics"][0]["pump_energy_intensity"] == "insufficient_data"

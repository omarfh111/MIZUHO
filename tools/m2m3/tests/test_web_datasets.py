import pytest

from mizu_m2m3.web import _anomalies, _forecast, _solar


def test_preloaded_routine_and_stress_csvs_change_anomaly_results():
    assert _anomalies({"dataset": "routine", "reference": 0.5})["alerts"] == []
    alerts = _anomalies({"dataset": "stress", "reference": 0.5})["alerts"]
    assert {alert["value"] for alert in alerts} == {0.7, 13}


def test_forecast_runs_on_seeded_dataset():
    result = _forecast({"dataset": "routine", "as_of": "2026-11-20T18:00:00+01:00"})
    assert result["status"] == "ok"
    assert len(result["points"]) == 24


def test_each_station_uses_its_own_forecast_and_anomaly_history():
    request = {"dataset": "routine", "as_of": "2026-11-20T18:00:00+01:00"}
    north = _forecast({**request, "site_id": "jendouba-pilote"})
    south = _forecast({**request, "site_id": "gabes-demo"})
    assert len(north["points"]) == len(south["points"]) == 24
    assert north["points"] != south["points"]
    alerts = _anomalies({"dataset": "stress", "reference": 0.54, "site_id": "gabes-demo"})["alerts"]
    assert alerts and {alert["site_id"] for alert in alerts} == {"gabes-demo"}


def test_solar_load_preset_changes_savings_and_unknown_preset_is_rejected():
    standard = _solar({"dataset": "sample", "price": 0.25})["options"][0]
    irrigation = _solar({"dataset": "irrigation", "price": 0.25})["options"][0]
    assert standard["production_kwh"] == irrigation["production_kwh"]
    assert standard["gross_savings_tnd"] != irrigation["gross_savings_tnd"]
    with pytest.raises(ValueError, match="dataset"):
        _solar({"dataset": "unknown"})

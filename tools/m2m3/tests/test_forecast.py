import pandas as pd

from mizu_m2m3.forecast import _weather_at_cutoff, forecast_load
from mizu_m2m3.inputs import DATA


SITE = "jendouba-pilote"
CUTOFF = "2026-11-20T18:00:00+01:00"


def test_forecast_and_chronological_baseline():
    result = forecast_load(SITE, CUTOFF)
    assert result["status"] == "ok"
    assert result["provenance"] == "simulated"
    assert len(result["points"]) == 24
    assert result["points"][0]["timestamp"] == "2026-11-20T19:00:00+01:00"
    assert result["points"][-1]["timestamp"] == "2026-11-21T18:00:00+01:00"
    assert result["test"]["regression_mae_kw"] >= 0
    assert result["test"]["same_hour_last_week_mae_kw"] >= 0
    assert pd.Timestamp(result["test"]["through"]) <= pd.Timestamp(CUTOFF)


def test_load_after_cutoff_cannot_change_forecast(tmp_path):
    data = pd.read_csv(DATA / "telemetry/sample.csv")
    past_cutoff = "2026-11-19T18:00:00+01:00"
    data.loc[pd.to_datetime(data.timestamp, utc=True) > pd.Timestamp(past_cutoff), "load_kw"] = 50000
    path = tmp_path / "future.csv"
    data.to_csv(path, index=False)
    assert forecast_load(SITE, past_cutoff, telemetry_path=path) == forecast_load(SITE, past_cutoff)


def test_future_weather_available_after_cutoff_is_ignored(tmp_path):
    columns = ["site_id", "timestamp", "available_at", "temperature_c"]
    target = "2026-11-20T19:00:00+01:00"
    rows = [[SITE, target, "2026-11-20T17:00:00+01:00", 20]]
    valid = tmp_path / "valid.csv"
    mixed = tmp_path / "mixed.csv"
    pd.DataFrame(rows, columns=columns).to_csv(valid, index=False)
    rows.append([SITE, target, "2026-11-20T18:15:00+01:00", 999])
    pd.DataFrame(rows, columns=columns).to_csv(mixed, index=False)
    selected = _weather_at_cutoff(mixed, SITE, pd.Timestamp(CUTOFF).tz_convert("UTC"))
    assert selected.loc[pd.Timestamp(target)] == 20
    assert forecast_load(SITE, CUTOFF, weather_path=valid) == forecast_load(SITE, CUTOFF, weather_path=mixed)


def test_insufficient_history():
    result = forecast_load(SITE, "2026-10-18T12:00:00+01:00")
    assert result["status"] == "insufficient_history"
    assert result["points"] == []

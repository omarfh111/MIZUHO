import json

import pandas as pd
import pytest

from mizu_m2m3.solar import compare_solar


SITE = "jendouba-pilote"


def test_saved_pvgis_profiles_are_complete_and_distinct():
    results = compare_solar(SITE, ["toiture", "ombriere"], load_path=None)
    assert [option["capacity_kwp"] for option in results] == [10, 10]
    assert all(len(option["profile_wh"]) == 24 for option in results)
    assert all(option["annual_production_kwh"] > 0 for option in results)
    assert results[0]["profile_wh"] != results[1]["profile_wh"]
    assert results[0]["gross_savings_tnd"] is None


def test_hourly_self_consumption_and_outage(tmp_path):
    hours = pd.date_range("2023-06-20T23:00:00Z", periods=24, freq="h")
    profiles = tmp_path / "profiles.csv"
    load = tmp_path / "load.csv"
    pd.DataFrame({
        "site_id": SITE, "option_id": "toiture", "timestamp": hours,
        "solar_wh": [5000, 5000] + [0] * 22,
    }).to_csv(profiles, index=False)
    pd.DataFrame({
        "site_id": SITE, "timestamp": hours, "load_wh": 3000,
        "grid_available": [True, False] + [True] * 22,
    }).to_csv(load, index=False)
    option, = compare_solar(SITE, ["toiture"], 0.25, profiles_path=profiles, load_path=load)
    assert option["production_kwh"] == 10
    assert option["self_consumed_kwh"] == option["grid_avoided_kwh"] == 3
    assert option["gross_savings_tnd"] == 0.75
    assert option["annual_production_kwh"] is None
    assert option["payback_years"] is None

    load_rows = pd.read_csv(load)
    load_rows.loc[0, "load_wh"] = 1000
    load_rows.to_csv(load, index=False)
    option, = compare_solar(SITE, ["toiture"], profiles_path=profiles, load_path=load)
    assert option["self_consumed_kwh"] == 1
    assert option["gross_savings_tnd"] is None


def test_annual_savings_require_complete_load_and_costs(tmp_path):
    hours = pd.date_range("2023-01-01", periods=8760, freq="h", tz="UTC")
    profiles = tmp_path / "profiles.csv"
    load = tmp_path / "load.csv"
    catalog = tmp_path / "options.json"
    pd.DataFrame({"site_id": SITE, "option_id": "x", "timestamp": hours, "solar_wh": 5000}).to_csv(profiles, index=False)
    rows = pd.DataFrame({"site_id": SITE, "timestamp": hours, "load_wh": 3000, "grid_available": True})
    rows.to_csv(load, index=False)
    catalog.write_text(json.dumps({SITE: {
        "timezone": "Africa/Tunis", "demo_day": "2023-06-21",
        "options": {"x": {"series_year": 2023, "annual_extra_cost_tnd": 570, "investment_tnd": 12000}},
    }}))
    paths = {"options_path": catalog, "profiles_path": profiles, "load_path": load}
    option, = compare_solar(SITE, ["x"], 0.25, **paths)
    assert option["annual_grid_avoided_kwh"] == 26280
    assert option["net_savings_tnd"] == 6000
    assert option["payback_years"] == 2
    rows.iloc[1:].to_csv(load, index=False)
    option, = compare_solar(SITE, ["x"], 0.25, **paths)
    assert option["annual_production_kwh"] == 43800
    assert option["net_savings_tnd"] is None
    assert option["payback_years"] is None


def test_unknown_option_is_reported():
    with pytest.raises(ValueError, match="option_ids"):
        compare_solar(SITE, ["invalid"])

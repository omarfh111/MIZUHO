import json

import pytest
from fastapi.testclient import TestClient

from backend.catalog import DATA_DIR
from backend.main import create_app


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as connection:
        yield connection


def compare_request(scenario: str, *, stock=None, quota=None, current=None, outages=None, **overrides):
    item = json.loads((DATA_DIR / "scenarios" / f"{scenario}.json").read_text(encoding="utf-8"))
    state = item["state"]
    for value, field in ((stock, "tank_stock_m3"), (quota, "quota_remaining_m3"), (current, "current_slot")):
        if value is not None:
            state[field] = value
    return {
        "scenario_id": scenario,
        "state": state,
        "outage_slots": [slot["slot"] for slot in item["slots"] if not slot["grid_available"]] if outages is None else outages,
        "solar_option_id": None,
        **overrides,
    }


def post_compare(client, request):
    response = client.post("/api/compare", json=request)
    assert response.status_code == 200, response.text
    return response.json()


def test_catalog_health_and_openapi(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/docs").status_code == 200
    assert "/api/compare" in client.get("/openapi.json").json()["paths"]
    scenarios = {item["id"]: item for item in client.get("/api/scenarios").json()}
    assert set(scenarios) == {"mini", "normal", "announced", "successive", "jplus1", "jplus1-stable"}
    assert len(scenarios["mini"]["slots"]) == 3
    assert scenarios["mini"]["state"]["tank_stock_m3"] == 10


def test_geographic_layers_and_source_links(client):
    sites = client.get("/api/sites").json()
    assert sites["type"] == "FeatureCollection"
    site = sites["features"][0]
    assert site["geometry"]["coordinates"] == [8.7702, 36.5007]
    site_id = site["properties"]["site_id"]
    assert site["properties"]["relief"] == "jendouba-demo"
    for layer, count in {"plots": 5, "solar": 2, "wind": 0, "anomalies": 1}.items():
        result = client.get(f"/api/layers/{site_id}/{layer}").json()
        assert result["type"] == "FeatureCollection"
        assert len(result["features"]) == count
        assert client.get(f"/api/evidence/{result['source_id']}").status_code == 200
    evidence = client.get("/api/evidence/wapor").json()
    assert evidence["organization"] == "FAO" and evidence["date"] == "2025"
    assert client.get("/api/evidence/missing").status_code == 404
    assert client.get("/api/layers/missing/plots").status_code == 404
    assert client.get(f"/api/layers/{site_id}/missing").status_code == 404


def test_development_cors_allows_configured_origin(monkeypatch):
    monkeypatch.setenv("MIZHUO_CORS_ORIGINS", "http://127.0.0.1:5173")
    with TestClient(create_app()) as connection:
        headers = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
        allowed = connection.options("/api/compare", headers={**headers, "Origin": "http://127.0.0.1:5173"})
        assert allowed.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
        disallowed = connection.options("/api/compare", headers={**headers, "Origin": "https://example.com"})
        assert disallowed.status_code == 400
        assert "access-control-allow-origin" not in disallowed.headers


def test_station_observations_and_replanning_endpoints(client):
    weather = client.get("/api/weather/bouhertma", params={"day": "2026-05-08"})
    assert weather.status_code == 200
    assert weather.json()["unit"] == "W/m²" and len(weather.json()["observations"]) == 24
    assert client.get("/api/weather/bouhertma", params={"day": "unavailable"}).status_code == 422
    result = post_compare(client, compare_request("mini", incident={"kind": "pump_shutdown", "start_slot": 2, "duration_slots": 1}))
    assert result["incident_checkpoint"]["tank_stock_m3"] == 5
    response = client.post("/api/compare", json=compare_request("mini", overrides={"demand_by_plot_m3": {"A": 1}}))
    assert response.status_code == 422 and response.json()["detail"][0]["loc"] == ["body", "overrides", "demand_by_plot_m3", "A"]


def test_v5_miniature_shares_water_during_an_outage(client):
    result = post_compare(client, compare_request("mini"))
    fixed, proposed = result["baseline"], result["optimized"]
    assert fixed["metrics"]["worst_coverage_bp"] == 0
    assert proposed["status"] == "OPTIMAL"
    assert proposed["metrics"]["worst_coverage_bp"] == 5000
    assert [item["delivered_on_time_m3"] for item in proposed["plot_results"]] == [5, 5]
    assert [item["coverage_bp"] for item in proposed["plot_results"]] == [5000, 5000]
    assert [slot["slot"] for slot in proposed["actions"]] == [1, 2]
    assert proposed["metrics"]["pump_wh"] == 0
    assert proposed["metrics"]["tank_stock_m3"] == 0


def test_versioned_comparison_example_matches_current_api(client):
    fixture = json.loads((DATA_DIR / "fixtures" / "compare.json").read_text(encoding="utf-8"))
    assert fixture["version"] == "m6-v1"
    actual = post_compare(client, fixture["request"])
    for name in ("baseline", "optimized"):
        assert actual[name]["status"] == fixture["response"][name]["status"]
        assert actual[name]["metrics"] == fixture["response"][name]["metrics"]
        assert actual[name]["plot_results"] == fixture["response"][name]["plot_results"]


def test_announcement_uses_solar_before_the_outage(client):
    result = post_compare(client, compare_request("mini", stock=0, quota=10, current=0))
    assert result["baseline"]["metrics"]["delivered_m3"] == 0
    plan = result["optimized"]
    assert plan["actions"][0]["pump_m3"] == 10
    assert plan["metrics"]["pump_wh"] == 5000
    assert plan["metrics"]["grid_wh"] == 0
    assert plan["metrics"]["worst_coverage_bp"] == 5000


def test_restart_is_power_limited_in_both_plans(client):
    result = post_compare(client, compare_request("mini", stock=0, quota=10, outages=[1], restart_grid_cap_w=3000))
    for plan in (result["baseline"], result["optimized"]):
        outage, restart = plan["actions"]
        assert outage["pump_m3"] == 0
        assert restart["pump_m3"] == 6
        assert restart["grid_wh"] == 3000
        assert plan["metrics"]["quota_remaining_m3"] == 4


def test_recalculation_preserves_history_and_skips_past_slots(client):
    request = compare_request("mini", stock=5, current=2)
    request["state"]["delivered_by_plot_m3"] = {"A": 5}
    request["state"]["delivered_on_time_by_plot_m3"] = {"A": 5}
    result = post_compare(client, request)
    plan = result["optimized"]
    assert plan["actions"][0]["deliveries"] == [{"plot_id": "B", "delivered_m3": 5}]
    assert len(plan["actions"]) == 1
    assert plan["metrics"]["delivered_on_time_m3"] == 10


@pytest.mark.parametrize(("mutate", "field"), [
    (lambda body: body["state"].update(tank_stock_m3=11), ["state", "tank_stock_m3"]),
    (lambda body: body["state"].update(tank_stock_m3="1"), ["state", "tank_stock_m3"]),
    (lambda body: body["state"].update(current_slot=4), ["state", "current_slot"]),
    (lambda body: body["state"].update(delivered_by_plot_m3={"X": 1}), ["state", "delivered_by_plot_m3", "X"]),
    (lambda body: body["state"].update(delivered_on_time_by_plot_m3={"A": 1}), ["state", "delivered_on_time_by_plot_m3", "A"]),
    (lambda body: body.update(outage_slots=[1, 1]), ["outage_slots"]),
    (lambda body: body.update(outage_slots=[1, 3]), ["outage_slots"]),
    (lambda body: body.update(solar_option_id="fake"), ["solar_option_id"]),
    (lambda body: body.update(scenario_id="fake"), ["scenario_id"]),
    (lambda body: body.update(planning_mode="weather_buffer"), ["weather_pair_id"]),
])
def test_invalid_values_point_to_the_request_field(client, mutate, field):
    request = compare_request("mini")
    mutate(request)
    response = client.post("/api/compare", json=request)
    assert response.status_code == 422, response.text
    assert response.json()["detail"][0]["loc"] == ["body", *field]


def test_solar_respects_grid_availability_and_tariff(client):
    body = {"site_id": "jendouba-pilote", "option_ids": ["ombriere", "toiture"]}
    response = client.post("/api/solar/compare", json=body)
    assert response.status_code == 200
    options = response.json()["options"]
    assert [option["id"] for option in options] == body["option_ids"]
    storage = json.loads((DATA_DIR / "energy" / "jendouba-pilote.json").read_text(encoding="utf-8"))
    for option in options:
        production = option["profile_wh"]
        expected = sum(min(p, d) for p, d, available in zip(production, storage["demand_wh"], storage["grid_available"])
                       if available) / 1000
        assert option["self_consumed_kwh"] == option["grid_avoided_kwh"] == expected
        assert option["production_kwh"] == sum(production) / 1000
        assert option["annual_production_kwh"] is None
        assert option["gross_savings_tnd"] is None and option["payback_years"] is None
        assert option["autonomy_hours"] == 0
    priced = client.post("/api/solar/compare", json={**body, "price_tnd_per_kwh": 0.25}).json()["options"]
    assert priced[0]["gross_savings_tnd"] == pytest.approx(0.25 * options[0]["grid_avoided_kwh"])
    invalid = client.post("/api/solar/compare", json={**body, "option_ids": ["ombriere", "fake"]})
    assert invalid.status_code == 422
    assert invalid.json()["detail"][0]["loc"] == ["body", "option_ids", 1]


def test_selected_solar_profile_powers_only_connected_slots(client):
    request = compare_request("normal", outages=[9, 10], solar_option_id="toiture")
    solar = post_compare(client, request)["optimized"]
    grid = post_compare(client, {**request, "solar_option_id": None})["optimized"]
    assert solar["metrics"]["delivered_on_time_m3"] >= grid["metrics"]["delivered_on_time_m3"]
    assert solar["metrics"]["grid_wh"] < grid["metrics"]["grid_wh"]
    assert all(not action["pump_m3"] for action in solar["actions"] if action["slot"] in (9, 10))


@pytest.mark.parametrize(("scenario", "pair", "quota", "early", "on_time", "reference", "deficit"), [
    ("jplus1", "jplus1-demo", 7, 2, 8, 6, 0),
    ("jplus1-stable", "jplus1-stable", 7, 0, 8, 8, 0),
    ("jplus1", "jplus1-demo", 5, 0, 6, 6, 2),
])
def test_day_ahead_acceptance_cases(client, scenario, pair, quota, early, on_time, reference, deficit):
    request = compare_request(scenario, quota=quota, planning_mode="weather_buffer", weather_pair_id=pair)
    comparison = post_compare(client, request)["weather_comparison"]
    assert comparison["before_slot"] == 11
    assert comparison["early_pump_m3"] == early
    assert comparison["remaining_deficit_m3"] == deficit
    assert comparison["expected_stock_m3"] == 1 + early
    fixed = comparison["reference_on_adverse"]["metrics"]
    buffer = comparison["buffer_on_adverse"]["metrics"]
    assert (fixed["delivered_on_time_m3"], buffer["delivered_on_time_m3"]) == (reference, on_time)
    assert fixed["grid_wh"] == buffer["grid_wh"] == 0
    assert buffer["withdrawn_m3"] == on_time - 1 <= quota


def test_diagnostics_use_independent_readings(client):
    result = post_compare(client, compare_request("successive"))
    alert = next(item for item in result["optimized"]["warnings"] if item["type"] == "efficiency")
    assert alert["value"] == 0.7 and alert["reference"] == 0.5
    assert client.get(f"/api/evidence/{alert['source_id']}").status_code == 200


def test_time_budget_exhaustion_keeps_the_replayed_baseline():
    with TestClient(create_app(solver_timeout=0)) as connection:
        result = post_compare(connection, compare_request("mini"))
        assert result["optimized"]["status"] == "NO_SOLUTION"
        assert result["optimized"]["actions"] is None and result["optimized"]["metrics"] is None
        assert result["baseline"]["metrics"]["delivered_m3"] == 10

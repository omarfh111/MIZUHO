from datetime import date
from hashlib import sha256
from math import ceil

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.catalog import DATA_DIR
from backend.field_zones import read_field_zones
from backend.main import create_app
from backend.models import DemandEstimateRequest
from backend.zone_planning import estimate_demand, read_planning_profiles
from tools.field_zones.reference_et import reference_et
from tools.field_zones.refresh_replays import fetch_day


ZONES = ("gafsa-oasis", "kairouan-chebika", "korba-cap-bon")


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as connection:
        yield connection


def assumptions(**updates):
    return {"date": "2025-07-15", "tank_capacity_m3": 20, "initial_stock_m3": 1,
            "withdrawal_limit_m3": 16, "pump_flow_m3_h": 4, "pump_wh_per_m3": 500,
            "gravity_flow_m3_h": 4, "grid_cap_w": 2000, "pv_capacity_kwp": 3.2,
            "pv_performance_ratio": 0.8, "demand_west_m3": 10, "demand_east_m3": 10,
            "delivery_start_hour": 15, "delivery_end_hour": 18, "outage_hours": [15, 16], **updates}


def test_profiles_use_real_cropland_and_regional_hourly_data(client):
    series = []
    for site in ZONES:
        profile = client.get(f"/api/sites/{site}/planning").json()
        assert profile["site_id"] == site and profile["timezone"] == "Africa/Tunis"
        zone = client.get(f"/api/sites/{site}/field-zone").json()
        assert profile["missing_inputs"] == zone["missing_inputs"]
        assert [day["date"] for day in profile["days"]] == ["2025-01-15", "2025-07-15"]
        west, south, east, north = zone["relief"]["bounds"]
        cover = zone["land_cover"]
        assert [anchor["plot_id"] for anchor in profile["anchors"]] == ["west", "east"]
        for anchor in profile["anchors"]:
            col = int((anchor["longitude"] - west) / (east - west) * cover["cols"])
            row = int((north - anchor["latitude"]) / (north - south) * cover["rows"])
            assert cover["classes"][col + row * cover["cols"]] == anchor["cover_class"] == 40
            assert (col < cover["cols"] / 2) == (anchor["plot_id"] == "west")
        for day in profile["days"]:
            samples = day["irradiation_wh_m2"]
            assert len(samples) == 24 and samples[0] == 0 and sum(samples) > 0
            assert day["source"]["provenance"] == "estimated" and len(day["source"]["sha256"]) == 64
            assert "power.larc.nasa.gov/api/temporal/hourly/point" in day["source"]["url"]
            series.append(tuple(samples))
    assert len(set(series)) == 6
    assert client.get("/api/sites/jendouba-pilote/planning").status_code == 404


def test_source_and_station_assumptions_drive_physical_replay(client):
    url = "/api/sites/korba-cap-bon/planning"
    profile = client.get(url).json()
    body = assumptions()
    response = client.post(url, json=body)
    assert response.status_code == 200
    result = response.json()
    assert result["provenance"] == "simulated"
    assert result["comparison_id"] == client.post(url, json=body).json()["comparison_id"]
    assert result["source"] == profile["days"][1]["source"]
    assert result["solar_wh"] == [round(value * 3.2 * 0.8) for value in profile["days"][1]["irradiation_wh_m2"]]
    for plan in (result["comparison"]["baseline"], result["comparison"]["optimized"]):
        assert plan["status"] in ("OPTIMAL", "FEASIBLE")
        stock, quota = body["initial_stock_m3"], body["withdrawal_limit_m3"]
        assert len(plan["actions"]) == 24
        for action in plan["actions"]:
            slot = action["slot"]
            if slot in body["outage_hours"]:
                assert action["pump_m3"] == action["grid_wh"] == 0
            if slot < 15 or slot > 18:
                assert not action["deliveries"]
            assert action["grid_wh"] == max(0, action["pump_m3"] * 500 - result["solar_wh"][slot])
            stock += action["pump_m3"]
            assert stock <= body["tank_capacity_m3"]
            stock -= sum(d["delivered_m3"] for d in action["deliveries"])
            quota -= action["pump_m3"]
            assert action["quota_remaining_m3"] == quota >= 0
            assert action["tank_stock_m3"] == stock >= 0
    assert (result["comparison"]["optimized"]["metrics"]["delivered_on_time_m3"]
            > result["comparison"]["baseline"]["metrics"]["delivered_on_time_m3"])
    # Day changes affect both the source and the energy fed to the planning engine.
    winter = client.post(url, json=assumptions(date="2025-01-15")).json()
    assert winter["source"] == profile["days"][0]["source"]
    assert sum(winter["solar_wh"]) < sum(result["solar_wh"])
    no_power = client.post(url, json=assumptions(pv_capacity_kwp=0, grid_cap_w=0)).json()
    for plan in (no_power["comparison"]["baseline"], no_power["comparison"]["optimized"]):
        assert plan["metrics"]["withdrawn_m3"] == 0 and plan["metrics"]["delivered_m3"] == 1


def test_missing_assumptions_and_invalid_sites_are_not_substituted(client):
    url = "/api/sites/korba-cap-bon/planning"
    assert client.post("/api/sites/unknown/planning", json=assumptions()).status_code == 404
    assert client.post(url, json={}).status_code == 422
    for body in (assumptions(date="2025-07-14"), assumptions(initial_stock_m3=21),
                 assumptions(delivery_end_hour=14), assumptions(outage_hours=[11, 11]),
                 assumptions(pv_performance_ratio=1.5), assumptions(withdrawal_limit_m3=-1)):
        assert client.post(url, json=body).status_code == 422


def test_catalog_keeps_other_zones_if_a_refreshed_window_lacks_cropland_anchors():
    zones = {z.site.properties.site_id: z for z in read_field_zones(DATA_DIR)}
    zone = zones["korba-cap-bon"]
    cover = zone.land_cover
    # A raster with no classified cropland in its eastern half cannot locate both simulated sectors.
    classes = tuple(None if index % cover.cols >= cover.cols // 2 else value
                    for index, value in enumerate(cover.classes))
    zones["korba-cap-bon"] = zone.model_copy(update={"land_cover": cover.model_copy(update={"classes": classes})})
    assert read_planning_profiles(DATA_DIR, zones).keys() == {"gafsa-oasis", "kairouan-chebika"}


def test_identical_operator_inputs_respond_to_geography_and_season(client):
    body = assumptions(grid_cap_w=0, initial_stock_m3=0, withdrawal_limit_m3=80, demand_west_m3=30,
                       demand_east_m3=30, delivery_start_hour=8, delivery_end_hour=19, outage_hours=[])
    january = []
    for site in ZONES:
        deliveries = []
        for day in ("2025-01-15", "2025-07-15"):
            result = client.post(f"/api/sites/{site}/planning", json={**body, "date": day}).json()
            metrics = result["comparison"]["optimized"]["metrics"]
            assert metrics["grid_wh"] == 0
            deliveries.append(metrics["delivered_on_time_m3"])
        assert deliveries[0] < deliveries[1]
        january.append(deliveries[0])
    assert len(set(january)) == 3


@pytest.mark.parametrize("site", ZONES)
@pytest.mark.parametrize(("changes", "delivered", "withdrawn"), [
    pytest.param({"initial_stock_m3": 0, "withdrawal_limit_m3": 0}, 0, 0, id="no-water"),
    pytest.param({"gravity_flow_m3_h": 0}, 0, 0, id="no-distribution"),
    pytest.param({"grid_cap_w": 0, "pv_capacity_kwp": 0}, 1, 0, id="no-power"),
    pytest.param({"outage_hours": list(range(24))}, 1, 0, id="full-outage"),
    pytest.param({"tank_capacity_m3": 5, "initial_stock_m3": 5, "delivery_start_hour": 15,
                  "delivery_end_hour": 15, "outage_hours": []}, 4, 0, id="full-tank-before-delivery"),
])
def test_physical_limits_at_every_zone(client, site, changes, delivered, withdrawn):
    body = assumptions(**changes)
    response = client.post(f"/api/sites/{site}/planning", json=body)
    assert response.status_code == 200
    comparison = response.json()["comparison"]
    for plan in (comparison["baseline"], comparison["optimized"]):
        assert plan["metrics"]["delivered_on_time_m3"] == delivered
        assert plan["metrics"]["withdrawn_m3"] == withdrawn
        stock = body["initial_stock_m3"]
        for action in plan["actions"]:
            # The tank is filled first and deliveries occur afterward in the canonical physical replay.
            assert stock + action["pump_m3"] <= body["tank_capacity_m3"]
            stock = action["tank_stock_m3"]


@pytest.mark.parametrize("site", ZONES)
def test_largest_allowed_operator_inputs_fit_the_canonical_integer_model(client, site):
    body = assumptions(tank_capacity_m3=100_000, initial_stock_m3=100_000, withdrawal_limit_m3=100_000,
                       pump_flow_m3_h=100_000, pump_wh_per_m3=100_000, gravity_flow_m3_h=100_000,
                       grid_cap_w=1_000_000_000, pv_capacity_kwp=10_000, pv_performance_ratio=1,
                       demand_west_m3=100_000, demand_east_m3=100_000, delivery_start_hour=0,
                       delivery_end_hour=23, outage_hours=[])
    response = client.post(f"/api/sites/{site}/planning", json=body)
    assert response.status_code == 200
    for name, plan in response.json()["comparison"].items():
        if name not in ("baseline", "optimized"):
            continue
        assert plan["status"] in ("FEASIBLE", "OPTIMAL")
        stock = body["initial_stock_m3"]
        for step in plan["actions"]:
            assert stock + step["pump_m3"] <= body["tank_capacity_m3"]
            stock = step["tank_stock_m3"]
            assert 0 <= step["grid_wh"] <= body["grid_cap_w"]
            assert 0 <= step["quota_remaining_m3"] <= body["withdrawal_limit_m3"]
        assert plan["metrics"]["delivered_m3"] <= body["demand_west_m3"] + body["demand_east_m3"]


def test_hourly_import_matches_civil_day_and_rejects_missing_data_or_wrong_units():
    times = {f"202507{day}{hour:02d}": day * 24 + hour for day in (14, 15) for hour in range(24)}
    payload = {"header": {"time_standard": "UTC", "sources": ["SYN1DEG"], "fill_value": -999.0},
               "parameters": {"ALLSKY_SFC_SW_DWN": {"units": "Wh/m^2"}},
               "geometry": {"coordinates": [10.85861, 36.57861, 0]},
               "properties": {"parameter": {"ALLSKY_SFC_SW_DWN": times}}}
    def respond(request):
        assert request.url.params["start"] == "20250714" and request.url.params["end"] == "20250715"
        assert request.url.params["time-standard"] == "UTC"
        return httpx.Response(200, json=payload)

    with httpx.Client(transport=httpx.MockTransport(respond)) as connection:
        args = connection, 10.85861, 36.57861, date(2025, 7, 15)
        data = fetch_day(*args)
        assert data.weather is None
        assert data.irradiation_wh_m2 == tuple(range(times["2025071423"], times["2025071522"] + 1))
        assert data.source.sha256 == sha256(httpx.Response(200, json=payload).content).hexdigest()
        times["2025071507"] = -999.0
        with pytest.raises(ValueError, match="Incomplete"):
            fetch_day(*args)
        payload["parameters"]["ALLSKY_SFC_SW_DWN"]["units"] = "kW-hr/m^2/day"
        with pytest.raises(ValueError, match="Wh/m²"):
            fetch_day(*args)


def test_fao56_daily_reference_et_matches_published_uccle_example_18():
    # FAO I&D Paper 56, ch. 4, example 18. Use the publication's standardized wind, pressure,
    # actual vapour pressure and incident shortwave (22.07 MJ/m² = 22.07 / 0.0036 Wh/m²).
    et0 = reference_et(day=date(1999, 7, 6), latitude=50.8, elevation_m=100, temperature_min_c=12.3,
                       temperature_max_c=21.5, actual_vapour_kpa=1.409, wind_2m_m_s=2.078,
                       pressure_kpa=100.1, irradiation_wh_m2=22.07 / 0.0036)
    assert et0 == pytest.approx(3.88, abs=0.01)


def test_incomplete_weather_preserves_solar_and_does_not_turn_missing_rain_into_zero():
    times = [f"202507{day}{hour:02d}" for day in (14, 15) for hour in range(24)]
    fields = {"ALLSKY_SFC_SW_DWN": ("Wh/m^2", 200), "T2M": ("C", 25), "T2MDEW": ("C", 10),
              "WS2M": ("m/s", 2), "PS": ("kPa", 101), "PRECTOTCORR": ("mm/hour", 1)}
    raw = {key: dict.fromkeys(times, value) for key, (_, value) in fields.items()}
    payload = {"header": {"time_standard": "UTC", "sources": ["MERRA2", "SYN1DEG"], "fill_value": -999.0},
               "parameters": {key: {"units": units} for key, (units, _) in fields.items()},
               "geometry": {"coordinates": [10.85861, 36.57861, 60]}, "properties": {"parameter": raw}}
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))) as connection:
        args = connection, 10.85861, 36.57861, date(2025, 7, 15)
        assert fetch_day(*args).weather.precipitation_mm == 24
        raw["PRECTOTCORR"]["2025071423"] = -999
        day = fetch_day(*args)
        assert day.weather is None and day.irradiation_wh_m2 == (200,) * 24
        raw["PRECTOTCORR"]["2025071423"] = 2
        payload["parameters"]["PS"]["units"] = "Pa"
        with pytest.raises(ValueError, match="meteorological unit"):
            fetch_day(*args)


@pytest.mark.parametrize("site", ZONES)
def test_weather_driven_demands_match_archive_and_planner(client, site):
    url = f"/api/sites/{site}"
    profile = client.get(f"{url}/planning").json()
    for day in profile["days"]:
        weather = day["weather"]
        assert weather["source"]["provenance"] == "estimated"
        assert "NASA POWER" in weather["source"]["name"] and "MIZUHO derives" in weather["source"]["coverage"]
        assert weather["temperature_min_c"] <= weather["temperature_mean_c"] <= weather["temperature_max_c"]
        assert weather["et0_mm"] == pytest.approx(reference_et(date.fromisoformat(day["date"]), profile["latitude"],
            weather["grid_elevation_m"], weather["temperature_min_c"], weather["temperature_max_c"],
            weather["actual_vapour_pressure_kpa"], weather["wind_2m_m_s"], weather["surface_pressure_kpa"],
            sum(day["irradiation_wh_m2"])), abs=0.0005)
        basis = dict(date=day["date"], area_m2=1_000, crop_coefficient=1.1, effective_rain_fraction=0.5,
                     application_efficiency=0.8)
        response = client.post(f"{url}/demand-estimate", json=basis)
        assert response.status_code == 200
        value = response.json()
        assert value["source"] == weather["source"]
        assert value["gross_demand_m3"] == pytest.approx(max(0, weather["et0_mm"] * 1.1 - weather["precipitation_mm"] * 0.5) / 0.8)
        assert value["demand_m3"] == ceil(value["gross_demand_m3"])
        body = assumptions(date=day["date"], demand_west_m3=value["demand_m3"], demand_basis={"west": basis})
        run = client.post(f"{url}/planning", json=body)
        assert run.status_code == 200
        west, east = run.json()["comparison"]["optimized"]["plot_results"]
        assert west["demand_m3"] == value["demand_m3"] and east["demand_m3"] == body["demand_east_m3"]
        body["demand_west_m3"] += 1
        assert client.post(f"{url}/planning", json=body).status_code == 422
        body["demand_basis"]["west"]["date"] = "2025-01-14"
        assert client.post(f"{url}/planning", json=body).json()["detail"][0]["loc"][-1] == "date"


def test_demand_estimator_respects_missing_inputs_and_decimal_rounding(client):
    profile = read_planning_profiles(DATA_DIR, {z.site.properties.site_id: z for z in read_field_zones(DATA_DIR)})["korba-cap-bon"]
    day = profile.days[0]
    basis = DemandEstimateRequest(date=day.date, area_m2=1000, crop_coefficient=0.1,
                                  effective_rain_fraction=0, application_efficiency=0.01)
    day = day.model_copy(update={"weather": day.weather.model_copy(update={"et0_mm": 0.7})})
    estimate = estimate_demand(profile.model_copy(update={"days": (day,)}), basis)
    assert estimate.demand_m3 == estimate.gross_demand_m3 == 7
    url = "/api/sites/korba-cap-bon/demand-estimate"
    rain_covers_request = client.post(url, json={**basis.model_dump(mode="json"), "effective_rain_fraction": 1})
    assert rain_covers_request.json()["demand_m3"] == 0
    for override in ({"date": "2025-02-01"}, {"application_efficiency": 0}, {"application_efficiency": 1e-300},
                     {"effective_rain_fraction": 1.2}, {"crop_coefficient": -1}):
        assert client.post(url, json={**basis.model_dump(mode="json"), **override}).status_code == 422
    with pytest.raises(ValueError, match="No complete regional weather"):
        estimate_demand(profile.model_copy(update={"days": (day.model_copy(update={"weather": None}),)}), basis)

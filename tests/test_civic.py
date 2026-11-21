import pytest
from fastapi.testclient import TestClient

from backend.main import create_app


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as connection:
        yield connection


EXAMPLE = dict(start_hour=18, duration_hours=4, households=10, essential_w_per_home=40,
               lighting_w_per_home=20, lights_from_hour=18, lights_until_hour=6,
               available_ac_wh=1200, island_output_w=750)


def run(client, **changes):
    response = client.post("/api/resilience/households", json=EXAMPLE | changes)
    assert response.status_code == 200, response.text
    return response.json()


def test_same_outage_evening_vs_day_and_independent_power_limit(client):
    evening = run(client)
    assert (evening["demand_wh"], evening["supplied_wh"], evening["first_shortfall_after_minutes"]) == (2400, 1200, 120)
    assert evening["minimum_island_output_w"] == 600 and evening["provenance"] == "simulated"
    day = run(client, start_hour=9)
    assert (day["demand_wh"], day["first_shortfall_after_minutes"]) == (1600, 180)
    constrained = run(client, island_output_w=300, available_ac_wh=2400)
    assert constrained["unserved_wh"] == 1200 and constrained["hours"][-1]["remaining_ac_wh"] == 1200
    assert constrained["first_shortfall_after_minutes"] == 0
    grid_only = run(client, island_output_w=0)
    assert grid_only["supplied_wh"] == 0 and grid_only["unserved_wh"] == grid_only["demand_wh"]


def test_partial_hour_and_midnight_conservation(client):
    case = run(client, start_hour=23, available_ac_wh=950)
    assert [(r["day_offset"], r["hour"]) for r in case["hours"]] == [(0, 23), (1, 0), (1, 1), (1, 2)]
    assert case["first_shortfall_after_minutes"] == 95
    remaining = 950
    for row in case["hours"]:
        remaining -= row["supplied_wh"]
        assert remaining == row["remaining_ac_wh"] >= 0
        assert row["demand_wh"] == row["supplied_wh"] + row["unserved_wh"]


def test_exact_capacity_no_load_and_full_day(client):
    assert run(client, available_ac_wh=2400)["first_shortfall_after_minutes"] is None
    daylight = run(client, start_hour=10, essential_w_per_home=0, available_ac_wh=0, island_output_w=0)
    assert daylight["demand_wh"] == 0 and daylight["first_shortfall_after_minutes"] is None
    day = run(client, duration_hours=24, available_ac_wh=20000)
    assert day["demand_wh"] == 12 * 400 + 12 * 600 and day["unserved_wh"] == 0


@pytest.mark.parametrize("invalid", [{"essential_w_per_home": 0, "lighting_w_per_home": 0},
                                     {"duration_hours": 25}, {"start_hour": 24}, {"lights_until_hour": 18},
                                     {"households": -1}, {"available_ac_wh": 0.5}, {"island_output_w": -1}])
def test_reject_invalid_inputs(client, invalid):
    assert client.post("/api/resilience/households", json=EXAMPLE | invalid).status_code == 422

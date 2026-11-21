from datetime import date
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from backend.tunisia import ARCHIVE_DIR, CATALOG_FILE, Relief, get_city_analysis, get_catalog, router
from tools.tunisia.refresh import POWER_PARAMETERS, parse_power_days


def test_archive_contains_sourced_governorate_profiles():
    catalog = get_catalog()
    assert len(catalog.boundary.features) == len(catalog.cities) == 24
    assert {source.provenance for source in catalog.sources} == {"mapped"}
    assert all(source.sha256 for source in catalog.sources)

    relief_patterns = set()
    climate_patterns = set()
    for city in catalog.cities:
        result = get_city_analysis(city.id)
        assert result.city == city
        relief, climate = result.relief, result.climate
        assert relief and climate
        west, south, east, north = relief.bounds
        assert west < city.longitude < east and south < city.latitude < north
        assert relief.source.provenance == climate.source.provenance == "estimated"
        assert relief.source.sha256 and climate.source.sha256
        assert climate.days == (climate.end - climate.start).days + 1
        relief_patterns.add(relief.elevations)
        climate_patterns.add((climate.temperature_mean_c, climate.precipitation_mm, climate.irradiation_mean_kwh_m2_day))
    assert len(relief_patterns) == 24
    assert len(climate_patterns) > 1


def test_routes_keep_unknown_and_unavailable_profiles_explicit(tmp_path):
    app = FastAPI()
    app.include_router(router)
    app.state.tunisia_data_dir = tmp_path
    with TestClient(app) as client:
        assert client.get("/api/tunisia").status_code == 503
        archive = json.loads((ARCHIVE_DIR / CATALOG_FILE).read_bytes())
        identifier = archive["cities"][0]["id"]
        archive["profiles"][identifier]["relief"] = None
        (tmp_path / CATALOG_FILE).write_text(json.dumps(archive), encoding="utf-8")

        catalog = client.get("/api/tunisia")
        assert catalog.status_code == 200
        assert "profiles" not in catalog.json()
        result = client.get(f"/api/tunisia/cities/{identifier}")
        assert result.status_code == 200
        assert result.json()["relief"] is None
        climate = result.json()["climate"]
        start = climate["start"]
        range_result = client.get(f"/api/tunisia/cities/{identifier}", params={"start": start, "end": start})
        assert range_result.status_code == 200
        summary = range_result.json()["climate"]
        first = archive["profiles"][identifier]["climate_series"]["daily"][0]
        assert summary["days"] == 1 and summary["start"] == summary["end"] == start
        assert summary["temperature_mean_c"] == round(first[0], 2)
        assert summary["precipitation_mm"] == round(first[1], 2)
        assert summary["irradiation_mean_kwh_m2_day"] == round(first[2], 3)
        assert client.get(f"/api/tunisia/cities/{identifier}", params={"start": start}).status_code == 422
        assert client.get(f"/api/tunisia/cities/{identifier}", params={
            "start": "2000-01-01", "end": "2000-02-01",
        }).status_code == 422
        assert client.get("/api/tunisia/cities/999999999999").status_code == 404


def test_invalid_grid_cannot_be_mistaken_for_city_terrain():
    relief = get_city_analysis("2470088").relief
    assert relief is not None
    with pytest.raises(ValidationError):
        Relief.model_validate({**relief.model_dump(), "elevations": relief.elevations[1:]})


def test_power_summary_excludes_fill_values_and_preserves_zero_rain():
    payload = {
        "header": {"time_standard": "UTC", "fill_value": -999.0},
        "parameters": {code: {"units": unit} for code, unit in POWER_PARAMETERS.items()},
        "properties": {"parameter": {
            "T2M": {"20250101": 10, "20250102": 18, "20250103": 14},
            "PRECTOTCORR": {"20250101": 0, "20250102": -999, "20250103": 2},
            "ALLSKY_SFC_SW_DWN": {"20250101": 4, "20250102": 8, "20250103": 5},
        }},
    }
    assert parse_power_days(payload, date(2025, 1, 1), date(2025, 1, 3)) == ((10, 0, 4), None, (14, 2, 5))
    payload["parameters"]["ALLSKY_SFC_SW_DWN"]["units"] = "W/m^2"
    with pytest.raises(ValueError, match="unit"):
        parse_power_days(payload, date(2025, 1, 1), date(2025, 1, 3))

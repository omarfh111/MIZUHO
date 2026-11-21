import json

import pytest

from backend import resilience


def _power(tmp_path, years):
    """NASA POWER shaped file: summer Tmax rising by 0.1 °C per year, constant elsewhere."""
    t = {}
    for y in years:
        for m in range(1, 13):
            for d in (1, 15):
                t[f"{y}{m:02d}{d:02d}"] = 30 + 0.1 * (y - years[0]) if m in resilience.SUMMER else 15.0
    p = tmp_path / "power.json"
    p.write_text(json.dumps({"header": {"fill_value": -999}, "properties": {"parameter": {"T2M_MAX": t}}}))
    return p


def test_heat_trend_finds_a_rising_summer(tmp_path):
    h = resilience.heat_trend(_power(tmp_path, list(range(1981, 2026))))
    tr = h["trend"]["summer_tmax_c"]
    assert tr["significant"] and tr["verdict"] == "hausse" and tr["slope_per_decade"] == pytest.approx(1.0)
    assert h["decades"]["summer_tmax_c"]["change"] == pytest.approx(3.5)
    assert all(y["days"] == 8 for y in h["years"])           # 4 summer months x 2 days, winter ignored


def test_fill_values_are_ignored(tmp_path):
    p = _power(tmp_path, list(range(1981, 2026)))
    d = json.loads(p.read_text())
    d["properties"]["parameter"]["T2M_MAX"]["19810701"] = -999
    p.write_text(json.dumps(d))
    assert resilience.heat_trend(p)["years"][0]["days"] == 7


def test_season_review_gap_and_incomplete_summer():
    def dek(y, m, k, aeti, ret):
        return {"dekad": f"{y}-{m:02d}-D{k}", "month": m, "tmax_c": 30.0 + y - 2018, "precip_mm_day": 0,
                "aeti_mm_day": aeti, "ret_mm_day": ret}
    series = [dek(y, m, k, 1.0 + 0.1 * (y - 2018), 6.0) for y in (2018, 2019, 2020) for m in resilience.SUMMER for k in (1, 2, 3)]
    series += [dek(2021, 6, 1, 1.0, 6.0)]                      # only one dekad: not a full summer
    temp = {"plots": [{"plot_id": "P-X", "surface_m2": 1000, "series": series}]}
    s = resilience.season_review(temp)["P-X"]
    assert [x["year"] for x in s["seasons"]] == [2018, 2019, 2020]
    assert s["seasons"][0]["gap_mm_day"] == 5.0 and s["seasons"][0]["gap_m3_day"] == 5.0
    assert s["worst"]["year"] == 2018 and s["best"]["year"] == 2020
    assert s["gap_vs_heat"]["slope_per_c"] == pytest.approx(-0.1)


def test_solar_conversions():
    assert resilience.pumped_m3_per_day(10, 0.5, 5.0) == 100
    assert resilience.kwp_needed(100, 0.5, 5.0) == 10
    with pytest.raises(ValueError):
        resilience.pumped_m3_per_day(10, 0, 5.0)       # pumping energy must be entered


def test_built_file_uses_downloaded_sources():
    d = resilience.load()
    assert d["heat"]["period"] == "1981-2025" and len(d["heat"]["years"]) == 45
    assert len(d["solar"]["months"]) == 12 and d["solar"]["system"]["radiation_db"].startswith("PVGIS")
    assert set(d["seasons"]) == {"P-01", "P-02", "P-03", "P-04", "P-05"}
    man = {x["source_id"] for x in json.loads((resilience.ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))["datasets"]}
    assert {"nasa-power-daily-1981-2025", "jrc-pvgis-5.3"} <= man


def test_priorities_follow_the_funnel(monkeypatch, tmp_path):
    from backend.causal import funnel
    monkeypatch.setattr(funnel, "FEEDBACK_FILE", tmp_path / "fb.json")
    funnel._cache.clear()
    p = resilience.priorities("P-03", use_agents=False)
    assert p["priorites"][0]["statut"] == "retenue"
    assert {c["statut"] for c in p["priorites"]} <= {"retenue", "terrain"} and p["appris"] == []
    funnel.add_feedback("P-03", "summer_gap", "quota", "confirm", "quota réduit")
    funnel._cache.clear()
    p = resilience.priorities("P-03", use_agents=False)
    assert p["appris"][0]["avis"] == "confirm" and any(c["cause_id"] == "quota" and c["statut"] == "retenue" for c in p["priorites"])

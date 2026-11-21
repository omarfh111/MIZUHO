import numpy as np
import pytest

from backend.temperature_effect import (
    ALPHA, effect_controlling, load_temperature_effect, simple_effect,
)

rng = np.random.default_rng(0)


# --- statistics -------------------------------------------------------------

def test_clear_positive_link_is_detected():
    t = np.linspace(15, 40, 60)
    r = simple_effect(t, 0.2 * t + rng.normal(0, 0.3, 60))
    assert r["verdict"] == "increase" and abs(r["slope"] - 0.2) < 0.03


def test_no_link_is_not_reported():
    r = simple_effect(rng.normal(30, 5, 60), rng.normal(2, 1, 60))
    assert r["verdict"] == "no_significant_effect"


def test_negative_link_is_a_decrease():
    t = np.linspace(15, 40, 60)
    assert simple_effect(t, 8 - 0.15 * t + rng.normal(0, 0.2, 60))["verdict"] == "decrease"


def test_effect_disappears_when_rain_explains_it():
    rain = rng.uniform(0, 5, 80)
    t = 35 - 3 * rain + rng.normal(0, 1, 80)  # hot dekads are dry dekads
    water = 1 + 0.8 * rain + rng.normal(0, 0.2, 80)  # water use follows rain only
    assert simple_effect(t, water)["verdict"] == "decrease"
    assert effect_controlling(t, water, rain)["verdict"] == "no_significant_effect"


def test_missing_values_are_ignored_and_small_samples_refused():
    assert simple_effect([1, 2, np.nan], [1, 2, 3])["verdict"] == "insufficient_data"


# --- shipped result -------------------------------------------------------------

@pytest.fixture(scope="module")
def result():
    try:
        return load_temperature_effect()
    except FileNotFoundError:
        pytest.skip("temperature_effect.json not built")


def test_every_plot_has_three_analyses(result):
    assert len(result["plots"]) == 5
    for p in result["plots"]:
        assert set(p["effect"]) == {"all_year", "all_year_equal_rain", "dry_season"}


def test_verdicts_follow_p_values(result):
    for p in result["plots"]:
        for e in p["effect"].values():
            if e["p"] is None:
                continue
            significant = e["p"] < ALPHA
            assert (e["verdict"] != "no_significant_effect") == significant
            if significant:
                assert e["verdict"] == ("increase" if e["slope"] > 0 else "decrease")


def test_m3_slope_matches_surface(result):
    for p in result["plots"]:
        e = p["effect"]["dry_season"]
        if e["slope"] is not None:
            assert abs(e["slope_m3_day_per_c"] - e["slope"] * p["surface_m2"] / 1000) < 0.01


def test_series_come_from_sources(result):
    assert set(result["source_ids"]) <= {"wapor3-l2-aeti-series", "wapor3-l1-ret-series", "nasa-power-daily"}
    s = result["plots"][0]["series"]
    assert len(s) == result["n_dekads"] and all(set(x) >= {"dekad", "tmax_c", "aeti_mm_day"} for x in s)

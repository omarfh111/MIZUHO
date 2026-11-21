import json

import pytest

from mizu_m2m3.inputs import DATA
from mizu_m2m3.weather import load_weather_pair, seeded_weather_pair


def test_shared_weather_values():
    pair = load_weather_pair("jplus1-demo")
    assert pair["risk_start_slot"] == 11
    assert pair["central"]["slots"][10]["solar_wh"] == pair["adverse"]["slots"][10]["solar_wh"] == 1000
    assert pair["central"]["slots"][13]["solar_wh"] == 3500
    assert pair["adverse"]["slots"][13]["solar_wh"] == 2500
    stable = load_weather_pair("jplus1-stable")
    assert stable["adverse"]["slots"][13]["solar_wh"] == 3500


def test_seeded_weather_varies_but_preserves_the_common_hours():
    pair = seeded_weather_pair(21)
    assert pair == seeded_weather_pair(21)
    assert pair["central"]["slots"] != seeded_weather_pair(22)["central"]["slots"]
    risk = pair["risk_start_slot"]
    assert pair["central"]["slots"][:risk] == pair["adverse"]["slots"][:risk]


def test_reject_inconsistent_weather_profile(tmp_path):
    pairs = json.loads((DATA / "weather/jplus1_demo.json").read_text())
    pairs["jplus1-demo"]["adverse"]["slots"][10]["solar_wh"] = 0
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(pairs))
    with pytest.raises(ValueError, match=r"adverse\.slots\[10\]\.solar_wh"):
        load_weather_pair("jplus1-demo", path)

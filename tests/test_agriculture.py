import copy
import json
import shutil
from pathlib import Path

import pytest

from backend.agriculture import (
    DATA_DIR, PlotDataError, coverage_bp, load_all, load_plots, mm_to_m3, round_m3,
)


# --- cahier acceptance cases -------------------------------------------------

def test_4mm_on_500m2_gives_2m3():
    assert mm_to_m3(4, 500) == 2
    assert round_m3(mm_to_m3(4, 500)) == 2


def test_coverage_10_min_5_delivered_is_50_percent():
    assert coverage_bp(10, 5) == 5_000


def test_coverage_capped_and_zero_minimum():
    assert coverage_bp(10, 15) == 10_000
    assert coverage_bp(0, 5) is None


def test_rounding_half_up():
    assert round_m3(2.5) == 3
    assert round_m3(2.4999) == 2


def test_mini_case_matches_cahier():
    a, b = sorted(load_plots("mini"), key=lambda p: p.plot_id)
    for p in (a, b):
        assert (p.demand_m3, p.minimum_m3, p.deadline_slot, p.allowed_slots) == (10, 10, 2, (1, 2))
        assert p.solver_ready


# --- shipped data ----------------------------------------------------------

def test_shipped_data_is_valid_and_sourced():
    by_site = load_all()
    manifest = json.loads((DATA_DIR / "manifest.json").read_text(encoding="utf-8"))
    sources = {d["source_id"] for d in manifest["datasets"]}
    real = [p for site, ps in by_site.items() if site != "mini" for p in ps]
    assert len(real) == 5
    for p in real:
        assert p.source_id in sources
        assert p.surface_m2 and p.surface_m2 > 0


def test_demand_follows_documented_formula():
    for f in json.loads((DATA_DIR / "plots.geojson").read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        raw = mm_to_m3(p["irrigation_need_mm_day"], p["surface_m2"])
        assert abs(raw - p["demand_m3_raw"]) < 0.01
        assert p["demand_m3"] == round_m3(p["demand_m3_raw"])


def test_fields_without_source_stay_null():
    for f in json.loads((DATA_DIR / "plots.geojson").read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        for k, status in p["status"].items():
            if status == "local_data_required":
                assert p[k] is None, k


def test_every_layer_opens_locally():
    for path in [DATA_DIR / "plots.geojson", DATA_DIR / "sites.geojson",
                 *(DATA_DIR / "layers").glob("*.geojson")]:
        gj = json.loads(path.read_text(encoding="utf-8"))
        assert gj["type"] == "FeatureCollection" and gj["features"], path.name


# --- rejection cases -------------------------------------------------------

@pytest.fixture
def data_copy(tmp_path: Path) -> Path:
    shutil.copytree(DATA_DIR, tmp_path / "data", ignore=shutil.ignore_patterns("raw"))
    return tmp_path / "data"


def _edit_mini(data_dir: Path, fn) -> None:
    path = data_dir / "agriculture" / "mini_plots.json"
    d = json.loads(path.read_text(encoding="utf-8"))
    fn(d["plots"])
    path.write_text(json.dumps(d), encoding="utf-8")


def _expect(data_dir: Path, field: str):
    with pytest.raises(PlotDataError) as e:
        load_all(data_dir)
    assert e.value.field == field


def test_duplicate_id_rejected(data_copy):
    _edit_mini(data_copy, lambda ps: ps.append(copy.deepcopy(ps[0])))
    _expect(data_copy, "plot_id")


def test_plot_without_site_rejected(data_copy):
    _edit_mini(data_copy, lambda ps: ps[0].update(site_id="nowhere"))
    _expect(data_copy, "site_id")


def test_minimum_above_demand_rejected(data_copy):
    _edit_mini(data_copy, lambda ps: ps[0].update(minimum_m3=11))
    _expect(data_copy, "minimum_m3")


def test_deadline_outside_allowed_slots_rejected(data_copy):
    _edit_mini(data_copy, lambda ps: ps[0].update(deadline_slot=0))
    _expect(data_copy, "deadline_slot")


def test_slot_out_of_range_rejected(data_copy):
    _edit_mini(data_copy, lambda ps: ps[0].update(allowed_slots=[1, 24]))
    _expect(data_copy, "allowed_slots")


def test_swapped_lat_lon_rejected(data_copy):
    path = data_copy / "plots.geojson"
    gj = json.loads(path.read_text(encoding="utf-8"))
    ring = gj["features"][0]["geometry"]["coordinates"][0]
    gj["features"][0]["geometry"]["coordinates"][0] = [[lat, lon] for lon, lat in ring]
    path.write_text(json.dumps(gj), encoding="utf-8")
    _expect(data_copy, "geometry")


def test_unknown_source_rejected(data_copy):
    _edit_mini(data_copy, lambda ps: ps[0].update(source_id="invented"))
    _expect(data_copy, "source_id")

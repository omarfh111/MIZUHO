import json
from shutil import copytree
from time import monotonic

import pytest
from fastapi.testclient import TestClient

from backend.agriculture import load_plots, mm_to_m3, read_survey
from backend.assistant_tools import Turn, run_tool
from backend.assistant import finalize
from backend.assistant_memory import AssistantMemory, recall
from backend.catalog import DATA_DIR, load_catalog
from backend.main import create_app
from backend.models import AssistantRequest, Plot, Provenance

SITE = "TN-32-BALTABOUAWENE-ASSILA"


def test_mapped_geometry_and_water_use_have_distinct_provenance():
    with TestClient(create_app()) as client:
        survey = client.get(f"/api/sites/{SITE}/agriculture").json()
        parcels = survey["parcels"]
        assert len(parcels) == 5 and len({p["plot_id"] for p in parcels}) == 5
        assert survey["quota_m3"] is None and not survey["optimizer_ready"]
        for p in parcels:
            assert p["site_id"] == SITE and p["source_id"] == "osm-jendouba-farmland"
            assert all(p[k] is None for k in ("farmer_id", "crop", "demand_m3", "minimum_m3", "allowed_slots",
                                               "deadline_slot", "past_deferrals"))
        p = parcels[0]
        assert p["surface_m2"] == 47851 and p["osm_way_id"] == 1408418916
        assert p["eta_mm_day"] == 1.25 and p["et_minus_rain_m3_day"] == pytest.approx(59.814)
        assert p["temperature"]["samples"] == 318
        assert survey["period"] == "2026-07-11/2026-07-20" and survey["resolution"] == "100 m"
        assert client.get(f"/api/layers/{SITE}/plots").json()["status"] == "observed"
        raster = client.get(f"/api/layers/{SITE}/wapor").json()
        assert raster["status"] == "estimated" and raster["unit"] == "mm/day"
        assert len(raster["features"]) == 1584
        for source_id in survey["source_ids"]:
            assert client.get(f"/api/evidence/{source_id}").json()["url"].startswith("https://")
        assert SITE not in {s["site_id"] for s in client.get("/api/scenarios").json()}
        assert client.get("/api/sites/jendouba-pilote/agriculture").status_code == 404


def test_v5_offline_plot_contract_and_units():
    assert mm_to_m3(4, 500) == 2
    assert len(load_plots(SITE)) == len(load_plots("jendouba-pilote")) == 5
    with pytest.raises(KeyError):
        load_plots("unknown")
    with pytest.raises(ValueError, match="minimum_m3"):
        Plot(plot_id="A", farmer_id="A", demand_m3=2, minimum_m3=3, deadline_slot=1, allowed_slots=(1,))


@pytest.mark.parametrize(("field", "bad_value"), [("plot_id", "P-02"), ("site_id", "")])
def test_corrupt_survey_is_rejected(tmp_path, field, bad_value):
    copytree(DATA_DIR / "agriculture" / "assila", tmp_path, dirs_exist_ok=True)
    path = tmp_path / "plots.geojson"
    data = json.loads(path.read_bytes())
    data["features"][0]["properties"][field] = bad_value
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        read_survey(tmp_path)


def test_survey_tool_keeps_water_use_out_of_planning_and_tracks_missing_data():
    catalog = load_catalog()
    turn = Turn(AssistantRequest(site_id=SITE, question="What does the satellite estimate for P-01?"),
                catalog, None, None, monotonic() + 10, 1)
    result = run_tool(turn, "get_agricultural_insights", '{"plot_id":"P-01"}')
    assert not result["optimizer_ready"] and turn.explanations["agriculture"].fact_ids
    assert {fact.provenance for fact in turn.facts.values()} == {Provenance.OBSERVED, Provenance.ESTIMATED}
    assert "No validated withdrawal quota" in result["interpretation"]
    assert all("P-02" not in fact.text for fact in turn.facts.values())
    assert run_tool(turn, "get_agricultural_insights", '{"plot_id":"unknown"}')["missing_information"]
    assert "error" in run_tool(turn, "get_simulation_results", '{"scenario_id":"mini","quota_m3":null}')
    memory = AssistantMemory()
    memory.remember("survey-test", memory.load("survey-test", turn.request), turn, finalize(turn, {}))
    followup = Turn(turn.request.model_copy(update={"question": "What was its area?"}), catalog, None, None,
                    monotonic() + 10, 1)
    recall(followup, memory.load("survey-test", followup.request))
    assert any("47851 m²" in f.text and f.provenance == Provenance.ESTIMATED for f in followup.facts.values())
    pilot = followup.request.model_copy(update={"site_id": "jendouba-pilote"})
    assert memory.load("survey-test", pilot)["answers"] == []

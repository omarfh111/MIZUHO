import pytest

from backend.causal import evidence, funnel
from backend.causal.catalog import CAUSE_IDS


@pytest.fixture(autouse=True)
def isolated_feedback(tmp_path, monkeypatch):
    monkeypatch.setattr(funnel, "FEEDBACK_FILE", tmp_path / "fb.json")
    funnel._cache.clear()


def _facts(**over):
    f = {"ete_aeti_mm_jour": 1.5, "ete_et0_mm_jour": 6.0, "ete_rapport_aeti_et0": 0.25, "printemps_aeti_mm_jour": 2.0,
         "rapport_printemps_ete": 1.3, "ete_effet_temperature": {"verdict": "no_significant_effect", "p": 0.7},
         "demande_climatique_effet_temperature": {"verdict": "increase"},
         "pluie_effet_sur_aeti": {"verdict": "decrease", "p": 0.001, "r": -0.2}, "ete_pluie_mm_jour": 0.3,
         "juillet_d2_2026_aeti": 3.0, "juillet_d2_mediane_2018_2025": 1.0, "pixels_wapor": 10}
    f.update(over)
    return f


def test_data_agent_rules():
    assert evidence.assess("water_supply", _facts())["stance"] == "supports"
    assert evidence.assess("water_supply", _facts(ete_rapport_aeti_et0=0.9))["stance"] == "against"
    assert evidence.assess("heat_stress", _facts(ete_effet_temperature={"verdict": "decrease", "p": 0.01}))["stance"] == "supports"
    assert evidence.assess("fallow", _facts(ete_aeti_mm_jour=0.6, rapport_printemps_ete=3))["strength"] == 2
    assert evidence.assess("power_cuts", _facts())["stance"] == "against"
    assert evidence.assess("satellite", _facts(pixels_wapor=2))["stance"] == "supports"
    for c in ("quota", "leaks", "salinity", "pump"):
        assert evidence.assess(c, _facts())["stance"] == "untestable"


def test_funnel_narrows_without_agents():
    r = funnel.run("P-03", use_agents=False)
    kept = [s["kept"] for s in r["stages"]]
    assert kept[0] == len(CAUSE_IDS) and kept == sorted(kept, reverse=True)
    assert len(r["final"]) <= funnel.KEEP_TOP


def test_untestable_causes_are_never_eliminated_by_data():
    r = funnel.run("P-03", use_agents=False)
    for c in r["causes"]:
        if c["lane"] == "field":
            assert c["stage_out"] is None and c["p"] == pytest.approx(0.5)


def test_human_feedback_changes_the_result():
    funnel.add_feedback("P-03", "summer_gap", "quota", "confirm", "quota CRDA réduit en 2026")
    funnel.add_feedback("P-03", "summer_gap", "water_supply", "reject")
    r = funnel.run("P-03", use_agents=False)
    assert "quota" in r["final"] and "water_supply" not in r["final"]
    assert next(c for c in r["causes"] if c["id"] == "quota")["p"] > 0.9


def test_last_feedback_wins_and_bad_input_is_refused():
    funnel.add_feedback("P-01", "summer_gap", "pump", "confirm")
    funnel.add_feedback("P-01", "summer_gap", "pump", "unsure")
    assert funnel.latest_feedback("P-01", "summer_gap")["pump"]["verdict"] == "unsure"
    with pytest.raises(ValueError):
        funnel.add_feedback("P-01", "summer_gap", "pump", "maybe")
    with pytest.raises(KeyError):
        funnel.add_feedback("P-01", "summer_gap", "aliens", "confirm")


def test_jev_scores_are_combined(monkeypatch):
    def fake_judge(consequence, plot_id, data, candidates, notes):
        return {"model": "fake", "answers": {c["id"]: {"type": "noul", "noul": 0.9 if c["id"] == "fallow" else 0.1}
                                              for c in candidates}, "usage": None, "request_id": None}

    monkeypatch.setattr(funnel, "judge_agent", fake_judge)
    monkeypatch.setattr(funnel, "critic_agent", lambda *a: {"text": "ok", "model": "fake", "check": {"ok": True}})
    r = funnel.run("P-03")
    fallow = next(c for c in r["causes"] if c["id"] == "fallow")
    assert fallow["jev_p"] == 0.9 and fallow["score"]["jev"] > 0 and "fallow" in r["final"]

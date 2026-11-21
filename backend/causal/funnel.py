"""Orchestrator of the cause funnel: N candidate causes narrowed stage by stage.

Stage 1  Data agent     deterministic tests on WaPOR / NASA POWER series
Stage 2  Judge agent    Jev gives each remaining cause a probability from the facts
Stage 3  Critic agent   an LLM reviews the retained causes and names the data that would decide
Stage 4  Human          confirm / reject / unsure + note, stored and reapplied

Scores are log-odds added stage by stage, so every step stays traceable:
  data   +1 per strength point if the data support the cause, -1 if they contradict it
  Jev    logit(p_yes), bounded to [-3, 3]
  human  +4 confirm, -4 reject
A cause with no data to test it is never eliminated for lack of evidence: it goes to the
"field check" lane until a human confirms or rejects it.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
from datetime import datetime, timezone
from pathlib import Path

from backend import llm
from backend.causal import evidence, jev
from backend.causal.catalog import CAUSES, CONSEQUENCES
from backend.temperature_effect import load_temperature_effect
from backend.temperature_explain import check_numbers

ROOT = Path(__file__).resolve().parents[2]
FEEDBACK_FILE = ROOT / "data" / "feedback" / "causes_feedback.json"
KEEP_TOP = 3
KEEP_MIN_P = 0.3
HUMAN_WEIGHT = {"confirm": 4.0, "reject": -4.0, "unsure": 0.0}
_lock = threading.Lock()
_cache: dict[str, dict] = {}


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def logit(p: float) -> float:
    p = min(0.98, max(0.02, p))
    return math.log(p / (1 - p))


# --- human feedback -------------------------------------------------------------

def load_feedback() -> list[dict]:
    if not FEEDBACK_FILE.exists():
        return []
    return json.loads(FEEDBACK_FILE.read_text(encoding="utf-8"))


def add_feedback(plot_id: str, consequence: str, cause_id: str, verdict: str, note: str = "") -> dict:
    if verdict not in HUMAN_WEIGHT:
        raise ValueError("verdict must be confirm, reject or unsure")
    if cause_id not in {c["id"] for c in CAUSES}:
        raise KeyError(cause_id)
    entry = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "plot_id": plot_id,
             "consequence": consequence, "cause_id": cause_id, "verdict": verdict, "note": note.strip()[:500]}
    with _lock:
        fb = load_feedback()
        fb.append(entry)
        FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
        FEEDBACK_FILE.write_text(json.dumps(fb, ensure_ascii=False, indent=1), encoding="utf-8")
    return entry


def latest_feedback(plot_id: str, consequence: str) -> dict[str, dict]:
    out = {}
    for e in load_feedback():
        if e["plot_id"] == plot_id and e["consequence"] == consequence:
            out[e["cause_id"]] = e  # last entry wins
    return out


# --- agents ------------------------------------------------------------------------

def judge_agent(consequence: dict, plot_id: str, data: dict, candidates: list[dict], notes: list[str]) -> dict:
    """Jev: one request, one yes/no question per candidate plus a choice of the main cause."""
    state = {
        "consequence": consequence["label"],
        "parcelle": plot_id,
        "faits": {c["id"]: data["assessments"][c["id"]]["why"] for c in candidates},
        "hypotheses": {c["id"]: f"{c['label']}. {c['mechanism']} Prédiction : {c['prediction']}" for c in candidates},
        "retour_terrain": notes or ["aucun"],
    }
    questions = {c["id"]: {"type": "noul", "instructions":
                 f"D'après `faits` et `retour_terrain`, l'hypothèse `hypotheses.{c['id']}` explique-t-elle `consequence` pour cette parcelle ?"}
                 for c in candidates}
    if len(candidates) >= 2:
        questions["cause_principale"] = {"type": "choice", "instructions":
            "D'après `faits` et `retour_terrain`, quelle hypothèse explique le mieux `consequence` ?",
            "criteria": {c["id"]: c["label"] for c in candidates}}
    return jev.decide(state, questions)


CRITIC_SYSTEM = ("Tu es l'agent Critique d'un système d'aide à la décision pour l'irrigation en Tunisie. "
                 "Tu relis les causes retenues par les autres agents et tu cherches les faiblesses. "
                 "Règles : français simple ; uniquement les faits fournis ; ne calcule aucun nouveau chiffre ; "
                 "n'invente aucune donnée ; une association n'est pas une preuve.")


def critic_agent(consequence: dict, plot_id: str, retained: list[dict], field: list[dict], notes: list[str]) -> dict:
    facts = {
        "consequence": consequence["label"], "parcelle": plot_id,
        "causes_retenues": [{"cause": r["label"], "probabilite": round(r["p"], 2), "preuve": r["data"]["why"],
                             "donnees_manquantes": r["data"]["missing"]} for r in retained],
        "a_verifier_sur_le_terrain": [{"cause": r["label"], "donnees_necessaires": r["data"]["missing"]} for r in field],
        "retour_terrain": notes or [],
    }
    prompt = ("FAITS (JSON) :\n" + json.dumps(facts, ensure_ascii=False, indent=1) +
              "\n\nEn 3 courts paragraphes séparés par une ligne vide, 150 mots au maximum, sans titre ni liste :\n"
              "1. Pour chaque cause retenue, dis en une phrase ce qui la soutient et ce qui pourrait la contredire.\n"
              "2. Dis quelle donnée de « a_verifier_sur_le_terrain » ou de « donnees_manquantes » permettrait le mieux "
              "de trancher, et pourquoi.\n"
              "3. Donne la question précise à poser au responsable du groupement.\n"
              "Mets en gras avec **...** le nom des causes.")
    out = llm.chat([{"role": "system", "content": CRITIC_SYSTEM}, {"role": "user", "content": prompt}])
    return {"text": out["text"], "model": out["model"], "check": check_numbers(out["text"], facts)}


# --- orchestrator ------------------------------------------------------------------

def _plot(result: dict, plot_id: str) -> dict:
    for p in result["plots"]:
        if p["plot_id"] == plot_id:
            return p
    raise KeyError(plot_id)


def run(plot_id: str, consequence_id: str = "summer_gap", use_agents: bool = True) -> dict:
    consequence = CONSEQUENCES[consequence_id]
    result = load_temperature_effect()
    sites = json.loads((ROOT / "data" / "sites.geojson").read_text(encoding="utf-8"))["features"]
    lat = sites[0]["properties"]["centroid_lon_lat"][1]
    data = evidence.run(_plot(result, plot_id), lat, result["climatic_demand"])
    feedback = latest_feedback(plot_id, consequence_id)
    notes = [f"{e['cause_id']}: {e['note']}" for e in feedback.values() if e["note"]]

    rows = []
    for c in CAUSES:
        a = data["assessments"][c["id"]]
        sign = {"supports": 1, "against": -1}.get(a["stance"], 0)
        rows.append({**c, "data": a, "score": {"data": sign * a["strength"], "jev": 0.0, "human": 0.0},
                     "stage_out": None, "lane": "field" if a["stance"] == "untestable" else "tested"})

    stages = [{"id": "catalogue", "agent": "Catalogue", "kept": len(rows), "note": f"{len(rows)} causes candidates"}]

    # Stage 1: data
    for r in rows:
        if r["lane"] == "tested" and r["data"]["stance"] == "against" and r["data"]["strength"] >= 2:
            r["stage_out"] = "data"
    tested = [r for r in rows if r["lane"] == "tested" and not r["stage_out"]]
    field = [r for r in rows if r["lane"] == "field"]
    stages.append({"id": "data", "agent": "Agent Données", "kept": len(tested),
                   "note": f"{len(tested)} testables gardées, {sum(r['stage_out'] == 'data' for r in rows)} éliminées, {len(field)} à vérifier sur le terrain"})

    # Stage 2: Jev judge
    judge = {"status": "skipped"}
    if use_agents and tested:
        key = hashlib.sha256(json.dumps([plot_id, [r["id"] for r in tested], notes,
                                         [data["assessments"][r["id"]]["why"] for r in tested]]).encode()).hexdigest()
        try:
            judge = _cache.get("jev" + key) or {"status": "ok", **judge_agent(consequence, plot_id, data, tested, notes)}
            _cache["jev" + key] = judge
            for r in tested:
                r["jev_p"] = judge["answers"][r["id"]]["noul"]
                r["score"]["jev"] = max(-3.0, min(3.0, logit(r["jev_p"])))
        except jev.JevNotConfigured as e:
            judge = {"status": "not_configured", "error": str(e)}
        except jev.JevError as e:
            judge = {"status": "error", "error": str(e)}

    # Stage 4 inputs (human) apply to every cause, including eliminated and field ones
    for r in rows:
        fb = feedback.get(r["id"])
        if fb:
            r["human"] = fb
            r["score"]["human"] = HUMAN_WEIGHT[fb["verdict"]]
    for r in rows:
        r["p"] = sigmoid(sum(r["score"].values()))

    ranked = sorted(tested, key=lambda r: -r["p"])
    for i, r in enumerate(ranked):
        if (i >= KEEP_TOP or r["p"] < KEEP_MIN_P) and not (r.get("human") and r["human"]["verdict"] == "confirm"):
            r["stage_out"] = "judge"
    retained = [r for r in ranked if not r["stage_out"]]
    stages.append({"id": "judge", "agent": "Agent Juge (Jev)", "kept": len(retained),
                   "note": {"ok": f"probabilités Jev ({judge.get('model')}) ; gardées : top {KEEP_TOP} avec p ≥ {KEEP_MIN_P}",
                            "skipped": "Jev non appelé", "not_configured": "Jev non configuré : classement sur les données seules",
                            "error": "Jev indisponible : classement sur les données seules"}[judge["status"]]})

    # Stage 3: critic
    critic = {"status": "skipped"}
    if use_agents and retained:
        key = hashlib.sha256(json.dumps([plot_id, [(r["id"], round(r["p"], 2)) for r in retained], notes]).encode()).hexdigest()
        try:
            critic = _cache.get("critic" + key) or {"status": "ok", **critic_agent(consequence, plot_id, retained, field, notes)}
            _cache["critic" + key] = critic
        except llm.LLMNotConfigured as e:
            critic = {"status": "not_configured", "error": str(e)}
        except llm.LLMError as e:
            critic = {"status": "error", "error": str(e)}
    stages.append({"id": "critic", "agent": "Agent Critique (LLM)", "kept": len(retained),
                   "note": "relit les causes retenues, n'élimine rien" if critic["status"] == "ok" else "critique indisponible"})

    # Stage 4: human decision
    confirmed = [r for r in rows if r.get("human") and r["human"]["verdict"] == "confirm"]
    final = sorted({r["id"]: r for r in retained + confirmed if not (r.get("human") and r["human"]["verdict"] == "reject")}.values(),
                   key=lambda r: -r["p"])
    stages.append({"id": "human", "agent": "Retour humain", "kept": len(final),
                   "note": f"{len(feedback)} avis enregistrés" if feedback else "aucun avis pour l'instant"})

    out_rows = [{k: r.get(k) for k in ("id", "label", "mechanism", "prediction", "lane", "stage_out", "data", "score", "p", "jev_p", "human")}
                for r in sorted(rows, key=lambda r: (r["lane"] != "tested", r["stage_out"] is not None, -r["p"]))]
    return {"consequence": consequence, "plot_id": plot_id, "facts": data["facts"], "stages": stages,
            "causes": out_rows, "final": [r["id"] for r in final], "judge": {k: v for k, v in judge.items() if k != "answers"},
            "judge_main_choice": judge.get("answers", {}).get("cause_principale"), "critic": critic,
            "agents": {"jev": jev.public_config(), "llm": llm.public_config()}}

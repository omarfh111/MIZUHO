"""M1 - plain-language explanation of the temperature result, written by an LLM.

The model receives only pre-sorted, pre-rounded facts computed by
backend/temperature_effect.py (no raw series, no outside data). Every number in
its answer is then checked against those facts.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

from backend import llm

SIG = ("increase", "decrease")

SYSTEM = (
    "Tu es un ingénieur agronome qui explique des résultats statistiques au responsable d'un "
    "groupement d'irrigation en Tunisie. Tu écris en français simple, sans jargon inutile. "
    "Règles strictes : utilise uniquement les faits et les chiffres fournis, tels qu'ils sont écrits ; "
    "ne calcule aucun nouveau chiffre ; ne donne pas de fourchette ; n'invente aucune culture ni "
    "aucune cause ; une association statistique n'est pas une preuve de cause."
)

INSTRUCTIONS = (
    "Rédige l'explication en 4 courts paragraphes séparés par une ligne vide, 170 mots au maximum, "
    "sans titre ni liste, avec des phrases naturelles (pas de style télégraphique) :\n"
    "1. Réponds à la question en reprenant « reponse_annee » et « reponse_ete ».\n"
    "2. Cite chaque parcelle de « annee_a_pluie_egale.hausse » avec sa propre valeur, formulée comme "
    "« X m³ de plus par jour pour chaque °C de plus », "
    "puis les parcelles sans effet sur l'année, puis dis qu'en saison sèche les parcelles de "
    "« saison_seche.sans_effet » n'ont pas d'effet.\n"
    "3. Explique « lecture » avec « demande_climatique_mm_jour_par_degre » et « rapport_demande_sur_usage ».\n"
    "4. Termine par la première limite, en une phrase.\n"
    "Mets en gras avec **...** les noms de parcelles et les mots Oui ou Non."
)


def _r(v, d):
    return None if v is None else round(v, d)


def facts(result: dict) -> dict:
    """Compact, pre-sorted facts for the model. Numbers are rounded as they must appear."""
    def group(key: str) -> dict:
        out = {"hausse": [], "baisse": [], "sans_effet": []}
        for p in result["plots"]:
            e = p["effect"][key]
            if e["verdict"] in SIG:
                out["hausse" if e["verdict"] == "increase" else "baisse"].append(
                    {"parcelle": p["plot_id"], "m3_jour_par_degre": _r(e["slope_m3_day_per_c"], 1)})
            else:
                out["sans_effet"].append(p["plot_id"])
        return out

    year, dry = group("all_year_equal_rain"), group("dry_season")
    demand = result["climatic_demand"]["slope"]
    max_use = max(abs(p["effect"]["all_year_equal_rain"]["slope"] or 0) for p in result["plots"])
    ratio = round(demand / max_use) if max_use else None
    yes_year, yes_dry = bool(year["hausse"] or year["baisse"]), bool(dry["hausse"] or dry["baisse"])
    return {
        "question": "La température change-t-elle l'eau réellement utilisée par chaque parcelle ?",
        "periode": "2018 à 2026, par périodes de 10 jours",
        "donnees": "eau utilisée : évapotranspiration réelle FAO WaPOR ; température : maximum NASA POWER",
        "reponse_annee": ("Oui, effet faible" if yes_year else "Non") + " sur l'année, à pluie égale",
        "reponse_ete": ("Oui" if yes_dry else "Non") + " en saison sèche (juin à septembre)",
        "annee_a_pluie_egale": year,
        "saison_seche": dry,
        "demande_climatique_mm_jour_par_degre": _r(demand, 2),
        "rapport_demande_sur_usage": ratio,
        "lecture": ("La chaleur augmente fortement le besoin d'eau des cultures, mais l'eau réellement "
                    "utilisée augmente beaucoup moins : quand il fait chaud, les parcelles ne reçoivent pas "
                    "l'eau supplémentaire demandée. C'est l'eau disponible qui limite, pas la température."
                    if ratio and ratio >= 2 else
                    "L'eau utilisée suit en grande partie la hausse du besoin climatique."),
        "limites": result["limits"],
    }


_NUM = re.compile(r"(?<![\w.,])-?\d+(?:[.,]\d+)?")


def _allowed_numbers(f: dict) -> set[str]:
    allowed = {"2018", "2026", "10", "1", "2", "3", "4", "5", "6", "9"}  # years, dekad length, months, plot numbers
    def walk(v):
        if isinstance(v, bool):
            return
        if isinstance(v, (int, float)):
            allowed.update({str(v), str(v).replace(".", ","), f"{v:g}", f"{v:g}".replace(".", ",")})
        elif isinstance(v, str):
            for n in _NUM.findall(v):
                allowed.update({n, n.replace(".", ","), n.replace(",", ".")})
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(f)
    return allowed


def check_numbers(text: str, f: dict) -> dict:
    """Every number in the answer must come from the facts (plot ids like P-02 excluded)."""
    cleaned = re.sub(r"P-\d+", "", text)
    found = _NUM.findall(cleaned)
    allowed = _allowed_numbers(f)
    unknown = sorted({n for n in found if n.lstrip("-") not in allowed and n not in allowed})
    return {"ok": not unknown, "numbers": len(found), "unknown": unknown}


_cache: dict[str, dict] = {}


def explain(result: dict, refresh: bool = False, tries: int = 2) -> dict:
    f = facts(result)
    cfg = llm.public_config()
    key = hashlib.sha256((cfg["model"] + json.dumps(f, sort_keys=True)).encode()).hexdigest()
    if not refresh and key in _cache:
        return {**_cache[key], "cached": True}
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "FAITS (JSON) :\n" + json.dumps(f, ensure_ascii=False, indent=1) + "\n\n" + INSTRUCTIONS},
    ]
    for attempt in range(1, tries + 1):
        out = llm.chat(messages)
        check = check_numbers(out["text"], f)
        if check["ok"]:
            break
    res = {"text": out["text"], "model": out["model"], "endpoint": cfg["base_url"],
           "finish_reason": out["finish_reason"], "usage": out["usage"], "attempts": attempt,
           "check": check, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "facts": f}
    _cache[key] = res
    return {**res, "cached": False}

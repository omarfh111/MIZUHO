"""M1 - plain-language explanation of the temperature result, written by an LLM.

The model receives only the numbers computed by backend/temperature_effect.py
(no raw series, no outside data) and must not add any figure of its own.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from backend import llm

LABEL = {"increase": "hausse significative", "decrease": "baisse significative",
         "no_significant_effect": "pas d'effet significatif", "insufficient_data": "données insuffisantes"}

SYSTEM = (
    "Tu es un ingénieur agronome qui explique des résultats statistiques au responsable d'un "
    "groupement d'irrigation en Tunisie. Tu écris en français simple, sans jargon inutile. "
    "Règles strictes : utilise uniquement les chiffres fournis dans les FAITS ; n'invente aucun "
    "chiffre, aucune culture, aucune cause certaine ; arrondis comme dans les FAITS ; une "
    "association statistique n'est pas une preuve de cause."
)

INSTRUCTIONS = (
    "Rédige l'explication en 4 courts paragraphes, 170 mots au maximum, sans titre ni liste :\n"
    "1. Réponds d'abord à la question par Oui ou Non et précise sur quelle période (année ou été).\n"
    "2. Nomme les parcelles concernées avec leur effet en m³/jour par °C, et celles sans effet.\n"
    "3. Compare la hausse de la demande climatique à la hausse de l'eau utilisée et dis ce que cela "
    "signifie pour l'irrigation pendant les fortes chaleurs.\n"
    "4. Termine par la limite la plus importante, en une phrase.\n"
    "Tu peux mettre en gras avec **...** les noms de parcelles et la réponse Oui/Non."
)


def facts(result: dict) -> dict:
    """Compact, model-facing summary of temperature_effect.json."""
    cd = result["climatic_demand"]
    return {
        "question": "La température change-t-elle l'eau réellement utilisée par chaque parcelle ?",
        "periode": result["period"], "nombre_de_periodes_10_jours": result["n_dekads"],
        "donnees": {"eau_utilisee": "évapotranspiration réelle FAO WaPOR (mm/jour)",
                    "temperature": "température maximale NASA POWER (°C)"},
        "seuil_de_significativite": result["alpha"],
        "demande_climatique": {"pente_mm_jour_par_degre": cd["slope"], "r": cd["r"], "p": cd["p"]},
        "parcelles": [
            {"parcelle": p["plot_id"], "surface_m2": p["surface_m2"],
             **{k: {"verdict": LABEL[e["verdict"]], "pente_mm_jour_par_degre": e["slope"],
                    "pente_m3_jour_par_degre": e["slope_m3_day_per_c"], "p": e["p"]}
                for k, e in (("annee_a_pluie_egale", p["effect"]["all_year_equal_rain"]),
                             ("saison_seche_juin_septembre", p["effect"]["dry_season"]))}}
            for p in result["plots"]
        ],
        "limites": result["limits"],
    }


_cache: dict[str, dict] = {}


def explain(result: dict, refresh: bool = False) -> dict:
    f = facts(result)
    cfg = llm.public_config()
    key = hashlib.sha256((cfg["model"] + json.dumps(f, sort_keys=True)).encode()).hexdigest()
    if not refresh and key in _cache:
        return {**_cache[key], "cached": True}
    out = llm.chat([
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": "FAITS (JSON) :\n" + json.dumps(f, ensure_ascii=False, indent=1) + "\n\n" + INSTRUCTIONS},
    ])
    res = {"text": out["text"], "model": out["model"], "endpoint": cfg["base_url"],
           "finish_reason": out["finish_reason"], "usage": out["usage"],
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "facts": f}
    _cache[key] = res
    return {**res, "cached": False}

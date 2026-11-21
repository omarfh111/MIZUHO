"""Data agent: tests each candidate cause against the observed series (no LLM).

Each test returns a stance ("supports", "against", "neutral" or "untestable"),
a strength (0 to 2), the facts used, and the data still missing.
"""
from __future__ import annotations

import math
from statistics import mean, median

from backend.causal.catalog import CAUSES
from backend.temperature_effect import ALPHA, DRY_MONTHS, simple_effect

SPRING_MONTHS = (3, 4, 5)
# WaPOR L2 pixel: 0.0009765625 degrees; its area depends on latitude.
PIXEL_DEG = 0.0009765625


def _vals(series, months, key):
    return [s[key] for s in series if s["month"] in months and s.get(key) is not None]


def _pixel_area_m2(lat: float) -> float:
    return (PIXEL_DEG * 111_320 * math.cos(math.radians(lat))) * (PIXEL_DEG * 110_574)


def plot_facts(plot: dict, site_lat: float, climatic_demand: dict) -> dict:
    s = plot["series"]
    dry_aeti, dry_ret = mean(_vals(s, DRY_MONTHS, "aeti_mm_day")), mean(_vals(s, DRY_MONTHS, "ret_mm_day"))
    spring_aeti = mean(_vals(s, SPRING_MONTHS, "aeti_mm_day"))
    by_dekad = {x["dekad"]: x for x in s}
    jul_d2_hist = [by_dekad[f"{y}-07-D2"]["aeti_mm_day"] for y in range(2018, 2026)
                   if f"{y}-07-D2" in by_dekad and by_dekad[f"{y}-07-D2"]["aeti_mm_day"] is not None]
    jul_d2_2026 = by_dekad.get("2026-07-D2", {}).get("aeti_mm_day")
    rain = simple_effect([x["precip_mm_day"] for x in s], [x["aeti_mm_day"] for x in s])
    return {
        "ete_aeti_mm_jour": round(dry_aeti, 2),
        "ete_et0_mm_jour": round(dry_ret, 2),
        "ete_rapport_aeti_et0": round(dry_aeti / dry_ret, 2) if dry_ret else None,
        "printemps_aeti_mm_jour": round(spring_aeti, 2),
        "rapport_printemps_ete": round(spring_aeti / dry_aeti, 1) if dry_aeti else None,
        "ete_effet_temperature": plot["effect"]["dry_season"],
        "demande_climatique_effet_temperature": {k: climatic_demand[k] for k in ("slope", "r", "p", "verdict")},
        "pluie_effet_sur_aeti": rain,
        "ete_pluie_mm_jour": round(mean(_vals(s, DRY_MONTHS, "precip_mm_day")), 2),
        "juillet_d2_2026_aeti": jul_d2_2026,
        "juillet_d2_mediane_2018_2025": round(median(jul_d2_hist), 2) if jul_d2_hist else None,
        "pixels_wapor": round(plot["surface_m2"] / _pixel_area_m2(site_lat), 1),
    }


def _r(stance, strength, why, used, missing=()):
    return {"stance": stance, "strength": strength, "why": why, "facts_used": used, "missing": list(missing)}


def assess(cause_id: str, f: dict) -> dict:
    dry = f["ete_effet_temperature"]
    if cause_id == "water_supply":
        ratio = f["ete_rapport_aeti_et0"]
        demand_up = f["demande_climatique_effet_temperature"]["verdict"] == "increase"
        flat = dry["verdict"] == "no_significant_effect"
        if ratio is not None and ratio < 0.3 and demand_up and flat:
            return _r("supports", 2, f"En été l'eau utilisée ne vaut que {ratio} fois la demande, et elle ne suit pas la chaleur alors que la demande la suit.",
                      ["ete_rapport_aeti_et0", "ete_effet_temperature", "demande_climatique_effet_temperature"], ["volumes d'irrigation reçus"])
        if ratio is not None and ratio < 0.6:
            return _r("supports", 1, f"Rapport été eau utilisée / demande de {ratio}.", ["ete_rapport_aeti_et0"], ["volumes d'irrigation reçus"])
        return _r("against", 1, f"Rapport été de {ratio} : l'eau utilisée suit en grande partie la demande.", ["ete_rapport_aeti_et0"])
    if cause_id == "heat_stress":
        if dry["verdict"] == "decrease":
            return _r("supports", 2, "L'eau utilisée baisse significativement quand il fait plus chaud en été.", ["ete_effet_temperature"])
        if dry["verdict"] == "increase":
            return _r("against", 2, "L'eau utilisée monte avec la chaleur en été.", ["ete_effet_temperature"])
        return _r("against", 1, f"Aucune baisse significative de l'eau utilisée avec la chaleur en été (p = {dry['p']}).", ["ete_effet_temperature"])
    if cause_id == "no_rain":
        rain = f["pluie_effet_sur_aeti"]
        if rain["verdict"] == "increase" and f["ete_pluie_mm_jour"] < 0.5:
            return _r("supports", 1, f"L'eau utilisée suit la pluie sur l'année (p = {rain['p']}) et il ne pleut presque pas en été ({f['ete_pluie_mm_jour']} mm/jour). Cela explique la baisse saisonnière, pas les écarts entre parcelles.",
                      ["pluie_effet_sur_aeti", "ete_pluie_mm_jour"])
        if rain["verdict"] == "decrease":
            return _r("against", 1, f"L'eau utilisée ne monte pas avec la pluie : elle baisse légèrement quand il pleut (r = {rain['r']}), "
                      "car les périodes pluvieuses sont aussi les plus froides. La pluie n'explique pas l'écart d'été.", ["pluie_effet_sur_aeti"])
        return _r("neutral", 0, f"Pas de lien significatif entre pluie et eau utilisée (p = {rain['p']}).", ["pluie_effet_sur_aeti"])
    if cause_id == "fallow":
        a, sr = f["ete_aeti_mm_jour"], f["rapport_printemps_ete"]
        if a < 1.0 and sr and sr > 2:
            return _r("supports", 2, f"Eau utilisée en été de {a} mm/jour, proche du sol nu, et {sr} fois plus au printemps.", ["ete_aeti_mm_jour", "rapport_printemps_ete"], ["calendrier cultural"])
        if a < 1.5:
            return _r("supports", 1, f"Eau utilisée en été faible ({a} mm/jour).", ["ete_aeti_mm_jour"], ["calendrier cultural"])
        if a > 2.5:
            return _r("against", 1, f"Eau utilisée en été de {a} mm/jour : une culture est active.", ["ete_aeti_mm_jour"])
        return _r("neutral", 0, f"Eau utilisée en été de {a} mm/jour : pas concluant.", ["ete_aeti_mm_jour"], ["calendrier cultural"])
    if cause_id == "power_cuts":
        now, hist = f["juillet_d2_2026_aeti"], f["juillet_d2_mediane_2018_2025"]
        if now is None or hist is None:
            return _r("untestable", 0, "Pas de série pour la période des coupures.", [], ["relevés des coupures STEG"])
        if now < 0.8 * hist:
            return _r("supports", 1, f"Du 11 au 20 juillet 2026, eau utilisée de {now} mm/jour contre une médiane de {hist} les années précédentes.",
                      ["juillet_d2_2026_aeti", "juillet_d2_mediane_2018_2025"], ["relevés des coupures STEG"])
        if now > 1.2 * hist:
            return _r("against", 1, f"Du 11 au 20 juillet 2026, eau utilisée de {now} mm/jour, plus élevée que la médiane {hist} des années précédentes : "
                      "pas de baisse visible pendant la période des coupures annoncées.",
                      ["juillet_d2_2026_aeti", "juillet_d2_mediane_2018_2025"], ["relevés des coupures STEG"])
        return _r("neutral", 0, f"Du 11 au 20 juillet 2026, eau utilisée de {now} mm/jour, proche de la médiane {hist} : pas de baisse visible. Une coupure de quelques heures peut ne pas se voir sur 10 jours.",
                  ["juillet_d2_2026_aeti", "juillet_d2_mediane_2018_2025"], ["relevés des coupures STEG"])
    if cause_id == "satellite":
        n = f["pixels_wapor"]
        if n < 4:
            return _r("supports", 1, f"Seulement {n} pixels WaPOR sur la parcelle.", ["pixels_wapor"])
        return _r("against", 1, f"{n} pixels WaPOR couvrent la parcelle : la mesure est représentative.", ["pixels_wapor"])
    cause = next(c for c in CAUSES if c["id"] == cause_id)
    return _r("untestable", 0, "Aucune donnée disponible pour tester cette cause.", [], cause["data"])


def run(plot: dict, site_lat: float, climatic_demand: dict) -> dict:
    f = plot_facts(plot, site_lat, climatic_demand)
    return {"facts": f, "assessments": {c["id"]: assess(c["id"], f) for c in CAUSES}, "alpha": ALPHA}

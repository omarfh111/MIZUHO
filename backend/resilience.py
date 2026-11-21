"""Climate and resilience: heat trend, solar pumping potential, season-by-season review.

Everything is computed from downloaded files (see scripts/m1_fetch_sources.py climate):
  - NASA POWER daily T2M_MAX 1981-2025 at the parcel cluster  -> long-term heat trend
  - WaPOR AETI / RET dekads 2018-2026 per parcel (temperature_effect.json) -> water gap per summer
  - JRC PVGIS monthly yield of 1 kWp                             -> solar vs water demand
  - the cause funnel and field feedback                          -> priorities for next season

Build:  python scripts/m1_build_resilience.py   -> data/agriculture/resilience.json
"""
from __future__ import annotations

import json
import statistics
from datetime import date
from pathlib import Path

from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
POWER_LONG = ROOT / "data" / "raw" / "power" / "power_daily_1981-2025.json"
PVGIS = ROOT / "data" / "raw" / "pvgis" / "pvgis_pvcalc_1kwp.json"
TEMP = ROOT / "data" / "agriculture" / "temperature_effect.json"
OUT = ROOT / "data" / "agriculture" / "resilience.json"

SUMMER = (6, 7, 8, 9)          # same dry season as the temperature analysis
HOT_DAY_C = (35.0, 40.0)       # thresholds for counting hot days
ALPHA = 0.05
FIRST_DECADE, LAST_DECADE = (1981, 1990), (2016, 2025)


def _fit(xs, ys) -> dict:
    lr = stats.linregress(xs, ys)
    sig = bool(lr.pvalue < ALPHA)
    return {"slope": float(lr.slope), "r": round(float(lr.rvalue), 3), "p": float(f"{lr.pvalue:.3g}"),
            "n": len(xs), "significant": sig,
            "verdict": ("hausse" if lr.slope > 0 else "baisse") if sig else "pas de tendance nette"}


def _trend(xs, ys) -> dict:
    """Slope per decade of a yearly series."""
    f = _fit(xs, ys)
    return {"slope_per_decade": round(f.pop("slope") * 10, 3), **f}


def _per_c(xs, ys) -> dict:
    """Slope per °C (summer gap against summer temperature)."""
    f = _fit(xs, ys)
    return {"slope_per_c": round(f.pop("slope"), 3), **f}


# --- 1. heat -------------------------------------------------------------------
def heat_trend(path: Path = POWER_LONG) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    tmax = raw["properties"]["parameter"]["T2M_MAX"]
    fill = raw.get("header", {}).get("fill_value", -999)
    years: dict[int, list[float]] = {}
    for day, v in tmax.items():
        if v is None or v == fill:
            continue
        y, m = int(day[:4]), int(day[4:6])
        if m in SUMMER:
            years.setdefault(y, []).append(float(v))
    rows = []
    for y in sorted(years):
        vals = years[y]
        rows.append({"year": y, "summer_tmax_c": round(statistics.fmean(vals), 2),
                     **{f"days_ge_{int(t)}": sum(v >= t for v in vals) for t in HOT_DAY_C}, "days": len(vals)})
    xs = [r["year"] for r in rows]

    def decade(rng, key):
        v = [r[key] for r in rows if rng[0] <= r["year"] <= rng[1]]
        return round(statistics.fmean(v), 2)

    keys = ["summer_tmax_c"] + [f"days_ge_{int(t)}" for t in HOT_DAY_C]
    return {
        "period": f"{rows[0]['year']}-{rows[-1]['year']}", "months": list(SUMMER),
        "years": rows,
        "trend": {k: _trend(xs, [r[k] for r in rows]) for k in keys},
        "decades": {k: {"first": decade(FIRST_DECADE, k), "last": decade(LAST_DECADE, k),
                        "change": round(decade(LAST_DECADE, k) - decade(FIRST_DECADE, k), 2)} for k in keys},
        "decade_labels": {"first": f"{FIRST_DECADE[0]}-{FIRST_DECADE[1]}", "last": f"{LAST_DECADE[0]}-{LAST_DECADE[1]}"},
    }


# --- 2. water gap per summer (2018-2026) --------------------------------------------
def season_review(temp: dict) -> dict:
    """Per parcel and per summer: water used, climatic demand, gap (demand - use)."""
    out = {}
    for p in temp["plots"]:
        by_year: dict[int, list[dict]] = {}
        for s in p["series"]:
            if s["month"] in SUMMER and s["aeti_mm_day"] is not None and s["ret_mm_day"] is not None:
                by_year.setdefault(int(s["dekad"][:4]), []).append(s)
        seasons = []
        for y, ss in sorted(by_year.items()):
            if len(ss) < 12:           # a full June-September has 12 dekads
                continue
            aeti = statistics.fmean(s["aeti_mm_day"] for s in ss)
            ret = statistics.fmean(s["ret_mm_day"] for s in ss)
            tmax = statistics.fmean(s["tmax_c"] for s in ss)
            gap = max(0.0, ret - aeti)
            seasons.append({"year": y, "aeti_mm_day": round(aeti, 2), "ret_mm_day": round(ret, 2),
                            "ratio": round(aeti / ret, 2) if ret else None, "gap_mm_day": round(gap, 2),
                            "gap_m3_day": round(gap * p["surface_m2"] / 1000, 1), "tmax_c": round(tmax, 2)})
        years = [s["year"] for s in seasons]
        gaps = [s["gap_mm_day"] for s in seasons]
        worst = max(seasons, key=lambda s: s["gap_mm_day"])
        best = min(seasons, key=lambda s: s["gap_mm_day"])
        last = seasons[-1]
        before = [s["gap_mm_day"] for s in seasons[:-1]]
        out[p["plot_id"]] = {
            "surface_m2": p["surface_m2"], "seasons": seasons,
            "gap_trend": _trend(years, gaps) if len(seasons) >= 3 else None,
            "gap_vs_heat": _per_c([s["tmax_c"] for s in seasons], gaps) if len(seasons) >= 3 else None,
            "worst": {"year": worst["year"], "gap_mm_day": worst["gap_mm_day"]},
            "best": {"year": best["year"], "gap_mm_day": best["gap_mm_day"]},
            "last": {"year": last["year"], "gap_mm_day": last["gap_mm_day"],
                     "median_before": round(statistics.median(before), 2) if before else None},
        }
    return out


# --- 3. solar ------------------------------------------------------------------
def solar(temp: dict, path: Path = PVGIS) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    monthly = {m["month"]: m for m in raw["outputs"]["monthly"]["fixed"]}
    ret_m: dict[int, list[float]] = {}
    for p in temp["plots"]:
        for s in p["series"]:
            if s["ret_mm_day"] is not None and s["dekad"][:4] <= "2025":
                ret_m.setdefault(s["month"], []).append(s["ret_mm_day"])
    rows = [{"month": m, "pv_kwh_per_kwp_day": monthly[m]["E_d"], "ret_mm_day": round(statistics.fmean(ret_m[m]), 2)}
            for m in range(1, 13)]
    lr = stats.linregress([r["ret_mm_day"] for r in rows], [r["pv_kwh_per_kwp_day"] for r in rows])
    summer = [r for r in rows if r["month"] in SUMMER]
    inp = raw["inputs"]
    return {
        "months": rows,
        "pv_vs_demand": {"r": round(lr.rvalue, 3), "p": float(f"{lr.pvalue:.3g}"), "n": 12, "significant": bool(lr.pvalue < ALPHA)},
        "summer_pv_kwh_per_kwp_day": round(statistics.fmean(r["pv_kwh_per_kwp_day"] for r in summer), 2),
        "best_month": max(rows, key=lambda r: r["pv_kwh_per_kwp_day"])["month"],
        "worst_month": min(rows, key=lambda r: r["pv_kwh_per_kwp_day"])["month"],
        "year_kwh_per_kwp": raw["outputs"]["totals"]["fixed"]["E_y"],
        "system": {"peak_kw": 1, "loss_pct": inp["pv_module"]["system_loss"],
                   "slope_deg": inp["mounting_system"]["fixed"]["slope"]["value"],
                   "azimuth_deg": inp["mounting_system"]["fixed"]["azimuth"]["value"],
                   "radiation_db": inp["meteo_data"]["radiation_db"],
                   "years": f"{inp['meteo_data']['year_min']}-{inp['meteo_data']['year_max']}"},
        "needs_user_input": "énergie de pompage en kWh par m³ (dépend de la hauteur et du rendement de la pompe, non mesurée)",
        "during_outage": ("Cela dépend de l'installation. Une pompe solaire autonome (variateur solaire branché directement "
                          "sur les panneaux) ou hybride avec secours continue de pomper le jour pendant une coupure STEG. "
                          "Un onduleur raccordé au réseau sans secours s'arrête pendant la coupure (protection anti-îlotage). "
                          "La nuit, il faut un réservoir rempli le jour ou une batterie."),
    }


def pumped_m3_per_day(kwp: float, kwh_per_m3: float, pv_kwh_per_kwp_day: float) -> float:
    if kwp < 0 or kwh_per_m3 <= 0 or pv_kwh_per_kwp_day < 0:
        raise ValueError("kWc >= 0, kWh/m³ > 0 et production >= 0 attendus.")
    return kwp * pv_kwh_per_kwp_day / kwh_per_m3


def kwp_needed(m3_per_day: float, kwh_per_m3: float, pv_kwh_per_kwp_day: float) -> float:
    if m3_per_day < 0 or kwh_per_m3 <= 0 or pv_kwh_per_kwp_day <= 0:
        raise ValueError("m³/jour >= 0, kWh/m³ > 0 et production > 0 attendus.")
    return m3_per_day * kwh_per_m3 / pv_kwh_per_kwp_day


# --- 4. priorities for next season (live: uses the funnel and feedback) -------------
def priorities(plot_id: str, use_agents: bool = True) -> dict:
    """Same funnel result as step 8 (agents included, cached), turned into a field checklist."""
    from backend.causal import funnel

    r = funnel.run(plot_id, use_agents=use_agents)
    by = {c["id"]: c for c in r["causes"]}
    from backend.causal.catalog import CAUSES
    data_needed = {c["id"]: c["data"] for c in CAUSES}
    items = []
    for cid in r["final"]:
        c = by[cid]
        items.append({"cause_id": cid, "cause": c["label"], "statut": "retenue", "p": round(c["p"], 2),
                      "a_verifier": c["prediction"], "donnees": c["data"]["missing"] or data_needed[cid]})
    field = sorted((c for c in r["causes"] if c["lane"] == "field" and c["id"] not in r["final"]), key=lambda c: -c["p"])
    for c in field:
        items.append({"cause_id": c["id"], "cause": c["label"], "statut": "terrain", "p": round(c["p"], 2),
                      "a_verifier": c["prediction"], "donnees": data_needed[c["id"]]})
    fb = [f for f in funnel.load_feedback() if f.get("plot_id") == plot_id]
    learned = [{"cause": by[f["cause_id"]]["label"] if f["cause_id"] in by else f["cause_id"],
                "avis": f["verdict"], "note": f.get("note"), "date": f.get("at")} for f in fb]
    return {"plot_id": plot_id, "priorites": items, "appris": learned,
            "agents": r.get("agents")}


# --- build / load ---------------------------------------------------------------
def build() -> dict:
    temp = json.loads(TEMP.read_text(encoding="utf-8"))
    heat = heat_trend()
    seasons = season_review(temp)
    sol = solar(temp)
    demand_per_c = temp["climatic_demand"]["slope"]
    warming = heat["decades"]["summer_tmax_c"]["change"]
    doc = {
        "built_on": date.today().isoformat(),
        "heat": heat,
        "demand_link": {
            "ret_mm_day_per_c": demand_per_c,
            "summer_tmax_change_c": warming,
            "ret_change_mm_day_estimate": round(demand_per_c * warming, 2),
            "note": ("Ordre de grandeur : pente ET0~Tmax observée sur 2018-2026 (toutes saisons) appliquée au "
                     "réchauffement estival entre les deux décennies. Ce n'est pas une mesure de l'ET0 en 1981."),
        },
        "seasons": seasons,
        "solar": sol,
        "limits": [
            "NASA POWER est une réanalyse (grille d'environ 50 km), pas une station à la parcelle.",
            "Le bilan par saison ne couvre que 2018-2026 (WaPOR v3) : 9 étés, trop peu pour une tendance solide.",
            "L'écart ET0 - AETI mesure l'eau que la culture aurait pu utiliser, pas un volume d'irrigation à livrer : "
            "il faudrait la culture, le sol et l'efficience.",
            "PVGIS donne une production moyenne (années de rayonnement indiquées) ; un été nuageux produit moins.",
            "Le volume pompé par kWc dépend de l'énergie de pompage (kWh/m³), qui n'est pas mesurée : c'est à saisir.",
        ],
        "source_ids": ["nasa-power-daily-1981-2025", "wapor3-l2-aeti-series", "wapor3-l1-ret-series", "jrc-pvgis-5.3"],
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    return doc


def load() -> dict:
    return json.loads(OUT.read_text(encoding="utf-8"))

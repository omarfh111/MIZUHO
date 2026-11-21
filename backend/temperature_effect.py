"""M1 - does temperature change the water actually used by each parcel?

Inputs are dekad (10-day) series built by scripts/m1_build_data.py from
FAO WaPOR v3 (AETI, RET) and NASA POWER (temperature, rainfall).
The result is a statistical association on observations, not a causal proof.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy import stats

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
ALPHA = 0.05
DRY_MONTHS = (6, 7, 8, 9)  # June to September


def _verdict(slope: float, p: float) -> str:
    if p >= ALPHA:
        return "no_significant_effect"
    return "increase" if slope > 0 else "decrease"


def simple_effect(x, y) -> dict:
    """Linear fit y = a + b·x with Pearson r and the two-sided p-value of b."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = ~(np.isnan(x) | np.isnan(y))
    x, y = x[m], y[m]
    if len(x) < 8 or np.ptp(x) == 0:
        return {"n": int(len(x)), "r": None, "p": None, "slope": None, "verdict": "insufficient_data"}
    fit = stats.linregress(x, y)
    return {"n": int(len(x)), "r": round(float(fit.rvalue), 3), "p": float(f"{fit.pvalue:.3g}"),
            "slope": round(float(fit.slope), 4), "verdict": _verdict(fit.slope, fit.pvalue)}


def effect_controlling(x, y, control) -> dict:
    """Effect of x on y at equal `control` (OLS y = a + b·x + c·control), t-test on b."""
    x, y, c = (np.asarray(v, float) for v in (x, y, control))
    m = ~(np.isnan(x) | np.isnan(y) | np.isnan(c))
    x, y, c = x[m], y[m], c[m]
    n = len(x)
    if n < 10:
        return {"n": int(n), "slope": None, "p": None, "verdict": "insufficient_data"}
    X = np.column_stack([np.ones(n), x, c])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    dof = n - 3
    sigma2 = resid @ resid / dof
    se = np.sqrt(sigma2 * np.linalg.inv(X.T @ X)[1, 1])
    t = beta[1] / se
    p = 2 * stats.t.sf(abs(t), dof)
    return {"n": int(n), "slope": round(float(beta[1]), 4), "p": float(f"{p:.3g}"),
            "control_slope": round(float(beta[2]), 4), "verdict": _verdict(beta[1], p)}


def analyse(series: list[dict], surface_m2: int | None) -> dict:
    """series: [{dekad, month, tmax_c, tmean_c, precip_mm_day, aeti_mm_day}]"""
    t = [s["tmax_c"] for s in series]
    a = [s["aeti_mm_day"] for s in series]
    pr = [s["precip_mm_day"] for s in series]
    dry = [s for s in series if s["month"] in DRY_MONTHS]
    out = {
        "all_year": simple_effect(t, a),
        "all_year_equal_rain": effect_controlling(t, a, pr),
        "dry_season": simple_effect([s["tmax_c"] for s in dry], [s["aeti_mm_day"] for s in dry]),
    }
    for k in out.values():
        k["slope_m3_day_per_c"] = (None if k.get("slope") is None or surface_m2 is None
                                   else round(k["slope"] * surface_m2 / 1000, 2))
    return out


def load_temperature_effect(data_dir: Path = DATA_DIR) -> dict:
    return json.loads((data_dir / "agriculture" / "temperature_effect.json").read_text(encoding="utf-8"))

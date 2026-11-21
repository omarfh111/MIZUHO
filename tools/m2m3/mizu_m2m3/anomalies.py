import math
from statistics import mean

import pandas as pd

from .telemetry import prepare_site, provenance


FIELDS = ["pumped_m3", "consumed_wh", "water_in_m3", "distributed_m3", "tank_stock_m3"]


def _record(kind, site_id, start, end, value, reference, unit, data):
    return {
        "type": kind, "site_id": site_id,
        "period": {"start": start.isoformat(), "end": (end + pd.Timedelta(hours=1)).isoformat()},
        "value": round(float(value), 6), "reference": reference, "unit": unit,
        "provenance": provenance(data),
    }


def analyze_telemetry(series, reference_kwh_per_m3=None, *, initial_stock_m3=None):
    if reference_kwh_per_m3 is not None and (
        not math.isfinite(reference_kwh_per_m3) or reference_kwh_per_m3 <= 0
    ):
        raise ValueError("reference_kwh_per_m3: expected a finite, positive reference")
    rows = pd.DataFrame(series)
    if not {"site_id", "timestamp"} <= set(rows.columns):
        raise ValueError("telemetry: site_id and timestamp are required")
    if rows.site_id.isna().any():
        raise ValueError("telemetry.site_id: missing site identifier")

    alerts, diagnostics = [], []
    for site_id, group in rows.groupby("site_id"):
        data = prepare_site(group, FIELDS)
        consecutive = data.index.to_series().diff().eq(pd.Timedelta(hours=1))
        stock_change = data.tank_stock_m3.diff().where(consecutive)
        if initial_stock_m3 is not None:
            stock_change.iloc[0] = data.tank_stock_m3.iloc[0] - initial_stock_m3
        residual = data.water_in_m3 - data.distributed_m3 - stock_change
        for time, value in residual.dropna().items():
            if not math.isclose(value, 0, abs_tol=1e-9):
                alerts.append(_record("unexplained_water", site_id, time, time, value, 0, "m³", data.loc[[time]]))

        valid = data.pumped_m3.gt(0) & data.grid_available.astype("boolean").fillna(False)
        ratio = data.consumed_wh.div(1000).div(data.pumped_m3.where(valid))
        ratio = ratio.where(ratio.map(math.isfinite))
        comparable = ratio.notna()
        diagnostics.append({
            "site_id": site_id,
            "water_balance": "ok" if residual.notna().any() else "insufficient_data",
            "pump_energy_intensity": "ok" if reference_kwh_per_m3 is not None and (
                comparable & comparable.shift(fill_value=False) & consecutive
            ).any() else "insufficient_data",
        })
        if reference_kwh_per_m3 is None:
            continue
        limit = 1.2 * reference_kwh_per_m3
        high = ratio.gt(limit) & ~ratio.map(lambda value: math.isclose(value, limit, rel_tol=1e-12))
        run = high.ne(high.shift(fill_value=False)) | ~consecutive
        for _, readings in ratio.loc[high].groupby(run.cumsum()):
            if len(readings) >= 2:
                alerts.append(_record(
                    "high_pump_energy_intensity", site_id, readings.index[0], readings.index[-1],
                    mean(readings), reference_kwh_per_m3, "kWh/m³", data.loc[readings.index],
                ))
    alerts.sort(key=lambda alert: (alert["site_id"], alert["period"]["start"], alert["type"]))
    return {"alerts": alerts, "diagnostics": diagnostics}


def detect_anomalies(series, reference_kwh_per_m3=None):
    return analyze_telemetry(series, reference_kwh_per_m3)["alerts"]

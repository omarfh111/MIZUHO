from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .inputs import DATA, hourly_timestamps, numeric, read_csv
from .telemetry import prepare_site, provenance, read_telemetry


def _weather_at_cutoff(path, site_id, cutoff):
    frame = read_csv(path, {"site_id", "timestamp", "available_at", "temperature_c"})
    frame = frame.loc[frame.site_id == site_id].copy()
    frame["timestamp"] = hourly_timestamps(frame.timestamp, "weather.timestamp")
    available = []
    for value in frame.available_at:
        time = pd.Timestamp(value)
        if pd.isna(time) or time.tzinfo is None:
            raise ValueError("weather.available_at: expected a timezone-aware timestamp")
        available.append(time.tz_convert("UTC"))
    frame["available_at"] = pd.DatetimeIndex(available, tz="UTC")
    frame["temperature_c"] = numeric(frame.temperature_c, "weather.temperature_c")
    if frame.duplicated(["timestamp", "available_at"]).any():
        raise ValueError("weather.timestamp: duplicate forecast for the same availability time")
    # Historical evaluation repeats the daily issuance hour used by this request.
    lead_hours = (frame.timestamp.dt.hour - cutoff.hour - 1) % 24 + 1
    origins = frame.timestamp - pd.to_timedelta(lead_hours, unit="h")
    eligible = frame.loc[frame.available_at <= origins].sort_values("available_at")
    return eligible.drop_duplicates("timestamp", keep="last").set_index("timestamp").temperature_c


def forecast_load(
    site_id, as_of, *, telemetry_path=DATA / "telemetry/sample.csv", weather_path=None,
    timezone="Africa/Tunis",
):
    cutoff = hourly_timestamps([as_of], "as_of")[0]
    zone = ZoneInfo(timezone)
    rows = read_telemetry(telemetry_path)
    if "load_kw" not in rows:
        raise ValueError(f"{telemetry_path}: missing column load_kw")
    site = rows.loc[rows.site_id == site_id]
    if site.empty:
        raise ValueError(f"{telemetry_path}: no telemetry for site_id {site_id!r}")
    history = prepare_site(site, ["load_kw", "temperature_c"])
    history = history.loc[history.index <= cutoff]
    result = {
        "site_id": site_id, "as_of": cutoff.tz_convert(zone).isoformat(), "timezone": timezone,
        "provenance": provenance(history), "status": "insufficient_history", "points": [], "test": None,
    }
    if (history.empty or history.load_kw.notna().sum() < 72
            or cutoff - history.index[-1] >= pd.Timedelta(days=7)):
        return result

    horizon = pd.date_range(cutoff + pd.Timedelta(hours=1), periods=24, freq="h")
    hours = pd.date_range(history.index[0], horizon[-1], freq="h")
    data = history.reindex(hours)
    local = hours.tz_convert(zone)
    # A confirmed outage is not a measurement of the site's underlying demand.
    available = data.grid_available.astype("boolean").fillna(True)
    features = pd.DataFrame({
        "hour_sin": np.sin(local.hour * 2 * np.pi / 24),
        "hour_cos": np.cos(local.hour * 2 * np.pi / 24),
        "weekday_sin": np.sin(local.day_of_week * 2 * np.pi / 7),
        "weekday_cos": np.cos(local.day_of_week * 2 * np.pi / 7),
        "load_last_week_kw": data.load_kw.where(available).shift(168),
        "temperature_last_week_c": data.temperature_c.shift(168),
    }, index=hours)
    if weather_path is not None:
        features["forecast_temperature_c"] = _weather_at_cutoff(weather_path, site_id, cutoff)

    valid = data.load_kw.notna() & features.load_last_week_kw.notna() & available
    known = features.loc[valid]
    test_size = max(24, len(known) // 5)
    if len(known) - test_size < 48:
        return result
    train, test = known.iloc[:-test_size], known.iloc[-test_size:]
    model = make_pipeline(SimpleImputer(strategy="median", keep_empty_features=True), StandardScaler(), Ridge())
    model.fit(train, data.loc[train.index, "load_kw"])
    actual = data.loc[test.index, "load_kw"]
    regression_mae = mean_absolute_error(actual, model.predict(test).clip(min=0))
    baseline_mae = mean_absolute_error(actual, test.load_last_week_kw)
    model.fit(known, data.loc[known.index, "load_kw"])
    future = features.loc[horizon]
    predictions = model.predict(future).clip(min=0)
    result.update(
        status="ok",
        test={
            "regression_mae_kw": round(regression_mae, 4),
            "same_hour_last_week_mae_kw": round(baseline_mae, 4),
            "hours": len(test), "from": test.index[0].isoformat(), "through": test.index[-1].isoformat(),
        },
        points=[
            {"timestamp": time.tz_convert(zone).isoformat(), "load_kw": round(float(predicted), 3),
             "same_hour_last_week_kw": float(baseline) if pd.notna(baseline) else None}
            for time, predicted, baseline in zip(horizon, predictions, future.load_last_week_kw, strict=True)
        ],
    )
    return result

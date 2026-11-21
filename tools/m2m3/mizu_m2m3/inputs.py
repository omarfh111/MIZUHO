from pathlib import Path

import pandas as pd


DATA = Path(__file__).resolve().parents[1] / "data"


def read_csv(path, required):
    frame = pd.read_csv(path)
    missing = set(required) - set(frame.columns)
    if missing:
        source = getattr(path, "name", path) if hasattr(path, "read") else path
        raise ValueError(f"{source}: missing columns {', '.join(sorted(missing))}")
    return frame


def hourly_timestamps(values, field):
    parsed = []
    for value in values:
        try:
            time = pd.Timestamp(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{field}: invalid timestamp {value!r}") from error
        if pd.isna(time) or time.tzinfo is None or time != time.floor("h"):
            raise ValueError(f"{field}: expected a timezone-aware hourly timestamp, got {value!r}")
        parsed.append(time.tz_convert("UTC"))
    return pd.DatetimeIndex(parsed, tz="UTC")


def numeric(values, field, *, nonnegative=False):
    result = pd.to_numeric(values, errors="coerce")
    invalid = (result.isna() & values.notna()) | result.isin([float("inf"), float("-inf")])
    if nonnegative:
        invalid |= result < 0
    if invalid.any():
        raise ValueError(f"{field}: invalid numeric value {values.loc[invalid].iloc[0]!r}")
    return result


def grid_flags(values):
    flags = values.astype("string").str.strip().str.lower().map(
        {"true": True, "false": False, "1": True, "0": False}
    ).astype("boolean")
    if (flags.isna() & values.notna()).any():
        raise ValueError("grid_available: expected true, false, or an empty field")
    return flags

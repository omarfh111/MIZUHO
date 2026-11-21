from .inputs import grid_flags, hourly_timestamps, numeric, read_csv


def read_telemetry(path):
    return read_csv(path, {"site_id", "timestamp"})


def prepare_site(rows, numeric_fields):
    frame = rows.copy()
    frame.index = hourly_timestamps(frame.timestamp, "telemetry.timestamp")
    if frame.index.has_duplicates:
        raise ValueError("telemetry.timestamp: duplicate hour for the site")
    for field in numeric_fields:
        if field in frame:
            frame[field] = numeric(frame[field], field, nonnegative=field != "temperature_c")
        else:
            frame[field] = float("nan")
    if "grid_available" in frame:
        frame["grid_available"] = grid_flags(frame.grid_available)
    else:
        frame["grid_available"] = None
    return frame.sort_index()


def provenance(rows):
    values = rows.get("provenance")
    if values is None or values.empty:
        return "unavailable"
    if values.eq("simulated").any():
        return "simulated"
    if values.isin(["observed", "estimated"]).all():
        return "estimated"
    return "unavailable"

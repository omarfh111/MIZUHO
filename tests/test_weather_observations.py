from datetime import date, datetime
from decimal import Decimal
from hashlib import sha256
from pathlib import Path

from backend.weather_observations import radiation_day, read_radiation


EXTRACT = Path(__file__).resolve().parents[1] / "data/weather/bouhertma-fieldclimate.csv"


def test_bouhertma_matches_the_downloaded_source():
    digest = sha256(EXTRACT.read_bytes()).hexdigest()
    assert digest == "d27b8d6ffaffe68461bc954fea116651e1f58518a6936d0bdc8939640c10436d"


def test_read_radiation_keeps_only_reported_measurements():
    records = read_radiation(EXTRACT)
    assert len(records) == 2_529
    assert records[0].reported_at == datetime(2026, 4, 18, 0)
    assert records[-1].reported_at == datetime(2026, 9, 14, 6)
    strongest = max(records, key=lambda record: record.watts_per_square_metre)
    assert strongest.reported_at == datetime(2026, 5, 8, 11)
    assert strongest.watts_per_square_metre == Decimal("1133.0")


def test_read_radiation_preserves_gaps_and_unspecified_timezone():
    records = read_radiation(EXTRACT)
    timestamps = [record.reported_at for record in records]
    assert all(timestamp.tzinfo is None for timestamp in timestamps)
    gap_count = sum((end - start).total_seconds() > 3_600 for start, end in zip(timestamps, timestamps[1:]))
    assert gap_count == 4


def test_public_archive_returns_actual_hours_and_no_invented_readings():
    data = EXTRACT.parents[1]
    latest = radiation_day(data, None)
    assert latest.day == date(2026, 9, 14) and latest.timezone is None
    assert latest.provenance == "observed" and len(latest.observations) == 7
    assert radiation_day(data, date(2000, 1, 1)).observations == []
    assert max(item.radiation_w_m2 for item in radiation_day(data, date(2026, 5, 8)).observations) == 1133

from csv import DictReader
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path


@dataclass(frozen=True)
class RadiationObservation:
    reported_at: datetime
    watts_per_square_metre: Decimal


def read_radiation(path: Path) -> tuple[RadiationObservation, ...]:
    """Extract reported Bouhertma radiation without resampling or filling gaps."""
    records: dict[datetime, RadiationObservation] = {}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = DictReader(stream)
        required = {"Date", "nom_fr", "unite", "valeur"}
        if not required.issubset(rows.fieldnames or ()):
            raise ValueError("unexpected FieldClimate CSV header")
        for row in rows:
            if row["nom_fr"] != "Solar radiation":
                continue
            if row["unite"] != "W/m2":
                raise ValueError(f"unexpected radiation unit on row {rows.line_num}")
            try:
                reported_at = datetime.strptime(row["Date"], "%Y-%m-%d %H:%M:%S")
                value = Decimal(row["valeur"])
            except (InvalidOperation, TypeError, ValueError) as exc:
                raise ValueError(f"invalid radiation observation on row {rows.line_num}") from exc
            if not value.is_finite() or value < 0:
                raise ValueError(f"invalid radiation value on row {rows.line_num}")
            if reported_at in records:
                raise ValueError(f"duplicate radiation timestamp on row {rows.line_num}")
            records[reported_at] = RadiationObservation(reported_at, value)
    if not records:
        raise ValueError("no solar radiation observations in the file")
    return tuple(records[timestamp] for timestamp in sorted(records))

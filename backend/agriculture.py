"""M1 - parcels, irrigation needs and volume rules.

load_plots(site_id) reads local files only (no network on demo day).
Values with no verified source are kept as None; see data/manifest.json.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
N_SLOTS = 24
# Rough lon/lat envelope of Tunisia, used to catch swapped coordinates.
TUNISIA_LON = (7.5, 11.7)
TUNISIA_LAT = (30.2, 37.6)


class PlotDataError(ValueError):
    """Invalid parcel data. `field` names the offending field, `plot_id` the parcel."""

    def __init__(self, message: str, field: str, plot_id: str | None = None):
        super().__init__(f"{plot_id or '-'}: {field}: {message}")
        self.field = field
        self.plot_id = plot_id


@dataclass(frozen=True)
class Plot:
    plot_id: str
    site_id: str
    farmer_id: str | None
    surface_m2: int | None
    crop: str | None
    demand_m3: int | None
    minimum_m3: int | None
    deadline_slot: int | None
    allowed_slots: tuple[int, ...] | None
    past_deferrals: int | None
    source_id: str

    def to_dict(self) -> dict:
        d = asdict(self)
        if d["allowed_slots"] is not None:
            d["allowed_slots"] = list(d["allowed_slots"])
        return d

    @property
    def solver_ready(self) -> bool:
        """True when every field the optimizer needs has a sourced value."""
        return None not in (self.farmer_id, self.demand_m3, self.minimum_m3,
                            self.deadline_slot, self.allowed_slots, self.past_deferrals)


def mm_to_m3(depth_mm: float, surface_m2: float) -> float:
    """Irrigation depth (mm) over a surface (m²) -> volume (m³). Raw, not rounded."""
    if depth_mm < 0 or surface_m2 < 0:
        raise ValueError("depth and surface must be >= 0")
    return depth_mm * surface_m2 / 1000


def round_m3(volume_m3: float) -> int:
    """Rounding rule of data/manifest.json: half up to a whole m³."""
    return int(Decimal(str(volume_m3)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def coverage_bp(minimum_m3: int, delivered_on_time_m3: int) -> int | None:
    """Coverage of the deadline minimum in basis points (10 000 = 100 %).

    None when the minimum is 0 (non-priority plot, no coverage to compute).
    """
    if minimum_m3 <= 0:
        return None
    return min(10_000, delivered_on_time_m3 * 10_000 // minimum_m3)


def _check_int(v, field: str, pid: str, lo: int = 0, hi: int | None = None) -> None:
    if v is None:
        return
    if isinstance(v, bool) or not isinstance(v, int):
        raise PlotDataError("must be an integer", field, pid)
    if v < lo or (hi is not None and v > hi):
        raise PlotDataError(f"out of range [{lo}, {hi}]", field, pid)


def validate_plots(plots: list[Plot], site_ids: set[str], source_ids: set[str]) -> None:
    seen: set[str] = set()
    for p in plots:
        pid = p.plot_id
        if not pid:
            raise PlotDataError("missing", "plot_id")
        if pid in seen:
            raise PlotDataError("duplicate identifier", "plot_id", pid)
        seen.add(pid)
        if not p.site_id or p.site_id not in site_ids:
            raise PlotDataError("parcel has no known site", "site_id", pid)
        if p.source_id not in source_ids:
            raise PlotDataError("unknown source", "source_id", pid)
        for f in ("surface_m2", "demand_m3", "minimum_m3", "past_deferrals"):
            _check_int(getattr(p, f), f, pid)
        _check_int(p.deadline_slot, "deadline_slot", pid, 0, N_SLOTS - 1)
        if p.minimum_m3 is not None and p.demand_m3 is not None and p.minimum_m3 > p.demand_m3:
            raise PlotDataError("minimum above demand", "minimum_m3", pid)
        if p.allowed_slots is not None:
            if not p.allowed_slots:
                raise PlotDataError("empty", "allowed_slots", pid)
            for s in p.allowed_slots:
                _check_int(s, "allowed_slots", pid, 0, N_SLOTS - 1)
            if p.deadline_slot is not None and p.deadline_slot not in p.allowed_slots:
                raise PlotDataError("deadline not in allowed slots", "deadline_slot", pid)


def _check_coords(geometry: dict, pid: str) -> None:
    rings = geometry["coordinates"] if geometry["type"] == "Polygon" else \
        [r for poly in geometry["coordinates"] for r in poly]
    for ring in rings:
        for lon, lat in ring:
            if not (TUNISIA_LON[0] <= lon <= TUNISIA_LON[1] and TUNISIA_LAT[0] <= lat <= TUNISIA_LAT[1]):
                raise PlotDataError("coordinate outside Tunisia (expected lon, lat)", "geometry", pid)


def _plot_from(d: dict) -> Plot:
    slots = d.get("allowed_slots")
    return Plot(
        plot_id=d.get("plot_id"), site_id=d.get("site_id"), farmer_id=d.get("farmer_id"),
        surface_m2=d.get("surface_m2"), crop=d.get("crop"), demand_m3=d.get("demand_m3"),
        minimum_m3=d.get("minimum_m3"), deadline_slot=d.get("deadline_slot"),
        allowed_slots=None if slots is None else tuple(slots),
        past_deferrals=d.get("past_deferrals"), source_id=d.get("source_id"),
    )


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_all(data_dir: Path = DATA_DIR) -> dict[str, list[Plot]]:
    """Load and validate every parcel, grouped by site_id."""
    source_ids = {d["source_id"] for d in _read(data_dir / "manifest.json")["datasets"]}
    sites = _read(data_dir / "sites.geojson")["features"]
    site_ids = {s["properties"]["site_id"] for s in sites}
    plots: list[Plot] = []

    for f in _read(data_dir / "plots.geojson")["features"]:
        p = _plot_from(f["properties"])
        _check_coords(f["geometry"], p.plot_id)
        plots.append(p)

    mini_path = data_dir / "agriculture" / "mini_plots.json"
    if mini_path.exists():
        mini = _read(mini_path)
        site_ids.add(mini["site"]["site_id"])
        plots.extend(_plot_from(d) for d in mini["plots"])

    validate_plots(plots, site_ids, source_ids)
    out: dict[str, list[Plot]] = {s: [] for s in site_ids}
    for p in plots:
        out[p.site_id].append(p)
    return out


def load_plots(site_id: str, data_dir: Path = DATA_DIR) -> list[Plot]:
    """Parcels of one site. Raises KeyError for an unknown site."""
    by_site = load_all(data_dir)
    if site_id not in by_site:
        raise KeyError(site_id)
    return by_site[site_id]

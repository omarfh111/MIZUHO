"""Build conditional irrigation plans on archived regional irradiation days."""

from datetime import date as Date
from decimal import Decimal, ROUND_CEILING
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, FiniteFloat, computed_field, model_validator

from .baseline import build_baseline
from .compare import InputError, to_api_plan
from .field_zones import FieldZone
from .models import Comparison, Delivery, DemandEstimateRequest, Plot, Scenario, Site, Slot, State, ZonePlanRequest
from .optimizer import optimize
from .tunisia import ArchiveModel, Latitude, Longitude, Source


Nonnegative = Annotated[FiniteFloat, Field(ge=0)]


class DailyWeather(ArchiveModel):
    temperature_mean_c: FiniteFloat
    temperature_min_c: FiniteFloat
    temperature_max_c: FiniteFloat
    precipitation_mm: Nonnegative
    wind_2m_m_s: Nonnegative
    actual_vapour_pressure_kpa: Nonnegative
    surface_pressure_kpa: Annotated[FiniteFloat, Field(gt=0)]
    grid_elevation_m: FiniteFloat
    et0_mm: Nonnegative
    source: Source


class IrradiationDay(ArchiveModel):
    date: Date
    irradiation_wh_m2: Annotated[tuple[Annotated[FiniteFloat, Field(ge=0)], ...], Field(min_length=24, max_length=24)]
    source: Source
    weather: DailyWeather | None = None


class IrradiationArchive(ArchiveModel):
    site_id: str
    longitude: Longitude
    latitude: Latitude
    days: Annotated[tuple[IrradiationDay, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def unique_days(self):
        dates = [day.date for day in self.days]
        if dates != sorted(set(dates)):
            raise ValueError("Regional replay dates must be distinct and chronological.")
        return self


class SectorAnchor(ArchiveModel):
    plot_id: Literal["west", "east"]
    longitude: Longitude
    latitude: Latitude
    cover_class: Literal[40] = 40


class ZonePlanningProfile(IrradiationArchive):
    timezone: Literal["Africa/Tunis"] = "Africa/Tunis"
    anchors: tuple[SectorAnchor, SectorAnchor]
    missing_inputs: tuple[str, ...]


class ZonePlanResult(ArchiveModel):
    site_id: str
    date: Date
    source: Source = Field(description="Source of the regional hourly irradiation input only.")
    provenance: Literal["simulated"] = "simulated"
    solar_wh: tuple[int, ...] = Field(description="Estimated hourly flat-array production before grid-outage losses.")
    comparison: Comparison

    @computed_field
    @property
    def comparison_id(self) -> str:
        return sha256(self.comparison.model_dump_json().encode()).hexdigest()


class DemandEstimate(ArchiveModel):
    date: Date
    source: Source
    et0_mm: Nonnegative
    precipitation_mm: Nonnegative
    effective_rain_mm: Nonnegative
    net_depth_mm: Nonnegative
    gross_demand_m3: Nonnegative
    demand_m3: int


def estimate_demand(profile: ZonePlanningProfile, inputs: DemandEstimateRequest) -> DemandEstimate:
    weather = next((item.weather for item in profile.days if item.date == inputs.date), None)
    if weather is None:
        raise InputError("date", "No complete regional weather inputs for reference ET on this date.")
    # The source and user inputs are rounded decimals; binary noise at integer m³ can add a whole cubic metre.
    effective_rain = Decimal(str(inputs.effective_rain_fraction)) * Decimal(str(weather.precipitation_mm))
    net = max(Decimal(0), Decimal(str(inputs.crop_coefficient)) * Decimal(str(weather.et0_mm)) - effective_rain)
    gross = net * Decimal(str(inputs.area_m2)) / (1000 * Decimal(str(inputs.application_efficiency)))
    if gross > 100_000:
        raise InputError("area_m2", "The estimate exceeds the planner's 100,000 m³ sector limit.")
    return DemandEstimate(date=inputs.date, source=weather.source, et0_mm=weather.et0_mm,
                          precipitation_mm=weather.precipitation_mm, effective_rain_mm=float(effective_rain),
                          net_depth_mm=float(net), gross_demand_m3=float(gross),
                          demand_m3=int(gross.to_integral_value(rounding=ROUND_CEILING)))


def sector_anchors(zone: FieldZone) -> tuple[SectorAnchor, SectorAnchor] | None:
    """Use a classified pixel near each half-window centre. These are synthetic service points."""
    land = zone.land_cover
    west, south, east, north = zone.relief.bounds

    def anchor(sector: Literal["west", "east"]) -> SectorAnchor | None:
        east_half = sector == "east"
        target_col = land.cols * (0.75 if east_half else 0.25)
        pixels = (divmod(index, land.cols) for index, code in enumerate(land.classes) if code == 40)
        candidates = ((row, col) for row, col in pixels if (col + 0.5 >= land.cols / 2) == east_half)
        selected = min(candidates, key=lambda cell: (cell[0] + 0.5 - land.rows / 2) ** 2
                       + (cell[1] + 0.5 - target_col) ** 2, default=None)
        if selected is None:
            return None
        row, col = selected
        return SectorAnchor(plot_id=sector, longitude=west + (col + 0.5) * (east - west) / land.cols,
                            latitude=north - (row + 0.5) * (north - south) / land.rows)

    left, right = anchor("west"), anchor("east")
    return (left, right) if left is not None and right is not None else None


def read_planning_profiles(root: Path, zones: dict[str, FieldZone]) -> dict[str, ZonePlanningProfile]:
    profiles = {}
    for path in sorted((root / "zone_planning").glob("*.json")):
        archive = IrradiationArchive.model_validate_json(path.read_bytes())
        zone = zones.get(archive.site_id)
        if path.stem != archive.site_id or zone is None or (
            archive.longitude, archive.latitude
        ) != zone.site.geometry.coordinates:
            raise ValueError(f"Irradiation archive {path.name} does not match its study window.")
        anchors = sector_anchors(zone)
        if anchors is not None:
            profiles[archive.site_id] = ZonePlanningProfile(**archive.model_dump(), anchors=anchors,
                                                           missing_inputs=zone.missing_inputs)
    return profiles


def compare_zone(profile: ZonePlanningProfile, request: ZonePlanRequest, max_time_seconds: float) -> ZonePlanResult:
    day = next((item for item in profile.days if item.date == request.date), None)
    if day is None:
        raise InputError("date", "No complete archived irradiation day for this site and date.")
    for sector, basis in request.demand_basis.items():
        if basis.date != day.date:
            raise InputError(("demand_basis", sector, "date"), "Recalculate the sector estimate for this replay day.")
        demand = request.demand_west_m3 if sector == "west" else request.demand_east_m3
        if estimate_demand(profile, basis).demand_m3 != demand:
            raise InputError(("demand_basis", sector), "The sector demand differs from the calculated estimate.")
    # Horizontal-array approximation: GHI [Wh/m²] / STC [1 kW/m²] × kWp × performance ratio.
    solar_wh = tuple(round(ghi * request.pv_capacity_kwp * request.pv_performance_ratio)
                     for ghi in day.irradiation_wh_m2)
    hours = tuple(range(request.delivery_start_hour, request.delivery_end_hour + 1))
    site = Site(tank_capacity_m3=request.tank_capacity_m3, pump_max_m3_per_slot=request.pump_flow_m3_h,
                pump_wh_per_m3=request.pump_wh_per_m3, gravity_max_m3_per_slot=request.gravity_flow_m3_h)
    state = State(current_slot=0, tank_stock_m3=request.initial_stock_m3, quota_remaining_m3=request.withdrawal_limit_m3)
    demands = (request.demand_west_m3, request.demand_east_m3)
    plots = tuple(Plot(plot_id=anchor.plot_id, farmer_id=f"hypothetical-{anchor.plot_id}", demand_m3=demand,
                       minimum_m3=demand, deadline_slot=hours[-1], allowed_slots=hours)
                  for anchor, demand in zip(profile.anchors, demands, strict=True))
    # The reference schedule alternates west/east and pumps only to cover the scheduled turn.
    # Build it before the outage, then use M4 to replay its requests under the actual scenario constraints.
    fixed_pumps = [0] * 24
    fixed_deliveries: list[tuple[Delivery, ...]] = [()] * 24
    remaining = list(demands)
    stock = request.initial_stock_m3
    for index, hour in enumerate(hours):
        sector = index % 2
        wanted = min(remaining[sector], request.gravity_flow_m3_h, request.tank_capacity_m3)
        pump = min(request.pump_flow_m3_h, max(0, wanted - stock))
        delivered = min(wanted, stock + pump)
        fixed_pumps[hour] = pump
        fixed_deliveries[hour] = (Delivery(plot_id=plots[sector].plot_id, delivered_m3=delivered),)
        stock += pump - delivered
        remaining[sector] -= delivered

    slots = tuple(Slot(slot=hour, solar_wh=wh, grid_cap_w=request.grid_cap_w,
                       grid_available=hour not in request.outage_hours) for hour, wh in enumerate(solar_wh))
    scenario = Scenario(site=site, slots=slots, plots=plots, fixed_pump_m3=fixed_pumps,
                        fixed_deliveries=fixed_deliveries)
    baseline = build_baseline(scenario, state)
    optimized = optimize(scenario, state, max_time_seconds=max_time_seconds)
    return ZonePlanResult(site_id=profile.site_id, date=day.date, source=day.source, solar_wh=solar_wh,
                          comparison=Comparison(baseline=to_api_plan(scenario, state, baseline),
                                                optimized=to_api_plan(scenario, state, optimized)))

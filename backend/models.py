from datetime import date as Date
from enum import StrEnum
from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import UUID4, AwareDatetime, BaseModel, ConfigDict, Field, HttpUrl, StringConstraints, model_validator


Amount = Annotated[int, Field(strict=True, ge=0, le=1_000_000_000)]
SlotIndex = Annotated[int, Field(strict=True, ge=0, le=24)]
PlotId = Annotated[str, Field(min_length=1)]
DeferralCount = Annotated[int, Field(strict=True, ge=0, le=10_000)]
PlanStatus = Literal["OPTIMAL", "FEASIBLE", "NO_SOLUTION"]


class PlanningModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Site(PlanningModel):
    tank_capacity_m3: Amount
    pump_max_m3_per_slot: Amount
    pump_wh_per_m3: Annotated[int, Field(strict=True, gt=0, le=1_000_000_000)]
    gravity_max_m3_per_slot: Amount


class Slot(PlanningModel):
    slot: SlotIndex
    grid_available: Annotated[bool, Field(strict=True)]
    grid_cap_w: Amount
    solar_wh: Amount
    pump_available: bool = True
    gravity_available: bool = True
    island_backup_w: Amount = 0
    # One-off physical withdrawal from stock at the opening of this hour, clipped to available water.
    tank_loss_m3: Amount = 0


class Plot(PlanningModel):
    plot_id: PlotId
    farmer_id: PlotId
    crop: str | None = None
    surface_m2: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None
    source_id: str | None = None
    demand_m3: Amount
    minimum_m3: Amount
    deadline_slot: SlotIndex
    allowed_slots: tuple[SlotIndex, ...]
    past_deferrals: DeferralCount = 0

    @model_validator(mode="after")
    def check_plot(self) -> Self:
        if self.minimum_m3 > self.demand_m3:
            raise ValueError("minimum_m3 cannot exceed demand_m3")
        if len(set(self.allowed_slots)) != len(self.allowed_slots):
            raise ValueError("allowed_slots contains duplicates")
        return self


class Delivery(PlanningModel):
    plot_id: PlotId
    delivered_m3: Amount


class Action(PlanningModel):
    slot: SlotIndex
    pump_m3: Amount = 0
    deliveries: tuple[Delivery, ...] = ()


class Scenario(PlanningModel):
    site: Site
    slots: Annotated[tuple[Slot, ...], Field(min_length=1, max_length=24)]
    plots: Annotated[tuple[Plot, ...], Field(min_length=1, max_length=100)]
    fixed_pump_m3: tuple[Amount, ...] = ()
    fixed_deliveries: tuple[tuple[Delivery, ...], ...] = ()

    @model_validator(mode="after")
    def check_horizon(self) -> Self:
        horizon = len(self.slots)
        if [slot.slot for slot in self.slots] != list(range(horizon)):
            raise ValueError("slots must be consecutive and start at zero")
        plot_ids = {plot.plot_id for plot in self.plots}
        if len(plot_ids) != len(self.plots):
            raise ValueError("plot_id must be unique")
        if len({plot.farmer_id for plot in self.plots}) != len(self.plots):
            raise ValueError("the prototype supports one plot per farmer")
        for plot in self.plots:
            if plot.deadline_slot >= horizon or any(slot >= horizon for slot in plot.allowed_slots):
                raise ValueError(f"plot {plot.plot_id} refers to a slot outside the horizon")
        for schedule in (self.fixed_pump_m3, self.fixed_deliveries):
            if schedule and len(schedule) != horizon:
                raise ValueError("fixed schedules must cover the entire horizon")
        for index, deliveries in enumerate(self.fixed_deliveries):
            if len(deliveries) > 1:
                raise ValueError(f"fixed deliveries in slot {index} exceed one plot")
            if any(delivery.plot_id not in plot_ids for delivery in deliveries):
                raise ValueError(f"fixed delivery in slot {index} refers to an unknown plot")
        return self


class State(PlanningModel):
    current_slot: SlotIndex
    tank_stock_m3: Amount
    quota_remaining_m3: Amount
    delivered_by_plot_m3: dict[PlotId, Amount] = Field(default_factory=dict)
    delivered_on_time_by_plot_m3: dict[PlotId, Amount] = Field(default_factory=dict)


class Violation(PlanningModel):
    slot: int
    constraint: str
    plot_id: str | None = None


class SlotBalance(PlanningModel):
    slot: int
    tank_stock_m3: int
    quota_remaining_m3: int
    pump_m3: int
    delivered_m3: int
    pump_wh: int
    solar_wh: int
    grid_wh: int
    backup_wh: int = 0
    physical_loss_m3: int = 0


class PlotResult(PlanningModel):
    plot_id: str
    farmer_id: str
    delivered_m3: int
    delivered_on_time_m3: int
    deficit_m3: int
    cover_bp: int | None
    reason_code: Literal["shortfall", "no_timely_slot", "timely_window_capacity", "late_or_partial", "covered"]


class Metrics(PlanningModel):
    withdrawn_m3: int
    delivered_m3: int
    grid_wh: int
    pump_wh: int
    peak_grid_w: int
    worst_coverage_bp: int | None


class Simulation(PlanningModel):
    slots: tuple[SlotBalance, ...] = ()
    plot_results: tuple[PlotResult, ...] = ()
    metrics: Metrics | None = None
    violations: tuple[Violation, ...] = ()
    end_state: State | None = None


class Plan(PlanningModel):
    status: PlanStatus
    actions: tuple[Action, ...] | None = None
    slots: tuple[SlotBalance, ...] = ()
    plot_results: tuple[PlotResult, ...] = ()
    metrics: Metrics | None = None
    warnings: tuple[str, ...] = ()


class WeatherComparison(PlanningModel):
    status: PlanStatus
    before_slot: int
    reference_on_adverse: Plan | None = None
    buffer_on_adverse: Plan | None = None
    central_plan: Plan | None = None
    nominal_plan: Plan
    early_pump_m3: int | None = None
    additional_early_pump_m3: int | None = None
    expected_stock_m3: int | None = None
    remaining_deficit_m3: int | None = None
    warnings: tuple[str, ...] = ()


class Provenance(StrEnum):
    OBSERVED = "observed"
    ESTIMATED = "estimated"
    SIMULATED = "simulated"
    UNAVAILABLE = "unavailable"


class LayerId(StrEnum):
    PLOTS = "plots"
    WAPOR = "wapor"
    SOLAR = "solar"
    WIND = "wind"
    ANOMALIES = "anomalies"


class ScenarioRecord(Scenario):
    id: PlotId
    label: PlotId
    site_id: PlotId
    provenance: Provenance
    state: State
    description: str
    weather_pair_id: PlotId | None = None


class OperatingOverrides(PlanningModel):
    pump_max_m3_per_slot: Amount | None = None
    pump_power_cap_w: Amount | None = None
    grid_cap_w: Amount | None = None
    gravity_available: bool = True
    solar_percent: Annotated[int, Field(strict=True, ge=0, le=100)] = 100
    pvgis_option_id: Literal["ombriere", "toiture"] | None = None
    demand_by_plot_m3: dict[PlotId, Amount] = Field(default_factory=dict)


class Incident(PlanningModel):
    kind: Literal["unexpected_outage", "pump_shutdown"]
    start_slot: SlotIndex
    duration_slots: Annotated[int, Field(strict=True, ge=1, le=24)]
    previous_actions: Annotated[tuple[Action, ...], Field(min_length=1, max_length=24)] | None = None


class CompareRequest(PlanningModel):
    scenario_id: PlotId
    state: State
    outage_slots: Annotated[tuple[SlotIndex, ...], Field(max_length=24)]
    solar_option_id: PlotId | None
    restart_grid_cap_w: Amount | None = None
    planning_mode: Literal["nominal", "weather_buffer"] = "nominal"
    weather_pair_id: PlotId | None = None
    overrides: OperatingOverrides = Field(default_factory=OperatingOverrides)
    incident: Incident | None = None


HourOfDay = Annotated[int, Field(strict=True, ge=0, le=23)]
ZoneAmount = Annotated[int, Field(strict=True, ge=0, le=100_000)]


class DemandEstimateRequest(PlanningModel):
    date: Date
    area_m2: Annotated[float, Field(strict=True, gt=0, le=10_000_000, allow_inf_nan=False)]
    crop_coefficient: Annotated[float, Field(strict=True, gt=0, le=3, allow_inf_nan=False)]
    effective_rain_fraction: Annotated[float, Field(strict=True, ge=0, le=1, allow_inf_nan=False)]
    application_efficiency: Annotated[float, Field(strict=True, gt=0, le=1, allow_inf_nan=False)]


class ZonePlanRequest(PlanningModel):
    """Explicit operating assumptions for a historical regional solar replay."""

    date: Date
    tank_capacity_m3: ZoneAmount
    initial_stock_m3: ZoneAmount
    withdrawal_limit_m3: ZoneAmount
    pump_flow_m3_h: ZoneAmount
    pump_wh_per_m3: Annotated[int, Field(strict=True, gt=0, le=100_000)]
    gravity_flow_m3_h: ZoneAmount
    grid_cap_w: Annotated[int, Field(strict=True, ge=0, le=1_000_000_000)]
    pv_capacity_kwp: Annotated[float, Field(strict=True, ge=0, le=10_000, allow_inf_nan=False)]
    pv_performance_ratio: Annotated[float, Field(strict=True, gt=0, le=1, allow_inf_nan=False)]
    demand_west_m3: ZoneAmount
    demand_east_m3: ZoneAmount
    demand_basis: dict[Literal["west", "east"], DemandEstimateRequest] = Field(default_factory=dict)
    delivery_start_hour: HourOfDay
    delivery_end_hour: HourOfDay
    outage_hours: Annotated[tuple[HourOfDay, ...], Field(max_length=24)]

    @model_validator(mode="after")
    def validate_inputs(self) -> Self:
        if self.initial_stock_m3 > self.tank_capacity_m3:
            raise ValueError("Initial stock exceeds the assumed tank capacity.")
        if self.delivery_start_hour > self.delivery_end_hour:
            raise ValueError("The delivery window must end on or after its start hour on the same day.")
        if len(set(self.outage_hours)) != len(self.outage_hours):
            raise ValueError("Outage hours must be distinct.")
        return self


Price = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0, le=1_000_000_000)]
Longitude = Annotated[float, Field(strict=True, ge=-180, le=180)]
Latitude = Annotated[float, Field(strict=True, ge=-90, le=90)]
Position = tuple[Longitude, Latitude]
Ring = Annotated[tuple[Position, ...], Field(min_length=4)]
EVIDENCE_YEAR = Annotated[str, Field(pattern=r"^\d{4}$")]


class Point(PlanningModel):
    type: Literal["Point"]
    coordinates: Position


class Polygon(PlanningModel):
    type: Literal["Polygon"]
    coordinates: Annotated[tuple[Ring, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def check_rings(self) -> Self:
        if any(ring[0] != ring[-1] for ring in self.coordinates):
            raise ValueError("GeoJSON polygon rings must be closed")
        return self


class SiteProperties(PlanningModel):
    site_id: PlotId
    label: PlotId
    source_id: PlotId
    status: Provenance
    locality: str
    description: str
    date: Date
    # Opt in only for the matching fictional geometry bundled with M7.
    relief: Literal["jendouba-demo"] | None = None
    survey_available: bool | None = None
    field_zone: bool | None = None


class LayerProperties(PlanningModel):
    eta_mm_day: Annotated[float, Field(ge=0, allow_inf_nan=False)] | None = None
    label: PlotId
    source_id: PlotId
    status: Provenance | None = None
    date: Date | None = None
    plot_id: PlotId | None = None
    option_id: PlotId | None = None
    crop: str | None = None
    signal: str | None = None
    period: str | None = None
    resolution: str | None = None
    unit: str | None = None


class Feature[T](PlanningModel):
    type: Literal["Feature"]
    geometry: Annotated[Point | Polygon, Field(discriminator="type")]
    properties: T


class Sites(PlanningModel):
    type: Literal["FeatureCollection"]
    features: tuple[Feature[SiteProperties], ...]


class Layer(PlanningModel):
    period: str | None = None
    resolution: str | None = None
    unit: str | None = None
    type: Literal["FeatureCollection"]
    features: tuple[Feature[LayerProperties], ...]
    date: Date | None = None
    source_id: PlotId
    status: Provenance


class Evidence(PlanningModel):
    title: PlotId
    organization: PlotId
    date: Date | EVIDENCE_YEAR | None
    page: str | int | None
    url: HttpUrl | None
    limitation: PlotId


class SolarOption(PlanningModel):
    id: PlotId
    label: PlotId
    source_id: PlotId
    provenance: Provenance
    capacity_kwp: Annotated[float, Field(gt=0, allow_inf_nan=False)]
    tilt_deg: Annotated[int, Field(ge=0, le=90)]
    azimuth_deg: Annotated[int, Field(ge=0, lt=360)]
    losses_pct: Annotated[float, Field(ge=0, lt=100)]
    period: PlotId
    profile_wh: Annotated[tuple[Amount, ...], Field(min_length=24, max_length=24)]
    annual_production_kwh: Price | None = None
    annual_grid_avoided_kwh: Price | None = None
    additional_annual_cost_tnd: Price | None = None
    installation_cost_tnd: Price | None = None


class SolarSite(PlanningModel):
    options: tuple[SolarOption, ...]
    demand_wh: Annotated[tuple[Amount, ...], Field(min_length=24, max_length=24)]
    grid_available: Annotated[tuple[bool, ...], Field(min_length=24, max_length=24)]


class SolarRequest(PlanningModel):
    site_id: PlotId
    option_ids: Annotated[tuple[PlotId, ...], Field(min_length=2, max_length=24)]
    price_tnd_per_kwh: Price | None = None


class SolarResult(SolarOption):
    production_kwh: float
    self_consumed_kwh: float
    grid_avoided_kwh: float
    autonomy_hours: int
    gross_savings_tnd: float | None
    net_savings_tnd: float | None
    payback_years: float | None


class SolarComparison(PlanningModel):
    options: tuple[SolarResult, ...]


class Health(PlanningModel):
    status: Literal["ok"] = "ok"


class EfficiencySample(PlanningModel):
    slot: SlotIndex
    pumped_m3: Amount | None
    consumed_wh: Amount | None


class EfficiencyReadings(PlanningModel):
    source_id: PlotId
    reference_wh_per_m3: Annotated[int, Field(strict=True, gt=0, le=1_000_000_000)]
    samples: tuple[EfficiencySample, ...]

    @model_validator(mode="after")
    def check_order(self) -> Self:
        slots = [sample.slot for sample in self.samples]
        if slots != sorted(set(slots)):
            raise ValueError("efficiency samples must have unique ascending slots")
        return self


class WeatherHour(PlanningModel):
    slot: SlotIndex
    solar_wh: Amount
    temperature_c: Annotated[float, Field(allow_inf_nan=False)] | None = None


class WeatherProfile(PlanningModel):
    id: PlotId
    issued_at: AwareDatetime
    timezone: PlotId
    risk_start_slot: SlotIndex
    source_id: PlotId
    provenance: Literal[Provenance.SIMULATED, Provenance.ESTIMATED]
    slots: Annotated[tuple[WeatherHour, ...], Field(min_length=1, max_length=24)]
    revised_demand_m3: dict[PlotId, Amount] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_profile(self) -> Self:
        try:
            zone = ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as error:
            raise ValueError("unknown weather timezone") from error
        if self.issued_at.astimezone(zone).utcoffset() != self.issued_at.utcoffset():
            raise ValueError("issued_at offset does not match the weather timezone")
        if [slot.slot for slot in self.slots] != list(range(len(self.slots))):
            raise ValueError("weather slots must be consecutive and start at zero")
        if self.risk_start_slot >= len(self.slots):
            raise ValueError("risk_start_slot is outside the weather horizon")
        return self


class WeatherPair(PlanningModel):
    id: PlotId
    central: WeatherProfile
    adverse: WeatherProfile
    reason: PlotId

    @model_validator(mode="after")
    def check_pair(self) -> Self:
        central, adverse = self.central, self.adverse
        if (
            central.id == adverse.id or central.risk_start_slot != adverse.risk_start_slot
            or central.issued_at != adverse.issued_at or central.timezone != adverse.timezone
            or len(central.slots) != len(adverse.slots)
        ):
            raise ValueError("weather profiles must identify the same forecast window")
        if central.slots[:central.risk_start_slot] != adverse.slots[:adverse.risk_start_slot]:
            raise ValueError("weather profiles must agree before the risk window")
        return self


class ActionResult(Action):
    tank_stock_m3: int
    quota_remaining_m3: int
    grid_wh: int


class ApiPlotResult(PlotResult):
    demand_m3: int
    minimum_m3: int
    coverage_bp: int | None
    reason: str | None


class ApiMetrics(Metrics):
    delivered_on_time_m3: int
    tank_stock_m3: int
    quota_remaining_m3: int


class Warning(PlanningModel):
    message: str
    type: str
    source_id: str | None = None
    period: str | None = None
    value: float | None = None
    reference: float | None = None
    unit: str | None = None


class ApiPlan(PlanningModel):
    status: PlanStatus
    actions: tuple[ActionResult, ...] | None = None
    plot_results: tuple[ApiPlotResult, ...] | None = None
    metrics: ApiMetrics | None = None
    warnings: tuple[Warning, ...] = ()


class ApiWeatherComparison(PlanningModel):
    reference_on_adverse: ApiPlan
    buffer_on_adverse: ApiPlan
    early_pump_m3: int
    additional_early_pump_m3: int | None = None
    before_slot: int
    expected_stock_m3: int
    remaining_deficit_m3: int
    quota_remaining_m3: int
    reason: str
    source_id: str
    provenance: Literal[Provenance.SIMULATED, Provenance.ESTIMATED]


class Comparison(PlanningModel):
    baseline: ApiPlan
    optimized: ApiPlan
    weather_comparison: ApiWeatherComparison | None = None
    incident_checkpoint: State | None = None


class Citation(PlanningModel):
    id: str
    source_id: str
    title: str
    organization: str
    date: str | None
    page: str | int | None
    url: HttpUrl
    section: str
    excerpt: str
    limitation: str


class EvidenceSearchRequest(PlanningModel):
    query: Annotated[str, StringConstraints(min_length=3, max_length=600, strip_whitespace=True)]


class DecisionFact(PlanningModel):
    id: str
    text: str
    provenance: Provenance
    source_url: HttpUrl | None = None


class ReplaySelection(PlanningModel):
    plan: Literal["baseline", "optimized"]
    actions: Annotated[tuple[Action, ...], Field(min_length=1, max_length=24)]
    weather_profile: Literal["central", "adverse"] = "central"
    missing_flow_slots: Annotated[tuple[SlotIndex, ...], Field(max_length=24)] = ()
    balance_anomaly_slots: Annotated[tuple[SlotIndex, ...], Field(max_length=24)] = ()


class AssistantTelemetry(ReplaySelection):
    selected_slot: SlotIndex | None = None


class AssistantCityPeriod(PlanningModel):
    start: Date
    end: Date


class RegionalPlanContext(PlanningModel):
    inputs: ZonePlanRequest
    comparison_id: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class AssistantRequest(PlanningModel):
    language: Literal["en", "ja"] = "en"
    provider: Literal["openai", "nvidia"] = "openai"
    question: Annotated[str, StringConstraints(min_length=3, max_length=1600, strip_whitespace=True)]
    site_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    city_id: Annotated[str, Field(pattern=r"^\d{1,12}$")] | None = None
    city_period: AssistantCityPeriod | None = None
    solar_option_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    pvgis_option_id: Literal["ombriere", "toiture"] | None = None
    comparison: CompareRequest | None = None
    zone_plan: RegionalPlanContext | None = None
    telemetry: AssistantTelemetry | None = None
    recent_questions: Annotated[tuple[Annotated[str, StringConstraints(max_length=1600)], ...], Field(max_length=3)] = ()
    session_id: UUID4 | None = None
    selected_scenario_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    simulation_revision: Amount | None = None
    simulation_pending: bool = False


class GroundedParagraph(PlanningModel):
    text: str
    citation_ids: tuple[str, ...]
    fact_ids: tuple[str, ...]


class AssistantAnswer(PlanningModel):
    paragraphs: tuple[GroundedParagraph, ...]
    citations: tuple[Citation, ...]
    facts: tuple[DecisionFact, ...]
    missing_information: tuple[str, ...]
    tools_used: tuple[str, ...]


class IndexStatus(PlanningModel):
    status: Literal["available", "unavailable", "incomplete"]
    documents: int
    expected_chunks: int
    indexed_chunks: int | None = None
    unavailable_sources: tuple[str, ...] = ()


class AssistantHealth(PlanningModel):
    nvidia_model: str | None = None
    status: Literal["available", "unavailable", "incomplete"]
    configured: bool
    index: IndexStatus

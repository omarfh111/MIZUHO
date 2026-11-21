from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    fixed_deliveries: tuple[Delivery | None, ...] = ()

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
        if any(delivery.plot_id not in plot_ids for delivery in self.fixed_deliveries if delivery):
            raise ValueError("fixed delivery refers to an unknown plot")
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
    early_pump_m3: int | None = None
    additional_early_pump_m3: int | None = None
    expected_stock_m3: int | None = None
    remaining_deficit_m3: int | None = None
    warnings: tuple[str, ...] = ()

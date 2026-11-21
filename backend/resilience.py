"""Counterfactual outage experiments using the site's planning inputs and the M4 ledger."""

from contextlib import contextmanager
from threading import BoundedSemaphore
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from ortools.sat.python import cp_model
from pydantic import Field

from .baseline import build_baseline, replay_plan
from .catalog import Catalog
from .compare import InputError, effective_scenario, to_api_plan
from .models import ApiPlan, CompareRequest, HourOfDay, Plan, PlanningModel, Scenario, State, ZonePlanRequest
from .optimizer import add_horizon, optimize
from .simulator import simulate, verified_plan
from .zone_planning import zone_scenario


router = APIRouter(prefix="/api/sites/{site_id}/resilience", tags=["Outage resilience"])
# Each request performs a bounded batch of single-worker CP-SAT solves.
workers = BoundedSemaphore(2)
Duration = Annotated[int, Field(strict=True, ge=1, le=24)]
Threshold = Annotated[int, Field(strict=True, ge=1, le=100)]
ReserveStatus = Literal["minimum", "unreachable", "unknown", "no_target"]


class LabInputs(PlanningModel):
    plan: CompareRequest | ZonePlanRequest
    target_percent: Threshold = 80


class GridInputs(LabInputs):
    starts: Annotated[tuple[HourOfDay, ...], Field(min_length=1, max_length=4)] | None = None
    durations: Annotated[tuple[Duration, ...], Field(min_length=1, max_length=4)] | None = None


class CaseInputs(LabInputs):
    start: HourOfDay
    duration: Duration
    urgent_plot_id: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    loss_m3: Annotated[int, Field(strict=True, ge=0, le=100_000)] = 3
    heat_percent: Annotated[int, Field(strict=True, ge=100, le=300)] = 125
    extra_tank_m3: Annotated[int, Field(strict=True, ge=0, le=100_000)] = 10
    backup_w: Annotated[int, Field(strict=True, ge=0, le=1_000_000)] = 2000


class Cell(PlanningModel):
    start: int
    duration: int
    status: Literal["OPTIMAL", "FEASIBLE", "NO_SOLUTION"]
    coverage_bp: int | None
    deficit_m3: int | None
    reserve_m3: int | None
    reserve_status: ReserveStatus


class OutageGrid(PlanningModel):
    site_id: str
    starts: tuple[int, ...]
    durations: tuple[int, ...]
    target_percent: int
    cells: list[Cell]


class Upgrade(PlanningModel):
    id: Literal["current", "larger_tank", "backup"]
    plan: ApiPlan
    backup_wh: int | None


class HeatDay(PlanningModel):
    day: int
    initial_stock_m3: int | None
    initial_quota_m3: int | None
    end_stock_m3: int | None
    end_quota_m3: int | None
    deficit_m3: int | None
    status: Literal["OPTIMAL", "FEASIBLE", "NO_SOLUTION"]
    plan: ApiPlan | None


class MeterReading(PlanningModel):
    slot: int
    physical_stock_m3: int
    reported_stock_m3: int
    physical_loss_m3: int


class LabIncident(PlanningModel):
    kind: Literal["physical_loss", "meter_error"]
    plan: ApiPlan
    readings: list[MeterReading]


class PlotTarget(PlanningModel):
    plot_id: str
    demand_m3: int
    minimum_m3: int
    deadline_slot: int


class OutageCase(PlanningModel):
    site_id: str
    start: int
    duration: int
    target_percent: int
    urgent_plot_id: str
    plots: list[PlotTarget]
    rules: dict[Literal["fixed", "fair", "urgent"], ApiPlan]
    reserve_m3: int | None
    reserve_status: ReserveStatus
    without_prefill: ApiPlan
    heat_days: list[HeatDay]
    heat_reserved_days: list[HeatDay]
    incidents: list[LabIncident]
    upgrades: list[Upgrade]
    outage_slots: list[int]


@contextmanager
def computation_slot():
    if not workers.acquire(blocking=False):
        raise HTTPException(503, "Two resilience calculations are in progress. Retry shortly.")
    try:
        yield
    finally:
        workers.release()


def resolve(catalog: Catalog, site_id: str, plan: CompareRequest | ZonePlanRequest) -> tuple[Scenario, State]:
    if isinstance(plan, ZonePlanRequest):
        profile = catalog.zone_planning.get(site_id)
        if profile is None:
            raise InputError("plan", "This site has no regional weather and planning archive.")
        scenario, state, _ = zone_scenario(profile, plan)
    else:
        record = catalog.scenarios.get(plan.scenario_id)
        if record is None or record.site_id != site_id:
            raise InputError("plan", "Choose a registered planning scenario for this site.")
        if plan.incident:
            raise InputError("plan", "Complete the separate incident experiment before adding a stress-test outage.")
        scenario, state = effective_scenario(catalog, plan), plan.state
    if state.current_slot >= len(scenario.slots):
        raise InputError("plan", "There are no remaining hours in this scenario.")
    return scenario, state


def with_outage(scenario: Scenario, state: State, start: int, duration: int, inputs: LabInputs) -> Scenario:
    if not state.current_slot <= start < start + duration <= len(scenario.slots):
        raise InputError("start", "The entire outage must fit inside the remaining planning horizon.")
    affected = range(start, start + duration)
    slots = [s.model_copy(update={"grid_available": False}) if s.slot in affected else s for s in scenario.slots]
    if isinstance(inputs.plan, CompareRequest) and inputs.plan.restart_grid_cap_w is not None:
        restart = start + duration
        if restart < len(slots) and slots[restart].grid_available:
            slots[restart] = slots[restart].model_copy(update={
                "grid_cap_w": min(slots[restart].grid_cap_w, inputs.plan.restart_grid_cap_w)})
    return scenario.model_copy(update={"slots": tuple(slots)})


def reserve_for_target(scenario: Scenario, state: State, start: int, target: int,
                       budget: float) -> tuple[int | None, ReserveStatus]:
    if not any(plot.minimum_m3 for plot in scenario.plots):
        return None, "no_target"
    if budget <= 0:
        return None, "unknown"
    model = cp_model.CpModel()
    horizon = add_horizon(model, scenario, state, "reserve")
    model.add(horizon.coverage >= target * 100)
    # Initial water can exceed what the target needs. Leave the surplus physically in the tank
    # (including its capacity constraint) and require that the witness never draws on it.
    untouched = model.new_int_var(0, scenario.site.tank_capacity_m3, "untouched_stock")
    model.add(untouched <= horizon.opening_stock[start])
    for hour, closing in horizon.closing_stock.items():
        if hour >= start:
            model.add(closing >= untouched)
    required = horizon.opening_stock[start] - untouched
    model.minimize(required)
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.max_time_in_seconds = budget
    status = solver.solve(model)
    if status == cp_model.INFEASIBLE:
        return None, "unreachable"
    if status != cp_model.OPTIMAL:
        return None, "unknown"
    ledger = simulate(scenario, state, horizon.actions(solver))
    if ledger.violations or ledger.metrics is None or ledger.metrics.worst_coverage_bp < target * 100:
        raise RuntimeError("The reserve witness failed physical replay.")
    opening = state.tank_stock_m3 if start == state.current_slot else next(
        slot.tank_stock_m3 for slot in ledger.slots if slot.slot == start - 1)
    reserve = opening - min(opening, *(s.tank_stock_m3 for s in ledger.slots if s.slot >= start))
    if reserve != solver.value(required):
        raise RuntimeError("The reserve witness failed physical replay.")
    return reserve, "minimum"


def total_deficit(plan: Plan) -> int | None:
    return None if plan.metrics is None else sum(plot.deficit_m3 for plot in plan.plot_results)


def default_axes(first: int, end: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    # Permit all row × column combinations, even on a partial operating day.
    remaining = end - first
    largest = min(8, max(1, remaining - 3))
    durations = tuple(d for d in (1, 2, 4, 8) if d <= largest)
    last = end - durations[-1]
    starts = tuple(sorted({first + (last - first) * step // 3 for step in range(4)}))
    if first == 0 and end == 24:
        starts = (6, 9, 11, 16)
    return starts, durations


@router.post("/grid")
def outage_grid(request: Request, site_id: str, body: GridInputs) -> OutageGrid:
    scenario, state = resolve(request.app.state.catalog, site_id, body.plan)
    starts, durations = default_axes(state.current_slot, len(scenario.slots))
    starts, durations = body.starts or starts, body.durations or durations
    if len(set(starts)) != len(starts) or len(set(durations)) != len(durations):
        raise InputError("starts", "Select distinct outage starts and durations.")
    budget = min(request.app.state.resilience_budget, 0.55)
    cells = []
    with computation_slot():
        for start in starts:
            for duration in durations:
                disrupted = with_outage(scenario, state, start, duration, body)
                plan = optimize(disrupted, state, max_time_seconds=budget)
                reserve, status = reserve_for_target(disrupted, state, start, body.target_percent, budget)
                cells.append(Cell(start=start, duration=duration, coverage_bp=plan.metrics.worst_coverage_bp if plan.metrics else None,
                                  deficit_m3=total_deficit(plan), status=plan.status, reserve_m3=reserve, reserve_status=status))
    return OutageGrid(site_id=site_id, starts=starts, durations=durations, target_percent=body.target_percent, cells=cells)


def matched_incidents(scenario: Scenario, state: State, fair: Plan, inputs: CaseInputs) -> list[LabIncident]:
    if fair.actions is None:
        return []
    # Both incidents begin with the same fair plan. The physical loss is taken once from available
    # opening stock, then remaining requests replay under the diminished stock. A sensor can only alter a reading.
    leaking = scenario.model_copy(update={"slots": tuple(
        slot.model_copy(update={"tank_loss_m3": inputs.loss_m3}) if slot.slot == inputs.start else slot
        for slot in scenario.slots)})
    after_loss = replay_plan(leaking, state, fair.actions)
    incidents = []
    for kind, physical, plan in (("physical_loss", leaking, after_loss), ("meter_error", scenario, fair)):
        readings = [MeterReading(slot=row.slot, physical_stock_m3=row.tank_stock_m3,
                                 reported_stock_m3=max(0, row.tank_stock_m3 - (
                                     inputs.loss_m3 if kind == "meter_error" and row.slot == inputs.start else 0)),
                                 physical_loss_m3=row.physical_loss_m3) for row in plan.slots]
        incidents.append(LabIncident(kind=kind, plan=to_api_plan(physical, state, plan), readings=readings))
    return incidents


def heat_replay(scenario: Scenario, state: State, percent: int, budget: float, *, pace_quota: bool = False) -> list[HeatDay]:
    if state.current_slot != 0 or len(scenario.slots) != 24:
        return []
    hotter = scenario.model_copy(update={"plots": tuple(plot.model_copy(update={
        "minimum_m3": (plot.minimum_m3 * percent + 99) // 100,
        "demand_m3": (plot.demand_m3 * percent + 99) // 100,
    }) for plot in scenario.plots)})
    days = []
    checkpoint: State | None = state
    for day in (1, 2, 3):
        plan = Plan(status="NO_SOLUTION")
        if checkpoint is not None:
            allowance = checkpoint.quota_remaining_m3 // (4 - day) if pace_quota else checkpoint.quota_remaining_m3
            operating = checkpoint.model_copy(update={"quota_remaining_m3": allowance})
            plan = optimize(hotter, operating, max_time_seconds=budget)
            if pace_quota and plan.actions is not None:
                plan = verified_plan(hotter, checkpoint, plan.actions, plan.status,
                                     warnings=tuple(w for w in plan.warnings if w == "optimizer_not_proven_optimal"))
        end = plan.slots[-1] if plan.slots else None
        # The daily allowance is a constraint, never a new quota. Unused water rights carry forward.
        remaining = checkpoint.quota_remaining_m3 - plan.metrics.withdrawn_m3 if checkpoint and plan.metrics else None
        days.append(HeatDay(day=day, initial_stock_m3=checkpoint.tank_stock_m3 if checkpoint else None,
                            initial_quota_m3=checkpoint.quota_remaining_m3 if checkpoint else None,
                            end_stock_m3=end.tank_stock_m3 if end else None, end_quota_m3=remaining,
                            status=plan.status, deficit_m3=total_deficit(plan),
                            plan=to_api_plan(hotter, checkpoint, plan) if end else None))
        checkpoint = State(current_slot=0, tank_stock_m3=end.tank_stock_m3, quota_remaining_m3=remaining) if end else None
    return days


@router.post("/case")
def outage_case(request: Request, site_id: str, body: CaseInputs) -> OutageCase:
    base, state = resolve(request.app.state.catalog, site_id, body.plan)
    scenario = with_outage(base, state, body.start, body.duration, body)
    plots = scenario.plots
    urgent = body.urgent_plot_id or min(plots, key=lambda p: (p.deadline_slot, p.plot_id)).plot_id
    if urgent not in {plot.plot_id for plot in plots}:
        raise InputError("urgent_plot_id", "Choose a plot from the selected site and scenario.")
    budget = min(request.app.state.resilience_budget, 0.55)
    with computation_slot():
        fair = optimize(scenario, state, max_time_seconds=budget)
        fixed = build_baseline(scenario, state)
        priority = optimize(scenario, state, max_time_seconds=budget, urgent_plot_id=urgent)
        reserve, status = reserve_for_target(scenario, state, body.start, body.target_percent, budget)
        limits = {i: scenario.fixed_pump_m3[i] if scenario.fixed_pump_m3 else 0
                  for i in range(state.current_slot, body.start)}
        no_prefill = optimize(scenario, state, max_time_seconds=budget, prefill_limits=limits)
        larger_tank = scenario.model_copy(update={"site": scenario.site.model_copy(update={
            "tank_capacity_m3": scenario.site.tank_capacity_m3 + body.extra_tank_m3})})
        backed_up = scenario.model_copy(update={"slots": tuple(slot.model_copy(update={
            "island_backup_w": body.backup_w}) if not slot.grid_available else slot for slot in scenario.slots)})
        upgrades = []
        for name, variant in (("current", scenario), ("larger_tank", larger_tank), ("backup", backed_up)):
            plan = fair if name == "current" else optimize(variant, state, max_time_seconds=budget)
            upgrades.append(Upgrade(id=name, plan=to_api_plan(variant, state, plan),
                                    backup_wh=sum(row.backup_wh for row in plan.slots) if plan.metrics else None))
        incidents = matched_incidents(scenario, state, fair, body)
        days = heat_replay(scenario, state, body.heat_percent, budget)
        paced = heat_replay(scenario, state, body.heat_percent, budget, pace_quota=True)
    return OutageCase(site_id=site_id, start=body.start, duration=body.duration, target_percent=body.target_percent,
                      urgent_plot_id=urgent, plots=[PlotTarget(**p.model_dump(include=set(PlotTarget.model_fields))) for p in plots],
                      rules={"fair": to_api_plan(scenario, state, fair), "fixed": to_api_plan(scenario, state, fixed),
                             "urgent": to_api_plan(scenario, state, priority)}, reserve_m3=reserve, reserve_status=status,
                      without_prefill=to_api_plan(scenario, state, no_prefill), upgrades=upgrades, incidents=incidents,
                      heat_days=days, heat_reserved_days=paced, outage_slots=[s.slot for s in scenario.slots if not s.grid_available])

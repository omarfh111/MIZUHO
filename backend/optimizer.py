from collections.abc import Callable
from dataclasses import dataclass
from math import isfinite
from time import monotonic

from ortools.sat.python import cp_model

from .models import Action, Delivery, Plan, PlanStatus, Scenario, State
from .simulator import available_power, pump_limit, validate_state, verified_plan


@dataclass
class Horizon:
    pumps: dict[int, cp_model.IntVar]
    deliveries: dict[tuple[int, str], cp_model.IntVar]
    coverage: cp_model.IntVar
    deficit: cp_model.LinearExpr | int
    peak: cp_model.IntVar
    grid: cp_model.LinearExpr | int
    backup: cp_model.LinearExpr | int
    opening_stock: dict[int, cp_model.IntVar | int]
    closing_stock: dict[int, cp_model.IntVar]

    def actions(self, solver: cp_model.CpSolver) -> tuple[Action, ...]:
        by_slot: dict[int, list[Delivery]] = {slot: [] for slot in self.pumps}
        for (slot, plot_id), variable in self.deliveries.items():
            volume = solver.value(variable)
            if volume:
                by_slot[slot].append(Delivery(plot_id=plot_id, delivered_m3=volume))
        return tuple(Action(
            slot=slot, pump_m3=solver.value(pump), deliveries=by_slot[slot],
        ) for slot, pump in self.pumps.items())


def add_horizon(model: cp_model.CpModel, scenario: Scenario, state: State, name: str) -> Horizon:
    site = scenario.site
    pumps = {}
    deliveries = {}
    grid = []
    backup = []
    stock = state.tank_stock_m3
    highest_grid_cap = 0
    opening_stock = {}
    closing_stock = {}
    for slot in scenario.slots[state.current_slot:]:
        index = slot.slot
        opening_stock[index] = stock
        if slot.tank_loss_m3:
            after_loss = model.new_int_var(0, site.tank_capacity_m3, f"{name}_after_loss_{index}")
            model.add_max_equality(after_loss, [0, stock - slot.tank_loss_m3])
            stock = after_loss
        solar, dispatchable_cap = available_power(slot)
        if slot.grid_available:
            highest_grid_cap = max(highest_grid_cap, dispatchable_cap)
        pump = model.new_int_var(0, pump_limit(site, slot), f"{name}_pump_{index}")
        pumps[index] = pump
        model.add(stock + pump <= site.tank_capacity_m3)
        supply_wh = model.new_int_var(0, dispatchable_cap, f"{name}_dispatchable_{index}")
        model.add_max_equality(supply_wh, (0, pump * site.pump_wh_per_m3 - solar))
        if slot.grid_available:
            grid.append(supply_wh)
        elif dispatchable_cap:
            backup.append(supply_wh)

        used = []
        volumes = []
        for plot in scenario.plots:
            if not slot.gravity_available or index not in plot.allowed_slots:
                continue
            limit = min(site.gravity_max_m3_per_slot,
                        plot.demand_m3 - state.delivered_by_plot_m3.get(plot.plot_id, 0))
            if not limit:
                continue
            label = f"{name}_{index}_{plot.plot_id}"
            active = model.new_bool_var(f"serve_{label}")
            volume = model.new_int_var(0, limit, f"volume_{label}")
            model.add(volume <= limit * active)
            model.add(volume >= active)
            used.append(active)
            volumes.append(volume)
            deliveries[index, plot.plot_id] = volume
        model.add(sum(used) <= 1)
        next_stock = model.new_int_var(0, site.tank_capacity_m3, f"{name}_stock_{index}")
        model.add(next_stock == stock + pump - sum(volumes))
        stock = next_stock
        closing_stock[index] = next_stock
    model.add(sum(pumps.values()) <= state.quota_remaining_m3)

    coverage = model.new_int_var(0, 10_000, f"{name}_worst_coverage")
    deficits = []
    for plot in scenario.plots:
        remaining = plot.demand_m3 - state.delivered_by_plot_m3.get(plot.plot_id, 0)
        volumes = [(index, volume) for (index, plot_id), volume in deliveries.items()
                   if plot_id == plot.plot_id]
        model.add(sum(volume for _, volume in volumes) <= remaining)
        if not plot.minimum_m3:
            continue
        timely = state.delivered_on_time_by_plot_m3.get(plot.plot_id, 0) + sum(
            volume for index, volume in volumes if index <= plot.deadline_slot
        )
        model.add(10_000 * timely >= coverage * plot.minimum_m3)
        shortfall = model.new_int_var(0, plot.minimum_m3, f"{name}_shortfall_{plot.plot_id}")
        model.add_max_equality(shortfall, (0, plot.minimum_m3 - timely))
        deficits.append((1 + plot.past_deferrals) * shortfall)

    peak = model.new_int_var(0, highest_grid_cap, f"{name}_peak")
    model.add_max_equality(peak, grid or [0])
    return Horizon(pumps, deliveries, coverage, sum(deficits), peak, sum(grid), sum(backup), opening_stock, closing_stock)


def solve_lexicographically[T](
    model: cp_model.CpModel,
    objectives: list[cp_model.LinearExpr | int],
    snapshot: Callable[[cp_model.CpSolver], T],
    max_time_seconds: float,
) -> tuple[PlanStatus, T | None]:
    if not isfinite(max_time_seconds) or max_time_seconds < 0:
        raise ValueError("max_time_seconds must be finite and nonnegative")
    deadline = monotonic() + max_time_seconds
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    best = None
    for objective in objectives:
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        solver.parameters.max_time_in_seconds = remaining
        model.minimize(objective)
        status = solver.solve(model)
        if status == cp_model.MODEL_INVALID:
            raise ValueError(f"invalid planning model: {model.validate()}")
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        best = snapshot(solver)
        if status == cp_model.FEASIBLE:
            return "FEASIBLE", best
        model.add(objective == solver.value(objective))
    else:
        return "OPTIMAL", best
    return ("NO_SOLUTION", None) if best is None else ("FEASIBLE", best)


def optimize(
    scenario: Scenario,
    state: State,
    *,
    max_time_seconds: float = 5.0,
    prefer_late_before: int | None = None,
    urgent_plot_id: str | None = None,
    prefill_limits: dict[int, int] | None = None,
) -> Plan:
    validate_state(scenario, state)
    model = cp_model.CpModel()
    horizon = add_horizon(model, scenario, state, "plan")
    for slot, limit in (prefill_limits or {}).items():
        model.add(horizon.pumps[slot] <= limit)
    objectives = [
        -horizon.coverage, horizon.deficit, -sum(horizon.deliveries.values()),
        horizon.peak, horizon.grid,
    ]
    if urgent_plot_id is not None:
        priority = next(plot for plot in scenario.plots if plot.plot_id == urgent_plot_id)
        objectives.insert(0, -sum(volume for (slot, plot_id), volume in horizon.deliveries.items()
                                  if plot_id == priority.plot_id and slot <= priority.deadline_slot))
    if any(not slot.grid_available and slot.island_backup_w for slot in scenario.slots[state.current_slot:]):
        objectives.append(horizon.backup)
    objectives.append(sum(horizon.pumps.values()))
    if prefer_late_before is not None:
        objectives.append(sum(pump for slot, pump in horizon.pumps.items() if slot < prefer_late_before))
    status, actions = solve_lexicographically(model, objectives, horizon.actions, max_time_seconds)
    if actions is None:
        return Plan(status="NO_SOLUTION", warnings=("optimizer_no_solution",))
    warnings = ("optimizer_not_proven_optimal",) if status == "FEASIBLE" else ()
    return verified_plan(scenario, state, actions, status, warnings)

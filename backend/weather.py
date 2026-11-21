from math import isfinite
from time import monotonic

from ortools.sat.python import cp_model

from .baseline import replay_plan
from .optimizer import add_horizon, optimize, solve_lexicographically
from .models import Action, Scenario, State, WeatherComparison
from .simulator import validate_state, verified_plan


def compare_weather(
    central: Scenario,
    adverse: Scenario,
    state: State,
    *,
    risk_start_slot: int,
    max_time_seconds: float = 5.0,
) -> WeatherComparison:
    """Plan one shared prefix and adapt the rest after the weather becomes known."""
    validate_pair(central, adverse, state, risk_start_slot)
    if not isfinite(max_time_seconds) or max_time_seconds < 0:
        raise ValueError("max_time_seconds must be finite and nonnegative")
    deadline = monotonic() + max_time_seconds
    nominal = optimize(
        central, state, max_time_seconds=max_time_seconds / 2,
        prefer_late_before=risk_start_slot,
    )
    reference = replay_plan(adverse, state, nominal.actions) if nominal.actions is not None else None
    warnings = () if nominal.status == "OPTIMAL" else (f"nominal_optimizer_{nominal.status.lower()}",)

    model = cp_model.CpModel()
    central_horizon = add_horizon(model, central, state, "central")
    adverse_horizon = add_horizon(model, adverse, state, "adverse")
    early_slots = range(state.current_slot, risk_start_slot)
    for slot in early_slots:
        model.add(central_horizon.pumps[slot] == adverse_horizon.pumps[slot])
        for plot in central.plots:
            key = (slot, plot.plot_id)
            model.add(central_horizon.deliveries.get(key, 0) == adverse_horizon.deliveries.get(key, 0))

    coverage = model.new_int_var(0, 10_000, "both_profiles_coverage")
    model.add_min_equality(coverage, (central_horizon.coverage, adverse_horizon.coverage))
    deficit_limit = max(
        sum((1 + plot.past_deferrals) * plot.minimum_m3 for plot in scenario.plots)
        for scenario in (central, adverse)
    )
    deficit = model.new_int_var(0, deficit_limit, "largest_weighted_deficit")
    model.add_max_equality(deficit, (central_horizon.deficit, adverse_horizon.deficit))
    early = sum(central_horizon.pumps[slot] for slot in early_slots)
    peak = model.new_int_var(0, max(slot.grid_cap_w for slot in (*central.slots, *adverse.slots)),
                             "largest_grid_peak")
    model.add_max_equality(peak, (central_horizon.peak, adverse_horizon.peak))
    objectives = [
        -coverage,
        deficit,
        central_horizon.deficit + adverse_horizon.deficit,
        early,
        peak,
        central_horizon.grid + adverse_horizon.grid,
        sum(central_horizon.pumps.values()) + sum(adverse_horizon.pumps.values()),
        -sum(central_horizon.deliveries.values()) - sum(adverse_horizon.deliveries.values()),
    ]
    status, pair = solve_lexicographically(
        model, objectives,
        lambda solver: (central_horizon.actions(solver), adverse_horizon.actions(solver)),
        max(0, deadline - monotonic()),
    )
    if pair is None:
        return WeatherComparison(
            status="NO_SOLUTION", before_slot=risk_start_slot, reference_on_adverse=reference,
            nominal_plan=nominal,
            warnings=(*warnings, "weather_optimizer_no_solution"),
        )
    if status == "FEASIBLE":
        warnings = (*warnings, "weather_optimizer_not_proven_optimal")
    central_plan = verified_plan(central, state, pair[0], status)
    adverse_plan = verified_plan(adverse, state, pair[1], status)
    stock = (
        adverse_plan.slots[risk_start_slot - state.current_slot - 1].tank_stock_m3
        if early_slots else state.tank_stock_m3
    )
    early_volume = volume_before(pair[1], risk_start_slot)
    extra_volume = (
        max(0, early_volume - volume_before(nominal.actions, risk_start_slot))
        if nominal.actions is not None else None
    )
    return WeatherComparison(
        status=status, before_slot=risk_start_slot, reference_on_adverse=reference,
        buffer_on_adverse=adverse_plan, central_plan=central_plan,
        nominal_plan=nominal,
        early_pump_m3=early_volume, additional_early_pump_m3=extra_volume,
        expected_stock_m3=stock, remaining_deficit_m3=sum(plot.deficit_m3 for plot in adverse_plan.plot_results),
        warnings=(*warnings, *adverse_plan.warnings),
    )


def validate_pair(central: Scenario, adverse: Scenario, state: State, risk_start_slot: int) -> None:
    for scenario in (central, adverse):
        validate_state(scenario, state)
    if central.site != adverse.site or len(central.slots) != len(adverse.slots):
        raise ValueError("weather scenarios must use the same equipment and time horizon")
    if plot_rules(central) != plot_rules(adverse):
        raise ValueError("weather scenarios must refer to the same plots and schedule rules")
    if type(risk_start_slot) is not int or not state.current_slot <= risk_start_slot < len(central.slots):
        raise ValueError("risk_start_slot must be in the remaining horizon")
    prefix = slice(state.current_slot, risk_start_slot)
    if central.slots[prefix] != adverse.slots[prefix]:
        raise ValueError("weather scenarios must have the same slot conditions before the risk window")


def volume_before(actions: tuple[Action, ...], slot: int) -> int:
    return sum(action.pump_m3 for action in actions if action.slot < slot)


def plot_rules(scenario: Scenario) -> dict[str, tuple]:
    return {plot.plot_id: (plot.farmer_id, frozenset(plot.allowed_slots),
                           plot.deadline_slot, plot.past_deferrals)
            for plot in scenario.plots}

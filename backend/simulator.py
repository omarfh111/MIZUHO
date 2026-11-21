from collections.abc import Sequence

from .metrics import summarize_plots, summarize_slots
from .planning_models import (
    Action, Plan, PlanStatus, Scenario, Simulation, Site, Slot, SlotBalance, State, Violation,
)


def available_power(slot: Slot) -> tuple[int, int]:
    """Return usable solar Wh and the grid limit in Wh for this one-hour slot."""
    return (slot.solar_wh, slot.grid_cap_w) if slot.grid_available else (0, 0)


def pump_limit(site: Site, slot: Slot) -> int:
    return min(site.pump_max_m3_per_slot, sum(available_power(slot)) // site.pump_wh_per_m3)


def validate_state(scenario: Scenario, state: State) -> None:
    if state.current_slot > len(scenario.slots):
        raise ValueError("current_slot is outside the horizon")
    if state.tank_stock_m3 > scenario.site.tank_capacity_m3:
        raise ValueError("tank_stock_m3 exceeds tank capacity")
    plots = {plot.plot_id: plot for plot in scenario.plots}
    history = state.delivered_by_plot_m3.keys() | state.delivered_on_time_by_plot_m3.keys()
    gravity = scenario.site.gravity_max_m3_per_slot
    occupied_slots: list[list[int]] = []
    for plot_id in history:
        plot = plots.get(plot_id)
        if plot is None:
            raise ValueError(f"history contains an unknown plot: {plot_id}")
        total = state.delivered_by_plot_m3.get(plot_id, 0)
        timely = state.delivered_on_time_by_plot_m3.get(plot_id, 0)
        if not 0 <= timely <= total <= plot.demand_m3:
            raise ValueError(f"inconsistent delivery history for {plot_id}")
        past_slots = [slot for slot in plot.allowed_slots if slot < state.current_slot]
        on_time_slots = [slot for slot in past_slots if slot <= plot.deadline_slot]
        late_slots = [slot for slot in past_slots if slot > plot.deadline_slot]
        for requested, candidates in ((timely, on_time_slots), (total - timely, late_slots)):
            if requested > len(candidates) * gravity:
                raise ValueError(f"delivery history is impossible for {plot_id}")
            if requested:
                required_slots = (requested + gravity - 1) // gravity
                occupied_slots.extend([candidates] * required_slots)
    if not can_allocate_history(occupied_slots, state.current_slot):
        raise ValueError("delivery history exceeds the shared past slots")


def can_allocate_history(requests: list[list[int]], past_slot_count: int) -> bool:
    if len(requests) > past_slot_count:
        return False
    # A past slot can belong to only one delivery. Reassign flexible deliveries if needed.
    owners: dict[int, int] = {}

    def allocate(request: int, visited: set[int]) -> bool:
        for slot in requests[request]:
            if slot in visited:
                continue
            visited.add(slot)
            owner = owners.get(slot)
            if owner is None or allocate(owner, visited):
                owners[slot] = request
                return True
        return False

    return all(allocate(request, set()) for request in range(len(requests)))


def simulate(
    scenario: Scenario,
    state: State,
    actions: Sequence[Action],
    *,
    stop_before_slot: int | None = None,
) -> Simulation:
    """Replay completed actions up to an exclusive slot and return the resulting state."""
    validate_state(scenario, state)
    end_slot = len(scenario.slots) if stop_before_slot is None else stop_before_slot
    if type(end_slot) is not int or not state.current_slot <= end_slot <= len(scenario.slots):
        raise ValueError("stop_before_slot is outside the remaining horizon")
    indexed = {}
    for action in actions:
        if not state.current_slot <= action.slot < end_slot:
            return invalid([], action.slot, "slot")
        if action.slot in indexed:
            return invalid([], action.slot, "duplicate_action")
        indexed[action.slot] = action

    site = scenario.site
    plots = {plot.plot_id: plot for plot in scenario.plots}
    delivered = dict(state.delivered_by_plot_m3)
    on_time = dict(state.delivered_on_time_by_plot_m3)
    stock, quota = state.tank_stock_m3, state.quota_remaining_m3
    balances: list[SlotBalance] = []
    for slot in scenario.slots[state.current_slot:end_slot]:
        action = indexed.get(slot.slot) or Action(slot=slot.slot)
        stock_before = stock
        solar_available, grid_limit = available_power(slot)
        pumped = action.pump_m3
        pump_wh = pumped * site.pump_wh_per_m3
        limits = (
            (site.pump_max_m3_per_slot, "pump_flow"),
            (quota, "quota"),
            (site.tank_capacity_m3 - stock, "tank_capacity"),
        )
        for limit, constraint in limits:
            if pumped > limit:
                return invalid(balances, slot.slot, constraint)
        if pump_wh > solar_available + grid_limit:
            return invalid(balances, slot.slot, "power")
        stock += pumped
        quota -= pumped

        deliveries = [delivery for delivery in action.deliveries if delivery.delivered_m3]
        if len(deliveries) > 1:
            return invalid(balances, slot.slot, "one_plot_per_slot")
        volume = 0
        if deliveries:
            delivery = deliveries[0]
            plot = plots.get(delivery.plot_id)
            if plot is None:
                return invalid(balances, slot.slot, "plot", delivery.plot_id)
            volume = delivery.delivered_m3
            prior = delivered.get(plot.plot_id, 0)
            if slot.slot not in plot.allowed_slots:
                return invalid(balances, slot.slot, "allowed_slot", plot.plot_id)
            limits = (
                (site.gravity_max_m3_per_slot, "gravity_flow"),
                (stock, "stock"),
                (plot.demand_m3 - prior, "demand"),
            )
            for limit, constraint in limits:
                if volume > limit:
                    return invalid(balances, slot.slot, constraint, plot.plot_id)
            delivered[plot.plot_id] = prior + volume
            if slot.slot <= plot.deadline_slot:
                on_time[plot.plot_id] = on_time.get(plot.plot_id, 0) + volume
            stock -= volume

        solar_used = min(pump_wh, solar_available)
        balances.append(SlotBalance(
            slot=slot.slot, tank_stock_before_m3=stock_before, tank_stock_m3=stock,
            quota_remaining_m3=quota, pump_m3=pumped, delivered_m3=volume,
            deliveries=tuple(deliveries), pump_wh=pump_wh,
            solar_wh=solar_used, grid_wh=pump_wh - solar_used,
            solar_available_wh=solar_available, grid_available=slot.grid_available,
            grid_cap_w=grid_limit,
        ))
    plot_results = summarize_plots(scenario, state, delivered, on_time)
    return Simulation(
        slots=tuple(balances), plot_results=plot_results, metrics=summarize_slots(balances, plot_results),
        end_state=State(
            current_slot=end_slot, tank_stock_m3=stock, quota_remaining_m3=quota,
            delivered_by_plot_m3=delivered, delivered_on_time_by_plot_m3=on_time,
        ),
    )


def invalid(
    balances: list[SlotBalance], slot: int, constraint: str, plot_id: str | None = None
) -> Simulation:
    return Simulation(slots=tuple(balances), violations=(Violation(
        slot=slot, constraint=constraint, plot_id=plot_id,
    ),))


def verified_plan(
    scenario: Scenario, state: State, actions: Sequence[Action], status: PlanStatus,
    warnings: tuple[str, ...] = (),
) -> Plan:
    result = simulate(scenario, state, actions)
    if result.violations:
        raise ValueError(f"cannot publish an invalid plan: {result.violations[0]}")
    if any(plot.deficit_m3 for plot in result.plot_results):
        warnings = (*warnings, *shortfall_warnings(scenario, state))
    return Plan(
        status=status, actions=tuple(actions), slots=result.slots,
        plot_results=result.plot_results, metrics=result.metrics, warnings=warnings,
    )


def shortfall_warnings(scenario: Scenario, state: State) -> tuple[str, ...]:
    required_by_deadline: dict[int, int] = {}
    for plot in scenario.plots:
        prior = state.delivered_on_time_by_plot_m3.get(plot.plot_id, 0)
        outstanding = max(0, plot.minimum_m3 - prior)
        required_by_deadline[plot.deadline_slot] = required_by_deadline.get(plot.deadline_slot, 0) + outstanding
    required = sum(required_by_deadline.values())
    remaining = scenario.slots[state.current_slot:]
    warnings = ["timely_coverage_shortfall"]
    if state.tank_stock_m3 + state.quota_remaining_m3 < required:
        warnings.append("stock_and_quota_below_minimum")
    if len(remaining) * scenario.site.gravity_max_m3_per_slot < required:
        warnings.append("gravity_capacity_below_minimum")
    if state.tank_stock_m3 + sum(pump_limit(scenario.site, slot) for slot in remaining) < required:
        warnings.append("pumping_capacity_below_minimum")
    cumulative = 0
    for deadline, due in sorted(required_by_deadline.items()):
        cumulative += due
        pumped_by_deadline = sum(
            pump_limit(scenario.site, slot) for slot in remaining if slot.slot <= deadline
        )
        if state.tank_stock_m3 + pumped_by_deadline < cumulative:
            warnings.append("pumping_capacity_before_deadline")
            break
    return tuple(warnings)

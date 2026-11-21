from collections.abc import Sequence

from .models import Action, Delivery, Plan, Scenario, State
from .simulator import pump_limit, validate_state, verified_plan


def build_baseline(scenario: Scenario, state: State) -> Plan:
    validate_state(scenario, state)
    if not scenario.fixed_pump_m3 or not scenario.fixed_deliveries:
        return Plan(status="NO_SOLUTION", warnings=("fixed_schedule_unavailable",))
    requests = tuple(
        Action(
            slot=slot.slot,
            pump_m3=scenario.fixed_pump_m3[slot.slot],
            deliveries=scenario.fixed_deliveries[slot.slot],
        )
        for slot in scenario.slots[state.current_slot:]
    )
    return replay_plan(scenario, state, requests)


def replay_plan(scenario: Scenario, state: State, requests: Sequence[Action]) -> Plan:
    """Keep planned times and reduce requests to what the site can actually serve."""
    validate_state(scenario, state)
    site = scenario.site
    plots = {plot.plot_id: plot for plot in scenario.plots}
    delivered = dict(state.delivered_by_plot_m3)
    indexed = {action.slot: action for action in requests}
    stock, quota = state.tank_stock_m3, state.quota_remaining_m3
    actions = []
    for slot in scenario.slots[state.current_slot:]:
        request = indexed.get(slot.slot) or Action(slot=slot.slot)
        pumped = min(request.pump_m3, pump_limit(site, slot), site.tank_capacity_m3 - stock, quota)
        stock += pumped
        quota -= pumped
        deliveries = ()
        positive_requests = [delivery for delivery in request.deliveries if delivery.delivered_m3]
        if len(positive_requests) > 1:
            raise ValueError(f"only one plot can be served in slot {slot.slot}")
        if positive_requests:
            wanted = positive_requests[0]
            plot = plots[wanted.plot_id]
            prior = delivered.get(plot.plot_id, 0)
            if slot.gravity_available and slot.slot in plot.allowed_slots:
                volume = min(wanted.delivered_m3, site.gravity_max_m3_per_slot, stock, plot.demand_m3 - prior)
                if volume:
                    delivered[plot.plot_id] = prior + volume
                    stock -= volume
                    deliveries = (Delivery(plot_id=plot.plot_id, delivered_m3=volume),)
        actions.append(Action(slot=slot.slot, pump_m3=pumped, deliveries=deliveries))
    return verified_plan(scenario, state, actions, "FEASIBLE")

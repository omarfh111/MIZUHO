from .models import Metrics, PlotResult, Scenario, SlotBalance, State


def summarize_plots(
    scenario: Scenario, state: State, delivered: dict[str, int], on_time: dict[str, int]
) -> tuple[PlotResult, ...]:
    results = []
    for plot in scenario.plots:
        total = delivered.get(plot.plot_id, 0)
        timely = on_time.get(plot.plot_id, 0)
        deficit = max(0, plot.minimum_m3 - timely)
        coverage = min(10_000, timely * 10_000 // plot.minimum_m3) if plot.minimum_m3 else None
        reason = "shortfall" if deficit else "late_or_partial" if total < plot.demand_m3 else "covered"
        if deficit:
            windows = sum(state.current_slot <= slot <= plot.deadline_slot and scenario.slots[slot].gravity_available
                          for slot in plot.allowed_slots)
            starting_volume = state.delivered_on_time_by_plot_m3.get(plot.plot_id, 0)
            if windows == 0:
                reason = "no_timely_slot"
            elif starting_volume + windows * scenario.site.gravity_max_m3_per_slot < plot.minimum_m3:
                reason = "timely_window_capacity"
        results.append(PlotResult(
            plot_id=plot.plot_id,
            farmer_id=plot.farmer_id,
            delivered_m3=total,
            delivered_on_time_m3=timely,
            deficit_m3=deficit,
            cover_bp=coverage,
            reason_code=reason,
        ))
    return tuple(results)


def summarize_slots(slots: list[SlotBalance], plots: tuple[PlotResult, ...]) -> Metrics:
    return Metrics(
        withdrawn_m3=sum(slot.pump_m3 for slot in slots),
        delivered_m3=sum(slot.delivered_m3 for slot in slots),
        grid_wh=sum(slot.grid_wh for slot in slots),
        pump_wh=sum(slot.pump_wh for slot in slots),
        peak_grid_w=max((slot.grid_wh for slot in slots), default=0),
        worst_coverage_bp=min((plot.cover_bp for plot in plots if plot.cover_bp is not None), default=None),
    )

from .planning_models import PlotResult, Site, SlotBalance, State


def analyze_water(slots: tuple[SlotBalance, ...], site: Site, initial: State) -> dict:
    stock, quota = initial.tank_stock_m3, initial.quota_remaining_m3
    failures = []
    for row in slots:
        expected_stock = stock + row.pump_m3 - row.delivered_m3
        expected_quota = quota - row.pump_m3
        if (
            row.tank_stock_before_m3 != stock
            or row.tank_stock_m3 != expected_stock
            or not 0 <= expected_stock <= site.tank_capacity_m3
            or row.quota_remaining_m3 != expected_quota
            or expected_quota < 0
            or sum(delivery.delivered_m3 for delivery in row.deliveries) != row.delivered_m3
        ):
            failures.append(row.slot)
        stock, quota = row.tank_stock_m3, row.quota_remaining_m3
    return {
        "balanced": not failures,
        "failed_slots": failures,
        "pumped_m3": sum(row.pump_m3 for row in slots),
        "delivered_m3": sum(row.delivered_m3 for row in slots),
        "gravity_during_outages_m3": sum(row.delivered_m3 for row in slots if not row.grid_available),
        "remaining_quota_m3": quota,
    }


def analyze_energy(slots: tuple[SlotBalance, ...], site: Site) -> dict:
    failures = []
    for row in slots:
        if (
            row.pump_wh != row.pump_m3 * site.pump_wh_per_m3
            or row.pump_wh != row.solar_wh + row.grid_wh
            or not 0 <= row.solar_wh <= row.solar_available_wh
            or not 0 <= row.grid_wh <= row.grid_cap_w
            or (not row.grid_available and (row.pump_wh or row.solar_available_wh or row.grid_cap_w))
        ):
            failures.append(row.slot)
    return {
        "balanced": not failures,
        "failed_slots": failures,
        "pump_wh": sum(row.pump_wh for row in slots),
        "solar_wh": sum(row.solar_wh for row in slots),
        "grid_wh": sum(row.grid_wh for row in slots),
        "outage_hours": sum(not row.grid_available for row in slots),
    }


def analyze_equity(reference: tuple[PlotResult, ...], optimized: tuple[PlotResult, ...]) -> dict:
    before = {plot.plot_id: plot for plot in reference}
    comparison = [{
        "plot_id": plot.plot_id,
        "reference_deficit_m3": before[plot.plot_id].deficit_m3,
        "optimized_deficit_m3": plot.deficit_m3,
        "reference_coverage_bp": before[plot.plot_id].cover_bp,
        "optimized_coverage_bp": plot.cover_bp,
    } for plot in optimized]
    reference_total = sum(plot.deficit_m3 for plot in reference)
    optimized_total = sum(plot.deficit_m3 for plot in optimized)
    return {
        "reference_deficit_m3": reference_total,
        "optimized_deficit_m3": optimized_total,
        "avoided_deficit_m3": reference_total - optimized_total,
        "plots": comparison,
    }

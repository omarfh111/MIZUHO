from itertools import pairwise

from .baseline import build_baseline
from .catalog import Catalog, apply_weather_profile
from .models import (
    ActionResult, ApiMetrics, ApiPlan, ApiPlotResult, ApiWeatherComparison, CompareRequest,
    Comparison, EfficiencyReadings, Plan, Scenario, State, Warning,
)
from .optimizer import optimize
from .simulator import validate_state
from .weather import compare_weather


class InputError(ValueError):
    def __init__(self, field: str | tuple[str | int, ...], message: str):
        super().__init__(message)
        self.location = (field,) if isinstance(field, str) else field


PLAN_WARNINGS = {
    "optimizer_no_solution": "The optimizer found no plan within its time budget.",
    "optimizer_not_proven_optimal": "The optimizer returned a verified plan before proving optimality.",
    "fixed_schedule_unavailable": "The scenario has no fixed schedule.",
    "timely_coverage_shortfall": "The plan falls short of at least one minimum delivery target.",
    "stock_and_quota_below_minimum": "Available water stock and withdrawal quota are below the minimum demand.",
    "gravity_capacity_below_minimum": "The remaining gravity-fed capacity is below the minimum demand.",
    "pumping_capacity_below_minimum": "Water stock and remaining pumping capacity are below the minimum demand.",
    "pumping_capacity_before_deadline": "Available water and pumping capacity cannot meet a deadline.",
}
PLOT_REASONS = {
    "no_timely_slot": "No delivery slot remains before the deadline.",
    "timely_window_capacity": "Gravity-fed capacity is too low in the remaining delivery windows.",
    "shortfall": "Minimum volume unmet within the allowed window.",
    "late_or_partial": "Some requested water was delivered late or remains undelivered.",
    "covered": None,
}


def to_api_plan(scenario: Scenario, state: State, plan: Plan, diagnostics: tuple[Warning, ...] = ()) -> ApiPlan:
    warnings = tuple(Warning(type=code, message=PLAN_WARNINGS.get(code, code.replace("_", " ")))
                     for code in plan.warnings) + diagnostics
    if plan.actions is None or plan.metrics is None:
        return ApiPlan(status="NO_SOLUTION", warnings=warnings)
    by_slot = {action.slot: action for action in plan.actions}
    actions = tuple(ActionResult(
        **by_slot[slot.slot].model_dump(),
        tank_stock_m3=slot.tank_stock_m3, quota_remaining_m3=slot.quota_remaining_m3, grid_wh=slot.grid_wh,
    ) for slot in plan.slots)
    plots = {plot.plot_id: plot for plot in scenario.plots}
    results = tuple(ApiPlotResult(
        **result.model_dump(), demand_m3=plots[result.plot_id].demand_m3,
        minimum_m3=plots[result.plot_id].minimum_m3,
        coverage_bp=result.cover_bp, reason=PLOT_REASONS[result.reason_code],
    ) for result in plan.plot_results)
    metrics = plan.metrics.model_dump()
    metrics["delivered_m3"] = sum(plot.delivered_m3 for plot in results)
    return ApiPlan(
        status=plan.status, actions=actions, plot_results=results, warnings=warnings,
        metrics=ApiMetrics(
            **metrics, delivered_on_time_m3=sum(plot.delivered_on_time_m3 for plot in results),
            tank_stock_m3=actions[-1].tank_stock_m3 if actions else state.tank_stock_m3,
            quota_remaining_m3=actions[-1].quota_remaining_m3 if actions else state.quota_remaining_m3,
        ),
    )


def efficiency_warning(readings: EfficiencyReadings | None) -> tuple[Warning, ...]:
    comparable = False
    if readings:
        reference = readings.reference_wh_per_m3
        for left, right in pairwise(readings.samples):
            if right.slot != left.slot + 1 or any(
                not sample.pumped_m3 or sample.consumed_wh is None for sample in (left, right)
            ):
                continue
            comparable = True
            if all(5 * sample.consumed_wh > 6 * reference * sample.pumped_m3 for sample in (left, right)):
                return (Warning(
                    type="efficiency", source_id=readings.source_id,
                    period=f"H{left.slot:02d}–H{right.slot:02d} · independent simulated readings",
                    value=right.consumed_wh / (1000 * right.pumped_m3), reference=reference / 1000, unit="kWh/m³",
                    message="Energy per m³ exceeded the reference by more than 20% in two consecutive readings. "
                            "Check the flow rate, pressure and pump meter.",
                ),)
    if comparable:
        return ()
    return (Warning(type="insufficient", message="Insufficient data to assess energy use per m³."),)


def operating_conditions(scenario: Scenario, request: CompareRequest, profile_wh: tuple[int, ...] | None) -> Scenario:
    outages = set(request.outage_slots)
    slots = []
    for slot in scenario.slots:
        index = slot.slot
        cap = slot.grid_cap_w
        if index >= request.state.current_slot and index - 1 in outages and request.restart_grid_cap_w is not None:
            cap = min(cap, request.restart_grid_cap_w)
        slots.append(slot.model_copy(update={
            "grid_available": index not in outages,
            "grid_cap_w": cap,
            "solar_wh": profile_wh[index] if profile_wh else slot.solar_wh,
        }))
    return scenario.model_copy(update={"slots": tuple(slots)})


def compare(catalog: Catalog, request: CompareRequest, max_time_seconds: float) -> Comparison:
    state = request.state
    scenario = catalog.scenarios.get(request.scenario_id)
    if scenario is None:
        raise InputError("scenario_id", "Unknown scenario.")
    validate_state(scenario, state)
    outages = set(request.outage_slots)
    if len(outages) != len(request.outage_slots) or any(slot >= len(scenario.slots) for slot in outages):
        raise InputError("outage_slots", "Outage slots must be distinct and within the scenario horizon.")
    past = {slot.slot for slot in scenario.slots[:state.current_slot] if not slot.grid_available}
    if past != {slot for slot in outages if slot < state.current_slot}:
        raise InputError("outage_slots", "Outage slots before the current slot cannot be changed.")
    profile = None
    if request.solar_option_id is not None:
        solar = catalog.solar.get(scenario.site_id)
        option = next((option for option in solar.options if option.id == request.solar_option_id), None) if solar else None
        if option is None:
            raise InputError("solar_option_id", "Unknown solar option for this site.")
        profile = option.profile_wh
    pair = None
    if request.planning_mode == "weather_buffer":
        if request.weather_pair_id is None or request.weather_pair_id != scenario.weather_pair_id:
            raise InputError("weather_pair_id", "Select a weather pair registered for this scenario.")
        pair = catalog.weather[request.weather_pair_id]
        if state.current_slot > pair.central.risk_start_slot:
            raise InputError(("state", "current_slot"), "The weather risk window has already started.")
    elif request.weather_pair_id is not None:
        raise InputError("weather_pair_id", "A weather pair requires weather_buffer mode.")

    # The weather pair defines the two supply forecasts. Nominal mode uses the selected PV option if supplied.
    operational = operating_conditions(scenario, request, profile if pair is None else None)
    central = apply_weather_profile(operational, pair.central) if pair else operational
    diagnostics = efficiency_warning(catalog.efficiency.get(scenario.id))
    fixed = build_baseline(central, state)
    baseline = to_api_plan(central, state, fixed, diagnostics)
    if pair is None:
        proposed = optimize(operational, state, max_time_seconds=max_time_seconds)
        return Comparison(baseline=baseline, optimized=to_api_plan(operational, state, proposed, diagnostics))

    adverse = apply_weather_profile(operational, pair.adverse)
    result = compare_weather(central, adverse, state, risk_start_slot=pair.central.risk_start_slot,
                             max_time_seconds=max_time_seconds)
    nominal = to_api_plan(central, state, result.nominal_plan, diagnostics)
    if result.reference_on_adverse is None or result.buffer_on_adverse is None:
        nominal = nominal.model_copy(update={"warnings": (*nominal.warnings,
            Warning(type="weather_optimizer_no_solution", message="The solver could not verify both weather plans within its time budget."),
        )})
        return Comparison(baseline=baseline, optimized=nominal)
    buffer = to_api_plan(adverse, state, result.buffer_on_adverse, diagnostics)
    assert buffer.metrics is not None  # Both weather plans have already passed physical replay.
    return Comparison(
        baseline=baseline,
        optimized=nominal,
        weather_comparison=ApiWeatherComparison(
            reference_on_adverse=to_api_plan(adverse, state, result.reference_on_adverse, diagnostics),
            buffer_on_adverse=buffer,
            early_pump_m3=result.early_pump_m3,
            additional_early_pump_m3=result.additional_early_pump_m3,
            before_slot=result.before_slot,
            expected_stock_m3=result.expected_stock_m3,
            remaining_deficit_m3=result.remaining_deficit_m3,
            quota_remaining_m3=buffer.metrics.quota_remaining_m3,
            reason=pair.reason,
            source_id=pair.adverse.source_id,
            provenance=pair.adverse.provenance,
        ),
    )

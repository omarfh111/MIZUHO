from itertools import pairwise
from typing import Literal

from .baseline import build_baseline, replay_plan
from .catalog import Catalog, apply_weather_profile
from .models import (
    ActionResult, ApiMetrics, ApiPlan, ApiPlotResult, ApiWeatherComparison, CompareRequest,
    Comparison, EfficiencyReadings, Plan, Scenario, State, Warning,
)
from .optimizer import optimize
from .simulator import simulate, validate_state, verified_plan
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


def effective_scenario(catalog: Catalog, request: CompareRequest, weather: Literal["central", "adverse"] = "central",
                       *, include_incident: bool = True) -> Scenario:
    """Resolve the same immutable physical inputs for planning and telemetry replay."""
    scenario = catalog.scenarios.get(request.scenario_id)
    if scenario is None:
        raise InputError("scenario_id", "Unknown scenario.")
    state = request.state
    outages = set(request.outage_slots)
    if len(outages) != len(request.outage_slots) or any(slot >= len(scenario.slots) for slot in outages):
        raise InputError("outage_slots", "Outage slots must be distinct and within the scenario horizon.")
    past = {slot.slot for slot in scenario.slots[:state.current_slot] if not slot.grid_available}
    if past != {slot for slot in outages if slot < state.current_slot}:
        raise InputError("outage_slots", "Outage slots before the current slot cannot be changed.")

    params = request.overrides
    profile = None
    if request.solar_option_id is not None:
        solar = catalog.solar.get(scenario.site_id)
        option = next((item for item in solar.options if item.id == request.solar_option_id), None) if solar else None
        if option is None:
            raise InputError("solar_option_id", "Unknown solar option for this site.")
        profile = option.profile_wh
    if request.planning_mode == "weather_buffer":
        if request.weather_pair_id is None or request.weather_pair_id != scenario.weather_pair_id:
            raise InputError("weather_pair_id", "Select a weather pair registered for this scenario.")
        if request.incident or params.pvgis_option_id:
            raise InputError("planning_mode", "Select nominal mode for incident replay or an archived solar day.")
        pair = catalog.weather[request.weather_pair_id]
        if state.current_slot > pair.central.risk_start_slot:
            raise InputError(("state", "current_slot"), "The weather risk window has already started.")
        scenario = apply_weather_profile(scenario, pair.adverse if weather == "adverse" else pair.central)
        profile = None
    elif request.weather_pair_id is not None:
        raise InputError("weather_pair_id", "A weather pair requires weather_buffer mode.")
    elif params.pvgis_option_id:
        from .energy_profiles import archived_profile_wh
        try:
            profile = archived_profile_wh(scenario.site_id, params.pvgis_option_id)
        except ValueError as error:
            raise InputError(("overrides", "pvgis_option_id"), "No complete archived profile for this site and option.") from error

    incident_slots = set()
    if request.incident:
        event = request.incident
        end = event.start_slot + event.duration_slots
        if event.start_slot < state.current_slot or end > len(scenario.slots):
            raise InputError("incident", "The entire incident must fall within the remaining horizon.")
        if include_incident:
            incident_slots = set(range(event.start_slot, end))
            if event.kind == "unexpected_outage":
                if event.start_slot in outages:
                    raise InputError("incident", "Start an unexpected outage while the grid is available.")
                outages.update(incident_slots)

    slots = []
    for slot in scenario.slots:
        index = slot.slot
        cap = slot.grid_cap_w
        if index >= state.current_slot:
            if params.grid_cap_w is not None:
                cap = min(cap, params.grid_cap_w)
            if index - 1 in outages and request.restart_grid_cap_w is not None:
                cap = min(cap, request.restart_grid_cap_w)
        slots.append(slot.model_copy(update={
            "grid_available": index not in outages, "grid_cap_w": cap,
            "solar_wh": (profile[index] if profile else slot.solar_wh) * params.solar_percent // 100,
            "gravity_available": slot.gravity_available and (index < state.current_slot or params.gravity_available),
            "pump_available": slot.pump_available and not (index in incident_slots and request.incident.kind == "pump_shutdown"),
        }))
    if params.demand_by_plot_m3.keys() - {plot.plot_id for plot in scenario.plots}:
        raise InputError(("overrides", "demand_by_plot_m3"), "Demand overrides must refer to a registered scenario plot.")
    plots = []
    for plot in scenario.plots:
        demand = params.demand_by_plot_m3.get(plot.plot_id)
        if demand is None:
            plots.append(plot)
            continue
        if demand < max(plot.minimum_m3, state.delivered_by_plot_m3.get(plot.plot_id, 0)):
            raise InputError(("overrides", "demand_by_plot_m3", plot.plot_id),
                             "Demand must cover the minimum target and all completed deliveries.")
        plots.append(plot.model_copy(update={"demand_m3": demand}))
    site = scenario.site
    capacity = site.pump_max_m3_per_slot if params.pump_max_m3_per_slot is None else params.pump_max_m3_per_slot
    if params.pump_power_cap_w is not None:
        # Each slot is exactly one hour, so the motor ceiling bounds total PV + grid Wh.
        capacity = min(capacity, params.pump_power_cap_w // site.pump_wh_per_m3)
    site = site.model_copy(update={"pump_max_m3_per_slot": capacity})
    effective = scenario.model_copy(update={"site": site, "slots": tuple(slots), "plots": tuple(plots)})
    validate_state(effective, state)
    return effective


def compare_incident(catalog: Catalog, request: CompareRequest, disrupted: Scenario, budget: float) -> Comparison:
    forecast = effective_scenario(catalog, request, include_incident=False)
    state = request.state
    event = request.incident
    previous = event.previous_actions
    if previous is None:
        initial = optimize(forecast, state, max_time_seconds=budget / 2)
        if initial.actions is None:
            unavailable = to_api_plan(forecast, state, initial)
            return Comparison(baseline=unavailable, optimized=unavailable)
        previous = initial.actions
    else:
        expected = list(range(state.current_slot, len(forecast.slots)))
        if [action.slot for action in previous] != expected or simulate(forecast, state, previous).violations:
            raise InputError(("incident", "previous_actions"), "The previous schedule must cover and pass physical replay of the original horizon.")
    cutoff = event.start_slot
    prefix = tuple(action for action in previous if action.slot < cutoff)
    checkpoint = simulate(forecast, state, prefix, stop_before_slot=cutoff).end_state
    if checkpoint is None:
        raise RuntimeError("The verified nominal plan could not be replayed.")
    continued = replay_plan(disrupted, checkpoint, tuple(a for a in previous if a.slot >= cutoff))
    recovery = optimize(disrupted, checkpoint, max_time_seconds=budget if event.previous_actions else budget / 2)

    def whole_plan(suffix: Plan) -> ApiPlan:
        if suffix.actions is None:
            return to_api_plan(disrupted, checkpoint, suffix)
        # Replay the entire day so stock, energy and coverage include its immutable history.
        warnings = tuple(w for w in suffix.warnings if w == "optimizer_not_proven_optimal")
        plan = verified_plan(disrupted, state, prefix + suffix.actions, suffix.status, warnings=warnings)
        return to_api_plan(disrupted, state, plan)

    return Comparison(baseline=whole_plan(continued), optimized=whole_plan(recovery), incident_checkpoint=checkpoint)


def compare(catalog: Catalog, request: CompareRequest, max_time_seconds: float) -> Comparison:
    state = request.state
    central = effective_scenario(catalog, request)
    if request.incident:
        return compare_incident(catalog, request, central, max_time_seconds)
    scenario = catalog.scenarios[request.scenario_id]
    pair = catalog.weather[request.weather_pair_id] if request.planning_mode == "weather_buffer" else None
    diagnostics = efficiency_warning(catalog.efficiency.get(scenario.id))
    fixed = build_baseline(central, state)
    baseline = to_api_plan(central, state, fixed, diagnostics)
    if pair is None:
        proposed = optimize(central, state, max_time_seconds=max_time_seconds)
        return Comparison(baseline=baseline, optimized=to_api_plan(central, state, proposed, diagnostics))

    adverse = effective_scenario(catalog, request, "adverse")
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

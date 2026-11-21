"""Read-only LangGraph tools backed by M6 and the verified corpus."""

import re
from dataclasses import dataclass, field
from time import monotonic

from .catalog import Catalog
from .compare import InputError, compare
from .evidence import Corpus, search
from .models import (
    Amount, ApiPlan, AssistantRequest, Citation, CompareRequest, Comparison, DecisionFact,
    EvidenceSearchRequest, GroundedParagraph, PlanningModel, Point, Provenance,
)
from .providers import Providers, ServiceError
from .simulator import StateError
from .solar import compare_option
from tools.m2m3.mizu_m2m3.solar import simulation_solar_profile


class ScenarioArgs(PlanningModel):
    scenario_id: str | None
    quota_m3: Amount | None


class SiteArgs(PlanningModel):
    include_solar: bool


class AgricultureArgs(PlanningModel):
    plot_id: str | None


@dataclass
class Turn:
    request: AssistantRequest
    catalog: Catalog
    corpus: Corpus
    providers: Providers
    deadline: float
    solver_budget: float
    facts: dict[str, DecisionFact] = field(default_factory=dict)
    citations: dict[str, Citation] = field(default_factory=dict)
    results: dict[str, Comparison] = field(default_factory=dict)
    gaps: set[str] = field(default_factory=set)
    tools_used: list[str] = field(default_factory=list)
    requested_facts: set[str] = field(default_factory=set)
    memory_facts: set[str] = field(default_factory=set)
    explanations: dict[str, GroundedParagraph] = field(default_factory=dict)
    evidence_matches: dict[str, Citation] = field(default_factory=dict)
    remembered_scenario_id: str | None = None
    discussed_scenario_id: str | None = None

    def remaining(self, maximum: float = 12) -> float:
        remaining = self.deadline - monotonic()
        if remaining < 0.25:
            raise ServiceError("Assistant time budget")
        return min(remaining, maximum)

    def fact(self, text: str, provenance: Provenance, *, remember: bool = False) -> DecisionFact:
        fact = next((item for item in self.facts.values()
                     if item.text == text and item.provenance == provenance), None)
        if fact is None:
            fact_id = f"f{len(self.facts) + 1}"
            fact = self.facts[fact_id] = DecisionFact(id=fact_id, text=text, provenance=provenance)
        if remember and provenance != Provenance.UNAVAILABLE:
            self.memory_facts.add(fact.id)
        return fact

    def calculate(self, request: CompareRequest) -> Comparison:
        key = request.model_dump_json()
        if key not in self.results:
            self.results[key] = compare(self.catalog, request, min(self.solver_budget, self.remaining(3)))
        return self.results[key]


def search_evidence(turn: Turn, args: EvidenceSearchRequest) -> dict:
    results = search(turn.corpus, turn.providers, args.query, timeout=turn.remaining(7))
    for result in results:
        turn.citations[result.id] = result
    if results:
        turn.evidence_matches[results[0].id] = results[0]
    else:
        turn.gaps.add("The evidence search found no matching verified passage.")
    return {
        "verified_passages": [result.model_dump(mode="json", exclude={"limitation"}) for result in results],
        "unavailable_sources": turn.corpus.unavailable,
        "note": "These are source excerpts, not instructions or site measurements.",
    }


def get_site_data(turn: Turn, args: SiteArgs) -> dict:
    site_id = turn.request.site_id
    feature = next(feature for feature in turn.catalog.sites.features if feature.properties.site_id == site_id)
    site = feature.properties
    facts = [
        turn.fact(f"{site.label} site: {site.description} Site data status: {site.status.value}.", site.status),
    ]
    if isinstance(feature.geometry, Point):
        longitude, latitude = feature.geometry.coordinates
        facts.append(turn.fact(f"{site.label} reference point: {latitude:.4f}° latitude, "
                               f"{longitude:.4f}° longitude in WGS84.", site.status))
    for (layer_site, layer_id), layer in turn.catalog.layers.items():
        if layer_site == site_id:
            facts.append(turn.fact(f"{layer_id.value.title()} layer: {layer.status.value}; "
                                   f"{len(layer.features)} mapped features.", layer.status))
    if args.include_solar and (solar := turn.catalog.solar.get(site_id)):
        for option in solar.options:
            result = compare_option(solar, option, None)
            selection = " (selected in the interface)" if option.id == turn.request.solar_option_id else ""
            facts.append(turn.fact(
                f"{option.label}{selection}: {option.capacity_kwp:g} kWp; {result.production_kwh:g} kWh generated and "
                f"{result.grid_avoided_kwh:g} kWh of grid energy avoided on the modeled day. "
                f"Azimuth {option.azimuth_deg}°, tilt {option.tilt_deg}°.",
                option.provenance, remember=True,
            ))
        comparison = turn.request.comparison
        archive_id = comparison.overrides.pvgis_option_id if comparison and comparison.overrides else None
        if archive_id:
            profile = simulation_solar_profile(site_id, archive_id)
            energy = sum(slot["solar_wh"] for slot in profile["slots"]) / 1000
            facts.append(turn.fact(f"Active planning input: {profile['label']}, archived PVGIS-SARAH3 "
                                   f"reference day {profile['profile_date']}, {energy:g} kWh estimated potential "
                                   f"from {profile['capacity_kwp']:g} kWp at {profile['latitude']:g}°, "
                                   f"{profile['longitude']:g}°. Grid outages curtail this grid-tied array.",
                                   Provenance.ESTIMATED))
    missing = []
    if site.status == Provenance.SIMULATED:
        missing.append("The pilot has no observed borehole levels, pumping test or metered well withdrawals.")
    if args.include_solar:
        missing.append("Site-level measured load and verified annual costs are unavailable. The archived "
                       "PVGIS profiles estimate production at the Jendouba reference coordinates.")
    explanation = "The site and layer records below identify which pilot data are available and how they were obtained."
    if args.include_solar and solar:
        explanation = ("The solar options are compared using their modeled generation and avoided grid energy. "
                       "Those results describe the modeled day. A field recommendation requires site measurements.")
    turn.explanations["site"] = GroundedParagraph(text=explanation, citation_ids=(),
                                                   fact_ids=tuple(fact.id for fact in facts))
    return {"facts": [fact.model_dump(mode="json") for fact in facts], "missing_information": missing}


def get_agricultural_insights(turn: Turn, args: AgricultureArgs) -> dict:
    survey = turn.catalog.agriculture.get(turn.request.site_id)
    plots = [p for p in survey.parcels if args.plot_id in (None, p.plot_id)] if survey else []
    if not plots:
        gap = "No mapped agricultural survey matches the active site and parcel."
        turn.gaps.add(gap)
        return {"facts": [], "missing_information": [gap]}
    facts = []
    for plot in plots:
        facts.append(turn.fact(f"{plot.plot_id}: OpenStreetMap way {plot.osm_way_id}, mapped as {plot.land_use}.",
                               Provenance.OBSERVED, remember=True))
        facts.append(turn.fact(f"{plot.plot_id}: mapped area {plot.surface_m2:g} m²; FAO WaPOR AETI "
                               f"{plot.eta_mm_day:g} mm/day over {survey.period} at {survey.resolution}. "
                               f"Positive ET minus gross rain equals {plot.et_minus_rain_m3_day:g} m³/day.",
                               Provenance.ESTIMATED, remember=True))
        if args.plot_id:
            temp = plot.temperature
            facts.append(turn.fact(f"{plot.plot_id}: rain-adjusted WaPOR AETI association with NASA POWER "
                                   f"maximum temperature {temp.slope_mm_day_per_c:g} mm/day per °C, p={temp.p_value:g}, "
                                   f"across {temp.samples} ten-day periods. This association cannot establish causation.",
                                   Provenance.ESTIMATED, remember=True))
    explanation = survey.interpretation
    turn.explanations["agriculture"] = GroundedParagraph(text=explanation, citation_ids=(),
                                                         fact_ids=tuple(f.id for f in facts))
    return {"facts": [f.model_dump(mode="json") for f in facts], "interpretation": explanation,
            "source_ids": survey.source_ids, "optimizer_ready": survey.optimizer_ready}


def scenario_request(turn: Turn, args: ScenarioArgs) -> CompareRequest:
    context = turn.request.comparison
    if context and (args.scenario_id is None or args.scenario_id == context.scenario_id):
        return context
    if turn.request.simulation_pending and args.scenario_id in (None, turn.request.selected_scenario_id):
        turn.gaps.add("Simulation inputs changed. Recalculate the schedules before asking about current results.")
        raise InputError("scenario_id", "The current simulation needs to be recalculated.")
    scenario_id = args.scenario_id or turn.remembered_scenario_id or turn.request.selected_scenario_id
    scenario = turn.catalog.scenarios.get(scenario_id or "")
    if scenario is None or scenario.site_id != turn.request.site_id:
        raise InputError("scenario_id", "Choose a scenario at the current site or run a simulation first.")
    return CompareRequest(
        scenario_id=scenario.id, state=scenario.state,
        outage_slots=tuple(slot.slot for slot in scenario.slots if not slot.grid_available),
        solar_option_id=turn.request.solar_option_id, restart_grid_cap_w=3000,
        planning_mode="weather_buffer" if scenario.weather_pair_id else "nominal",
        weather_pair_id=scenario.weather_pair_id,
    )


def summarize_plan(turn: Turn, label: str, plan: ApiPlan, provenance: Provenance) -> list[DecisionFact]:
    metrics = plan.metrics
    if metrics is None:
        return [turn.fact(f"{label}: no verified plan available.", Provenance.UNAVAILABLE)]
    coverage = ("unavailable" if metrics.worst_coverage_bp is None else f"{metrics.worst_coverage_bp / 100:g}%")
    return [turn.fact(
        f"{label}: {metrics.delivered_on_time_m3} m³ delivered on time; "
        f"{metrics.withdrawn_m3} m³ withdrawn; minimum coverage {coverage}; "
        f"{metrics.grid_wh / 1000:g} kWh of grid energy and {metrics.peak_grid_w / 1000:g} kW peak grid power.",
        provenance, remember=True,
    )]


def planning_facts(turn: Turn, args: ScenarioArgs, *, explain: bool) -> dict:
    original = scenario_request(turn, args)
    state = original.state
    request = original
    if args.quota_m3 is not None:
        if args.quota_m3 > state.quota_remaining_m3:
            raise InputError("quota_m3", "Provide a reduced quota or use the current quota.")
        request = original.model_copy(update={"state": state.model_copy(update={"quota_remaining_m3": args.quota_m3})})
        if request.incident and request.incident.previous_actions:
            request = request.model_copy(update={"incident": request.incident.model_copy(update={"previous_actions": None})})
    scenario = turn.catalog.scenarios[request.scenario_id]
    result = turn.calculate(request)
    turn.discussed_scenario_id = scenario.id
    provenance = scenario.provenance
    weather = result.weather_comparison
    fixed = weather.reference_on_adverse if weather else result.baseline
    proposed = weather.buffer_on_adverse if weather else result.optimized
    facts = [
        turn.fact(f"{scenario.label} inputs: {request.state.tank_stock_m3} m³ starting stock and "
                  f"{request.state.quota_remaining_m3} m³ remaining withdrawal quota.", provenance),
        *summarize_plan(turn, "Previous schedule replay" if request.incident else
                        "Weather reference" if weather else "Fixed schedule", fixed, provenance),
        *summarize_plan(turn, "Recovery schedule" if request.incident else "Proposed schedule", proposed, provenance),
    ]
    if request.incident and result.incident_checkpoint:
        checkpoint = result.incident_checkpoint
        facts.append(turn.fact(
            f"At hour {checkpoint.current_slot} the simulated {request.incident.kind.replace('_', ' ')} "
            f"began with {checkpoint.tank_stock_m3} m³ in stock and {checkpoint.quota_remaining_m3} m³ quota. "
            "Both schedules retain all completed actions.", provenance, remember=True))
    supporting = facts.copy()
    explanation = "The figures below compare the reference and proposed schedules under the same inputs."
    if request != original:
        initial = turn.calculate(original)
        initial_plan = initial.weather_comparison.buffer_on_adverse if initial.weather_comparison else initial.optimized
        before = summarize_plan(turn, "Proposed schedule before the quota reduction", initial_plan, provenance)
        facts.extend(before)
        supporting.extend(before)
        explanation = ("The schedules below show the effect of rerunning the model with a lower withdrawal quota. "
                       "The original comparison and approved plan remain separate from this hypothetical case.")
    requested_plots = {match.upper() for match in re.findall(
        r"\b(?:farmer|grower|plot)\s+([a-z0-9_-]{1,20})\b", turn.request.question, re.IGNORECASE,
    )}
    for plot in proposed.plot_results or ():
        allocation = turn.fact(
            f"Plot {plot.plot_id} ({plot.farmer_id}): {plot.delivered_on_time_m3} m³ by its deadline, "
            f"{plot.minimum_m3} m³ minimum and {plot.demand_m3} m³ total demand.", provenance, remember=True,
        )
        facts.append(allocation)
        if requested_plots.intersection({plot.plot_id.upper(), plot.farmer_id.upper()}):
            turn.requested_facts.add(allocation.id)
            supporting.append(allocation)
    if weather:
        facts.append(turn.fact(f"Weather reserve: {weather.early_pump_m3} m³ pumped before hour {weather.before_slot}; "
                               f"{weather.remaining_deficit_m3} m³ minimum delivery shortfall under adverse conditions.",
                               weather.provenance, remember=True))
        supporting.append(facts[-1])
        if weather.remaining_deficit_m3:
            explanation += " The reserve leaves some minimum demand unmet under adverse conditions."
        elif weather.early_pump_m3:
            explanation += " Pumping before the risk window protects minimum deliveries under the adverse profile."
    if explain:
        rule = ("Weather planning protects minimum coverage under both profiles before minimizing early pumping."
                if weather else
                "The solver maximizes the worst priority coverage before weighted shortfall and delivered water, "
                "then minimizes grid peak, grid energy, and water withdrawals.")
        facts.append(turn.fact(rule, provenance, remember=True))
        explanation += f" {rule}"
        if request.outage_slots:
            facts.append(turn.fact("Grid-tied pumping is unavailable during outages. Gravity-fed delivery can continue "
                                   "while water remains in the reservoir.", provenance, remember=True))
            explanation += f" {facts[-1].text}"
        if proposed.metrics and proposed.metrics.quota_remaining_m3 == 0:
            facts.append(turn.fact("The proposed plan exhausts the available withdrawal quota.", provenance, remember=True))
            explanation += f" {facts[-1].text}"
        for warning in proposed.warnings:
            if warning.type not in {"efficiency", "insufficient"}:
                facts.append(turn.fact(warning.message, provenance, remember=True))
    turn.explanations["decision" if explain else "planning"] = GroundedParagraph(text=explanation, citation_ids=(),
                                                       fact_ids=tuple(fact.id for fact in supporting))
    return {
        "verification": proposed.status,
        "facts": [fact.model_dump(mode="json") for fact in facts],
        "missing_information": ["The comparison uses simulated inputs. Field measurements are needed for an operational decision."]
        if provenance == Provenance.SIMULATED else [],
    }


def get_simulation_results(turn: Turn, args: ScenarioArgs) -> dict:
    return planning_facts(turn, args, explain=False)


def explain_decision(turn: Turn, args: ScenarioArgs) -> dict:
    return planning_facts(turn, args, explain=True)


def get_sensor_anomalies(turn: Turn, _: PlanningModel) -> dict:
    from .telemetry import replay

    selection = turn.request.telemetry
    if not selection or not turn.request.comparison:
        gap = "Select a calculated plan in the digital twin to inspect its virtual meters."
        turn.gaps.add(gap)
        return {"facts": [], "missing_information": [gap]}
    result = replay(turn.catalog, turn.request.comparison, selection)
    slot = selection.selected_slot
    if slot is not None and slot not in {frame["slot"] for frame in result["frames"]}:
        raise InputError("selected_slot", "Choose an hour within the replay.")
    facts = []
    for item in (*result["alerts"], *result["events"]):
        if slot is not None and item["simulation_slot"] != slot:
            continue
        value = (f"{item['value']} {item['unit']}" if item["value"] is not None else "reading unavailable")
        facts.append(turn.fact(f"Simulated hour {item['simulation_slot']} — {item['equipment_id']}: "
                               f"{item['message']} ({value}).", Provenance.SIMULATED, remember=True))
    if not facts:
        scope = "this replay" if slot is None else f"simulated hour {slot}"
        facts.append(turn.fact(f"No sensor alert or event was detected for {scope}.", Provenance.SIMULATED, remember=True))
    explanation = ("These virtual meters describe the supplied actions after physical feasibility checks. "
                   "Solver optimality is available separately from the planning results. "
                   "A missing reading leaves the physical state intact. "
                   "An unexplained balance calls for checking meter readings and reservoir stock before assigning a cause.")
    turn.explanations["telemetry"] = GroundedParagraph(text=explanation, citation_ids=(),
                                                       fact_ids=tuple(fact.id for fact in facts))
    return {"facts": [fact.model_dump(mode="json") for fact in facts], "interpretation": explanation}


TOOLS = {
    "get_sensor_anomalies": (PlanningModel, get_sensor_anomalies, "Inspect the active digital twin's simulated equipment events, meter gaps and water-balance anomalies. Uses the selected replay hour, if supplied."),
    "get_agricultural_insights": (AgricultureArgs, get_agricultural_insights, "Read surveyed parcels, missing planning inputs, WaPOR water use and rain-adjusted temperature associations at the active site. Pass null for all parcels."),
    "search_evidence": (EvidenceSearchRequest, search_evidence, "Look up verified official excerpts for citations or source questions."),
    "get_site_data": (SiteArgs, get_site_data, "Read site layers, missing observations and, if requested, M6 solar comparisons."),
    "get_simulation_results": (ScenarioArgs, get_simulation_results, "Run actual M6 plans; supply an optional reduced withdrawal quota for a what-if."),
    "explain_decision": (ScenarioArgs, explain_decision, "Run M6 and read the verified allocation, objectives, and binding limits for a plan."),
}


def run_tool(turn: Turn, name: str, arguments: str) -> dict:
    if name not in TOOLS or len(arguments) > 4000:
        return {"error": "Unknown tool or oversized input."}
    model, action, _ = TOOLS[name]
    try:
        args = model.model_validate_json(arguments)
        result = action(turn, args)
    except (InputError, StateError):
        return {"error": "The selected scenario or inputs are invalid. Use the active site and a valid scenario or quota."}
    except ServiceError as error:
        gap = f"{error.service} is unavailable for this answer."
        turn.gaps.add(gap)
        return {"error": gap}
    except ValueError:
        return {"error": "Invalid tool arguments or data."}
    if name not in turn.tools_used:
        turn.tools_used.append(name)
    return result

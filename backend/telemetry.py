"""Project validated hourly water and energy balances into simulated meter observations."""

from datetime import UTC, datetime, time, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from pydantic import AwareDatetime, Field

from tools.m2m3.mizu_m2m3.sensors import project_telemetry
from tools.m2m3.mizu_m2m3.solar import compare_solar, simulation_solar_profile
from tools.m2m3.mizu_m2m3.weather import validate_weather_pair
from .catalog import Catalog
from .compare import InputError
from .models import CompareRequest, PlanningModel, Price, ReplaySelection, SlotIndex
from .simulator import simulate
from .telemetry_contracts import ArchivedComparison, Projection, Replay

router = APIRouter(tags=["Digital twin and virtual sensors"])
Reading = Annotated[float, Field(strict=True, ge=0, le=1_000_000_000, allow_inf_nan=False)]


class ReplayRequest(ReplaySelection):
    comparison: CompareRequest


class PhysicalState(PlanningModel):
    site_id: str
    timestamp: AwareDatetime
    simulation_slot: SlotIndex
    tank_stock_m3: Reading
    pumped_m3: Reading
    water_in_m3: Reading
    distributed_m3: Reading
    consumed_wh: Reading
    solar_wh: Reading | None = None
    grid_available: Annotated[bool, Field(strict=True)]


class ProjectionRequest(PlanningModel):
    states: Annotated[tuple[PhysicalState, ...], Field(min_length=1, max_length=24)]
    reference: Annotated[float, Field(gt=0, allow_inf_nan=False)] | None = None
    initial_stock_m3: Reading | None = None
    missing_flow_slots: Annotated[tuple[SlotIndex, ...], Field(max_length=24)] = ()
    balance_anomaly_slots: Annotated[tuple[SlotIndex, ...], Field(max_length=24)] = ()


class SolarProfileRequest(PlanningModel):
    site_id: str
    option_id: Literal["toiture", "ombriere"]
    day: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")] = "2023-06-21"


class ArchiveComparisonRequest(PlanningModel):
    site_id: str
    option_ids: Annotated[tuple[Literal["toiture", "ombriere"], ...], Field(min_length=1, max_length=2)]
    day: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")] = "2023-06-21"
    price_tnd_per_kwh: Price | None = None


class ForecastRequest(PlanningModel):
    site_id: str
    as_of: AwareDatetime


class WeatherRequest(PlanningModel):
    pair_id: str = "jplus1-demo"


def known_site(catalog: Catalog, site_id: str):
    for site in catalog.sites.features:
        if site.properties.site_id == site_id:
            return site.properties
    raise InputError("site_id", "Unknown site.")


def project(states, reference, missing, imbalance, initial_stock):
    slots = {state["simulation_slot"] for state in states}
    for field, injected in (("missing_flow_slots", missing), ("balance_anomaly_slots", imbalance)):
        if len(set(injected)) != len(injected) or not set(injected) <= slots:
            raise InputError(field, "Choose distinct slots within this replay.")
    # Inject an inlet meter offset only into observations. The M4 ledger stays authoritative.
    meter_states = [{**row, "water_in_m3": row["water_in_m3"] + (13 if row["simulation_slot"] in imbalance else 0)}
                    for row in states]
    try:
        result = project_telemetry(meter_states, reference, missing, initial_stock_m3=initial_stock)
    except ValueError as error:
        raise InputError("states", str(error)) from error
    events = []
    previous_grid = None
    previous_stock = initial_stock
    for row in result["records"]:
        slot = row["simulation_slot"]
        metadata = {"site_id": row["site_id"], "simulation_slot": slot, "timestamp": row["timestamp"],
                    "source": "virtual_sensor", "provenance": "simulated", "quality": "valid"}

        def emit(kind, equipment, value, unit, message, quality="valid"):
            events.append({**metadata, "type": kind, "equipment_id": equipment, "value": value,
                           "unit": unit, "message": message, "quality": quality})

        if slot in missing:
            emit("missing_flow", "pump-01", None, "m3/h", "Pump flow reading is missing.", "missing")
        if slot in imbalance:
            emit("inlet_meter_offset", "tank-01", 13, "m³", "Injected inlet meter discrepancy.")
        if not row["grid_available"] and previous_grid is not False:
            emit("grid_outage", "grid-01", False, "boolean", "Grid supply interrupted.")
        if row["grid_available"] and previous_grid is False:
            emit("grid_recovery", "grid-01", True, "boolean", "Grid supply restored.")
        if row["tank_stock_m3"] == 0 and (previous_stock != 0 or previous_grid is None):
            emit("tank_empty", "tank-01", 0, "m³", "Reservoir stock is depleted.")
        previous_grid, previous_stock = row["grid_available"], row["tank_stock_m3"]

    slot_by_time = {datetime.fromisoformat(r["timestamp"]): r["simulation_slot"] for r in result["records"]}
    for item in result["measurements"]:
        item["provenance"] = "simulated"
    for alert in result["alerts"]:
        balance = alert["type"] == "unexplained_water"
        timestamp = alert["period"]["start"]
        alert.update(simulation_slot=slot_by_time[datetime.fromisoformat(timestamp)], timestamp=timestamp,
                     equipment_id="distribution-01" if balance else "pump-01", quality="valid",
                     source="virtual_sensor", message=("Unexplained water balance. Inspect the meters and reservoir."
                     if balance else "Pump energy intensity exceeded the reference in consecutive readings."))
    return {**result, "events": events, "timezone": "Africa/Tunis", "provenance": "simulated"}


def replay(catalog: Catalog, comparison: CompareRequest, selection: ReplaySelection):
    # Use exactly the scenario preparation path used by /api/compare, including incident restrictions.
    from .compare import effective_scenario

    if selection.weather_profile == "adverse" and comparison.planning_mode != "weather_buffer":
        raise InputError("weather_profile", "An adverse profile requires a weather-buffer comparison.")
    scenario = effective_scenario(catalog, comparison, weather=selection.weather_profile)
    state = comparison.state
    if [action.slot for action in selection.actions] != list(range(state.current_slot, len(scenario.slots))):
        raise InputError("actions", "Supply the full ordered action trace from the selected plan.")
    physics = simulate(scenario, state, selection.actions)
    if physics.violations:
        issue = physics.violations[0]
        raise InputError("actions", f"Invalid physical replay at slot {issue.slot}: {issue.constraint}.")
    site_id = catalog.scenarios[comparison.scenario_id].site_id
    day = known_site(catalog, site_id).date
    start = datetime.combine(day, time.min, ZoneInfo("Africa/Tunis"))
    if comparison.weather_pair_id:
        profile = getattr(catalog.weather[comparison.weather_pair_id], selection.weather_profile)
        start = datetime.combine(profile.issued_at.astimezone(ZoneInfo(profile.timezone)).date() + timedelta(days=1),
                                 time.min, ZoneInfo(profile.timezone))
    states, frames = [], []
    timely = dict(state.delivered_on_time_by_plot_m3)
    for action, ledger in zip(selection.actions, physics.slots, strict=True):
        slot = scenario.slots[ledger.slot]
        timestamp = (start + timedelta(hours=ledger.slot)).isoformat()
        states.append({"site_id": site_id, "timestamp": timestamp, "simulation_slot": ledger.slot,
                       "tank_stock_m3": ledger.tank_stock_m3, "pumped_m3": ledger.pump_m3,
                       "water_in_m3": ledger.pump_m3, "distributed_m3": ledger.delivered_m3,
                       "consumed_wh": ledger.pump_wh, "solar_wh": slot.solar_wh, "grid_available": slot.grid_available})
        deliveries = {delivery.plot_id: delivery.delivered_m3 for delivery in action.deliveries if delivery.delivered_m3}
        parcels = []
        for plot in scenario.plots:
            amount = deliveries.get(plot.plot_id, 0)
            if ledger.slot <= plot.deadline_slot:
                timely[plot.plot_id] = timely.get(plot.plot_id, 0) + amount
            volume = timely.get(plot.plot_id, 0)
            parcels.append({"plot_id": plot.plot_id, "farmer_id": plot.farmer_id, "delivered_m3": amount,
                            "delivered_on_time_m3": volume, "demand_m3": plot.demand_m3,
                            "minimum_m3": plot.minimum_m3, "coverage_bp": min(10000, volume * 10000 // plot.minimum_m3)
                            if plot.minimum_m3 else None})
        frames.append({**ledger.model_dump(), "timestamp": timestamp, "grid_available": slot.grid_available,
                       "pump_available": slot.pump_available, "solar_potential_wh": slot.solar_wh,
                       "tank_capacity_m3": scenario.site.tank_capacity_m3, "parcels": parcels})
    result = project(states, scenario.site.pump_wh_per_m3 / 1000, selection.missing_flow_slots,
                     selection.balance_anomaly_slots, state.tank_stock_m3)
    pump_was_available = True
    for frame in frames:
        available = frame["pump_available"]
        if available != pump_was_available:
            result["events"].append({"site_id": site_id, "simulation_slot": frame["slot"], "timestamp": frame["timestamp"],
                                     "type": "pump_recovery" if available else "pump_shutdown",
                                     "equipment_id": "pump-01", "value": available,
                                     "unit": "boolean", "quality": "valid", "provenance": "simulated",
                                     "source": "m4_replay", "message": "Pump available again." if available else
                                     "Pump unavailable during this incident."})
        pump_was_available = available
    result["events"].sort(key=lambda event: event["simulation_slot"])
    return {**result, "site_id": site_id, "physical_source": "m4_replay", "plan": selection.plan,
            "validation": "physical_feasibility_of_submitted_actions", "frames": frames}


@router.post("/api/telemetry/replay", response_model=Replay)
def replay_endpoint(request: Request, body: ReplayRequest):
    return replay(request.app.state.catalog, body.comparison, body)


@router.post("/api/telemetry/project", response_model=Projection)
def projection(request: Request, body: ProjectionRequest):
    known_site(request.app.state.catalog, body.states[0].site_id)
    return {**project([state.model_dump(mode="json") for state in body.states], body.reference,
                      body.missing_flow_slots, body.balance_anomaly_slots, body.initial_stock_m3),
            "physical_source": "supplied_hourly_states"}


@router.post("/api/solar/profile")
def solar_profile(request: Request, body: SolarProfileRequest):
    known_site(request.app.state.catalog, body.site_id)
    try:
        return simulation_solar_profile(body.site_id, body.option_id, body.day)
    except ValueError as error:
        raise InputError("day", str(error)) from error


@router.post("/api/telemetry/forecast")
def forecast(request: Request, body: ForecastRequest):
    from tools.m2m3.mizu_m2m3.forecast import forecast_load

    known_site(request.app.state.catalog, body.site_id)
    # Normalize before Pandas parses the value so an out-of-range offset cannot wrap to a different year.
    try:
        body.as_of.astimezone(UTC).astimezone(ZoneInfo("Africa/Tunis"))
    except OverflowError as error:
        raise InputError("as_of", "The timestamp must fit in the UTC and Africa/Tunis datetime ranges.") from error
    try:
        return forecast_load(body.site_id, body.as_of.isoformat())
    except ValueError as error:
        raise InputError("as_of", str(error)) from error


@router.post("/api/solar/compare-archive", response_model=ArchivedComparison)
def archive_comparison(request: Request, body: ArchiveComparisonRequest):
    known_site(request.app.state.catalog, body.site_id)
    if len(set(body.option_ids)) != len(body.option_ids):
        raise InputError("option_ids", "Choose distinct archived configurations.")
    try:
        options = compare_solar(body.site_id, body.option_ids, body.price_tnd_per_kwh, day=body.day)
    except ValueError as error:
        raise InputError("day", str(error)) from error
    for option in options:
        option["compass_azimuth_deg"] = (180 + option["azimuth_deg"]) % 360
    return {"site_id": body.site_id, "day": body.day, "load_provenance": "simulated", "options": options}


@router.post("/api/weather")
def weather_export(request: Request, body: WeatherRequest):
    pair = request.app.state.catalog.weather.get(body.pair_id)
    if pair is None:
        raise InputError("pair_id", "Unknown weather pair.")
    return validate_weather_pair(pair.id, {pair.id: pair.model_dump(mode="json")})

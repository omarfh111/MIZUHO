from json import loads
from os import environ
from pathlib import Path
from time import perf_counter
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field, ValidationError

from .baseline import replay_plan
from .optimizer import optimize, with_grid_outages
from .planning_models import PlanningModel, Scenario, SlotIndex, State
from .rag_assistant import router as assistant_router
from .simulator import simulate
from .workbench_analysis import analyze_energy, analyze_equity, analyze_water


ASSETS = Path(__file__).with_name("workbench_ui")


class IncidentRequest(PlanningModel):
    case: dict[str, Any]
    outage_slots: Annotated[tuple[SlotIndex, ...], Field(min_length=1, max_length=24)]


def load_case(case: dict) -> tuple[Scenario, State]:
    if not isinstance(case, dict):
        raise ValueError("Le scénario doit être un objet JSON.")
    scenario_data = dict(case["scenario"]) if "scenario" in case else {
        field: case[field] for field in Scenario.model_fields if field in case
    }
    schedule = scenario_data.get("fixed_deliveries", [])
    if isinstance(schedule, (list, tuple)):
        converted = []
        for delivery in schedule:
            if isinstance(delivery, list):
                if len(delivery) > 1:
                    raise ValueError("Le tour fixe accepte une parcelle par créneau.")
                delivery = delivery[0] if delivery else None
            converted.append(delivery)
        scenario_data["fixed_deliveries"] = converted
    return Scenario.model_validate(scenario_data), State.model_validate(case.get("state"))


app = FastAPI(title="MIZUHO · Atelier M4/M5")
app.mount("/assets", StaticFiles(directory=ASSETS), name="workbench-assets")
app.include_router(assistant_router)


@app.get("/", include_in_schema=False)
def workbench_page():
    return FileResponse(ASSETS / "index.html")


@app.get("/assistant", include_in_schema=False)
def assistant_page():
    return FileResponse(ASSETS / "assistant.html")


@app.get("/api/scenario")
def configured_scenario():
    path = environ.get("MIZUHO_SCENARIO_FILE")
    if not path:
        return {"case": None}
    try:
        case = loads(Path(path).read_text(encoding="utf-8-sig"))
        load_case(case)
    except (OSError, ValueError, TypeError) as error:
        raise HTTPException(503, "Le fichier de scénario configuré est illisible ou invalide.") from error
    return {"case": case, "filename": Path(path).name}


@app.post("/api/incident")
def run_incident(request: IncidentRequest):
    started = perf_counter()
    try:
        scenario, start = load_case(request.case)
        disruption = with_grid_outages(scenario, start, request.outage_slots)
    except ValidationError as error:
        raise HTTPException(422, error.errors(include_url=False, include_context=False, include_input=False)) from error
    except (ValueError, TypeError) as error:
        raise HTTPException(422, str(error)) from error
    if disruption.slots == scenario.slots:
        raise HTTPException(422, "Les créneaux choisis sont déjà tous en coupure.")

    nominal = optimize(scenario, start)
    if nominal.actions is None:
        raise HTTPException(503, {"stage": "initial", "status": nominal.status, "warnings": nominal.warnings})
    cutoff = min(request.outage_slots)
    executed = tuple(action for action in nominal.actions if action.slot < cutoff)
    prefix = simulate(scenario, start, executed, stop_before_slot=cutoff)
    checkpoint = prefix.end_state
    if checkpoint is None:
        raise HTTPException(500, "Le rejeu du plan initial a échoué.")

    continuation = tuple(action for action in nominal.actions if action.slot >= cutoff)
    reference = replay_plan(disruption, checkpoint, continuation)
    optimized = optimize(disruption, checkpoint)
    if optimized.actions is None:
        raise HTTPException(503, {"stage": "recalcul", "status": optimized.status, "warnings": optimized.warnings})
    reference_slots = prefix.slots + reference.slots
    optimized_slots = prefix.slots + optimized.slots
    return {
        "runtime_ms": round((perf_counter() - started) * 1_000),
        "outage_slots": sorted(request.outage_slots),
        "capacity_m3": scenario.site.tank_capacity_m3,
        "checkpoint": checkpoint,
        "nominal": {"slots": nominal.slots, "status": nominal.status, "warnings": nominal.warnings},
        "without_replan": {"slots": reference_slots, "status": reference.status},
        "with_replan": {"slots": optimized_slots, "status": optimized.status, "warnings": optimized.warnings},
        "analyses": {
            "water": analyze_water(optimized_slots, scenario.site, start),
            "energy": analyze_energy(optimized_slots, scenario.site),
            "equity": analyze_equity(reference.plot_results, optimized.plot_results),
        },
    }

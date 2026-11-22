from typing import Annotated, Literal, Self

from fastapi import APIRouter, Request, Response
from pydantic import Field, model_validator

from .baseline import replay_plan
from .compare import InputError, to_api_plan
from .models import Action, ApiPlan, CompareRequest, Delivery, HourOfDay, PlanningModel, ZoneAmount, ZonePlanRequest
from .optimizer import optimize
from .resilience import computation_slot, resolve


router = APIRouter(tags=["Irrigation planning"])


class RotationHour(PlanningModel):
    hour: HourOfDay
    pump_m3: ZoneAmount
    plot_id: Annotated[str, Field(min_length=1, max_length=100)] | None = None
    delivery_m3: ZoneAmount

    @model_validator(mode="after")
    def validate_delivery(self) -> Self:
        if self.delivery_m3 and self.plot_id is None:
            raise ValueError("Select a parcel for this delivery.")
        return self


class RotationRequest(PlanningModel):
    plan: CompareRequest | ZonePlanRequest
    hours: Annotated[tuple[RotationHour, ...], Field(min_length=1, max_length=24)]


class ReplayedHour(RotationHour):
    feasible_pump_m3: int
    feasible_delivery_m3: int


class RotationResult(PlanningModel):
    provenance: Literal["simulated"] = "simulated"
    hours: list[ReplayedHour]
    operator: ApiPlan
    optimized: ApiPlan


@router.post("/api/sites/{site_id}/operator-rotation")
def compare_operator_rotation(site_id: str, body: RotationRequest, request: Request, response: Response) -> RotationResult:
    response.headers["Cache-Control"] = "no-store"
    plan = body.plan
    if isinstance(plan, CompareRequest):
        if plan.planning_mode != "nominal" or plan.weather_pair_id is not None or plan.incident is not None:
            raise InputError("plan", "Use a nominal day without incident replanning or paired weather scenarios.")
        if (plan.state.current_slot or any(plan.state.delivered_by_plot_m3.values())
                or any(plan.state.delivered_on_time_by_plot_m3.values())):
            raise InputError("plan", "Start the day before the first completed action to compare rotations.")
    scenario, state = resolve(request.app.state.catalog, site_id, plan)
    plots = {plot.plot_id for plot in scenario.plots}
    hours_used: set[int] = set()
    actions = []
    for index, row in enumerate(body.hours):
        if row.hour in hours_used or row.hour >= len(scenario.slots):
            raise InputError(("hours", index, "hour"), "Use a distinct hour inside the selected planning day.")
        if row.plot_id is not None and row.plot_id not in plots:
            raise InputError(("hours", index, "plot_id"), "Choose a parcel in the selected scenario.")
        hours_used.add(row.hour)
        deliveries = (Delivery(plot_id=row.plot_id, delivered_m3=row.delivery_m3),) if row.delivery_m3 else ()
        actions.append(Action(slot=row.hour, pump_m3=row.pump_m3, deliveries=deliveries))

    operator = replay_plan(scenario, state, actions)
    operator_api = to_api_plan(scenario, state, operator)
    # A rotation replay always yields a physical action for each hour, including idle hours.
    actual = {action.slot: action for action in operator.actions}
    replayed = []
    for row in sorted(body.hours, key=lambda r: r.hour):
        action = actual[row.hour]
        replayed.append(ReplayedHour(**row.model_dump(), feasible_pump_m3=action.pump_m3,
                                     feasible_delivery_m3=sum(d.delivered_m3 for d in action.deliveries)))
    with computation_slot():
        optimized = optimize(scenario, state, max_time_seconds=request.app.state.resilience_budget)
    return RotationResult(hours=replayed, operator=operator_api, optimized=to_api_plan(scenario, state, optimized))

"""Hourly energy balance for residents on a separate backup circuit during an outage."""

from typing import Annotated, Literal, Self

from fastapi import APIRouter
from pydantic import Field, model_validator

from .models import HourOfDay, PlanningModel


router = APIRouter(prefix="/api/resilience", tags=["resilience"])
Power = Annotated[int, Field(strict=True, ge=0, le=10_000_000)]


class CivicInputs(PlanningModel):
    start_hour: HourOfDay
    duration_hours: Annotated[int, Field(strict=True, ge=1, le=24)]
    households: Annotated[int, Field(strict=True, ge=1, le=10_000)]
    essential_w_per_home: Annotated[int, Field(strict=True, ge=0, le=100_000)]
    lighting_w_per_home: Annotated[int, Field(strict=True, ge=0, le=100_000)]
    lights_from_hour: HourOfDay
    lights_until_hour: HourOfDay
    available_ac_wh: Annotated[int, Field(strict=True, ge=0, le=1_000_000_000)]
    island_output_w: Power

    @model_validator(mode="after")
    def check_loads(self) -> Self:
        if not self.essential_w_per_home and not self.lighting_w_per_home:
            raise ValueError("Enter at least one circuit load.")
        if self.lighting_w_per_home and self.lights_from_hour == self.lights_until_hour:
            raise ValueError("Lighting needs a distinct start and end hour.")
        return self


class CivicHour(PlanningModel):
    day_offset: int
    hour: int
    demand_wh: int
    supplied_wh: int
    unserved_wh: int
    remaining_ac_wh: int


class CivicResult(PlanningModel):
    provenance: Literal["simulated"] = "simulated"
    demand_wh: int
    supplied_wh: int
    unserved_wh: int
    minimum_island_output_w: int
    first_shortfall_after_minutes: int | None
    hours: list[CivicHour]


@router.post("/households")
def household_continuity(inputs: CivicInputs) -> CivicResult:
    """Simulate a constant critical load plus scheduled lighting, with no recharge during the outage."""
    reserve = inputs.available_ac_wh
    first_shortfall = None
    hours = []
    lighting_duration = (inputs.lights_until_hour - inputs.lights_from_hour) % 24
    for offset in range(inputs.duration_hours):
        day, hour = divmod(inputs.start_hour + offset, 24)
        lights_on = (hour - inputs.lights_from_hour) % 24 < lighting_duration
        demand = inputs.households * (inputs.essential_w_per_home + (inputs.lighting_w_per_home if lights_on else 0))
        supplied = min(demand, reserve, inputs.island_output_w)
        if first_shortfall is None and supplied < demand:
            # An undersized inverter cannot serve the entire load even with a full battery.
            minutes = 0 if inputs.island_output_w < demand else supplied * 60 // demand
            first_shortfall = offset * 60 + minutes
        reserve -= supplied
        hours.append(CivicHour(day_offset=day, hour=hour, demand_wh=demand, supplied_wh=supplied,
                              unserved_wh=demand - supplied, remaining_ac_wh=reserve))
    return CivicResult(demand_wh=sum(row.demand_wh for row in hours),
                       supplied_wh=sum(row.supplied_wh for row in hours),
                       unserved_wh=sum(row.unserved_wh for row in hours),
                       minimum_island_output_w=max(row.demand_wh for row in hours),
                       first_shortfall_after_minutes=first_shortfall, hours=hours)

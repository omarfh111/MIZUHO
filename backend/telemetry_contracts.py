"""Public replay and virtual-meter response contracts."""

from typing import Literal

from pydantic import AwareDatetime

from .models import PlanningModel, SlotBalance


class Sample(PlanningModel):
    site_id: str
    simulation_slot: int
    timestamp: AwareDatetime
    equipment_id: str
    value: float | bool | None
    unit: str
    quality: Literal["valid", "missing", "unavailable"]
    source: Literal["virtual_sensor", "m4_replay"]
    provenance: Literal["simulated"]


class Measurement(Sample):
    sensor_id: str
    metric: str


class Event(Sample):
    type: str
    message: str


class Period(PlanningModel):
    start: AwareDatetime
    end: AwareDatetime


class Alert(Event):
    period: Period
    reference: float


class Diagnosis(PlanningModel):
    site_id: str
    water_balance: Literal["ok", "insufficient_data"]
    pump_energy_intensity: Literal["ok", "insufficient_data"]


class ObservedRecord(PlanningModel):
    site_id: str
    timestamp: AwareDatetime
    simulation_slot: int
    grid_available: bool
    provenance: Literal["simulated"]
    tank_stock_m3: float
    pumped_m3: float | None
    water_in_m3: float
    distributed_m3: float
    consumed_wh: float
    solar_wh: float | None
    pump_power_kw: float
    pump_energy_total_kwh: float | None
    solar_generated_wh: float | None
    solar_used_wh: float | None
    grid_import_wh: float | None


class Projection(PlanningModel):
    measurements: list[Measurement]
    events: list[Event]
    alerts: list[Alert]
    records: list[ObservedRecord]
    diagnostics: list[Diagnosis]
    timezone: str
    provenance: Literal["simulated"]
    physical_source: Literal["supplied_hourly_states", "m4_replay"]


class ParcelFrame(PlanningModel):
    plot_id: str
    farmer_id: str
    delivered_m3: int
    delivered_on_time_m3: int
    demand_m3: int
    minimum_m3: int
    coverage_bp: int | None


class PhysicalFrame(SlotBalance):
    timestamp: AwareDatetime
    grid_available: bool
    pump_available: bool
    solar_potential_wh: int
    tank_capacity_m3: int
    parcels: list[ParcelFrame]


class Replay(Projection):
    site_id: str
    plan: Literal["baseline", "optimized"]
    validation: Literal["physical_feasibility_of_submitted_actions"]
    frames: list[PhysicalFrame]


class ArchivedOption(PlanningModel):
    id: str
    site_id: str
    label: str
    latitude: float
    longitude: float
    capacity_kwp: float
    tilt_deg: float
    azimuth_deg: float
    compass_azimuth_deg: float
    losses_pct: float
    mounting: str
    series_year: int
    period: str
    provenance: Literal["estimated"]
    source_id: str
    source_file: str
    source_url: str
    timezone: str
    profile_date: str
    profile_wh: list[int]
    production_kwh: float
    self_consumed_kwh: float | None
    grid_avoided_kwh: float | None
    gross_savings_tnd: float | None
    annual_production_kwh: float | None
    annual_self_consumed_kwh: float | None
    annual_grid_avoided_kwh: float | None
    annual_gross_savings_tnd: float | None
    net_savings_tnd: float | None
    payback_years: float | None


class ArchivedComparison(PlanningModel):
    site_id: str
    day: str
    load_provenance: Literal["simulated"]
    options: list[ArchivedOption]

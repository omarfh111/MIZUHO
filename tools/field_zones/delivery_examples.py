"""Regenerate the local delivery-audit downloads from the committed catalogue."""

import csv
from datetime import date
from io import StringIO

from backend.baseline import build_baseline
from backend.catalog import DATA_DIR, Catalog, load_catalog
from backend.models import DemandEstimateRequest, Scenario, State, ZonePlanRequest
from backend.zone_planning import ZonePlanningProfile, estimate_demand, zone_scenario

OUTPUT = DATA_DIR.parent / "frontend/src/assets/delivery-examples"
COLUMNS = ("date", "parcel_id", "last_slot", "minimum_m3", "by_deadline_m3", "by_day_end_m3")
REPLAY_DAY = date(2025, 7, 15)


def regional_inputs(profile: ZonePlanningProfile) -> ZonePlanRequest:
    # These are demonstration assumptions, shared across locations. Regional
    # weather drives the demand and hourly PV estimates independently at each site.
    basis = {sector: DemandEstimateRequest(date=REPLAY_DAY, area_m2=area, crop_coefficient=1.1,
                                           effective_rain_fraction=0.8, application_efficiency=0.8)
             for sector, area in (("west", 1000), ("east", 750))}
    return ZonePlanRequest(date=REPLAY_DAY, tank_capacity_m3=20, initial_stock_m3=1, withdrawal_limit_m3=16,
                           pump_flow_m3_h=4, pump_wh_per_m3=500, gravity_flow_m3_h=4, grid_cap_w=500,
                           pv_capacity_kwp=2.5, pv_performance_ratio=0.8, delivery_start_hour=8, delivery_end_hour=15,
                           outage_hours=(11, 12, 13), demand_basis=basis,
                           demand_west_m3=estimate_demand(profile, basis["west"]).demand_m3,
                           demand_east_m3=estimate_demand(profile, basis["east"]).demand_m3)


def csv_text(header, rows) -> str:
    stream = StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return stream.getvalue()


def simulated_csv(site_id: str, day: date, scenario: Scenario, state: State) -> str:
    baseline = build_baseline(scenario, state)
    if baseline.metrics is None:
        raise ValueError(f"No verified fixed-turn replay for {site_id}")
    results = {item.plot_id: item for item in baseline.plot_results}
    return csv_text((*COLUMNS, "simulated_site"), (
        (day, plot.plot_id, plot.deadline_slot, plot.minimum_m3, results[plot.plot_id].delivered_on_time_m3,
         results[plot.plot_id].delivered_m3, site_id) for plot in scenario.plots if plot.minimum_m3 > 0))


def example_files(catalog: Catalog) -> dict[str, str]:
    files = {}
    for site_id, profile in catalog.zone_planning.items():
        scenario, state, day = zone_scenario(profile, regional_inputs(profile))
        files[f"{site_id}-simulated.csv"] = simulated_csv(site_id, day.date, scenario, state)
    pilot = catalog.scenarios["normal"]
    # The fictional normal day has no calendar date. Use the same example date as the regional files.
    files[f"{pilot.site_id}-simulated.csv"] = simulated_csv(pilot.site_id, REPLAY_DAY, pilot, pilot.state)
    for site_id, survey in catalog.agriculture.items():
        files[f"{site_id}-template.csv"] = csv_text(COLUMNS, (("", p.plot_id, "", "", "", "") for p in survey.parcels))
    return files


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, contents in example_files(load_catalog()).items():
        (OUTPUT / name).write_text(contents, encoding="utf-8", newline="\n")

"""Adapter from the reviewed M1 survey to the site catalogue and map."""

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from .models import Amount, Evidence, Feature, Layer, LayerId, PlanningModel, Plot, PlotId, SiteProperties, SlotIndex

Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
AETI = "wapor3-l2-aeti-2026-07-d2"
RAIN = "wapor3-l1-pcp-2026-07-d2"
REFERENCE_ET = "wapor3-l1-ret-2026-07-d2"


class SurveyVariable(PlanningModel):
    source_ids: tuple[PlotId, ...]
    status: Literal["observed", "estimated"]
    unit: str
    resolution: str


class TemperatureAssociation(PlanningModel):
    period: str
    samples: Annotated[int, Field(gt=0)]
    slope_mm_day_per_c: float
    p_value: Annotated[float, Field(ge=0, le=1)]


class SurveyPlot(PlanningModel):
    plot_id: PlotId
    site_id: PlotId
    source_id: PlotId
    osm_way_id: int
    geometry_date: date
    surface_m2: Annotated[float, Field(gt=0)]
    land_use: str
    farmer_id: str | None
    crop: str | None
    minimum_m3: Amount | None
    allowed_slots: tuple[SlotIndex, ...] | None
    deadline_slot: SlotIndex | None
    past_deferrals: Amount | None
    demand_m3: None = None
    eta_mm_day: Nonnegative
    precip_mm_day: Nonnegative
    ref_et_mm_day: Nonnegative
    et_minus_rain_m3_day: Nonnegative
    temperature: TemperatureAssociation


class Survey(PlanningModel):
    site_id: PlotId
    parcels: tuple[SurveyPlot, ...]
    period: str
    resolution: str
    source_ids: tuple[str, ...]
    variables: dict[str, SurveyVariable]
    quota_m3: Amount | None
    optimizer_ready: Literal[False] = False
    interpretation: str = ("Parcel volumes estimate positive actual evapotranspiration minus gross rainfall. "
                           "Irrigation demand requires crop, soil storage, effective rain and application efficiency. "
                           "No validated withdrawal quota or operational schedule is available.")


@dataclass(frozen=True)
class SurveyDataset:
    survey: Survey
    site: Feature[SiteProperties]
    layers: dict[tuple[str, LayerId], Layer]
    sources: dict[str, Evidence]


def mm_to_m3(depth_mm: float, surface_m2: float) -> float:
    if depth_mm < 0 or surface_m2 <= 0:
        raise ValueError("Expected nonnegative water depth and positive parcel area.")
    return depth_mm * surface_m2 / 1000


def load_plots(site_id: str, data_dir: Path | None = None) -> tuple[SurveyPlot | Plot, ...]:
    """Load the mapped parcels for one site from the same offline catalogue as M6."""
    from .catalog import DATA_DIR, load_catalog

    return load_catalog(data_dir or DATA_DIR).load_plots(site_id)


def read_survey(folder: Path) -> SurveyDataset:
    def read(name):
        return json.loads((folder / name).read_bytes())

    site_geometry = read("site.geojson")
    site_data = site_geometry["properties"]
    site_id = site_data["site_id"]
    sources = {}
    for record in read("sources.json"):
        key = record["source_id"]
        url = record["url"]
        if "{dekad}" in url:
            url = "https://www.fao.org/in-action/remote-sensing-for-water-productivity/en"
        if record["organisation"] == "OpenStreetMap contributors":
            url = "https://www.openstreetmap.org/copyright"
        sources[key] = Evidence(title=record["title"], organization=record["organisation"],
                                date=record["retrieved_at"][:10], page=None, url=url,
                                limitation=" · ".join(filter(None, ["Date is the snapshot retrieval date", record["license"], record.get("resolution"),
                                                                    record.get("period"), record.get("limits")])))
    site = Feature[SiteProperties].model_validate({
        **site_geometry,
        "properties": {"site_id": site_id, "label": "Assila", "locality": "Balta Bouawene · Jendouba",
                       "description": "Mapped farmland with satellite water-use estimates and incomplete planning inputs.",
                       "date": sources[site_data["source_id"]].date, "status": "observed",
                       "source_id": site_data["source_id"], "survey_available": True},
    })
    raster = read("wapor.geojson")
    metadata = raster["metadata"]
    period = metadata["period"]
    resolution = f"{metadata['resolution_approx_m']} m"
    temperature = read("temperature.json")
    parcels, boundaries = [], []
    for feature in read("plots.geojson")["features"]:
        p = feature["properties"]
        plot_id = p["plot_id"]
        if p["site_id"] != site_id or p["period"] != period or p["need_source_id"] != metadata["source_id"]:
            raise ValueError(f"Inconsistent survey metadata for {plot_id}.")
        fit = temperature["plots"][plot_id]
        parcel = SurveyPlot(
            **{key: p[key] for key in ("plot_id", "site_id", "source_id", "osm_way_id", "surface_m2", "land_use", "farmer_id", "crop",
                                       "minimum_m3", "allowed_slots", "deadline_slot", "past_deferrals",
                                       "eta_mm_day", "precip_mm_day", "ref_et_mm_day")},
            geometry_date=p["osm_last_edit"][:10],
            et_minus_rain_m3_day=round(mm_to_m3(max(0, p["eta_mm_day"] - p["precip_mm_day"]), p["surface_m2"]), 3),
            temperature=TemperatureAssociation(period=temperature["period"], samples=fit["n"],
                                               slope_mm_day_per_c=fit["slope"], p_value=fit["p"]),
        )
        parcels.append(parcel)
        boundaries.append({**feature, "properties": {"label": f"Parcel {plot_id}", "plot_id": plot_id,
                           "source_id": p["source_id"], "date": parcel.geometry_date, "status": "observed",
                           "signal": "Mapped farmland · crop unverified"}})
    if sorted(p.plot_id for p in parcels) != sorted(set(site_data["plot_ids"])):
        raise ValueError("Survey parcel IDs must be unique and match the site's parcel list.")
    variables = {
        "surface_m2": SurveyVariable(source_ids=("osm-jendouba-farmland",), status="estimated", unit="m²",
                                     resolution="Area computed from the mapped parcel boundary"),
        "eta_mm_day": SurveyVariable(source_ids=(AETI,), status="estimated", unit="mm/day", resolution=resolution),
        "precip_mm_day": SurveyVariable(source_ids=(RAIN,), status="estimated", unit="mm/day", resolution="about 5 km"),
        "ref_et_mm_day": SurveyVariable(source_ids=(REFERENCE_ET,), status="estimated", unit="mm/day", resolution="about 30 km"),
        "et_minus_rain_m3_day": SurveyVariable(source_ids=("osm-jendouba-farmland", AETI, RAIN), status="estimated",
                                               unit="m³/day", resolution="Per parcel, using mixed-resolution grids"),
        "temperature": SurveyVariable(source_ids=("nasa-power-daily", "wapor3-l2-aeti-series"), status="estimated",
                                      unit="mm/day per °C", resolution="NASA POWER 0.5° × 0.625°, WaPOR 100 m"),
    }
    if any(set(variable.source_ids) - sources.keys() for variable in variables.values()):
        raise ValueError("Agricultural variable references an unknown source.")
    survey = Survey(site_id=site_id, parcels=tuple(parcels), quota_m3=site_data["quota_m3"], period=period,
                    resolution=resolution, source_ids=tuple(sources), variables=variables)
    cells = [{**f, "properties": {"label": "WaPOR AETI", "source_id": metadata["source_id"],
                                   "eta_mm_day": f["properties"]["eta_mm_day"]}} for f in raster["features"]]
    layers = {
        (site_id, LayerId.PLOTS): Layer(type="FeatureCollection", features=boundaries,
            source_id=boundaries[0]["properties"]["source_id"], status="observed"),
        (site_id, LayerId.WAPOR): Layer(type="FeatureCollection", features=cells, date=period.split("/")[1],
            source_id=metadata["source_id"], status="estimated", period=period, unit=metadata["unit"], resolution=resolution),
    }
    return SurveyDataset(survey, site, layers, sources)

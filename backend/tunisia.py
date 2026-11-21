"""Versioned national map and sourced regional environmental profiles."""

from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from statistics import fmean
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, HttpUrl, model_validator

from .catalog import DATA_DIR

ARCHIVE_DIR = DATA_DIR / "tunisia"
CATALOG_FILE = "catalog.json"
CityId = Annotated[str, Field(pattern=r"^[0-9]{1,12}$")]
Longitude = Annotated[FiniteFloat, Field(ge=-180, le=180)]
Latitude = Annotated[FiniteFloat, Field(ge=-90, le=90)]


class ArchiveModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Source(ArchiveModel):
    id: str
    name: str
    url: HttpUrl
    attribution: str
    license: str
    provenance: Literal["mapped", "estimated"]
    retrieved_at: datetime
    coverage: str
    sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")] | None = None
    assets: tuple[HttpUrl, ...] = ()


class City(ArchiveModel):
    id: CityId
    name: str
    latitude: Latitude
    longitude: Longitude
    population: Annotated[int, Field(ge=1)] | None


class Boundary(ArchiveModel):
    type: Literal["FeatureCollection"]
    features: Annotated[tuple[dict, ...], Field(min_length=1)]


class TunisiaCatalog(ArchiveModel):
    boundary: Boundary
    cities: Annotated[tuple[City, ...], Field(min_length=1)]
    sources: Annotated[tuple[Source, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def unique_cities(self):
        if len({city.id for city in self.cities}) != len(self.cities):
            raise ValueError("A city ID must be unique.")
        return self


class Relief(ArchiveModel):
    rows: Annotated[int, Field(ge=2, le=51)]
    cols: Annotated[int, Field(ge=2, le=51)]
    bounds: tuple[Longitude, Latitude, Longitude, Latitude]
    elevations: tuple[FiniteFloat | None, ...]
    source: Source

    @model_validator(mode="after")
    def validate_grid(self):
        west, south, east, north = self.bounds
        if west >= east or south >= north or len(self.elevations) != self.rows * self.cols:
            raise ValueError("Invalid relief bounds or grid size.")
        if all(value is None for value in self.elevations):
            raise ValueError("An empty grid must be reported as unavailable.")
        return self


class Climate(ArchiveModel):
    start: date
    end: date
    temperature_mean_c: FiniteFloat
    precipitation_mm: Annotated[FiniteFloat, Field(ge=0)]
    irradiation_mean_kwh_m2_day: Annotated[FiniteFloat, Field(ge=0)]
    days: Annotated[int, Field(ge=1)]
    source: Source

    @model_validator(mode="after")
    def validate_period(self):
        if self.days > (self.end - self.start).days + 1:
            raise ValueError("Climate days exceed the named period.")
        return self


class TunisiaCityAnalysis(ArchiveModel):
    city: City
    relief: Relief | None
    climate: Climate | None


DailySample = tuple[FiniteFloat, Annotated[FiniteFloat, Field(ge=0)], Annotated[FiniteFloat, Field(ge=0)]]


def climate_summary(
    start: date, end: date, daily: tuple[DailySample | None, ...], source: Source,
) -> Climate | None:
    valid = [sample for sample in daily if sample is not None]
    if not valid:
        return None
    temperatures, rainfall, irradiance = zip(*valid, strict=True)
    return Climate(
        start=start, end=end, temperature_mean_c=round(fmean(temperatures), 2),
        precipitation_mm=round(sum(rainfall), 2),
        irradiation_mean_kwh_m2_day=round(fmean(irradiance), 3), days=len(valid), source=source,
    )


class ClimateSeries(ArchiveModel):
    start: date
    end: date
    daily: tuple[DailySample | None, ...]
    source: Source

    @model_validator(mode="after")
    def complete_calendar(self):
        if len(self.daily) != (self.end - self.start).days + 1 or not self.daily:
            raise ValueError("Climate series must contain one entry per archive day.")
        return self


class ArchivedCity(ArchiveModel):
    city: City
    relief: Relief | None
    climate_series: ClimateSeries | None


class TunisiaArchive(TunisiaCatalog):
    profiles: dict[str, ArchivedCity]

    @model_validator(mode="after")
    def matching_profiles(self):
        if set(self.profiles) != {city.id for city in self.cities}:
            raise ValueError("Every catalog city must have a corresponding profile.")
        if any(self.profiles[city.id].city != city for city in self.cities):
            raise ValueError("Profile geography must match the catalog.")
        return self


class ArchiveUnavailableError(RuntimeError):
    """The verified national archive is missing or invalid."""


class ClimatePeriodError(ValueError):
    """The requested time period is outside the archive."""


@lru_cache(maxsize=4)
def _read_archive(path: Path, modified_ns: int, size: int) -> TunisiaArchive:
    return TunisiaArchive.model_validate_json(path.read_bytes())


def _archive(data_dir: Path) -> TunisiaArchive:
    path = data_dir / CATALOG_FILE
    try:
        stat = path.stat()
        return _read_archive(path, stat.st_mtime_ns, stat.st_size)
    except (OSError, ValueError) as exc:
        raise ArchiveUnavailableError("The Tunisia data archive is unavailable.") from exc


def get_catalog(data_dir: Path = ARCHIVE_DIR) -> TunisiaCatalog:
    archive = _archive(data_dir)
    return TunisiaCatalog(boundary=archive.boundary, cities=archive.cities, sources=archive.sources)


def get_city_analysis(
    city_id: str, data_dir: Path = ARCHIVE_DIR, *, start: date | None = None, end: date | None = None,
) -> TunisiaCityAnalysis:
    """Raise KeyError for an unknown ID or ArchiveUnavailableError for a missing archive."""
    entry = _archive(data_dir).profiles[city_id]
    series = entry.climate_series
    if (start is None) != (end is None) or (start is not None and end is not None and start > end):
        raise ClimatePeriodError("Provide both climate dates in chronological order.")
    climate = None
    if series:
        first, last = start or series.start, end or series.end
        if first < series.start or last > series.end:
            raise ClimatePeriodError(f"Select dates from {series.start} to {series.end}.")
        dates = slice((first - series.start).days, (last - series.start).days + 1)
        climate = climate_summary(first, last, series.daily[dates], series.source)
    return TunisiaCityAnalysis(city=entry.city, relief=entry.relief, climate=climate)


router = APIRouter(prefix="/api/tunisia", tags=["Tunisia atlas"])


@router.get("")
def catalog(request: Request) -> TunisiaCatalog:
    try:
        return get_catalog(getattr(request.app.state, "tunisia_data_dir", ARCHIVE_DIR))
    except ArchiveUnavailableError as error:
        raise HTTPException(503, str(error)) from error


@router.get("/cities/{city_id}")
def city_profile(
    request: Request, city_id: CityId, start: date | None = None, end: date | None = None,
) -> TunisiaCityAnalysis:
    try:
        return get_city_analysis(
            city_id, getattr(request.app.state, "tunisia_data_dir", ARCHIVE_DIR), start=start, end=end,
        )
    except KeyError as error:
        raise HTTPException(404, "Unknown Tunisian city.") from error
    except ArchiveUnavailableError as error:
        raise HTTPException(503, str(error)) from error
    except ClimatePeriodError as error:
        raise HTTPException(422, str(error)) from error

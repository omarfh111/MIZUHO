"""Georeferenced profile windows for researched agricultural zones."""

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .models import Evidence, Feature, Point, SiteProperties
from .tunisia import ArchiveModel, Climate, Relief, Source

CoverCode = Literal[10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]

LAND_COVER_LABELS = {
    10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland",
    50: "Built-up", 60: "Bare or sparse vegetation", 70: "Snow and ice",
    80: "Permanent water", 90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen",
}


class LandCover(ArchiveModel):
    rows: Annotated[int, Field(ge=2, le=256)]
    cols: Annotated[int, Field(ge=2, le=256)]
    classes: tuple[CoverCode | None, ...]
    pixel_counts: dict[int, Annotated[int, Field(gt=0)]]
    source: Source

    @model_validator(mode="after")
    def aligned_cover(self):
        if len(self.classes) != self.rows * self.cols or not self.pixel_counts:
            raise ValueError("The land-cover window must contain a valid grid and its source pixel counts.")
        if self.pixel_counts.keys() - LAND_COVER_LABELS.keys():
            raise ValueError("The source window contains unknown land-cover classes.")
        if not {code for code in self.classes if code is not None} <= self.pixel_counts.keys():
            raise ValueError("Land-cover samples contain a class absent from their source window.")
        return self


class FieldZone(ArchiveModel):
    site: Feature[SiteProperties]
    evidence: Evidence
    relief: Relief
    land_cover: LandCover
    climate: Climate
    location_source: Source
    water_question: str
    missing_inputs: tuple[str, ...]

    @model_validator(mode="after")
    def located_zone(self):
        if not isinstance(self.site.geometry, Point) or not self.site.properties.field_zone:
            raise ValueError("The field zone must register a point in the site catalogue.")
        longitude, latitude = self.site.geometry.coordinates
        west, south, east, north = self.relief.bounds
        if not (west < longitude < east and south < latitude < north):
            raise ValueError("The site reference point must be within the sampled window.")
        return self


def read_field_zones(root: Path) -> list[FieldZone]:
    return [FieldZone.model_validate_json(path.read_bytes()) for path in sorted((root / "field_zones").glob("*.json"))]

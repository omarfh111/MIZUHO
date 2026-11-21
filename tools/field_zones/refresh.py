"""Refresh agricultural demonstration windows from ESA, Copernicus and NASA data."""

import argparse
from dataclasses import dataclass
from datetime import date
from hashlib import file_digest
from math import floor
from pathlib import Path
import ssl
from tempfile import NamedTemporaryFile

import httpx
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from backend.catalog import DATA_DIR
from backend.field_zones import FieldZone, LAND_COVER_LABELS, LandCover
from backend.models import Evidence
from backend.tunisia import City, Source, climate_summary
from tools.tunisia.refresh import ElevationTiles, get_climate, get_relief, source_date


WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
WORLDCOVER_ATTRIBUTION = (
    "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) "
    "processed by ESA WorldCover consortium"
)
GRID_SIZE = 128
RADIUS_KM = 5


@dataclass(frozen=True)
class ZoneSpec:
    id: str
    name: str
    locality: str
    longitude: float
    latitude: float
    location_url: str
    location_credit: str
    description: str
    evidence_title: str
    evidence_organization: str
    evidence_year: str
    evidence_url: str
    water_question: str
    limitation: str
    missing_inputs: tuple[str, ...]


ZONES = (
    ZoneSpec(
        id="korba-cap-bon", name="Korba · Cap Bon", locality="Nabeul · Coastal agriculture",
        longitude=10.85861, latitude=36.57861, location_url="https://www.geonames.org/2467920/korba.html",
        location_credit="GeoNames contributors",
        description="A coastal agricultural window around Korba, where groundwater used for irrigation is exposed to seawater intrusion.",
        evidence_title="Vulnerability of a Tunisian Coastal Aquifer to Seawater Intrusion",
        evidence_organization="Water · peer-reviewed Korba aquifer study", evidence_year="2022",
        evidence_url="https://doi.org/10.3390/w14071177",
        water_question="What water-quality checks are needed before relying on a coastal well for irrigation?",
        limitation="Aquifer-scale vulnerability modelling. The study does not give current salinity, pumping rates or water rights for this map window.",
        missing_inputs=("Recent well conductivity and groundwater level", "Parcel demand and abstraction authorization",
                        "Pump and storage specifications"),
    ),
    ZoneSpec(
        id="kairouan-chebika", name="Kairouan Plain · Chebika", locality="Kairouan · Central irrigated plain",
        longitude=9 + 53 / 60 + 57 / 3600, latitude=35 + 34 / 60 + 51 / 3600,
        location_url="https://doi.org/10.3390/rs10121953", location_credit="Bousbih et al., Remote Sensing (2018)",
        description="A window on the semi-arid Kairouan plain near the Chebika research area, where remote sensing has been studied for irrigation mapping.",
        evidence_title="Soil Moisture and Irrigation Mapping in a Semi-Arid Region",
        evidence_organization="Remote Sensing · Bousbih et al.", evidence_year="2018",
        evidence_url="https://horizon.documentation.ird.fr/exl-doc/pleins_textes/divers19-02/010074950.pdf",
        water_question="Which field observations would let us tell recent irrigation from rainfall or land-cover differences?",
        limitation="The paper studies satellite irrigation mapping. The app's independent WorldCover layer maps land-cover classes and does not identify recent irrigation.",
        missing_inputs=("Parcel boundaries and current crop calendars", "Recent irrigation and rainfall observations",
                        "Withdrawal limits and storage measurements"),
    ),
    ZoneSpec(
        id="gafsa-oasis", name="Gafsa · El Ksar oasis landscape", locality="Gafsa · Inland oasis",
        longitude=8.80399, latitude=34.3992, location_url="https://www.geonames.org/2473466/",
        location_credit="GeoNames contributors",
        description="A landscape window around El Ksar in the Gafsa oasis area, where FAO documents layered cultivation and traditional water-sharing.",
        evidence_title="Gafsa Oases · Globally Important Agricultural Heritage Systems",
        evidence_organization="FAO", evidence_year="2011",
        evidence_url="https://www.fao.org/giahs/giahs-around-the-world/gafsa-oases--tunisia/en",
        water_question="What delivery turns and canal measurements are needed to represent shared oasis irrigation?",
        limitation="FAO describes the historical oasis and its water-sharing practices. This map window is centred on El Ksar and does not trace the heritage boundary.",
        missing_inputs=("Current water turns and canal rights", "Canal flow and conveyance losses",
                        "Plot demand and verified storage"),
    ),
)


def tile_name(latitude: float, longitude: float) -> str:
    return f"N{3 * floor(latitude / 3):02d}E{3 * floor(longitude / 3):03d}"


def download_tile(client: httpx.Client, url: str, destination: Path) -> None:
    if destination.is_file():
        return
    with NamedTemporaryFile(dir=destination.parent, suffix=".tif.tmp", delete=False) as target:
        temporary = Path(target.name)
    try:
        with client.stream("GET", url) as response, temporary.open("wb") as target:
            response.raise_for_status()
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > 200_000_000:
                    raise ValueError("Unexpected WorldCover tile size.")
                target.write(chunk)
            advertised = response.headers.get("Content-Length")
            if not size or (advertised is not None and size != int(advertised)):
                raise ValueError("Incomplete WorldCover tile.")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def cover_grid(client: httpx.Client, cache: Path, bounds: tuple[float, float, float, float]) -> LandCover:
    west, south, east, north = bounds
    tiles = {tile_name(lat, lon) for lat in (south, north) for lon in (west, east)}
    if len(tiles) != 1:
        raise ValueError("This profile window must fit inside a single WorldCover tile.")
    filename = f"ESA_WorldCover_10m_2021_v200_{tiles.pop()}_Map.tif"
    url = f"{WORLDCOVER}/{filename}"
    cached = cache / filename
    download_tile(client, url, cached)
    with rasterio.open(cached) as raster:
        if raster.crs.to_epsg() != 4326 or raster.count != 1:
            raise ValueError("Expected a single WGS84 WorldCover classification band.")
        window = from_bounds(west, south, east, north, raster.transform)
        raw = raster.read(1, window=window, masked=True)
        classes, counts = np.unique(raw.compressed(), return_counts=True)
        preview = raster.read(1, window=window, out_shape=(GRID_SIZE, GRID_SIZE),
                              resampling=Resampling.mode, masked=True)
    present = {int(code): int(count) for code, count in zip(classes, counts, strict=True) if code}
    if present.keys() - LAND_COVER_LABELS.keys():
        raise ValueError("The WorldCover tile contains unknown class codes.")
    with cached.open("rb") as handle:
        checksum = file_digest(handle, "sha256").hexdigest()
    return LandCover(
        rows=GRID_SIZE, cols=GRID_SIZE,
        classes=tuple(int(value) or None for value in preview.filled(0).ravel()),
        pixel_counts=present,
        source=Source(
            id="esa-worldcover-2021", name="ESA WorldCover 2021 v200", url="https://doi.org/10.5281/zenodo.7254221",
            attribution=WORLDCOVER_ATTRIBUTION, license="CC BY 4.0", provenance="estimated",
            retrieved_at=source_date(), sha256=checksum, assets=(url,),
            coverage="Categorical 10 m land cover in the profile window. The 3D texture shows the dominant class "
                     "in each coarser cell. Class shares use the original valid pixels, including water.",
        ),
    )


def build_zone(client: httpx.Client, tiles: ElevationTiles, cache: Path, spec: ZoneSpec, year: int) -> FieldZone:
    point = City(id="0", name=spec.name, latitude=spec.latitude, longitude=spec.longitude, population=None)
    relief = get_relief(tiles, point, size=33, radius_km=RADIUS_KM)
    cover = cover_grid(client, cache, relief.bounds)
    series = get_climate(client, point, date(year, 1, 1), date(year, 12, 31))
    climate = climate_summary(series.start, series.end, series.daily, series.source)
    if climate is None:
        raise ValueError("The selected year has no usable climate data.")
    return FieldZone(
        site={
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [spec.longitude, spec.latitude]},
            "properties": {"site_id": spec.id, "label": spec.name, "source_id": f"research-{spec.id}",
                           "status": "observed", "locality": spec.locality, "description": spec.description,
                           "date": source_date().date(), "field_zone": True},
        },
        evidence=Evidence(title=spec.evidence_title, organization=spec.evidence_organization,
                          date=spec.evidence_year, url=spec.evidence_url, page=None, limitation=spec.limitation),
        relief=relief, land_cover=cover, climate=climate,
        location_source=Source(
            id=f"location-{spec.id}", name="Study-window reference point", url=spec.location_url,
            attribution=spec.location_credit, license="GeoNames CC BY 4.0" if spec.location_credit.startswith("GeoNames") else "Published study coordinates",
            retrieved_at=source_date(), provenance="mapped",
            coverage="Reference point for an approximately 10 × 10 km evidence window. The window is not a cadastral or study-area boundary.",
        ),
        water_question=spec.water_question, missing_inputs=spec.missing_inputs,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=date.today().year - 1)
    parser.add_argument("--cache-dir", type=Path, required=True, help="Local directory for the original WorldCover tiles.")
    parser.add_argument("--output-dir", type=Path, default=DATA_DIR / "field_zones")
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    with httpx.Client(verify=ssl.create_default_context(), timeout=60, follow_redirects=True,
                      headers={"User-Agent": "MIZUHO Agricultural Zones/1.0"}) as client:
        tiles = ElevationTiles(client)
        zones = [build_zone(client, tiles, args.cache_dir, spec, args.year) for spec in ZONES]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for zone in zones:
        with NamedTemporaryFile(dir=args.output_dir, suffix=".json.tmp", delete=False, mode="w", encoding="utf-8", newline="\n") as target:
            path = Path(target.name)
            target.write(zone.model_dump_json() + "\n")
        try:
            path.replace(args.output_dir / f"{zone.site.properties.site_id}.json")
        finally:
            path.unlink(missing_ok=True)
        print(f"{zone.site.properties.label}: {sum(zone.land_cover.pixel_counts.values()):,} classified pixels.")


if __name__ == "__main__":
    main()

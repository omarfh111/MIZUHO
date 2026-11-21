"""Download and validate the Tunisia atlas archive from documented public sources."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from io import BytesIO
import json
from math import cos, floor, isfinite, radians
from pathlib import Path
import ssl
import sys
from tempfile import NamedTemporaryFile
from threading import Lock
from urllib.parse import urlencode, urlsplit
from zipfile import ZipFile

import httpx

from backend.tunisia import (
    ARCHIVE_DIR, CATALOG_FILE, ArchivedCity, City, ClimateSeries, Relief, Source, TunisiaArchive,
)

GEONAMES = "https://download.geonames.org/export/dump/TN.zip"
BOUNDARIES = "https://www.geoboundaries.org/api/current/gbOpen/TUN/ADM1/"
ELEVATION = "https://copernicus-dem-90m.s3.amazonaws.com"
NASA = "https://power.larc.nasa.gov/api/temporal/daily/point"
ELEVATION_CREDIT = (
    "Produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and "
    "© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"
)
GRID_SIZE = 15
RELIEF_RADIUS_KM = 6
POWER_PARAMETERS = {
    "T2M": "C",
    "PRECTOTCORR": "mm/day",
    "ALLSKY_SFC_SW_DWN": "kW-hr/m^2/day",
}


def digest(responses: list[bytes]) -> str:
    result = sha256()
    for content in responses:
        result.update(content)
    return result.hexdigest()


def source_date() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def download(client: httpx.Client, url: str, *, limit: int = 5_000_000) -> bytes:
    response = client.get(url)
    response.raise_for_status()
    if len(response.content) > limit:
        raise ValueError("Unexpected source archive size.")
    return response.content


def city_catalog(raw: bytes) -> list[City]:
    with ZipFile(BytesIO(raw)) as archive:
        if archive.getinfo("TN.txt").file_size > 15_000_000:
            raise ValueError("Unexpected GeoNames country dump size.")
        text = archive.read("TN.txt").decode("utf-8")
    capitals = {}
    for line in text.splitlines():
        row = line.split("\t")
        if len(row) != 19 or row[6] != "P" or row[7] not in ("PPLC", "PPLA") or row[8] != "TN":
            continue
        if not row[10] or row[10] in capitals:
            raise ValueError("Conflicting GeoNames governorate capitals.")
        capitals[row[10]] = City(
            id=row[0], name=row[1], latitude=float(row[4]), longitude=float(row[5]),
            population=int(row[14]) or None,
        )
    return sorted(capitals.values(), key=lambda city: city.name.casefold())


def boundary_catalog(client: httpx.Client) -> tuple[dict, Source]:
    metadata = json.loads(download(client, BOUNDARIES))
    url = metadata["simplifiedGeometryGeoJSON"]
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {"github.com", "raw.githubusercontent.com", "media.githubusercontent.com"}:
        raise ValueError("Unexpected geoBoundaries download location.")
    blob = download(client, url)
    geojson = json.loads(blob)
    if geojson["type"] != "FeatureCollection" or len(geojson["features"]) != int(metadata["admUnitCount"]):
        raise ValueError("The boundary archive does not match its published ADM1 metadata.")
    if any(entry["geometry"]["type"] not in {"Polygon", "MultiPolygon"} for entry in geojson["features"]):
        raise ValueError("Unexpected geometry in the governorate boundary layer.")
    source = Source(
        id="tunisia-adm1", name="Tunisia governorates", url=url,
        attribution=f"geoBoundaries · {metadata['boundarySource']}",
        license=metadata["boundaryLicense"], provenance="mapped", retrieved_at=source_date(),
        coverage=f"ADM1 simplified boundaries. Year represented: {metadata['boundaryYearRepresented']}. "
                 f"Release: {metadata['boundaryID']}.",
        sha256=digest([blob]),
    )
    return {"type": "FeatureCollection", "features": geojson["features"]}, source


def relief_grid(city: City):
    latitude_radius = RELIEF_RADIUS_KM / 111.32
    longitude_radius = latitude_radius / cos(radians(city.latitude))
    west, south = city.longitude - longitude_radius, city.latitude - latitude_radius
    east, north = city.longitude + longitude_radius, city.latitude + latitude_radius
    bounds = tuple(round(value, 5) for value in (west, south, east, north))
    west, south, east, north = bounds
    points = [
        (round(south + row * (north - south) / (GRID_SIZE - 1), 5),
         round(west + col * (east - west) / (GRID_SIZE - 1), 5))
        for row in range(GRID_SIZE) for col in range(GRID_SIZE)
    ]
    return bounds, points


class ElevationTiles:
    """Load the original WGS84 Copernicus tiles once per refresh."""

    def __init__(self, client: httpx.Client):
        self.client = client
        self.tiles = {}
        self.lock = Lock()

    def tile(self, lat: int, lon: int):
        from PIL import Image

        identifier = f"Copernicus_DSM_COG_30_N{lat:02d}_00_E{lon:03d}_00_DEM"
        url = f"{ELEVATION}/{identifier}/{identifier}.tif"
        with self.lock:
            if url not in self.tiles:
                self.tiles[url] = self._read_tile(Image, url)
            return url, self.tiles[url]

    def _read_tile(self, image_module, url):
        try:
            raw = download(self.client, url, limit=12_000_000)
        except httpx.HTTPStatusError as error:
            if error.response.status_code != 404:
                raise
            return None
        with image_module.open(BytesIO(raw)) as image:
            scale_x, scale_y, _ = image.tag_v2[33550]
            px, py, _, west, north, _ = image.tag_v2[33922]
            nodata = image.tag_v2.get(42113)
            values = image.copy()
        return raw, values, west - px * scale_x, north + py * scale_y, scale_x, scale_y, nodata


def get_relief(tiles: ElevationTiles, city: City) -> Relief:
    bounds, points = relief_grid(city)
    raw = {}
    elevations = []
    for latitude, longitude in points:
        url, tile = tiles.tile(floor(latitude), floor(longitude))
        if tile is None:
            elevations.append(None)
            continue
        blob, image, west, north, scale_x, scale_y, nodata = tile
        raw[url] = blob
        x = min(image.width - 1, max(0, round((longitude - west) / scale_x)))
        y = min(image.height - 1, max(0, round((north - latitude) / scale_y)))
        value = float(image.getpixel((x, y)))
        present = isfinite(value) and (nodata is None or value != float(nodata))
        elevations.append(round(value, 2) if present else None)
    return Relief(
        rows=GRID_SIZE, cols=GRID_SIZE, bounds=bounds, elevations=elevations,
        source=Source(
            id="copernicus-dem-glo90", name="Copernicus DEM GLO-90", url="https://registry.opendata.aws/copernicus-dem/",
            attribution=ELEVATION_CREDIT, license="Copernicus WorldDEM-90 free licence", provenance="estimated",
            retrieved_at=source_date(),
            coverage=f"{GRID_SIZE} × {GRID_SIZE} samples over ~{2 * RELIEF_RADIUS_KM} km per axis; "
                     "sampled surface heights in metres, ~90 m native DEM, 2021 release.",
            sha256=digest([raw[url] for url in sorted(raw)]), assets=tuple(sorted(raw)),
        ),
    )


def parse_power_days(payload: dict, start: date, end: date):
    header = payload["header"]
    if header["time_standard"] != "UTC":
        raise ValueError("Expected UTC dates from NASA POWER.")
    for code, unit in POWER_PARAMETERS.items():
        if payload["parameters"][code]["units"] != unit:
            raise ValueError(f"Unexpected NASA POWER unit for {code}.")
    parameters = payload["properties"]["parameter"]
    fill = header["fill_value"]
    samples = []
    for index in range((end - start).days + 1):
        day = (start + timedelta(days=index)).strftime("%Y%m%d")
        values = [parameters[code].get(day) for code in POWER_PARAMETERS]
        if all(isinstance(value, (int, float)) and isfinite(value) and value != fill for value in values):
            if values[1] < 0 or values[2] < 0:
                raise ValueError("NASA POWER precipitation and irradiance must be nonnegative.")
            samples.append(tuple(values))
        else:
            samples.append(None)
    if all(sample is None for sample in samples):
        raise ValueError("NASA POWER returned no complete days.")
    return tuple(samples)


def get_climate(client: httpx.Client, city: City, start: date, end: date) -> ClimateSeries:
    query = urlencode({
        "parameters": ",".join(POWER_PARAMETERS), "community": "RE", "longitude": city.longitude,
        "latitude": city.latitude, "start": start.strftime("%Y%m%d"), "end": end.strftime("%Y%m%d"),
        "format": "JSON", "time-standard": "UTC",
    })
    url = f"{NASA}?{query}"
    blob = download(client, url)
    return ClimateSeries(
        start=start, end=end, daily=parse_power_days(json.loads(blob), start, end),
        source=Source(
            id="nasa-power", name="NASA POWER daily", url=url, attribution="NASA POWER Project",
            license="NASA open data", provenance="estimated", retrieved_at=source_date(),
            coverage="MERRA-2 and SYN1DEG gridded data for the requested point. UTC complete-day "
                     "means for temperature and irradiance, precipitation summed over the same days.",
            sha256=digest([blob]),
        ),
    )


def refresh(client: httpx.Client, start: date, end: date, *, allow_partial: bool) -> TunisiaArchive:
    boundary, boundaries = boundary_catalog(client)
    blob = download(client, GEONAMES)
    cities = city_catalog(blob)
    if len(cities) != len(boundary["features"]):
        raise ValueError("GeoNames capital coverage differs from geoBoundaries governorate coverage.")
    geonames = Source(
        id="geonames-tunisia", name="GeoNames Tunisia", url=GEONAMES,
        attribution="GeoNames contributors", license="CC BY 4.0", provenance="mapped",
        retrieved_at=source_date(), coverage="Tunisian PPLC and PPLA populated places (governorate capitals). "
                                            "Population figures are gazetteer entries.", sha256=digest([blob]),
    )
    tiles = ElevationTiles(client)

    def profile(city: City) -> ArchivedCity:
        def read(fetch):
            try:
                return fetch()
            except (httpx.HTTPError, KeyError, TypeError, ValueError) as error:
                if not allow_partial:
                    raise
                print(f"{city.name}: {type(error).__name__}; source unavailable", file=sys.stderr)
                return None

        return ArchivedCity(
            city=city, relief=read(lambda: get_relief(tiles, city)),
            climate_series=read(lambda: get_climate(client, city, start, end)),
        )

    with ThreadPoolExecutor(max_workers=3) as pool:
        profiles = {entry.city.id: entry for entry in pool.map(profile, cities)}
    return TunisiaArchive(boundary=boundary, cities=cities, sources=(boundaries, geonames), profiles=profiles)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    end_of_year = date(date.today().year - 1, 12, 31)
    parser.add_argument("--start", type=date.fromisoformat, default=end_of_year.replace(month=1, day=1))
    parser.add_argument("--end", type=date.fromisoformat, default=end_of_year)
    parser.add_argument("--output-dir", type=Path, default=ARCHIVE_DIR)
    parser.add_argument("--allow-partial", action="store_true", help="Record missing relief or climate instead of failing the refresh.")
    args = parser.parse_args()
    if not 0 <= (args.end - args.start).days <= 365:
        parser.error("Select at most 366 days in chronological order.")
    with httpx.Client(
        verify=ssl.create_default_context(), timeout=45, follow_redirects=True,
        headers={"User-Agent": "MIZUHO Tunisia Atlas/1.0"},
    ) as client:
        archive = refresh(client, args.start, args.end, allow_partial=args.allow_partial)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=args.output_dir, suffix=".json.tmp", delete=False, mode="w", encoding="utf-8", newline="\n") as file:
        path = Path(file.name)
        file.write(archive.model_dump_json() + "\n")
    try:
        path.replace(args.output_dir / CATALOG_FILE)
    finally:
        path.unlink(missing_ok=True)
    relief = sum(entry.relief is not None for entry in archive.profiles.values())
    climate = sum(entry.climate_series is not None for entry in archive.profiles.values())
    print(f"Imported {len(archive.cities)} cities, {relief} relief grids and {climate} climate summaries.")


if __name__ == "__main__":
    main()

"""Refresh the elevation window around the five published OSM parcels at Assila."""

import json
from math import ceil, cos, radians
import ssl

import httpx

from backend import DATA_DIR
from backend.tunisia import City
from tools.tunisia.refresh import ElevationTiles, get_relief


def main():
    folder = DATA_DIR / "agriculture" / "assila"
    polygon = json.loads((folder / "site.geojson").read_bytes())["geometry"]["coordinates"][0]
    raster = json.loads((folder / "wapor.geojson").read_bytes())
    cells = [point for feature in raster["features"] for ring in feature["geometry"]["coordinates"] for point in ring]
    lng, lat = zip(*polygon, *cells, strict=True)
    centre_lon, centre_lat = (min(lng) + max(lng)) / 2, (min(lat) + max(lat)) / 2
    half_span = max((max(lng) - min(lng)) * cos(radians(centre_lat)), max(lat) - min(lat)) * 111.32 / 2
    radius = ceil(half_span * 1.05 * 100) / 100
    # The atlas sampler only needs coordinates. Its numeric identifier is unused here.
    point = City(id="0", name="Assila survey window", latitude=centre_lat, longitude=centre_lon, population=None)
    with httpx.Client(verify=ssl.create_default_context(), follow_redirects=True, timeout=60) as client:
        relief = get_relief(ElevationTiles(client), point, size=33, radius_km=radius)
    (folder / "relief.json").write_text(relief.model_dump_json() + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

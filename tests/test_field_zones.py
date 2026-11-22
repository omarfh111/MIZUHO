import hashlib
import json
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from backend.catalog import DATA_DIR
from backend.main import create_app


def test_registered_zones_publish_distinct_real_layers_and_climate():
    with TestClient(create_app()) as client:
        registered = client.get("/api/sites").json()["features"]
        sites = {site["properties"]["site_id"]: site for site in registered if site["properties"].get("field_zone")}
        assert {"gafsa-oasis", "kairouan-chebika", "korba-cap-bon",
                "bizerte-mateur", "sfax-el-hajeb", "sidi-bouzid-plain"} <= sites.keys()
        imagery_dir = DATA_DIR.parent / "frontend" / "src" / "assets" / "site-imagery"
        imagery = json.loads((imagery_dir / "manifest.json").read_bytes())
        cover_fingerprints, relief_grids, climates, images, questions = set(), set(), set(), set(), set()
        for identifier, site in sites.items():
            response = client.get(f"/api/sites/{identifier}/field-zone")
            assert response.status_code == 200
            zone = response.json()
            assert zone["site"]["geometry"] == site["geometry"]
            cover, relief, climate = zone["land_cover"], zone["relief"], zone["climate"]
            assert len(cover["classes"]) == cover["rows"] * cover["cols"]
            assert len(relief["elevations"]) == relief["rows"] * relief["cols"]
            assert cover["pixel_counts"]["40"] > 0
            assert sum(cover["pixel_counts"].values()) > 1_000_000
            assert cover["source"]["sha256"] and cover["source"]["assets"]
            assert climate["days"] == 365
            cover_fingerprints.add(tuple(cover["classes"]))
            relief_grids.add(tuple(relief["elevations"]))
            climates.add(climate["precipitation_mm"])
            questions.add(zone["water_question"])
            image = imagery[identifier]
            assert image["bounds"] == relief["bounds"]
            west, south, east, north = image["bounds"]
            bbox = parse_qs(urlsplit(image["url"]).query)["BBOX"][0]
            assert list(map(float, bbox.split(","))) == [south, west, north, east]
            image_hash = hashlib.sha256((imagery_dir / image["asset"]).read_bytes()).hexdigest()
            assert image_hash == image["sha256"]
            images.add(image_hash)
            source = client.get(f"/api/evidence/{site['properties']['source_id']}")
            assert source.status_code == 200
            assert source.json() == zone["evidence"]
            assert client.get(f"/api/sites/{identifier}/agriculture").status_code == 404
        assert len(cover_fingerprints) == len(relief_grids) == len(images) == len(questions) == len(sites)
        assert len(climates) > 1
        assert set(sites).isdisjoint(scenario["site_id"] for scenario in client.get("/api/scenarios").json())
        assert client.get("/api/sites/jendouba-pilote/field-zone").status_code == 404

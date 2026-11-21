from fastapi.testclient import TestClient

from backend.main import create_app


def test_registered_zones_publish_distinct_real_layers_and_climate():
    with TestClient(create_app()) as client:
        registered = client.get("/api/sites").json()["features"]
        sites = {site["properties"]["site_id"]: site for site in registered if site["properties"].get("field_zone")}
        assert set(sites) == {"gafsa-oasis", "kairouan-chebika", "korba-cap-bon"}
        cover_fingerprints, relief_grids, climates = set(), set(), set()
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
            source = client.get(f"/api/evidence/{site['properties']['source_id']}")
            assert source.status_code == 200
            assert source.json() == zone["evidence"]
            assert client.get(f"/api/sites/{identifier}/agriculture").status_code == 404
        assert len(cover_fingerprints) == len(relief_grids) == len(climates) == 3
        assert set(sites).isdisjoint(scenario["site_id"] for scenario in client.get("/api/scenarios").json())
        assert client.get("/api/sites/jendouba-pilote/field-zone").status_code == 404

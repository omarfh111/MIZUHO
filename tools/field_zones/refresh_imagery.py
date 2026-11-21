"""Archive natural-colour, north-up WMS composites aligned to each study's DEM."""

import argparse
from datetime import UTC, datetime
import hashlib
from io import BytesIO
import json
from pathlib import Path
import ssl
from tempfile import TemporaryDirectory

import httpx
from PIL import Image

from backend import DATA_DIR

WMS = "https://titiler.terrascope.be/wms"
LAYER = "esa-worldcover-s2rgbnir-10m-2021-v2_tcc"
ASSETS = DATA_DIR.parent / "frontend" / "src" / "assets" / "site-imagery"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", help="Refresh one site's image and retain the other verified footprints.")
    args = parser.parse_args()
    windows = {}
    for path in sorted((DATA_DIR / "field_zones").glob("*.json")):
        windows[path.stem] = json.loads(path.read_bytes())["relief"]["bounds"]
    survey = DATA_DIR / "agriculture" / "assila"
    site_id = json.loads((survey / "site.geojson").read_bytes())["properties"]["site_id"]
    windows[site_id] = json.loads((survey / "relief.json").read_bytes())["bounds"]
    ASSETS.mkdir(parents=True, exist_ok=True)
    manifest = ASSETS / "manifest.json"
    records = json.loads(manifest.read_bytes()) if args.site and manifest.exists() else {}
    if args.site:
        if args.site not in windows:
            parser.error(f"Unknown site. Choose from {', '.join(windows)}.")
        windows = {args.site: windows[args.site]}
    outputs: dict[str, bytes] = {}
    with httpx.Client(verify=ssl.create_default_context(), follow_redirects=True, timeout=90) as client:
        for key, bounds in windows.items():
            west, south, east, north = bounds
            params = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": LAYER,
                      "STYLES": "", "TIME": "2021-01-01", "CRS": "EPSG:4326",
                      "BBOX": ",".join(map(str, [south, west, north, east])), "WIDTH": "768",
                      "HEIGHT": "768", "FORMAT": "image/png", "TRANSPARENT": "true"}
            result = client.get(WMS, params=params)
            result.raise_for_status()
            with Image.open(BytesIO(result.content)) as image:
                rgba = image.convert("RGBA")
                alpha = rgba.getchannel("A")
                if (rgba.size != (768, 768) or alpha.getextrema()[0] == 0
                        or all(hi - lo < 5 for lo, hi in rgba.convert("RGB").getextrema())):
                    raise ValueError(f"Incomplete imagery received for {key}")
                encoded = BytesIO()
                rgba.convert("RGB").save(encoded, format="WEBP", quality=86, method=6)
            filename = f"{key}.webp"
            outputs[filename] = encoded.getvalue()
            records[key] = {"bounds": bounds, "asset": filename, "url": str(result.url),
                            "source_sha256": hashlib.sha256(result.content).hexdigest(),
                            "sha256": hashlib.sha256(outputs[filename]).hexdigest(),
                            "retrieved_at": datetime.now(UTC).date().isoformat()}
    # Validate every upstream image and finish writing every temporary file before publication.
    outputs[manifest.name] = (json.dumps(records, indent=2) + "\n").encode("utf-8")
    with TemporaryDirectory(dir=ASSETS) as tmp:
        staging = Path(tmp)
        for filename, data in outputs.items():
            (staging / filename).write_bytes(data)
        for filename in outputs:
            (staging / filename).replace(ASSETS / filename)
            print(f"{filename}: {len(outputs[filename])} bytes", flush=True)


if __name__ == "__main__":
    main()

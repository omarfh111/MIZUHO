"""Serve the local M2/M3 browser interface and JSON calculations."""

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from zoneinfo import ZoneInfoNotFoundError

from .anomalies import analyze_telemetry
from .explain import EXPLAINABLE, explain_result, remember_result
from .inputs import DATA
from .sensors import project_telemetry
from .simulation import connected_snapshot, demo_network_snapshot
from .solar import compare_solar, simulation_solar_profile
from .stations import DEFAULT_SITE, demo_catalog
from .telemetry import read_telemetry
from .weather import load_weather_pair, seeded_weather_pair, validate_weather_pair


SITE = DEFAULT_SITE
LOAD_DATASETS = {"sample": "energy/load.csv", "irrigation": "energy/load-irrigation.csv", "none": None}
TELEMETRY_DATASETS = {"sample": "telemetry/sample.csv", "routine": "telemetry/routine-seed-21.csv",
                      "stress": "telemetry/stress-seed-21.csv"}
MAX_REQUEST_BYTES = 3_000_000
FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/simulation.js": ("simulation.js", "text/javascript; charset=utf-8"),
    "/explanation.js": ("explanation.js", "text/javascript; charset=utf-8"),
}


def _csv_input(payload, field, default):
    if field not in payload:
        return default
    content = payload[field]
    if not isinstance(content, str) or not content.strip():
        raise ValueError(f"{field}: supply a nonempty CSV file")
    file = StringIO(content)
    file.name = field
    return file


def _number(payload, field):
    value = payload.get(field)
    if value is not None and type(value) not in {int, float}:
        raise ValueError(f"{field}: expected a number")
    return value


def _dataset(payload, catalog, upload_field, default="sample"):
    selection = payload.get("dataset", default)
    if upload_field in payload:
        return _csv_input(payload, upload_field, None)
    if not isinstance(selection, str) or selection not in catalog:
        raise ValueError("dataset: choose one of the bundled datasets")
    path = catalog[selection]
    return DATA / path if path is not None else None


def _solar(payload):
    option_ids = payload.get("option_ids", ["toiture", "ombriere"])
    if not isinstance(option_ids, list) or not all(isinstance(item, str) for item in option_ids):
        raise ValueError("option_ids: expected a list of option names")
    use_sample = payload.get("use_sample_load", True)
    if type(use_sample) is not bool:
        raise ValueError("use_sample_load: expected true or false")
    return {"options": compare_solar(
        SITE, option_ids, _number(payload, "price"), day=payload.get("day"),
        load_path=_dataset(payload, LOAD_DATASETS, "load_csv", "sample" if use_sample else "none"),
    )}


def _forecast(payload):
    from .forecast import forecast_load

    return forecast_load(
        payload.get("site_id", SITE), payload["as_of"],
        telemetry_path=_dataset(payload, TELEMETRY_DATASETS, "telemetry_csv"),
        weather_path=_csv_input(payload, "weather_csv", None),
    )


def _anomalies(payload):
    telemetry = _dataset(payload, TELEMETRY_DATASETS, "telemetry_csv")
    rows = read_telemetry(telemetry)
    if site_id := payload.get("site_id"):
        if not isinstance(site_id, str):
            raise ValueError("site_id: choose a station")
        rows = rows.loc[rows.site_id == site_id]
        if rows.empty:
            raise ValueError(f"site_id: no telemetry for {site_id!r} in this dataset")
    return analyze_telemetry(rows, _number(payload, "reference"))


def _weather(payload):
    pair_id = payload["pair"]
    if "profiles" in payload:
        return validate_weather_pair(pair_id, payload["profiles"])
    if pair_id == "seeded":
        return seeded_weather_pair(payload.get("seed", 21))
    return load_weather_pair(pair_id)


def _simulation(payload):
    if payload.get("mode") == "connected":
        return connected_snapshot(payload.get("site_id"))
    site_id = payload.get("site_id", DEFAULT_SITE)
    queues = payload.get("fault_queues", {})
    if "faults" in payload:
        if not isinstance(site_id, str):
            raise ValueError("site_id: choose a station")
        queues = {site_id: payload["faults"]}
    selection = payload.get("solar_selection")
    solar_profile = _solar_profile(selection) if selection is not None else None
    return demo_network_snapshot(payload.get("hour", 3), site_id, queues,
                                 seed=payload.get("seed", 21), scenario=payload.get("scenario", "stress"), solar_profile=solar_profile)


def _solar_profile(payload):
    if not isinstance(payload, dict):
        raise ValueError("solar_selection: provide an option and profile date")
    site_id, option_id, day = payload.get("site_id", SITE), payload["option_id"], payload.get("day")
    if not isinstance(site_id, str) or not isinstance(option_id, str) or (day is not None and not isinstance(day, str)):
        raise ValueError("provide site_id, option_id, and an optional profile date")
    return simulation_solar_profile(site_id, option_id, day)


def _project_sensors(payload):
    return project_telemetry(payload["states"], _number(payload, "reference"), payload.get("missing_flow_slots", []))


OPERATIONS = {"solar": _solar, "forecast": _forecast, "anomalies": _anomalies, "weather": _weather,
              "simulation": _simulation, "solar/profile": _solar_profile, "telemetry/project": _project_sensors,
              "explain": lambda payload: explain_result(payload.get("explanation_id"))}


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, payload):
        self._reply(status, "application/json; charset=utf-8", json.dumps(payload, allow_nan=False).encode("utf-8"))

    def do_GET(self):
        if self.path == "/api/stations":
            self._json(200, {"stations": demo_catalog()})
            return
        asset = ASSETS.get(self.path)
        if asset is None:
            self._json(404, {"error": "Page not found."})
            return
        filename, content_type = asset
        self._reply(200, content_type, (FRONTEND / filename).read_bytes())

    def do_POST(self):
        name = self.path.removeprefix("/api/") if self.path.startswith("/api/") else ""
        operation = OPERATIONS.get(name)
        if operation is None:
            self._json(404, {"error": "Calculation not found."})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "Send an application/json request."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_REQUEST_BYTES:
                self._json(413, {"error": "Select input files totaling less than 3 MB."})
                return
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object.")
            result = operation(payload)
            if name in EXPLAINABLE and payload.get("include_explanation") is True:
                result = {**result, "explanation_id": remember_result(name, result)}
            self._json(200, result)
        except (ValueError, TypeError, KeyError, ZoneInfoNotFoundError) as error:
            self._json(422, {"error": str(error)})
        except OSError:
            logging.exception("Failed to read calculation inputs")
            self._json(500, {"error": "The server could not read a bundled input."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"Open http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()

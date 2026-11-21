import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from mizu_m2m3.simulation import connected_snapshot, demo_network_snapshot, demo_snapshot


def test_replay_only_detects_anomalies_after_required_observations():
    assert demo_snapshot(9)["alerts"] == []
    assert [alert["value"] for alert in demo_snapshot(10)["alerts"]] == [0.7]
    assert [alert["value"] for alert in demo_snapshot(14)["alerts"]] == [0.7, 13]


def test_injected_outage_and_inefficiency():
    faults = [{"hour": 4, "kind": "outage"}, {"hour": 5, "kind": "inefficiency"}]
    result = demo_snapshot(6, faults)
    assert result["records"][4]["grid_available"] is False
    assert result["records"][4]["pumped_m3"] == 0
    assert result["records"][4]["distributed_m3"] == 2
    assert [alert["value"] for alert in result["alerts"]] == [0.7]


def test_seeded_days_repeat_change_with_seed_and_keep_their_prefix():
    early = demo_snapshot(7, seed=47, scenario="routine")
    full = demo_snapshot(23, seed=47, scenario="routine")
    assert early["records"] == full["records"][:8]
    assert early["records"] == demo_snapshot(7, seed=47, scenario="routine")["records"]
    assert early["records"] != demo_snapshot(7, seed=48, scenario="routine")["records"]
    assert full["alerts"] == []


def test_invalid_seed_is_rejected():
    with pytest.raises(ValueError, match="seed"):
        demo_snapshot(3, seed=-1)


def test_faults_are_isolated_and_switching_station_preserves_clock():
    queues = {"kairouan-demo": [{"hour": 4, "kind": "inefficiency"}]}
    first = demo_network_snapshot(4, "kairouan-demo", queues, seed=21)
    assert first["alerts"] == []
    result = demo_network_snapshot(5, "kairouan-demo", queues, seed=21)
    assert result["alerts"][0]["site_id"] == "kairouan-demo"
    assert result["alerts"][0]["reference"] == 0.52
    assert {entry["site_id"]: entry["alerts"] for entry in result["stations"]} == {
        "jendouba-pilote": 0, "kairouan-demo": 1, "gabes-demo": 0,
    }
    comparison = demo_network_snapshot(5, "jendouba-pilote", queues, seed=21)
    assert comparison["stations"] == result["stations"]
    assert comparison["alerts"] == []
    assert comparison["records"][-1]["timestamp"] == result["records"][-1]["timestamp"]


def test_connected_feed_is_retrieved_and_recalculated(monkeypatch):
    readings = demo_snapshot(10)["records"]

    class TestGateway(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"records": readings}).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

    with ThreadingHTTPServer(("127.0.0.1", 0), TestGateway) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            monkeypatch.setenv("MIZU_TELEMETRY_URL", f"http://127.0.0.1:{server.server_port}/station")
            monkeypatch.setenv("MIZU_TELEMETRY_REFERENCE", "0.5")
            result = connected_snapshot()
            assert result["mode"] == "connected"
            assert result["records"][-1]["provenance"] == "observed"
            assert result["alerts"][0]["value"] == 0.7
            readings[-1]["consumed_wh"] = readings[-1]["pumped_m3"] * 500
            assert connected_snapshot()["alerts"] == []
        finally:
            server.shutdown()
            thread.join()


def test_unconfigured_station_feed_is_reported(monkeypatch):
    monkeypatch.delenv("MIZU_TELEMETRY_URL", raising=False)
    with pytest.raises(ValueError, match="MIZU_TELEMETRY_URL"):
        connected_snapshot()


def test_connected_network_keeps_references_and_readings_separate(monkeypatch):
    import io

    payload = {
        "records": demo_snapshot(10)["records"] + demo_snapshot(10, scenario="routine", site_id="kairouan-demo")["records"],
        "references": {"jendouba-pilote": 0.5},
    }
    monkeypatch.setenv("MIZU_TELEMETRY_URL", "http://127.0.0.1/station")
    monkeypatch.setattr("mizu_m2m3.simulation.urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(payload).encode()))
    selected = connected_snapshot("kairouan-demo")
    assert {row["site_id"] for row in selected["records"]} == {"kairouan-demo"}
    assert selected["reference"] is None
    assert [(entry["site_id"], entry["alerts"]) for entry in selected["stations"]] == [
        ("jendouba-pilote", 1), ("kairouan-demo", 0),
    ]

"""M1 - local test bench (standard library only, separate from the M6 API).

Run from the repo root, then open http://127.0.0.1:8765 :
    .\\.venv\\Scripts\\python.exe scripts\\m1_test_server.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import agriculture as agri  # noqa: E402
from backend import llm  # noqa: E402
from backend import temperature_effect as tfx  # noqa: E402
from backend import temperature_explain as texp  # noqa: E402
from backend import assistant  # noqa: E402
from backend import resilience  # noqa: E402
from backend.causal import funnel  # noqa: E402

UI = ROOT / "tools" / "m1_test_ui" / "index.html"
PORT = int(os.environ.get("PORT", "8765"))


def _manifest() -> dict:
    return json.loads((agri.DATA_DIR / "manifest.json").read_text(encoding="utf-8"))


def _sources() -> set[str]:
    return {d["source_id"] for d in _manifest()["datasets"]}


def step_sources() -> dict:
    downloads = json.loads((agri.DATA_DIR / "raw" / "m1_downloads.json").read_text(encoding="utf-8"))
    import hashlib
    for d in downloads:
        p = ROOT / d["file"]
        d["exists"] = p.exists()
        d["sha256_ok"] = p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == d["sha256"]
    return {"manifest": _manifest(), "downloads": downloads}


def step_plots(site_id: str) -> dict:
    plots = agri.load_plots(site_id)
    return {"site_id": site_id, "plots": [dict(p.to_dict(), solver_ready=p.solver_ready) for p in plots]}


def step_convert(body: dict) -> dict:
    raw = agri.mm_to_m3(float(body["depth_mm"]), float(body["surface_m2"]))
    return {"raw_m3": raw, "rounded_m3": agri.round_m3(raw)}


def step_coverage(body: dict) -> dict:
    bp = agri.coverage_bp(int(body["minimum_m3"]), int(body["delivered_on_time_m3"]))
    return {"coverage_bp": bp, "coverage_pct": None if bp is None else bp / 100}


def step_validate(body: dict) -> dict:
    """Validate the mini plots after applying one edit sent by the page."""
    mini = json.loads((agri.DATA_DIR / "agriculture" / "mini_plots.json").read_text(encoding="utf-8"))
    plots = [agri._plot_from(d) for d in mini["plots"]]
    if body.get("duplicate"):
        plots.append(plots[0])
    else:
        changes = body.get("changes", {})
        if "allowed_slots" in changes and changes["allowed_slots"] is not None:
            changes["allowed_slots"] = tuple(changes["allowed_slots"])
        plots[0] = replace(plots[0], **changes)
    try:
        agri.validate_plots(plots, {"mini"}, _sources())
        return {"valid": True, "plot": plots[0].to_dict()}
    except agri.PlotDataError as e:
        return {"valid": False, "field": e.field, "plot_id": e.plot_id, "message": str(e)}


def step_solar(body: dict) -> dict:
    """Solar pumping: kWh/m³ is entered by the user (not measured), PV yield comes from PVGIS."""
    sol = resilience.load()["solar"]
    month = int(body.get("month", 7))
    pv = next(m["pv_kwh_per_kwp_day"] for m in sol["months"] if m["month"] == month)
    kwh_m3 = float(body["kwh_per_m3"])
    out = {"month": month, "pv_kwh_per_kwp_day": pv, "kwh_per_m3": kwh_m3}
    if body.get("kwp") not in (None, ""):
        out["m3_per_day"] = round(resilience.pumped_m3_per_day(float(body["kwp"]), kwh_m3, pv), 1)
    if body.get("m3_per_day") not in (None, ""):
        out["kwp_needed"] = round(resilience.kwp_needed(float(body["m3_per_day"]), kwh_m3, pv), 2)
    return out


def step_tests() -> dict:
    r = subprocess.run([sys.executable, "-m", "pytest", "tests/test_agriculture.py", "tests/test_temperature_effect.py", "tests/test_llm_explain.py", "tests/test_causal.py", "tests/test_assistant.py", "tests/test_resilience.py", "-v", "--no-header", "-p", "no:cacheprovider"],
                       cwd=ROOT, capture_output=True, text=True, timeout=120)
    lines = [ln for ln in r.stdout.splitlines() if "::" in ln and ("PASSED" in ln or "FAILED" in ln or "ERROR" in ln)]
    tests = [{"name": ln.split("::")[1].split(" ")[0], "ok": "PASSED" in ln} for ln in lines]
    return {"returncode": r.returncode, "tests": tests, "output": r.stdout[-4000:]}


FILES = {
    "/data/plots.geojson": agri.DATA_DIR / "plots.geojson",
    "/data/sites.geojson": agri.DATA_DIR / "sites.geojson",
    "/data/wapor.geojson": agri.DATA_DIR / "layers" / "wapor_aeti_2026-07-D2.geojson",
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, default=list).encode("utf-8"), "application/json; charset=utf-8")

    def _run(self, fn, *args) -> None:
        try:
            self._json(fn(*args))
        except KeyError as e:
            self._json({"error": f"unknown: {e}"}, 404)
        except Exception as e:  # shown in the page, this is a test bench
            self._json({"error": f"{type(e).__name__}: {e}"}, 400)

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/":
            return self._send(200, UI.read_bytes(), "text/html; charset=utf-8")
        if path in FILES:
            return self._send(200, FILES[path].read_bytes(), "application/geo+json; charset=utf-8")
        if path == "/api/sources":
            return self._run(step_sources)
        if path.startswith("/api/plots/"):
            return self._run(step_plots, path.rsplit("/", 1)[1])
        if path == "/api/temperature":
            return self._run(tfx.load_temperature_effect)
        if path == "/api/tests":
            return self._run(step_tests)
        if path.startswith("/api/causes/"):
            q = dict(x.split("=", 1) for x in self.path.split("?", 1)[1].split("&")) if "?" in self.path else {}
            return self._run(funnel.run, path.rsplit("/", 1)[1], "summer_gap", q.get("agents", "1") != "0")
        if path == "/api/resilience":
            return self._run(resilience.load)
        if path.startswith("/api/resilience/priorities/"):
            return self._run(resilience.priorities, path.rsplit("/", 1)[1])
        if path == "/api/llm":
            return self._run(llm.public_config)
        if path == "/api/assistant/status":
            return self._run(assistant.status)
        self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/api/temperature/explain":
            try:
                return self._json(texp.explain(tfx.load_temperature_effect(), bool(body.get("refresh"))))
            except llm.LLMNotConfigured as e:
                return self._json({"error": str(e), "configured": False}, 503)
            except llm.LLMError as e:
                return self._json({"error": str(e), "configured": True}, 502)
        if self.path == "/api/assistant/chat":
            try:
                return self._json(assistant.chat(body["plot_id"], body["messages"]))
            except llm.LLMNotConfigured as e:
                return self._json({"error": str(e)}, 503)
            except llm.LLMError as e:
                return self._json({"error": str(e)}, 502)
            except Exception as e:
                return self._json({"error": f"{type(e).__name__}: {e}"}, 400)
        if self.path == "/api/causes/feedback":
            return self._run(lambda b: funnel.add_feedback(b["plot_id"], "summer_gap", b["cause_id"], b["verdict"], b.get("note", "")), body)
        routes = {"/api/resilience/solar": step_solar, "/api/convert": step_convert, "/api/coverage": step_coverage, "/api/validate": step_validate}
        fn = routes.get(self.path)
        if fn is None:
            return self._json({"error": "not found"}, 404)
        self._run(fn, body)

    def log_message(self, fmt, *args) -> None:
        sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    print(f"M1 test bench on http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

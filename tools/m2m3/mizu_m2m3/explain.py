"""Explain server-computed workbench results with optional NVIDIA wording."""

import json
import os
import re
from collections import OrderedDict
from pathlib import Path
from secrets import token_urlsafe
from ssl import SSLCertVerificationError
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
DEFAULT_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
EXPLAINABLE = frozenset({"solar", "forecast", "anomalies", "weather", "simulation"})
_METRIC_VALUE = re.compile(r"[+-]?\d+(?:[.,]\d+)*(?::\d{2})?(?:%|[ \t]*(?:kWh/m³|kWh|kW|TND|m³))?")
_JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", flags=re.DOTALL | re.IGNORECASE)
_reports = OrderedDict()
_lock = Lock()


def _quantity(value, unit, digits=2):
    if value is None:
        return "unavailable"
    return f"{value:.{digits}f}".rstrip("0").rstrip(".") + f" {unit}"


def _solar(result):
    options = result["options"]
    facts = {}
    for index, option in enumerate(options, start=1):
        facts[f"option_{index}"] = (
            f"{option['label']} produced an estimated {_quantity(option['production_kwh'], 'kWh')} on the selected day. "
            f"Solar used on site was {_quantity(option['self_consumed_kwh'], 'kWh')}. "
            f"Grid energy avoided was {_quantity(option['grid_avoided_kwh'], 'kWh')}."
        )
        if option["gross_savings_tnd"] is not None:
            facts[f"savings_{index}"] = f"{option['label']} gross savings estimate: {_quantity(option['gross_savings_tnd'], 'TND')} for the selected day."
    facts["method"] = "Savings depend on the hourly overlap of PV generation with eligible load and the tariff."
    return "Compare PV generation, local use and gross savings for the selected load case.", facts


def _forecast(result):
    test = result["test"]
    if test is None:
        return "There is insufficient history to produce the load forecast.", {"coverage": "A forecast needs usable recent readings and matching previous-week hours."}
    regression = test["regression_mae_kw"]
    baseline = test["same_hour_last_week_mae_kw"]
    winner = "Ridge regression had the lower error" if regression < baseline else (
        "The same-hour-last-week baseline had the lower error" if baseline < regression else "Both methods had the same reported error"
    )
    return winner + " on the held-out data.", {
        "errors": f"Mean absolute error was {_quantity(regression, 'kW', 4)} for Ridge and {_quantity(baseline, 'kW', 4)} for the baseline.",
        "evaluation": f"Both methods were evaluated on {test['hours']} shared hourly readings. Lower MAE means smaller average error.",
        "provenance": "The input history is simulated." if result["provenance"] == "simulated" else "The test score applies to the supplied history.",
    }


def _alerts(result):
    alerts = result["alerts"]
    facts = {"count": f"The detector reported {len(alerts)} alerts in the selected readings." if alerts
             else "The detector reported no alerts in the selected readings."}
    for kind in ("high_pump_energy_intensity", "unexplained_water"):
        alert = next((item for item in reversed(alerts) if item["type"] == kind), None)
        if alert is None:
            continue
        if kind == "high_pump_energy_intensity":
            facts["energy"] = f"The latest energy alert measured {_quantity(alert['value'], 'kWh/m³')} against a reference of {_quantity(alert['reference'], 'kWh/m³')}. The rule requires two consecutive valid hours more than 20% above reference."
        else:
            facts["water"] = f"The latest water-balance residual was {_quantity(alert['value'], 'm³')} after accounting for changes in tank stock. The residual indicates a discrepancy to investigate."
    if not result["diagnostics"] or any(state == "insufficient_data" for row in result["diagnostics"] for state in (row["water_balance"], row["pump_energy_intensity"])):
        facts["coverage"] = "At least one check had insufficient data, so the alert count reflects the checks that could run."
    return "Review which checks ran and which readings crossed their thresholds.", facts


def _weather(result):
    risk = result["risk_start_slot"]
    totals = [sum(slot["solar_wh"] for slot in result[profile]["slots"][risk:]) / 1000 for profile in ("central", "adverse")]
    summary = "The adverse profile has less solar energy during the risk window." if totals[1] < totals[0] else (
        "Both profiles have the same total solar energy during the risk window." if totals[0] == totals[1]
        else "The adverse profile has more solar energy during the risk window."
    )
    return summary, {
        "risk": f"The risk window begins at {risk:02d}:00 in the scenario's local time.",
        "solar": f"From that hour onward, the central profile provides {_quantity(totals[0], 'kWh')} and the adverse profile provides {_quantity(totals[1], 'kWh')}.",
        "boundary": "These are inputs for the irrigation planner. The planner computes how much water, if any, to pump earlier.",
    }


def _simulation(result):
    summary, facts = _alerts(result)
    if result["mode"] == "simulated":
        facts["source"] = "These are simulated station readings from a seeded replay."
    if result["records"]:
        row = result["records"][-1]
        facts["stock"] = f"Latest tank stock: {_quantity(row['tank_stock_m3'], 'm³')}."
        if row["grid_available"] is False:
            facts["grid"] = "The latest snapshot shows a grid outage. Pump readings and reported water delivery are separate measurements."
        if any(item["quality"] == "missing" and item["simulation_slot"] == row.get("simulation_slot") for item in result.get("measurements", [])):
            facts["sensor"] = "The current flow measurement is missing. It cannot be used to calculate energy per cubic metre."
    return summary, facts


_summarizers = {"solar": _solar, "forecast": _forecast, "anomalies": _alerts, "weather": _weather, "simulation": _simulation}


def remember_result(view, result):
    summary, facts = _summarizers[view](result)
    report = {"view": view, "summary": summary, "facts": facts}
    id_ = token_urlsafe(16)
    with _lock:
        _reports[id_] = report
        if len(_reports) > 128:
            _reports.popitem(last=False)
    return id_


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_provider = build_opener(_NoRedirect())


def _settings():
    keys = {"NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NVIDIA_MODEL"}
    values = {}
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() in keys:
                values[key.strip()] = value.strip().strip("\"'")
    return {key: os.environ.get(key, values.get(key, "")).strip() for key in keys}


def _nvidia(report, settings):
    base = (settings["NVIDIA_BASE_URL"] or DEFAULT_URL).rstrip("/")
    url = urlsplit(base)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}):
        raise ValueError("invalid model endpoint")
    model = settings["NVIDIA_MODEL"] or DEFAULT_MODEL
    system = (
        'Explain these already computed irrigation metrics in one or two short English sentences. '
        'Use only the supplied facts. The numeric values are rendered separately by the app. '
        'Describe the findings qualitatively using the available labels and relationships. Do not infer causes or prescribe actions. '
        'Return a JSON object with a short qualitative "summary" containing no digits and an "evidence" array '
        'of one to three fact IDs that support your summary. Return JSON only.'
    )
    prompt = {**report, "facts": {id_: _METRIC_VALUE.sub("[calculated value]", value) for id_, value in report["facts"].items()}}
    payload = {"model": model, "messages": [{"role": "system", "content": system},
               {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)}], "stream": False,
               "temperature": 0.2, "max_tokens": 320, "chat_template_kwargs": {"enable_thinking": False}}
    request = Request(base + "/chat/completions", data=json.dumps(payload).encode("utf-8"), headers={
        "Authorization": f"Bearer {settings['NVIDIA_API_KEY']}", "Content-Type": "application/json", "Accept": "application/json",
    })
    with _provider.open(request, timeout=7) as response:
        response_body = response.read(64_001)
    if len(response_body) > 64_000:
        raise ValueError("oversized model response")
    completion = json.loads(response_body)
    content = completion["choices"][0]["message"]["content"]
    if not isinstance(content, str):
        raise ValueError("invalid model response")
    fence = _JSON_FENCE.fullmatch(content.strip())
    result = json.loads(fence[1] if fence else content)
    summary, evidence = result["summary"], result["evidence"]
    if (not isinstance(summary, str) or not 10 <= len(summary.strip()) <= 350 or re.search(r"\d", summary)
            or not isinstance(evidence, list) or not 1 <= len(evidence) <= 3
            or any(not isinstance(id_, str) or id_ not in report["facts"] for id_ in evidence)):
        raise ValueError("ungrounded model response")
    return {"mode": "nvidia", "model": model, "summary": summary.strip(), "evidence": [report["facts"][id_] for id_ in dict.fromkeys(evidence)]}


def explain_result(id_):
    if not isinstance(id_, str):
        raise ValueError("explanation_id: expected a result identifier")
    with _lock:
        report = _reports.get(id_)
    if report is None:
        raise ValueError("This result has expired. Run the calculation and try again.")
    settings = _settings()
    if settings["NVIDIA_API_KEY"]:
        try:
            return _nvidia(report, settings)
        except HTTPError as error:
            messages = {
                401: "NVIDIA rejected the API key (401). Set NVIDIA_API_KEY in .env to a valid NVIDIA Build key and retry.",
                403: "NVIDIA denied access (403). Check that the key and its account can access the configured model.",
                404: "NVIDIA could not find the configured model or endpoint (404). Check NVIDIA_MODEL and NVIDIA_BASE_URL.",
                422: "NVIDIA rejected the request format (422). Check that the configured endpoint supports Chat Completions.",
                429: "NVIDIA rate-limited the request (429). Check your quota or retry later.",
            }
            reason = messages.get(error.code, f"NVIDIA returned HTTP {error.code}. The local explanation is available below.")
        except (URLError, OSError) as error:
            cause = error.reason if isinstance(error, URLError) else error
            if isinstance(cause, PermissionError):
                reason = "This server could not make an outbound request to NVIDIA. Check the server's network permissions."
            elif isinstance(cause, SSLCertVerificationError):
                reason = "The server could not verify NVIDIA’s TLS certificate. Check the server’s trusted certificates."
            elif isinstance(cause, TimeoutError):
                reason = "NVIDIA did not respond in time. Retry when the service is available."
            else:
                reason = "The server could not reach NVIDIA. Check the connection and NVIDIA_BASE_URL."
        except (ValueError, KeyError, TypeError, IndexError):
            reason = "The model reply could not be validated. The explanation uses the calculated evidence."
    else:
        reason = "Add NVIDIA_API_KEY to .env to enable model-generated wording."
    return {"mode": "local", "summary": report["summary"], "evidence": list(report["facts"].values()), "note": reason}

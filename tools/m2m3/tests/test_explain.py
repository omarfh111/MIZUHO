import io
import json
from urllib.error import HTTPError

import pytest

from mizu_m2m3 import explain
from mizu_m2m3.web import _anomalies, _forecast, _solar, _weather


@pytest.fixture(autouse=True)
def unset_provider(monkeypatch, tmp_path):
    for key in ("NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NVIDIA_MODEL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(explain, "ENV_FILE", tmp_path / ".env")


def test_local_explanation_preserves_computed_values():
    report_id = explain.remember_result("anomalies", _anomalies({"reference": 0.5}))
    result = explain.explain_result(report_id)
    assert result["mode"] == "local"
    assert any("0.7 kWh/m³" in item for item in result["evidence"])
    assert any("13 m³" in item for item in result["evidence"])
    with pytest.raises(ValueError, match="expired"):
        explain.explain_result("unknown-result")


def test_nvidia_uses_dotenv_and_returns_existing_evidence(monkeypatch):
    explain.ENV_FILE.write_text("NVIDIA_API_KEY=example-key\nNVIDIA_MODEL=configured-model\n", encoding="utf-8")

    def mocked_provider(request, timeout):
        assert request.full_url == "https://integrate.api.nvidia.com/v1/chat/completions"
        assert request.get_header("Authorization") == "Bearer example-key"
        body = json.loads(request.data)
        assert body["model"] == "configured-model" and body["stream"] is False
        report = json.loads(body["messages"][1]["content"])
        assert set(report) == {"view", "summary", "facts"}
        assert "0.7" not in report["facts"]["energy"]
        assert "[calculated value]" in report["facts"]["energy"]
        content = json.dumps({"summary": "The pump energy reading crossed its reference threshold.", "evidence": ["energy"]})
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": f"```json\n{content}\n```"}}]}).encode())

    monkeypatch.setattr(explain._provider, "open", mocked_provider)
    report_id = explain.remember_result("anomalies", _anomalies({"reference": 0.5}))
    result = explain.explain_result(report_id)
    assert result["mode"] == "nvidia"
    assert result["model"] == "configured-model"
    assert len(result["evidence"]) == 1 and "0.7 kWh/m³" in result["evidence"][0]


@pytest.mark.parametrize("summary,evidence", [("The measured value was 5000 kWh.", ["risk"]), ("The risk window changes available solar.", ["made_up"])])
def test_invalid_model_output_falls_back(monkeypatch, summary, evidence):
    monkeypatch.setenv("NVIDIA_API_KEY", "example-key")
    content = json.dumps({"summary": summary, "evidence": evidence})
    response = io.BytesIO(json.dumps({"choices": [{"message": {"content": content}}]}).encode())
    monkeypatch.setattr(explain._provider, "open", lambda *args, **kwargs: response)
    report_id = explain.remember_result("weather", _weather({"pair": "jplus1-demo"}))
    assert explain.explain_result(report_id)["mode"] == "local"


def test_forecast_explanation_and_missing_tariff():
    forecast = _forecast({"as_of": "2026-11-20T18:00:00+01:00"})
    response = explain.explain_result(explain.remember_result("forecast", forecast))
    assert "baseline had the lower error" in response["summary"]
    assert any("0.2381 kW" in item for item in response["evidence"])
    solar = explain.explain_result(explain.remember_result("solar", _solar({"dataset": "none"})))
    assert not any("TND" in item for item in solar["evidence"])


def test_auth_failure_explains_how_to_recover_without_exposing_the_key(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "private-test-key")

    def unauthorized(request, timeout):
        raise HTTPError(request.full_url, 401, "unauthorized", {}, None)

    monkeypatch.setattr(explain._provider, "open", unauthorized)
    report_id = explain.remember_result("weather", _weather({"pair": "jplus1-demo"}))
    result = explain.explain_result(report_id)
    assert result["mode"] == "local"
    assert "401" in result["note"] and "NVIDIA_API_KEY" in result["note"]
    assert "private-test-key" not in json.dumps(result)

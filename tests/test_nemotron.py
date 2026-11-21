import json

import httpx
import pytest

from backend.assistant import run_assistant
from backend.catalog import DATA_DIR, load_catalog
from backend.evidence import load_corpus
from backend.models import AssistantRequest
from backend.providers import NVIDIA_MODEL, Providers, ServiceError, Services


def provider(monkeypatch, reply):
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai")
    monkeypatch.setenv("QDRANT_API_KEY", "test-qdrant")
    monkeypatch.setenv("QDRANT_URL", "https://example.cloud.qdrant.io")
    monkeypatch.setenv("LLM_API_KEY", "test-nvidia")
    settings = Services.from_env()
    assert "test-nvidia" not in repr(settings)
    service = Providers(settings)
    service.http.close()
    service.http = httpx.Client(transport=httpx.MockTransport(reply))
    return service


def completion(content=None, calls=None, model=NVIDIA_MODEL):
    return httpx.Response(200, json={"model": model, "choices": [{
        "finish_reason": "tool_calls" if calls else "stop",
        "message": {"role": "assistant", "content": content, "tool_calls": calls},
    }]})


def test_nemotron_executes_tools_and_renders_only_verified_figures(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", NVIDIA_MODEL)
    requests = []
    def reply(request):
        assert str(request.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
        assert request.headers["Authorization"] == "Bearer test-nvidia"
        payload = json.loads(request.content)
        assert payload["model"] == NVIDIA_MODEL
        requests.append(payload)
        if len(requests) == 1:
            return completion(calls=[
                {"type": "function", "id": "allocation", "function": {"name": "explain_decision",
                 "arguments": json.dumps({"scenario_id": "mini", "quota_m3": "None"})}},
                {"type": "function", "id": "site", "function": {"name": "get_site_data",
                 "arguments": json.dumps({"include_solar": False})}},
            ])
        dialogue = payload["messages"]
        assert [m["role"] for m in dialogue] == ["system", "user", "assistant", "tool", "tool"]
        assert [m["tool_call_id"] for m in dialogue[-2:]] == ["allocation", "site"]
        facts = json.loads(dialogue[-2]["content"])["facts"]
        return completion(json.dumps({"paragraphs": [{"text": "It delivered 9000 cubic metres.",
            "citation_ids": [], "fact_ids": [facts[0]["id"]]}], "missing_information": []}))

    service = provider(monkeypatch, reply)
    catalog = load_catalog()
    try:
        answer = run_assistant(AssistantRequest(provider="nvidia", site_id="jendouba-pilote",
            question="Why did farmer A receive only 5 m³?"), catalog, load_corpus(DATA_DIR, catalog.evidence), service, 5)
        assert len(requests) == 2
        assert answer.tools_used == ("explain_decision", "get_site_data")
        assert any("Plot A (EXP-01): 5 m³" in fact.text for fact in answer.facts)
        assert "9000" not in answer.model_dump_json()
    finally:
        service.close()


@pytest.mark.parametrize("mode", ["wrong-config", "missing-key", "wrong-response-model", "invalid-response", "provider-denied"])
def test_nemotron_fails_without_switching_providers_or_leaking_secrets(monkeypatch, mode):
    contacted = []
    def reply(request):
        contacted.append(request.url.host)
        if mode == "provider-denied":
            return httpx.Response(401, text="test-nvidia")
        return completion(None, model="other-model" if mode == "wrong-response-model" else NVIDIA_MODEL)
    monkeypatch.setenv("LLM_MODEL", "other-model" if mode == "wrong-config" else NVIDIA_MODEL)
    service = provider(monkeypatch, reply)
    if mode == "missing-key":
        monkeypatch.delenv("LLM_API_KEY")
        service.settings = Services.from_env()
    try:
        with pytest.raises(ServiceError) as error:
            service.respond_nvidia({"instructions": "", "text": {"format": {"schema": {}}}, "input": [],
                                    "tools": [], "max_output_tokens": 50}, timeout=2)
        assert "test-nvidia" not in str(error.value)
        assert contacted == ([] if mode in ("wrong-config", "missing-key") else ["integrate.api.nvidia.com"])
    finally:
        service.close()

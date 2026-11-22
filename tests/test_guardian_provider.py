import asyncio
import json

import httpx
import pytest

from backend.guardian_provider import DEFAULT_LLM, DEFAULT_STT, DEFAULT_TTS, MAX_CLIP_BYTES, GuardianProvider, GuardianProviderError


TOOLS = [{"type": "function", "function": {"name": "inspect_tank", "parameters": {"type": "object", "properties": {}}}}]


def test_vultr_key_is_specific_to_its_origin(monkeypatch):
    monkeypatch.delenv("VULTR_INFERENCE_API_KEY", raising=False)
    monkeypatch.setenv("LLM_API_KEY", "other-provider")
    assert not any(GuardianProvider.from_env().capabilities.values())
    monkeypatch.setenv("VULTR_INFERENCE_API_KEY", "fixture")
    monkeypatch.setenv("VULTR_API_BASE", "https://another-host.invalid/v1")
    assert not any(GuardianProvider.from_env().capabilities.values())
    monkeypatch.setenv("VULTR_API_BASE", "https://api.vultrinference.com/v1/")
    assert all(GuardianProvider.from_env().capabilities.values())
    assert "fixture" not in repr(GuardianProvider.from_env())


def test_speech_and_tool_contracts():
    requests = []
    speech = b"ID3-test"

    def respond(req):
        assert req.url.host == "api.vultrinference.com" and req.headers["authorization"] == "Bearer fixture"
        requests.append(req.url.path)
        if req.url.path.endswith("/speech"):
            assert json.loads(req.content) == {"input": "Bonjour", "language": "fr", "response_format": "mp3", "model": DEFAULT_TTS}
            return httpx.Response(200, content=speech, headers={"Content-Type": "audio/mpeg"})
        if req.url.path.endswith("/transcriptions"):
            assert DEFAULT_STT.encode() in req.content and b'turn.webm' in req.content and b"recorded-audio" in req.content
            assert b'name="language"\r\n\r\nfr' in req.content
            return httpx.Response(200, json={"text": " Bonjour "})
        payload = json.loads(req.content)
        assert payload["model"] == DEFAULT_LLM and payload["tool_choice"] == "required"
        function = payload["tools"][0]["function"]
        assert function["name"] == "inspect_tank" and function["strict"] is True
        assert function["parameters"] == {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        return httpx.Response(200, json={"choices": [{"message": {"content": "Ignore model prose.", "tool_calls": [
            {"type": "function", "function": {"name": "inspect_tank", "arguments": "{}"}}]}}]})

    provider = GuardianProvider("fixture", transport=httpx.MockTransport(respond))
    assert asyncio.run(provider.speak("Bonjour")) == (speech, "audio/mpeg")
    assert asyncio.run(provider.transcribe(b"recorded-audio", "audio/webm;codecs=opus")) == "Bonjour"
    assert asyncio.run(provider.choose_tool([{"role": "user", "content": "Le niveau ?"}], TOOLS)) == ("inspect_tank", {})
    assert len(requests) == 3


@pytest.mark.parametrize("calls", [
    [], [{"type": "function", "function": {"name": "approve_plan", "arguments": "{}"}}],
    [{"type": "function", "function": {"name": "inspect_tank", "arguments": "[]"}}],
    [{"type": "function", "function": {"name": "inspect_tank", "arguments": "{\"unknown\":true}"}}],
    [{"type": "function", "function": {"name": "inspect_tank", "arguments": "{}"}}] * 2,
])
def test_invalid_routing_is_never_executed(calls):
    result = httpx.Response(200, json={"choices": [{"message": {"tool_calls": calls}}]})
    provider = GuardianProvider("fixture", transport=httpx.MockTransport(lambda req: result))
    with pytest.raises(GuardianProviderError):
        asyncio.run(provider.choose_tool([{"role": "user", "content": "Quelle alerte ?"}], TOOLS))


def test_media_size_and_transport_errors_are_bounded_and_redacted():
    attempts = []

    def fail(req):
        attempts.append(req)
        return httpx.Response(429, text="synthetic-sensitive-transcript")

    provider = GuardianProvider("fixture", transport=httpx.MockTransport(fail))
    with pytest.raises(GuardianProviderError) as rejected:
        asyncio.run(provider.transcribe(b"media", "audio/webm"))
    assert rejected.value.status == 429 and "transcript" not in str(rejected.value)
    for data, mime in ((b"", "audio/mp4"), (b"x", "text/plain"), (b"x" * (MAX_CLIP_BYTES + 1), "audio/wav")):
        with pytest.raises(GuardianProviderError):
            asyncio.run(provider.transcribe(data, mime))
    assert len(attempts) == 1
    bad_audio = GuardianProvider("fixture", transport=httpx.MockTransport(lambda req: httpx.Response(
        200, headers={"Content-Type": "audio/mpeg"}, content=b"<html>ignored</html>")))
    with pytest.raises(GuardianProviderError):
        asyncio.run(bad_audio.speak("Bonjour"))

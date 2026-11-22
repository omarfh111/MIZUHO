import asyncio
import json

import httpx
import pytest

from backend.guardian_provider import DEFAULT_LLM, DEFAULT_STT, DEFAULT_TTS, MAX_CLIP_BYTES, GuardianProvider, GuardianProviderError


TOOLS = [{"type": "function", "function": {"name": "inspect_tank", "parameters": {"type": "object", "properties": {}}}}]


def test_vultr_key_is_specific_to_its_origin(monkeypatch):
    monkeypatch.delenv("VULTR_INFERENCE_API_KEY", raising=False)
    monkeypatch.setenv("LLM_API_KEY", "other-provider")
    assert GuardianProvider.from_env().capabilities == {"stt": False, "tts": False, "llm": True}
    monkeypatch.setenv("VULTR_INFERENCE_API_KEY", "fixture")
    monkeypatch.setenv("VULTR_API_BASE", "https://another-host.invalid/v1")
    assert GuardianProvider.from_env().text_backend == "nvidia"
    assert not GuardianProvider.from_env().capabilities["stt"]
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


@pytest.mark.parametrize(("locale", "language", "model"), [
    ("aeb", "ar", "chatterbox"), ("ja", "ja", DEFAULT_TTS), ("en", "en", DEFAULT_TTS),
])
def test_language_specific_media_contract(locale, language, model):
    def respond(req):
        if req.url.path.endswith("/speech"):
            payload = json.loads(req.content)
            assert payload["language"] == language and payload["model"] == model
            return httpx.Response(200, content=b"ID3-synthetic", headers={"Content-Type": "audio/mpeg"})
        assert f'name="language"\r\n\r\n{language}\r\n'.encode() in req.content
        return httpx.Response(200, json={"text": "transcribed"})

    provider = GuardianProvider("fixture", transport=httpx.MockTransport(respond))
    assert all(provider.capabilities_for(locale).values())
    audio, mime = asyncio.run(provider.speak("Synthetic sample", locale))
    assert asyncio.run(provider.transcribe(audio, mime, locale)) == "transcribed"
    assert not any(provider.capabilities_for("unknown").values())


def test_progressive_speech_forwards_whole_samples_immediately_and_closes_on_interrupt():
    class Utterance(httpx.AsyncByteStream):
        def __init__(self):
            self.finish = asyncio.Event()
            self.closed = False

        async def __aiter__(self):
            yield b"abc"
            await self.finish.wait()
            yield b"d" + b"ef" * 5000

        async def aclose(self):
            self.closed = True

    async def scenario(interrupt):
        speech = Utterance()
        requests = []

        def respond(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, stream=speech, headers={"Content-Type": 'audio/pcm; channels=1; rate="24000"'})

        provider = GuardianProvider("fixture", transport=httpx.MockTransport(respond))
        parts = provider.stream_speech("  قصّة قصيرة  ", "aeb")
        async with asyncio.timeout(2):
            assert await anext(parts) == b"ab"
        if interrupt:
            await parts.aclose()
        else:
            speech.finish.set()
            rest = [chunk async for chunk in parts]
            assert all(0 < len(chunk) <= 8192 and not len(chunk) % 2 for chunk in rest)
            assert b"".join(rest) == b"cd" + b"ef" * 5000
        assert speech.closed
        assert requests == [{"input": "قصّة قصيرة", "language": "ar", "model": "chatterbox",
                             "response_format": "pcm", "speed": 1, "stream_format": "audio"}]

    asyncio.run(scenario(False))
    asyncio.run(scenario(True))


@pytest.mark.parametrize(("content_type", "content"), [
    ("audio/mpeg", b"ID3"),
    ("audio/pcm", b"data"),
    ("audio/pcm;rate=16000;channels=1", b"data"),
    ("audio/pcm;rate=24000;channels=2", b"data"),
    ("audio/pcm;rate=24000;channels=1", b""),
    ("audio/pcm;rate=24000;channels=1", b"x"),
    ("audio/pcm;rate=24000;channels=1", b"x" * 34),
])
def test_progressive_speech_rejects_mislabeled_truncated_and_oversized_audio(monkeypatch, content_type, content):
    monkeypatch.setattr("backend.guardian_provider.MAX_PCM_BYTES", 32)
    provider = GuardianProvider("fixture", transport=httpx.MockTransport(lambda r: httpx.Response(
        200, headers={"Content-Type": content_type}, content=content)))

    async def read():
        return [chunk async for chunk in provider.stream_speech("Hello", "en")]

    with pytest.raises(GuardianProviderError):
        asyncio.run(read())


@pytest.mark.parametrize("fallback", [True, False])
def test_translation_stays_on_its_own_origin_and_never_receives_tools(fallback):
    phrase = "Translate me, including the number 13."

    def respond(req):
        assert req.url.host == ("integrate.api.nvidia.com" if fallback else "api.vultrinference.com")
        assert req.headers["authorization"] == "Bearer " + ("nvidia-fixture" if fallback else "vultr-fixture")
        payload = json.loads(req.content)
        assert payload["messages"][1] == {"role": "user", "content": phrase}
        assert "Tunisian" in payload["messages"][0]["content"]
        assert "tools" not in payload
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": "ترجملي النص هذا فيه 13."}}]})

    provider = GuardianProvider("" if fallback else "vultr-fixture", nvidia_key="nvidia-fixture", transport=httpx.MockTransport(respond))
    assert asyncio.run(provider.translate(phrase, "en", "aeb")) == "ترجملي النص هذا فيه 13."
    with pytest.raises(GuardianProviderError):
        asyncio.run(provider.translate(phrase, "en", "unknown"))


def test_truncated_translation_is_not_returned_to_the_farmer():
    provider = GuardianProvider("fixture", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={
        "choices": [{"finish_reason": "length", "message": {"role": "assistant", "content": "partial"}}]})))
    with pytest.raises(GuardianProviderError):
        asyncio.run(provider.translate("Please check the meter.", "en", "ja"))


@pytest.mark.parametrize(("question", "valid"), [
    ("How would you share the available water?", True),
    ("شنوّة أوّل حاجة تتثبّتوا فيها؟", True),
    ("何を確認してから決めますか？", True),
    ("We detected 13 cubic metres of leakage. What now?", False),
    ("فمّا ١٣ متر. شنوّة نعملوا؟", False),
    ("The plan is approved.", False),
    ("What happened? What next?", False),
])
def test_presentation_opener_is_an_isolated_question_without_figures(question, valid):
    def respond(req):
        payload = json.loads(req.content)
        assert "tools" not in payload
        assert json.loads(payload["messages"][1]["content"]) == {"topic": "allocation", "verified_brief": "simulated coverage"}
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": question}}]})

    provider = GuardianProvider("fixture", transport=httpx.MockTransport(respond))
    task = provider.presentation_opener("simulated coverage", "en", "allocation")
    if valid:
        assert asyncio.run(task) == question
    else:
        with pytest.raises(GuardianProviderError):
            asyncio.run(task)

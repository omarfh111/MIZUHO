"""Bounded, server-only Vultr Inference transport for a consented M9 call."""

import asyncio
import json
import os
import ssl
from dataclasses import dataclass, field
from functools import cache

import httpx


API = "https://api.vultrinference.com/v1"
DEFAULT_STT = "whisper-large-v3-turbo"
DEFAULT_TTS = "qwen3-tts-12hz-1.7b"
DEFAULT_LLM = "qwen3.8-flash-next"
MAX_CLIP_BYTES = 2 * 1024 * 1024
AUDIO_FORMATS = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav",
                 "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac"}


@cache
def _tls_context() -> ssl.SSLContext:
    return ssl.create_default_context()


class GuardianProviderError(Exception):
    """Safe for a caller to report without exposing speech, tool arguments or credentials."""

    def __init__(self, service: str, status: int | None = None):
        self.service = service
        self.status = status
        super().__init__(f"Vultr {service} is unavailable.")


@dataclass(frozen=True)
class GuardianProvider:
    key: str = field(repr=False)
    stt: str = DEFAULT_STT
    llm: str = DEFAULT_LLM
    tts: str = DEFAULT_TTS
    transport: httpx.AsyncBaseTransport | None = field(default=None, repr=False, compare=False)

    @classmethod
    def from_env(cls):
        base = os.getenv("VULTR_API_BASE", API).strip().rstrip("/")
        key = os.getenv("VULTR_INFERENCE_API_KEY", "").strip()
        if base not in {API, "https://api.vultrinference.com"} or not all(33 <= ord(c) <= 126 for c in key):
            key = ""
        return cls(key=key, stt=os.getenv("VULTR_STT_MODEL", DEFAULT_STT).strip(),
                   tts=os.getenv("VULTR_TTS_MODEL", DEFAULT_TTS).strip(),
                   llm=os.getenv("VULTR_LLM_MODEL", DEFAULT_LLM).strip())

    @property
    def capabilities(self) -> dict[str, bool]:
        return {"stt": bool(self.key and self.stt), "llm": bool(self.key and self.llm),
                "tts": bool(self.key and self.tts)}

    async def _post(self, service: str, path: str, *, limit: int, **kwargs) -> tuple[bytes, str]:
        if not self.capabilities[service]:
            raise GuardianProviderError(service)
        try:
            async with asyncio.timeout(32), httpx.AsyncClient(transport=self.transport, timeout=25,
                                                              verify=True if self.transport else _tls_context(),
                                                              follow_redirects=False) as client:
                async with client.stream("POST", API + path, headers={"Authorization": f"Bearer {self.key}"},
                                         **kwargs) as response:
                    if response.status_code != 200:
                        raise GuardianProviderError(service, response.status_code)
                    data = bytearray()
                    async for block in response.aiter_bytes():
                        if len(data) + len(block) > limit:
                            raise GuardianProviderError(service)
                        data.extend(block)
                    return bytes(data), response.headers.get("content-type", "").split(";")[0].lower().strip()
        except (httpx.HTTPError, TimeoutError):
            raise GuardianProviderError(service) from None

    async def transcribe(self, audio: bytes, mime_type: str, language: str = "fr") -> str:
        mime = mime_type.split(";")[0].strip().lower()
        fmt = AUDIO_FORMATS.get(mime)
        if not fmt or not 0 < len(audio) <= MAX_CLIP_BYTES or language not in {"en", "ja", "fr"}:
            raise GuardianProviderError("stt")
        body, _ = await self._post("stt", "/audio/transcriptions", limit=64_000,
                                  files={"file": (f"turn.{fmt}", audio, mime)},
                                  data={"model": self.stt, "language": language, "response_format": "json"})
        try:
            transcript = json.loads(body)["text"]
            if not isinstance(transcript, str) or not 0 < len(transcript.strip()) <= 1600:
                raise ValueError
            return transcript.strip()
        except (KeyError, ValueError, TypeError):
            raise GuardianProviderError("stt") from None

    async def speak(self, text: str, language: str = "fr") -> tuple[bytes, str]:
        if not 0 < len(text.strip()) <= 1600 or language not in {"en", "ja", "fr"}:
            raise GuardianProviderError("tts")
        data, mime = await self._post("tts", "/audio/speech", limit=MAX_CLIP_BYTES,
                                     json={"model": self.tts, "input": text.strip(), "language": language,
                                           "response_format": "mp3"})
        if mime != "audio/mpeg" or not (data.startswith(b"ID3") or
                                         len(data) > 2 and data[0] == 0xff and data[1] & 0xe0 == 0xe0):
            raise GuardianProviderError("tts")
        return data, mime

    async def choose_tool(self, messages: list[dict], tools: list[dict]) -> tuple[str, dict]:
        """Select one of the caller's current tools. The M6 handler validates its typed arguments and executes it."""
        if not tools or not messages or len(messages) > 24:
            raise GuardianProviderError("llm")
        functions = [tool["function"] for tool in tools]
        schemas = {fn["name"]: {"required": [], **fn["parameters"], "additionalProperties": False}
                   for fn in functions}
        strict_tools = [{"type": "function", "function": {**fn, "strict": True, "parameters": schemas[fn["name"]]}}
                        for fn in functions]
        body, _ = await self._post("llm", "/chat/completions", limit=96_000,
                                  json={"model": self.llm, "messages": messages, "tools": strict_tools,
                                        "tool_choice": "required", "max_tokens": 512})
        try:
            call, = json.loads(body)["choices"][0]["message"]["tool_calls"]
            name = call["function"]["name"]
            arguments = json.loads(call["function"]["arguments"])
            if call["type"] != "function" or name not in schemas or not isinstance(arguments, dict):
                raise ValueError
            if arguments.keys() - schemas[name]["properties"].keys() or set(schemas[name]["required"]) - arguments.keys():
                raise ValueError
            return name, arguments
        except (KeyError, ValueError, IndexError, TypeError):
            raise GuardianProviderError("llm") from None

"""Minimal client for any OpenAI-compatible chat completions endpoint.

Configuration comes from the environment or from a .env file at the repo root
(see .env.example). The API key is never logged or returned.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]


class LLMNotConfigured(RuntimeError):
    pass


class LLMError(RuntimeError):
    pass


def _load_dotenv(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def config() -> dict:
    _load_dotenv()
    return {
        "base_url": os.environ.get("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/"),
        "api_key": os.environ.get("LLM_API_KEY", ""),
        "model": os.environ.get("LLM_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b"),
        "temperature": float(os.environ.get("LLM_TEMPERATURE", "0.2")),
        "max_tokens": int(os.environ.get("LLM_MAX_TOKENS", "900")),
        "timeout": float(os.environ.get("LLM_TIMEOUT_S", "60")),
        # Reasoning models (Nemotron 3.5...) can spend every token "thinking" and return no text.
        "disable_thinking": os.environ.get("LLM_DISABLE_THINKING", "true").lower() in ("1", "true", "yes"),
    }


def public_config() -> dict:
    c = config()
    return {"base_url": c["base_url"], "model": c["model"], "configured": bool(c["api_key"])}


def _strip_reasoning(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


def chat(messages: list[dict]) -> dict:
    c = config()
    if not c["api_key"]:
        raise LLMNotConfigured("LLM_API_KEY is empty: copy .env.example to .env and add the key")
    body = {"model": c["model"], "messages": messages, "temperature": c["temperature"],
            "max_tokens": c["max_tokens"], "stream": False}
    if c["disable_thinking"]:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    try:
        r = requests.post(
            f"{c['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {c['api_key']}", "Content-Type": "application/json"},
            json=body, timeout=c["timeout"],
        )
    except requests.RequestException as e:
        raise LLMError(f"endpoint unreachable: {type(e).__name__}") from None
    if not r.ok:
        detail = r.text[:300].replace(c["api_key"], "***")
        raise LLMError(f"HTTP {r.status_code}: {detail}")
    data = r.json()
    msg = data["choices"][0]["message"]
    text = _strip_reasoning(msg.get("content") or "")
    if not text:
        hint = ""
        if msg.get("reasoning_content") and data["choices"][0].get("finish_reason") == "length":
            hint = " (all tokens spent on reasoning: set LLM_DISABLE_THINKING=true or raise LLM_MAX_TOKENS)"
        raise LLMError("empty answer from the model" + hint)
    return {"text": text, "model": data.get("model", c["model"]),
            "finish_reason": data["choices"][0].get("finish_reason"), "usage": data.get("usage")}

"""Minimal client for TypeSafe's Jev decision model (POST /v1/systemone).

Jev returns typed answers with probabilities (noul = yes/no, choice, score);
it does not write text. Key: TYPESAFE_API_KEY in the environment or .env.
"""
from __future__ import annotations

import os
import time

import requests

from backend.llm import _load_dotenv

BASE_URL = "https://api.typesafe.ai"


class JevNotConfigured(RuntimeError):
    pass


class JevError(RuntimeError):
    pass


def config() -> dict:
    _load_dotenv()
    return {"base_url": os.environ.get("TYPESAFE_BASE_URL", BASE_URL).rstrip("/"),
            "api_key": os.environ.get("TYPESAFE_API_KEY", ""),
            "model": os.environ.get("TYPESAFE_MODEL", "jev-latest"),
            "timeout": float(os.environ.get("TYPESAFE_TIMEOUT_S", "30"))}


def public_config() -> dict:
    c = config()
    return {"base_url": c["base_url"], "model": c["model"], "configured": bool(c["api_key"])}


def decide(state: dict, questions: dict, tries: int = 3) -> dict:
    c = config()
    if not c["api_key"]:
        raise JevNotConfigured("TYPESAFE_API_KEY is empty")
    body = {"model": c["model"], "state": state, "questions": questions}
    headers = {"Authorization": f"Bearer {c['api_key']}", "Content-Type": "application/json"}
    for i in range(tries):
        try:
            r = requests.post(f"{c['base_url']}/v1/systemone", headers=headers, json=body, timeout=c["timeout"])
        except requests.RequestException as e:
            err = f"endpoint unreachable: {type(e).__name__}"
        else:
            if r.ok:
                d = r.json()
                return {"model": d.get("model"), "answers": d["answers"], "usage": d.get("usage"),
                        "request_id": r.headers.get("x-typesafe-request-id")}
            err = f"HTTP {r.status_code}: {r.text[:300].replace(c['api_key'], '***')}"
            if r.status_code not in (429, 529) and r.status_code < 500:
                raise JevError(err)
            time.sleep(float(r.headers.get("retry-after", 0.5 * 2 ** i)))
            continue
        time.sleep(0.5 * 2 ** i)
    raise JevError(err)

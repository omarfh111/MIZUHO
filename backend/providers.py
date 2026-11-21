"""Server-side transports for the M8 services."""

import math
import re
import ssl
from dataclasses import dataclass, field
from os import getenv
from urllib.parse import urlsplit

import httpx

DEFAULT_COLLECTION = "mizhuo_m8_evidence_v1"
MODEL = "gpt-6-luna"
EMBEDDING_MODEL = "text-embedding-3-small"
DIMENSIONS = 1536


class ServiceError(Exception):
    def __init__(self, service: str, status: int | None = None):
        self.service = service
        self.status = status
        super().__init__(f"{service} could not complete the request.")


@dataclass(frozen=True)
class Services:
    openai_key: str = field(repr=False)
    qdrant_key: str = field(repr=False)
    qdrant_url: str = field(repr=False)
    collection: str = DEFAULT_COLLECTION

    @classmethod
    def from_env(cls) -> "Services | None":
        openai_key = getenv("OPENAI_API_KEY", "")
        qdrant_key = getenv("QDRANT_API_KEY", "")
        url = getenv("QDRANT_URL", "").rstrip("/")
        if not all((openai_key, qdrant_key, url)):
            return None
        if (getenv("OPENAI_MODEL", MODEL), getenv("OPENAI_EMBEDDING_MODEL", EMBEDDING_MODEL),
                getenv("EMBEDDING_DIMENSIONS", str(DIMENSIONS))) != (MODEL, EMBEDDING_MODEL, str(DIMENSIONS)):
            raise ValueError("M8 model or embedding configuration does not match the required settings.")
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".cloud.qdrant.io")
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("M8 requires an HTTPS Qdrant Cloud cluster endpoint.")
        collection = getenv("QDRANT_COLLECTION") or getenv("QDRANT_COLLECTION_NAME") or DEFAULT_COLLECTION
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", collection) or collection in {".", ".."}:
            raise ValueError("Invalid Qdrant evidence collection name.")
        if any(not 33 <= ord(char) <= 126 for value in (openai_key, qdrant_key) for char in value):
            raise ValueError("Invalid API credential format.")
        return cls(openai_key, qdrant_key, url, collection)


class Providers:
    def __init__(self, settings: Services):
        self.settings = settings
        self.http = httpx.Client(verify=ssl.create_default_context(), follow_redirects=False,
                                 limits=httpx.Limits(max_connections=8, max_keepalive_connections=4))

    def close(self):
        self.http.close()

    def _request(self, service: str, method: str, url: str, headers: dict, body: dict | None,
                 timeout: float) -> dict:
        try:
            result = self.http.request(method, url, headers=headers, json=body, timeout=timeout)
            result.raise_for_status()
            data = result.json()
            if not isinstance(data, dict):
                raise ValueError("Expected a JSON object.")
            return data
        except httpx.HTTPStatusError as error:
            raise ServiceError(service, error.response.status_code) from None
        except (httpx.HTTPError, ValueError):
            raise ServiceError(service) from None

    def openai(self, path: str, body: dict, timeout: float) -> dict:
        return self._request("OpenAI", "POST", f"https://api.openai.com/v1/{path}",
                             {"Authorization": f"Bearer {self.settings.openai_key}"}, body, timeout)

    def embeddings(self, inputs: list[str], *, timeout: float = 12) -> list[list[float]]:
        data = self.openai("embeddings", {"input": inputs, "model": EMBEDDING_MODEL, "dimensions": DIMENSIONS}, timeout)
        try:
            ordered = sorted(data["data"], key=lambda item: item["index"])
            if data.get("model") != EMBEDDING_MODEL or [item["index"] for item in ordered] != list(range(len(inputs))):
                raise ValueError("Unexpected embedding metadata.")
            vectors = [item["embedding"] for item in ordered]
            if any(len(vector) != DIMENSIONS or any(not math.isfinite(number) for number in vector) for vector in vectors):
                raise ValueError("Unexpected embedding vector.")
            return vectors
        except (KeyError, TypeError, ValueError):
            raise ServiceError("OpenAI embeddings") from None

    def respond(self, body: dict, *, timeout: float) -> dict:
        data = self.openai("responses", {"model": MODEL, "store": False, **body}, timeout)
        if data.get("model") != MODEL or data.get("status") != "completed" or not isinstance(data.get("output"), list):
            raise ServiceError("OpenAI Responses")
        return data

    def qdrant(self, method: str, path: str = "", body: dict | None = None, *, timeout: float = 8):
        origin = self.settings.qdrant_url
        collection = self.settings.collection
        data = self._request("Qdrant", method, f"{origin}/collections/{collection}{path}",
                             {"api-key": self.settings.qdrant_key}, body, timeout)
        if data.get("status") != "ok" or "result" not in data:
            raise ServiceError("Qdrant")
        return data["result"]

    def verify_collection(self) -> None:
        config = self.qdrant("GET")
        try:
            vectors = config["config"]["params"]["vectors"]
        except (KeyError, TypeError):
            raise ServiceError("Qdrant collection schema") from None
        if (not isinstance(vectors, dict) or vectors.get("size") != DIMENSIONS
                or str(vectors.get("distance", "")).lower() != "cosine"):
            raise ServiceError("Qdrant collection schema")

"""Single-worker entry point for the AWS HTTPS load balancer and the built dashboard."""

import asyncio
import base64
import binascii
import os
import re
import secrets
from collections import OrderedDict
from getpass import getpass
from hashlib import pbkdf2_hmac
from pathlib import Path
from time import monotonic


ITERATIONS = 600_000
COOKIE = "__Host-mizuho-judge"
SESSION_SECONDS = 8 * 60 * 60
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"


def encode_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


class JudgeAccess:
    """Authenticate the dashboard, API and browser WebSocket at the same boundary."""

    def __init__(self, app, user: str, salt: bytes, digest: bytes):
        self.app = app
        self.user = user.encode()
        self.salt = salt
        self.digest = digest
        self.slots = asyncio.Semaphore(2)
        self.sessions: OrderedDict[str, float] = OrderedDict()

    def matches(self, header: str) -> bool:
        scheme, _, value = header.partition(" ")
        if scheme.lower() != "basic" or len(value) > 2048:
            return False
        try:
            user, _, password = base64.b64decode(value, validate=True).partition(b":")
        except (ValueError, binascii.Error):
            return False
        if not secrets.compare_digest(self.user, user) or not password:
            return False
        supplied = pbkdf2_hmac("sha256", password, self.salt, ITERATIONS)
        return secrets.compare_digest(self.digest, supplied)

    def new_session(self) -> str:
        now = monotonic()
        while self.sessions and (len(self.sessions) >= 256 or next(iter(self.sessions.values())) <= now):
            self.sessions.popitem(last=False)
        token = secrets.token_urlsafe(32)
        self.sessions[token] = now + SESSION_SECONDS
        return token

    async def __call__(self, scope, receive, send):
        from starlette.requests import HTTPConnection
        from starlette.responses import PlainTextResponse

        kind = scope["type"]
        if kind not in {"http", "websocket"} or (scope.get("method") == "GET" and scope["path"] == "/deploy-healthz"):
            return await self.app(scope, receive, send)

        conn = HTTPConnection(scope)
        headers = conn.headers
        browser_write = kind == "websocket" or scope["method"] not in {"GET", "HEAD", "OPTIONS"}
        # The public listener is HTTPS-only. Ignore client-supplied forwarding headers.
        if browser_write and (not headers.get("host") or headers.get("origin") != f"https://{headers['host']}"):
            if kind == "websocket":
                return await send({"type": "websocket.close", "code": 1008})
            return await PlainTextResponse("Same-origin request required", 403)(scope, receive, send)

        token = None
        if self.sessions.get(conn.cookies.get(COOKIE, ""), 0) <= monotonic():
            auth = headers.get("authorization", "")
            if auth and self.slots.locked():
                if kind == "websocket":
                    return await send({"type": "websocket.close", "code": 1013})
                return await PlainTextResponse("Retry shortly", 429, {"Retry-After": "1"})(scope, receive, send)
            async with self.slots:
                authenticated = bool(auth) and await asyncio.to_thread(self.matches, auth)
            if not authenticated:
                if kind == "websocket":
                    return await send({"type": "websocket.close", "code": 1008})
                challenge = {"WWW-Authenticate": 'Basic realm="MIZUHO", charset="UTF-8"', "Cache-Control": "no-store"}
                return await PlainTextResponse("Judge sign-in required", 401, challenge)(scope, receive, send)
            if kind == "http":
                token = self.new_session()

        async def protected_send(message):
            if message["type"] == "http.response.start":
                from starlette.datastructures import MutableHeaders

                response = MutableHeaders(scope=message)
                response["cache-control"] = "private, no-cache" if scope["path"].startswith("/assets/") else "no-store"
                response["referrer-policy"] = "no-referrer"
                response["x-content-type-options"] = "nosniff"
                response["content-security-policy"] = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
                if token:
                    response.append("set-cookie", f"{COOKIE}={token}; Path=/; Max-Age={SESSION_SECONDS}; Secure; HttpOnly; SameSite=Strict")
            await send(message)

        downstream = dict(scope, scheme="wss" if kind == "websocket" else "https")
        downstream["headers"] = [(key, value) for key, value in scope["headers"] if key not in {b"authorization", b"cookie"}]
        await self.app(downstream, receive, protected_send)


def create_app(dist: Path = DIST):
    from fastapi.staticfiles import StaticFiles
    from .main import create_app as create_api

    user = os.environ.get("MIZUHO_JUDGE_USER", "")
    encoded = os.environ.get("MIZUHO_JUDGE_PASSWORD_HASH", "")
    match = re.fullmatch(r"pbkdf2_sha256\$600000\$([0-9a-f]{32})\$([0-9a-f]{64})", encoded)
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{1,128}", user) or match is None:
        raise ValueError("Configure MIZUHO_JUDGE_USER and MIZUHO_JUDGE_PASSWORD_HASH for the hosted dashboard.")
    if not os.environ.get("MIZHUO_MANAGER_APPROVAL_CODE", "").strip():
        raise ValueError("Configure MIZHUO_MANAGER_APPROVAL_CODE for the hosted simulator.")
    if not (dist / "index.html").is_file():
        raise ValueError("Build the connected frontend before starting the hosted dashboard.")
    app = create_api()
    revision = os.environ.get("MIZUHO_RELEASE_SHA", "development")

    @app.get("/deploy-healthz", include_in_schema=False)
    async def release_health():
        return {"status": "ok", "revision": revision}

    # Existing FastAPI routes retain precedence. Client navigation uses URL fragments.
    app.mount("/", StaticFiles(directory=dist, html=True), name="dashboard")
    app.add_middleware(JudgeAccess, user=user, salt=bytes.fromhex(match[1]), digest=bytes.fromhex(match[2]))
    return app


if __name__ == "__main__":
    password = getpass("New judge password (at least 16 characters): ")
    if len(password) < 16 or password != getpass("Confirm judge password: "):
        raise SystemExit("Choose a matching password of at least 16 characters.")
    print(encode_password(password))

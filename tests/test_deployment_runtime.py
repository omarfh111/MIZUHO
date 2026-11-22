import json
import secrets

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import DATA_DIR, deployment


ORIGIN = "https://demo.example"
START = {"type": "start", "reason": "accessibility", "site_id": "jendouba-pilote", "language": "ja"}


@pytest.fixture
def release(tmp_path, monkeypatch):
    password = secrets.token_urlsafe(28)
    monkeypatch.setenv("MIZUHO_JUDGE_USER", "judge")
    monkeypatch.setenv("MIZUHO_JUDGE_PASSWORD_HASH", deployment.encode_password(password))
    monkeypatch.setenv("MIZHUO_MANAGER_APPROVAL_CODE", secrets.token_urlsafe(12))
    monkeypatch.setenv("MIZUHO_RELEASE_SHA", "abc123")
    for key in ("OPENAI_API_KEY", "LLM_API_KEY", "QDRANT_API_KEY", "VULTR_INFERENCE_API_KEY"):
        monkeypatch.setenv(key, "")
    (tmp_path / "index.html").write_text("<h1>Dashboard</h1>")
    (tmp_path / "guardian-capture-worklet.js").write_text("// audio worklet")
    return tmp_path, password


def test_missing_settings_or_dashboard_prevent_startup(release, monkeypatch):
    directory, _ = release
    for name in ("MIZUHO_JUDGE_USER", "MIZUHO_JUDGE_PASSWORD_HASH", "MIZHUO_MANAGER_APPROVAL_CODE"):
        with monkeypatch.context() as isolated:
            isolated.setenv(name, "")
            with pytest.raises(ValueError, match="Configure"):
                deployment.create_app(directory)
    with monkeypatch.context() as isolated:
        isolated.setenv("MIZUHO_JUDGE_PASSWORD_HASH", "unusable")
        with pytest.raises(ValueError, match="Configure"):
            deployment.create_app(directory)
    with pytest.raises(ValueError, match="frontend"):
        deployment.create_app(directory / "missing")


def test_only_release_health_is_public_and_auth_expires(release, monkeypatch):
    directory, password = release
    now = 100.0
    monkeypatch.setattr(deployment, "monotonic", lambda: now)
    with TestClient(deployment.create_app(directory), base_url=ORIGIN) as client:
        assert client.get("/deploy-healthz").json() == {"status": "ok", "revision": "abc123"}
        for path in ("/", "/api/health", "/guardian-capture-worklet.js", "/docs", "/openapi.json"):
            response = client.get(path)
            assert response.status_code == 401
            assert response.headers["www-authenticate"].startswith("Basic ")
        assert client.get("/", auth=("judge", "wrong")).status_code == 401
        assert client.get("/", headers={"Authorization": "Basic !!!"}).status_code == 401
        page = client.get("/", auth=("judge", password))
        assert page.status_code == 200 and "Dashboard" in page.text
        assert all(flag in page.headers["set-cookie"] for flag in ("__Host-", "Secure", "HttpOnly", "SameSite=Strict"))
        assert client.get("/guardian-capture-worklet.js").status_code == 200
        assert client.get("/api/unknown").status_code == 404
        assert client.get("/api/health").json() == {"status": "ok"}
        now += deployment.SESSION_SECONDS + 1
        assert client.get("/api/health").status_code == 401


def test_hosted_planning_and_voice_share_browser_authentication(release):
    directory, password = release
    with TestClient(deployment.create_app(directory), base_url=ORIGIN) as client:
        assert client.get("/", auth=("judge", password)).is_success
        fixture = json.loads((DATA_DIR / "fixtures" / "compare.json").read_text(encoding="utf-8"))
        assert client.post("/api/compare", json=fixture["request"]).status_code == 403
        for foreign in ("https://other.example", "null", ORIGIN + ".other.example"):
            response = client.post("/api/compare", headers={"Origin": foreign}, json=fixture["request"])
            assert response.status_code == 403
        valid = client.post("/api/compare", headers={"Origin": ORIGIN}, json=fixture["request"])
        assert valid.status_code == 200
        assert valid.json()["baseline"]["metrics"]["worst_coverage_bp"] == 0
        assert valid.json()["optimized"]["metrics"]["worst_coverage_bp"] == 5000
        socket_url = ORIGIN.replace("https://", "wss://") + "/api/guardian/call"
        for origin in ("https://other.example", ""):
            with pytest.raises(WebSocketDisconnect):
                with client.websocket_connect(socket_url, headers={"Origin": origin}):
                    pytest.fail("foreign origin accepted")
        with client.websocket_connect(socket_url, headers={"Origin": ORIGIN}) as socket:
            socket.send_json(START)
            welcome = socket.receive_json()
            assert welcome["type"] == "ready" and welcome["language"] == "ja" and welcome["requires_manager_code"]
        client.cookies.clear()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(socket_url, headers={"Origin": ORIGIN}):
                pytest.fail("unauthenticated connection accepted")

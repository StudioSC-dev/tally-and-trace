"""Integration tests for httpOnly-cookie refresh-token storage. Skips without a database.

Web clients never see the refresh token in JS: login sets it as an httpOnly cookie,
/refresh and /logout read it from that cookie. The body-token path is retained for
native clients and is covered by test_refresh_auth_integration.
"""
import os

import pytest
from sqlalchemy import create_engine, text

from app.core.config import settings


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_reachable(), reason="no database available")

API = "/api/v1"
COOKIE = settings.REFRESH_COOKIE_NAME


@pytest.fixture
def client():
    """Function-scoped so each test starts with an empty cookie jar."""
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


def _login(client):
    return client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})


def test_login_sets_an_httponly_refresh_cookie(client):
    resp = _login(client)
    assert resp.status_code == 200, resp.text

    set_cookie = resp.headers.get("set-cookie", "")
    assert COOKIE in set_cookie
    assert "HttpOnly" in set_cookie
    # The token is in the cookie jar, not readable by JS.
    assert client.cookies.get(COOKIE)


def test_refresh_works_from_the_cookie_alone(client):
    """No body token — exactly how the web client calls it."""
    assert _login(client).status_code == 200

    resp = client.post(f"{API}/auth/refresh", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_token"]
    # A fresh cookie is set on rotation.
    assert COOKIE in resp.headers.get("set-cookie", "")


def test_refresh_rotates_the_cookie_and_revokes_the_old_one(client):
    assert _login(client).status_code == 200
    first_cookie = client.cookies.get(COOKIE)

    assert client.post(f"{API}/auth/refresh", json={}).status_code == 200
    rotated_cookie = client.cookies.get(COOKIE)
    assert rotated_cookie != first_cookie

    # Presenting the OLD token (via body) must now be rejected — it was revoked.
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": first_cookie}).status_code == 401


def test_logout_clears_the_cookie_and_revokes_the_token(client):
    assert _login(client).status_code == 200
    token = client.cookies.get(COOKIE)

    logout = client.post(f"{API}/auth/logout", json={})
    assert logout.status_code == 200

    # The revoked token can't be refreshed, even if replayed from the body.
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": token}).status_code == 401


def test_refresh_without_any_token_is_401(client):
    """Fresh client, no cookie, empty body."""
    assert client.post(f"{API}/auth/refresh", json={}).status_code == 401


def test_logout_is_idempotent_without_a_token(client):
    """Signing out with no session must still succeed, not error."""
    assert client.post(f"{API}/auth/logout", json={}).status_code == 200

"""Integration test for the rotating refresh-token flow. Skips without a database."""
import os

import pytest
from sqlalchemy import create_engine, text


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


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


def test_refresh_rotation_and_revocation(client):
    login = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert login.status_code == 200, login.text
    tok = login.json()
    assert tok["access_token"] and tok["refresh_token"]

    # Rotate: refresh returns new tokens, and the refresh token changes.
    r2 = client.post(f"{API}/auth/refresh", json={"refresh_token": tok["refresh_token"]})
    assert r2.status_code == 200, r2.text
    tok2 = r2.json()
    assert tok2["refresh_token"] != tok["refresh_token"]

    # The old refresh token is now revoked.
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": tok["refresh_token"]}).status_code == 401

    # The new access token works.
    me = client.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {tok2['access_token']}"})
    assert me.status_code == 200

    # Logout revokes the current refresh token.
    assert client.post(f"{API}/auth/logout", json={"refresh_token": tok2["refresh_token"]}).status_code == 200
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": tok2["refresh_token"]}).status_code == 401

    # A bogus refresh token is rejected.
    assert client.post(f"{API}/auth/refresh", json={"refresh_token": "not-a-real-token-value"}).status_code == 401

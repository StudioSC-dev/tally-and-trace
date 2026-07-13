"""
Integration test for GET /forecast/timeline against a real database.

Skips itself when no database is reachable (so the pure suite still runs
anywhere). In CI the backend job runs `alembic upgrade head` first, so this also
validates the new migration (semi-monthly columns + cadence enum values) and the
full request path. Uses the seeded demo user.
"""
import os

import pytest
from sqlalchemy import create_engine, text


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        eng = create_engine(url)
        with eng.connect() as c:
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

    with TestClient(app) as c:  # triggers lifespan -> seeds the demo user
        yield c


def _auth_headers(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_timeline_endpoint_shape_and_excludes_credit(client):
    h = _auth_headers(client)

    # Expected opening = sum of NON-credit active account balances (user-scoped).
    accts = client.get(f"{API}/accounts/", headers=h, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    expected_opening = round(
        sum(a["balance"] for a in items if a["account_type"] != "credit" and a.get("is_active", True)),
        2,
    )

    r = client.get(f"{API}/forecast/timeline", headers=h, params={"days": 60})
    assert r.status_code == 200, r.text
    body = r.json()

    for key in (
        "window_start", "window_end", "opening_balance", "lowest_balance",
        "trough_date", "closing_balance", "shortfall", "shortfalls", "events",
    ):
        assert key in body

    # Credit-card balances must NOT count as available cash.
    assert body["opening_balance"] == pytest.approx(expected_opening, abs=0.01)

    # Events are chronologically ordered and carry a running balance.
    dates = [e["date"] for e in body["events"]]
    assert dates == sorted(dates)
    for e in body["events"]:
        assert "running_balance" in e

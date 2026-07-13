"""
Integration test for POST /budget-entries/{id}/materialize.

Skips when no database is reachable. Uses the seeded demo user: picks an active
budget entry that has an account, posts it, and asserts a linked transaction was
created, the account balance moved by the amount, and the schedule advanced.
"""
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


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _account_balance(client, headers, account_id):
    accts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    for a in items:
        if a["id"] == account_id:
            return a["balance"]
    return None


def test_materialize_posts_transaction_and_advances(client):
    h = _auth(client)

    entries = client.get(f"{API}/budget-entries/", headers=h, params={"is_active": True, "limit": 200}).json()["items"]
    entry = next((e for e in entries if e.get("account_id")), None)
    if entry is None:
        pytest.skip("no seeded budget entry with an account to post to")

    before_balance = _account_balance(client, h, entry["account_id"])
    before_next = entry["next_occurrence"]
    amount = entry["amount"]
    expect_type = "credit" if entry["entry_type"] == "income" else "debit"

    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=h, json={})
    assert r.status_code == 201, r.text
    txn = r.json()
    assert txn["budget_entry_id"] == entry["id"]
    assert txn["is_posted"] is True
    assert txn["is_recurring"] is True
    assert txn["transaction_type"] == expect_type
    assert txn["amount"] == pytest.approx(amount, abs=0.01)

    # Account balance moved by the amount in the right direction.
    after_balance = _account_balance(client, h, entry["account_id"])
    delta = after_balance - before_balance
    expected = amount if expect_type == "credit" else -amount
    assert delta == pytest.approx(expected, abs=0.01)

    # Schedule advanced (entry still active in these seeds).
    after = client.get(f"{API}/budget-entries/{entry['id']}", headers=h).json()
    assert after["next_occurrence"] != before_next

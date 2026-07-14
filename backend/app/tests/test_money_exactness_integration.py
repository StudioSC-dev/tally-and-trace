"""
Integration tests that money stays exact through the transaction paths now that
balances are NUMERIC(15,2). Skips when no database is reachable.
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


def _new_account(client, headers, balance):
    r = client.post(f"{API}/accounts/", headers=headers, json={
        "name": "Decimal Test", "account_type": "checking", "balance": balance, "currency": "PHP",
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _balance(client, headers, account_id):
    accts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    return next(a["balance"] for a in items if a["id"] == account_id)


def _post_txn(client, headers, body):
    r = client.post(f"{API}/transactions/", headers=headers, json={
        "transaction_date": "2026-08-01T00:00:00", "is_posted": True, "currency": "PHP", **body,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_accumulated_balance_is_exact(client):
    h = _auth(client)
    aid = _new_account(client, h, 0)
    for amt in (0.10, 0.20, 0.05, 0.01, 0.03):   # sums that float-drift when accumulated
        _post_txn(client, h, {"account_id": aid, "amount": amt, "transaction_type": "credit"})
    _post_txn(client, h, {"account_id": aid, "amount": 0.15, "transaction_type": "debit"})
    # 0.10+0.20+0.05+0.01+0.03 - 0.15 = 0.24, exactly.
    assert _balance(client, h, aid) == pytest.approx(0.24, abs=1e-9)


def test_transfer_with_fee_is_exact(client):
    h = _auth(client)
    src = _new_account(client, h, 100.00)
    dst = _new_account(client, h, 0)
    _post_txn(client, h, {
        "account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": dst,
        "amount": 30.30, "transfer_fee": 0.20, "transaction_type": "transfer",
    })
    assert _balance(client, h, src) == pytest.approx(69.50, abs=1e-9)   # 100.00 - 30.30 - 0.20
    assert _balance(client, h, dst) == pytest.approx(30.30, abs=1e-9)

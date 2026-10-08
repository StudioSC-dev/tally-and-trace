"""Recurring transfer budget entries (``transfer_to_account_id``).

The destination may be any accessible non-credit account; the entry materialises
as a transfer transaction that moves balances like any other transfer. Skips
without a database.
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


@pytest.fixture
def headers(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def made(client):
    """Ids of accounts / entries created by a test; hard-deleted afterwards with their rows."""
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    created = {"accounts": [], "entries": []}
    yield created

    db = SessionLocal()
    try:
        db.query(Transaction).filter(Transaction.budget_entry_id.in_(created["entries"])).delete(
            synchronize_session=False)
        db.query(BudgetEntry).filter(BudgetEntry.id.in_(created["entries"])).delete(
            synchronize_session=False)
        db.commit()
        db.query(Account).filter(Account.id.in_(created["accounts"])).delete(
            synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _account(client, headers, made, name, account_type, balance=0, **extra):
    r = client.post(f"{API}/accounts/", headers=headers, json={
        "name": name, "account_type": account_type, "balance": balance, **extra})
    assert r.status_code == 200, r.text
    made["accounts"].append(r.json()["id"])
    return r.json()


def _entry(client, headers, made, **payload):
    body = {"name": "Move to loan", "entry_type": "expense", "amount": 3000,
            "next_occurrence": "2026-11-01T00:00:00"}
    body.update(payload)
    r = client.post(f"{API}/budget-entries/", json=body, headers=headers)
    if r.status_code == 201:
        made["entries"].append(r.json()["id"])
    return r


def _balance(client, headers, account_id):
    return client.get(f"{API}/accounts/{account_id}", headers=headers).json()["balance"]


def test_transfer_destination_accepts_any_non_credit_account(client, headers, made):
    secb = _account(client, headers, made, "SecB Probe", "savings", 10000)
    loan = _account(client, headers, made, "BDO Loan Probe", "checking")
    wallet = _account(client, headers, made, "GCash Probe", "e_wallet", is_spending_wallet=True)

    for dest in (loan, wallet):
        r = _entry(client, headers, made, account_id=secb["id"], transfer_to_account_id=dest["id"])
        assert r.status_code == 201, r.text
        assert r.json()["transfer_to_account_id"] == dest["id"]


def test_transfer_destination_rejections(client, headers, made):
    secb = _account(client, headers, made, "SecB Probe", "savings", 10000)
    loan = _account(client, headers, made, "BDO Loan Probe", "checking")
    card = _account(client, headers, made, "Card Probe", "credit",
                    billing_cycle_start=24, days_until_due_date=21)

    # Into a credit card: not allowed, so statements never see a projected payment.
    r = _entry(client, headers, made, account_id=secb["id"], transfer_to_account_id=card["id"])
    assert r.status_code == 400
    # From a credit card: not allowed either (no recurring cash advances).
    r = _entry(client, headers, made, account_id=card["id"], transfer_to_account_id=loan["id"])
    assert r.status_code == 400
    # Inaccessible / nonexistent destination.
    r = _entry(client, headers, made, account_id=secb["id"], transfer_to_account_id=99_999_999)
    assert r.status_code == 404
    # Same account, and no source at all.
    r = _entry(client, headers, made, account_id=secb["id"], transfer_to_account_id=secb["id"])
    assert r.status_code == 400
    r = _entry(client, headers, made, transfer_to_account_id=loan["id"])
    assert r.status_code == 400

    # Edits are validated against the resulting entry.
    ok = _entry(client, headers, made, account_id=secb["id"], transfer_to_account_id=loan["id"])
    assert ok.status_code == 201
    r = client.put(f"{API}/budget-entries/{ok.json()['id']}",
                   json={"transfer_to_account_id": card["id"]}, headers=headers)
    assert r.status_code == 400
    r = client.put(f"{API}/budget-entries/{ok.json()['id']}",
                   json={"account_id": loan["id"]}, headers=headers)
    assert r.status_code == 400


def test_transfer_entry_materialises_as_a_transfer(client, headers, made):
    secb = _account(client, headers, made, "SecB Probe", "savings", 10000)
    loan = _account(client, headers, made, "BDO Loan Probe", "checking", 0)
    entry = _entry(client, headers, made, account_id=secb["id"], transfer_to_account_id=loan["id"])
    assert entry.status_code == 201, entry.text

    r = client.post(f"{API}/budget-entries/{entry.json()['id']}/materialize",
                    json={"transfer_fee": 15}, headers=headers)
    assert r.status_code == 201, r.text
    txn = r.json()
    assert txn["transaction_type"] == "transfer"
    assert txn["account_id"] == secb["id"]
    assert txn["transfer_from_account_id"] == secb["id"]
    assert txn["transfer_to_account_id"] == loan["id"]
    assert txn["transfer_fee"] == pytest.approx(15)
    assert txn["budget_entry_id"] == entry.json()["id"]

    # Balances move like a normal transfer: -(amount + fee) / +amount.
    assert _balance(client, headers, secb["id"]) == pytest.approx(10000 - 3015)
    assert _balance(client, headers, loan["id"]) == pytest.approx(3000)

    after = client.get(f"{API}/budget-entries/{entry.json()['id']}", headers=headers).json()
    assert after["next_occurrence"].startswith("2026-12-01")

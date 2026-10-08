"""Spending wallets as accounts, and routing validation that rejects them as funding.

A wallet's balance is shown but is not projection cash, so nothing that routing
draws on may be one: a card's statement payment / overflow account, or a budget
entry's overflow account. A wallet may still be an entry's own account (such
entries are skipped by the projection). Skips without a database.
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
    """Ids of accounts / entries created by a test; hard-deleted afterwards."""
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry

    created = {"accounts": [], "entries": []}
    yield created

    db = SessionLocal()
    try:
        db.query(BudgetEntry).filter(BudgetEntry.id.in_(created["entries"])).delete(
            synchronize_session=False)
        db.query(Account).filter(Account.id.in_(created["accounts"])).update(
            {"payment_account_id": None, "payment_overflow_account_id": None},
            synchronize_session=False)
        db.commit()
        db.query(Account).filter(Account.id.in_(created["accounts"])).delete(
            synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _account(client, headers, made, **payload):
    body = {"name": "Wallet Probe", "account_type": "cash", "balance": 0}
    body.update(payload)
    r = client.post(f"{API}/accounts/", json=body, headers=headers)
    if r.status_code == 200:
        made["accounts"].append(r.json()["id"])
    return r


def _card(client, headers, made, **payload):
    return _account(client, headers, made, name="Probe CC", account_type="credit",
                    billing_cycle_start=24, days_until_due_date=21, **payload)


def _entry(client, headers, made, **payload):
    body = {"name": "Probe bill", "entry_type": "expense", "amount": 100,
            "next_occurrence": "2026-11-04T00:00:00"}
    body.update(payload)
    r = client.post(f"{API}/budget-entries/", json=body, headers=headers)
    if r.status_code == 201:
        made["entries"].append(r.json()["id"])
    return r


def test_account_round_trips_the_spending_wallet_flag(client, headers, made):
    wallet = _account(client, headers, made, is_spending_wallet=True)
    assert wallet.status_code == 200, wallet.text
    assert wallet.json()["is_spending_wallet"] is True

    bank = _account(client, headers, made, name="Bank Probe", account_type="savings")
    assert bank.json()["is_spending_wallet"] is False

    r = client.put(f"{API}/accounts/{wallet.json()['id']}",
                   json={"is_spending_wallet": False}, headers=headers)
    assert r.status_code == 200 and r.json()["is_spending_wallet"] is False

    r = client.put(f"{API}/accounts/{wallet.json()['id']}",
                   json={"is_spending_wallet": None}, headers=headers)
    assert r.status_code == 422


def test_a_credit_card_cannot_be_a_spending_wallet(client, headers, made):
    assert _card(client, headers, made, is_spending_wallet=True).status_code == 400
    card = _card(client, headers, made)
    r = client.put(f"{API}/accounts/{card.json()['id']}",
                   json={"is_spending_wallet": True}, headers=headers)
    assert r.status_code == 400


@pytest.mark.parametrize("field", ["payment_account_id", "payment_overflow_account_id"])
def test_card_payment_routing_rejects_a_wallet(client, headers, made, field):
    wallet = _account(client, headers, made, is_spending_wallet=True).json()
    bank = _account(client, headers, made, name="Bank Probe", account_type="savings").json()

    r = _card(client, headers, made, **{field: wallet["id"]})
    assert r.status_code == 400 and "spending wallet" in r.text

    card = _card(client, headers, made, **{field: bank["id"]})
    assert card.status_code == 200, card.text
    r = client.put(f"{API}/accounts/{card.json()['id']}", json={field: wallet["id"]}, headers=headers)
    assert r.status_code == 400 and "spending wallet" in r.text


def test_budget_entry_overflow_rejects_a_wallet(client, headers, made):
    wallet = _account(client, headers, made, is_spending_wallet=True).json()
    bank = _account(client, headers, made, name="Bank Probe", account_type="savings").json()

    r = _entry(client, headers, made, account_id=bank["id"], overflow_account_id=wallet["id"])
    assert r.status_code == 400 and "spending wallet" in r.text

    entry = _entry(client, headers, made, account_id=bank["id"])
    assert entry.status_code == 201, entry.text
    r = client.put(f"{API}/budget-entries/{entry.json()['id']}",
                   json={"overflow_account_id": wallet["id"]}, headers=headers)
    assert r.status_code == 400 and "spending wallet" in r.text


def test_budget_entry_overflow_must_be_accessible(client, headers, made):
    r = _entry(client, headers, made, overflow_account_id=99_999_999)
    assert r.status_code == 404


def test_a_wallet_may_fund_an_entry_directly(client, headers, made):
    wallet = _account(client, headers, made, is_spending_wallet=True).json()
    r = _entry(client, headers, made, account_id=wallet["id"])
    assert r.status_code == 201, r.text


def test_an_account_that_funds_routing_cannot_become_a_wallet(client, headers, made):
    bank = _account(client, headers, made, name="Bank Probe", account_type="savings").json()
    assert _card(client, headers, made, payment_account_id=bank["id"]).status_code == 200
    r = client.put(f"{API}/accounts/{bank['id']}", json={"is_spending_wallet": True}, headers=headers)
    assert r.status_code == 400

    other = _account(client, headers, made, name="Other Probe", account_type="checking").json()
    assert _entry(client, headers, made, account_id=bank["id"],
                  overflow_account_id=other["id"]).status_code == 201
    r = client.put(f"{API}/accounts/{other['id']}", json={"is_spending_wallet": True}, headers=headers)
    assert r.status_code == 400

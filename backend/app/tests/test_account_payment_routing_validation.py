"""Ownership/shape validation for a card's statement-payment routing.

The routing fields are account ids supplied by the client, and the ids they name
surface back to the caller through the timeline's ``account_shortfalls``
(which include ``account_name``). So they need the same treatment entity_id got in
Session 13: validate membership rather than trusting the payload.

Skips itself when no database is reachable.
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
def db():
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def other_users_account(db):
    """An account belonging to somebody else entirely."""
    from decimal import Decimal

    from app.core.auth import get_password_hash
    from app.models.account import Account, AccountType
    from app.models.user import User

    stranger = User(
        email=f"stranger-{os.urandom(4).hex()}@example.com",
        password_hash=get_password_hash("password123"),
        first_name="Not", last_name="Yours", is_verified=True,
    )
    db.add(stranger)
    db.commit()
    db.refresh(stranger)

    account = Account(
        user_id=stranger.id, name="Stranger Secret Savings",
        account_type=AccountType.SAVINGS, balance=Decimal("999.00"),
    )
    db.add(account)
    db.commit()
    db.refresh(account)

    yield account

    db.query(Account).filter(Account.user_id == stranger.id).delete()
    db.query(User).filter(User.id == stranger.id).delete()
    db.commit()


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _make_card(client, headers, **extra):
    payload = {
        "name": "Routing Probe CC",
        "account_type": "credit",
        "balance": 0,
        "billing_cycle_start": 24,
        "days_until_due_date": 21,
    }
    payload.update(extra)
    return client.post(f"{API}/accounts/", json=payload, headers=headers)


def test_cannot_route_a_statement_at_another_users_account(client, other_users_account):
    headers = _auth(client)
    resp = _make_card(client, headers, payment_account_id=other_users_account.id)
    assert resp.status_code == 404, resp.text
    assert "Stranger Secret Savings" not in resp.text  # no name leak


def test_cannot_route_a_statement_at_a_nonexistent_account(client):
    headers = _auth(client)
    resp = _make_card(client, headers, payment_account_id=99_999_999)
    assert resp.status_code == 404, resp.text


def test_cannot_route_a_statement_at_another_credit_card(client):
    """Paying a card from a card isn't a funding source."""
    headers = _auth(client)
    other_card = _make_card(client, headers, name="Other CC")
    assert other_card.status_code == 200, other_card.text

    resp = _make_card(client, headers, payment_account_id=other_card.json()["id"])
    assert resp.status_code == 400, resp.text
    assert "credit card" in resp.text


def test_overflow_account_is_validated_too(client, other_users_account):
    headers = _auth(client)
    resp = _make_card(client, headers, payment_overflow_account_id=other_users_account.id)
    assert resp.status_code == 404, resp.text


def test_card_cannot_fund_its_own_statement(client):
    headers = _auth(client)
    card = _make_card(client, headers)
    assert card.status_code == 200, card.text
    card_id = card.json()["id"]

    resp = client.put(
        f"{API}/accounts/{card_id}",
        json={"payment_account_id": card_id},
        headers=headers,
    )
    assert resp.status_code == 400, resp.text
    assert "itself" in resp.text


def test_valid_routing_to_an_owned_account_is_accepted(client):
    headers = _auth(client)
    accounts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()["items"]
    funding = next(a for a in accounts if a["account_type"] != "credit")

    resp = _make_card(client, headers, payment_account_id=funding["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["payment_account_id"] == funding["id"]

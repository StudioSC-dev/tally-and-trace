"""Integration tests: forecast endpoints only project the caller's own accounts (STU-216).

STU-216 stopped a caller passing any ``entity_id`` to read another entity's
projections. Entities are gone (STU-229): the scope is the accounts the caller
holds a role on, so neither an ``entity_id`` parameter nor an ``X-Entity-Id``
header can widen it. Skips without a database.
"""
import os
import secrets

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
ENDPOINTS = ["/forecast/cashflow", "/forecast/upcoming", "/forecast/timeline", "/forecast/disposable"]


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


def _make_user(db):
    from app.core.auth import get_password_hash
    from app.models.user import User

    email = f"fc-{secrets.token_hex(6)}@example.com"
    user = User(
        email=email,
        password_hash=get_password_hash("Password123!"),
        first_name="Forecast",
        last_name="Probe",
        is_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user, email


def _token(client, email):
    r = client.post(f"{API}/auth/login", json={"email": email, "password": "Password123!"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def world(db):
    """An owner with a funded account and a recurring bill, plus a stranger with neither."""
    from datetime import datetime
    from decimal import Decimal
    from app.models.account import Account, AccountType
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency
    from app.models.user import User

    owner, owner_email = _make_user(db)
    stranger, stranger_email = _make_user(db)
    bank = Account(user_id=owner.id, name="Owner bank", account_type=AccountType.CHECKING,
                   balance=Decimal("77777.00"))
    db.add(bank)
    db.commit()
    db.add(BudgetEntry(user_id=owner.id, name="Owner rent", entry_type=BudgetEntryType.EXPENSE,
                       amount=Decimal("5555.00"), cadence=RecurrenceFrequency.MONTHLY,
                       next_occurrence=datetime.now().replace(microsecond=0),
                       account_id=bank.id))
    db.commit()

    yield {"owner_email": owner_email, "stranger_email": stranger_email}

    db.query(BudgetEntry).filter(BudgetEntry.user_id == owner.id).delete()
    db.query(Account).filter(Account.user_id == owner.id).delete()
    for uid in (owner.id, stranger.id):
        db.query(User).filter(User.id == uid).delete()
    db.commit()


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _leaks(r):
    return any(s in r.text for s in ("Owner bank", "Owner rent", "77777", "5555"))


@pytest.mark.parametrize("path", ENDPOINTS)
def test_an_entity_id_param_does_not_widen_the_scope(client, world, path):
    token = _token(client, world["stranger_email"])
    for entity_id in (1, 2, 999999):
        r = client.get(f"{API}{path}", headers=_auth(token), params={"entity_id": entity_id})
        assert r.status_code == 200, r.text
        assert not _leaks(r), r.text


@pytest.mark.parametrize("path", ENDPOINTS)
def test_an_entity_header_does_not_widen_the_scope(client, world, path):
    token = _token(client, world["stranger_email"])
    for entity_id in (1, 2, 999999):
        r = client.get(f"{API}{path}", headers={**_auth(token), "X-Entity-Id": str(entity_id)})
        assert r.status_code == 200, r.text
        assert not _leaks(r), r.text


@pytest.mark.parametrize("path", ENDPOINTS)
def test_the_owner_gets_their_own_projection(client, world, path):
    token = _token(client, world["owner_email"])
    r = client.get(f"{API}{path}", headers=_auth(token))
    assert r.status_code == 200, r.text
    assert _leaks(r), r.text

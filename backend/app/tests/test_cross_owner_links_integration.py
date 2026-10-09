"""A stale cross-owner reference never moves or discloses another user's numbers (STU-229).

Before STU-229 a row could reference another user's allocation, recurring entry
or category (through a shared entity). Such a reference is stale: anything that
matches rows by ``allocation_id``, ``budget_entry_id`` or ``category_id`` counts
a row only when its creator owns the record it names. Each test plants such a
row directly in the database, as the entity era left them. Skips without a
database.
"""
import os
import secrets
from datetime import datetime
from decimal import Decimal

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
PASSWORD = "Password123!"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def people(client, db):
    """Factory for throwaway logged-in users; everything they made is removed."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User

    users = []

    def make():
        email = f"links-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Links", last_name="Probe", is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        users.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": u.id, "user": u,
                "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    yield make

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id.in_(users)).delete(
        synchronize_session=False)
    for model in (BudgetEntry, Allocation, Category):
        db.query(model).filter(model.user_id.in_(users)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(users)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
    db.commit()


def _post(client, who, path, body):
    r = client.post(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code in (200, 201), r.text
    return r.json()


def _account(db, who, name, account_type, balance="0", **kw):
    from app.models.account import Account

    a = Account(user_id=who["id"], name=name, account_type=account_type,
                balance=Decimal(balance), **kw)
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _stale_txn(db, who, account_id, when, txn_type=None, amount="500", **kw):
    """A row of ``who``'s that references another user's record (set in ``kw``)."""
    from app.models.transaction import Transaction, TransactionType

    t = Transaction(
        user_id=who["id"], account_id=account_id, amount=Decimal(amount), currency="PHP",
        transaction_type=txn_type or TransactionType.DEBIT, transaction_date=when,
        description="Stale link", transfer_fee=0, **kw)
    db.add(t)
    db.commit()
    return t


# --- Allocation progress -------------------------------------------------------


def test_allocation_progress_counts_only_its_owners_credits(client, db, people):
    """B's credit naming A's allocation is not A's progress; A's own credit is."""
    from app.models.transaction import TransactionType

    a, b = people(), people()
    bank = _post(client, a, "/accounts/", {
        "name": "A bank", "account_type": "checking", "balance": 1_000})["id"]
    allocation = _post(client, a, "/allocations/", {
        "account_id": bank, "name": "A fund", "allocation_type": "savings",
        "target_amount": 10_000, "monthly_target": 1_000})["id"]
    b_bank = _post(client, b, "/accounts/", {
        "name": "B bank", "account_type": "checking", "balance": 0})["id"]
    now = datetime.now().replace(microsecond=0)
    _stale_txn(db, b, b_bank, now, TransactionType.CREDIT, "500", allocation_id=allocation)
    _stale_txn(db, a, bank, now, TransactionType.CREDIT, "50", allocation_id=allocation)

    r = client.get(f"{API}/allocations/{allocation}/progress", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert Decimal(str(r.json()["monthly_progress"])) == Decimal("50")

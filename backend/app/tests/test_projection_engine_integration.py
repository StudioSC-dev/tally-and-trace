"""Integration tests for the unified dated-event projection engine.

Exercises collect_events through the real query path: per-account transfer legs,
the monthly projection, and the shared window between the monthly and dated
views. All accounts and amounts are generic fixtures. Skips without a database.
"""
import os
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


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:  # lifespan creates tables / seeds
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
def user(db):
    """A throwaway user; everything it owns is deleted afterwards."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.models.user import User

    u = User(
        email=f"proj-{os.urandom(4).hex()}@example.com",
        password_hash=get_password_hash("password123"),
        first_name="Proj",
        last_name="Probe",
        is_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    yield u

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id == u.id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.user_id == u.id).delete()
    db.query(Account).filter(Account.user_id == u.id).update(
        {"payment_account_id": None, "payment_overflow_account_id": None}
    )
    db.commit()
    db.query(Account).filter(Account.user_id == u.id).delete()
    db.query(User).filter(User.id == u.id).delete()
    db.commit()


def _account(db, user, name, account_type, balance="0", **kw):
    from app.models.account import Account

    a = Account(user_id=user.id, name=name, account_type=account_type,
                balance=Decimal(balance), **kw)
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _entry(db, user, name, entry_type, amount, next_occurrence, account=None, **kw):
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import RecurrenceFrequency

    e = BudgetEntry(
        user_id=user.id, name=name, entry_type=entry_type, amount=Decimal(amount),
        cadence=kw.pop("cadence", RecurrenceFrequency.MONTHLY),
        next_occurrence=next_occurrence,
        account_id=account.id if account else None, **kw,
    )
    db.add(e)
    db.commit()
    return e


def _txn(db, user, account, txn_type, amount, when, **kw):
    from app.models.transaction import Transaction

    t = Transaction(user_id=user.id, account_id=account.id, amount=Decimal(amount),
                    transaction_type=txn_type, transaction_date=when,
                    is_posted=kw.pop("is_posted", False), **kw)
    db.add(t)
    db.commit()
    return t


# ---------------------------------------------------------------------------
# Transfers between projection-cash accounts
# ---------------------------------------------------------------------------

def test_transfer_funds_destination_before_its_payable_and_costs_only_the_fee(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.models.transaction import TransactionType
    from app.services.forecast import project_running_balance

    savings_a = _account(db, user, "Savings A", AccountType.SAVINGS, "10000.00")
    checking_b = _account(db, user, "Checking B", AccountType.CHECKING, "0.00")
    _txn(db, user, savings_a, TransactionType.TRANSFER, "5000.00", datetime(2026, 8, 5),
         transfer_fee=Decimal("15.00"), description="Move to B",
         transfer_from_account_id=savings_a.id, transfer_to_account_id=checking_b.id)
    _entry(db, user, "Bill from B", BudgetEntryType.EXPENSE, "4000.00", datetime(2026, 8, 10),
           account=checking_b, end_mode="after_occurrences", max_occurrences=1)

    r = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))

    # Checking B is funded by the transfer before its bill is due: no shortfall.
    assert r["account_shortfalls"] == []
    # The pooled total moves only by the fee (and the bill itself).
    assert r["opening_balance"] == Decimal("10000.00")
    transfer = [e for e in r["events"] if e["type"] == "transfer"]
    assert len(transfer) == 1 and transfer[0]["amount"] == Decimal("-15.00")
    assert r["closing_balance"] == Decimal("5985.00")

    # Per account: the transfer reduced Savings A and funded Checking B's bill.
    closings = {a["account_name"]: a["closing_balance"] for a in r["by_account"]}
    assert closings == {"Savings A": Decimal("4985.00"), "Checking B": Decimal("1000.00")}
    assert r["overflow_moves"] == []


def test_timeline_reports_overflow_use_without_moving_closings(db, user, client):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import project_running_balance, serialize_timeline

    savings_a = _account(db, user, "Savings A", AccountType.SAVINGS, "1000.00")
    checking_b = _account(db, user, "Checking B", AccountType.CHECKING, "100.00")
    _entry(db, user, "Bill from B", BudgetEntryType.EXPENSE, "300.00", datetime(2026, 8, 10),
           account=checking_b, overflow_account_id=savings_a.id,
           end_mode="after_occurrences", max_occurrences=1)

    body = serialize_timeline(
        project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
    )

    assert body["account_shortfalls"] == []
    assert body["overflow_moves"] == [{
        "date": "2026-08-10", "name": "Bill from B",
        "from_account_id": savings_a.id, "from_account_name": "Savings A",
        "to_account_id": checking_b.id, "to_account_name": "Checking B",
        "amount": 200.0,
    }]
    closings = {a["account_name"]: a["closing_balance"] for a in body["by_account"]}
    assert closings == {"Savings A": 1000.0, "Checking B": -200.0}
    assert body["unassigned_closing"] == 0.0
    assert body["closing_balance"] == 800.0

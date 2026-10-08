"""Loans in the projection: a liability, never projection cash.

A loan's (negative) balance is not money on hand, so it is excluded from
available cash, the timeline opening and the per-account closings. A planned
payment into a loan from a bank still takes principal + interest out of cash
exactly once, and the timeline closing agrees with the month-end balance. Loan
payables on due dates are a later ticket and are not modelled here. Generic
fixtures on a throwaway user. Skips without a database.
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

REF = datetime(2026, 10, 1)


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
def user(db):
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.transaction import Transaction
    from app.models.user import User

    u = User(email=f"loanproj-{os.urandom(4).hex()}@example.com",
             password_hash=get_password_hash("password123"),
             first_name="Loan", last_name="Projection", is_verified=True)
    db.add(u)
    db.commit()
    db.refresh(u)

    yield u

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id == u.id).delete()
    db.query(Account).filter(Account.user_id == u.id).update({"payment_account_id": None})
    db.commit()
    db.query(Account).filter(Account.user_id == u.id).delete()
    db.query(User).filter(User.id == u.id).delete()
    db.commit()


def _account(db, user, name, account_type, balance, **kw):
    from app.models.account import Account

    a = Account(user_id=user.id, name=name, account_type=account_type,
                balance=Decimal(balance), **kw)
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def test_a_loan_is_a_liability_not_projection_cash(db, user):
    from types import SimpleNamespace

    from app.models.account import AccountType
    from app.models.transaction import Transaction, TransactionType
    from app.services.forecast import (
        get_account_balances, get_available_cash, is_projection_cash, is_spending_wallet,
        project_cashflow, project_running_balance,
    )

    loan_like = SimpleNamespace(account_type=AccountType.LOAN, is_spending_wallet=False)
    assert is_projection_cash(loan_like) is False
    assert is_spending_wallet(SimpleNamespace(account_type=AccountType.LOAN,
                                              is_spending_wallet=True)) is False

    bank = _account(db, user, "Bank", AccountType.SAVINGS, "50000")
    loan = _account(db, user, "Car loan", AccountType.LOAN, "-900000", loan_kind="auto",
                    loan_amortization="fixed", payment_account_id=bank.id)

    assert get_available_cash(get_account_balances(db, user.id)) == Decimal("50000")

    # A planned payment: 20,000 principal + 8,000 interest leaves the bank once.
    db.add(Transaction(user_id=user.id, account_id=bank.id, amount=Decimal("20000"),
                       transfer_fee=Decimal("8000"), transaction_type=TransactionType.TRANSFER,
                       transaction_date=datetime(2026, 10, 4), is_posted=False,
                       transfer_from_account_id=bank.id, transfer_to_account_id=loan.id,
                       loan_payment_kind="scheduled", description="Car loan #8"))
    db.commit()

    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert Decimal(str(timeline["opening_balance"])) == Decimal("50000")
    assert Decimal(str(timeline["closing_balance"])) == Decimal("22000")
    closings = {a["account_name"]: a["closing_balance"] for a in timeline["by_account"]}
    assert set(closings) == {"Bank"}
    assert Decimal(str(closings["Bank"])) == Decimal("22000")

    months = project_cashflow(db, user.id, months=1, reference=REF)
    assert months[0]["opening_balance"] == 50000
    assert months[0]["closing_balance"] == 22000
    assert [a["account_name"] for a in months[0]["by_account"]] == ["Bank"]

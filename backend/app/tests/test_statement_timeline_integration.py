"""Integration test for credit-card statement payables in the timeline.

Pins the behaviour change from Session 14: a charge on a credit card used to be
counted as an immediate cash outflow on its PURCHASE date. It isn't -- the cash
leaves when the statement is paid. The card now contributes one dated payable on
its due date instead, derived from the cycle's transactions.

Skips itself when no database is reachable.
"""
import os
from datetime import datetime

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
def scenario(db):
    """A checking account + a credit card charged mid-cycle, routed to checking.

    Dates are pinned relative to a fixed reference so the assertions don't drift
    with the real clock.
    """
    from decimal import Decimal

    from app.core.auth import get_password_hash
    from app.models.account import Account, AccountType
    from app.models.transaction import Transaction, TransactionType
    from app.models.user import User

    user = User(
        email=f"stmt-{os.urandom(4).hex()}@example.com",
        password_hash=get_password_hash("password123"),
        first_name="Stmt",
        last_name="Probe",
        is_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    checking = Account(
        user_id=user.id, name="Checking", account_type=AccountType.CHECKING,
        balance=Decimal("50000.00"),
    )
    card = Account(
        user_id=user.id, name="Probe CC", account_type=AccountType.CREDIT,
        balance=Decimal("0.00"), billing_cycle_start=24, days_until_due_date=21,
    )
    db.add_all([checking, card])
    db.commit()
    db.refresh(checking)
    db.refresh(card)

    card.payment_account_id = checking.id
    db.commit()

    # A charge on 10 Jul lands on the 24 Jul statement, due 14 Aug.
    #
    # is_posted=False is load-bearing: project_running_balance only reads UNPOSTED
    # transactions, so a posted charge would never have entered the cash timeline
    # anyway and the exclusion assertion below would pass vacuously. An unposted
    # charge is exactly the case the old code got wrong.
    db.add(Transaction(
        user_id=user.id, account_id=card.id, amount=Decimal("12000.00"),
        transaction_type=TransactionType.DEBIT, description="Card charge",
        transaction_date=datetime(2026, 7, 10), is_posted=False,
    ))
    db.commit()

    yield {"user": user, "checking": checking, "card": card}

    db.query(Transaction).filter(Transaction.user_id == user.id).delete()
    db.query(Account).filter(Account.user_id == user.id).update(
        {"payment_account_id": None, "payment_overflow_account_id": None}
    )
    db.commit()
    db.query(Account).filter(Account.user_id == user.id).delete()
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


def _timeline(db, scenario, reference):
    from app.services.forecast import project_running_balance

    return project_running_balance(
        db, user_id=scenario["user"].id, days=60, reference=reference,
    )


def test_statement_payable_lands_on_the_due_date_not_the_purchase_date(db, scenario):
    """The charge was 10 Jul; the cash must leave on 14 Aug."""
    result = _timeline(db, scenario, reference=datetime(2026, 8, 1))

    statements = [e for e in result["events"] if e["source"] == "statement"]
    assert len(statements) == 1, result["events"]
    assert statements[0]["date"] == datetime(2026, 8, 14).date()
    assert statements[0]["amount"] == pytest.approx(-12000.00)
    assert statements[0]["name"] == "Probe CC statement"


def test_card_charge_is_not_an_immediate_cash_outflow(db, scenario):
    """The regression: no event on the purchase date, and opening cash untouched."""
    result = _timeline(db, scenario, reference=datetime(2026, 7, 1))

    # The window covers the 10 Jul purchase date, but nothing leaves cash then.
    purchase_day_events = [e for e in result["events"] if e["date"] == datetime(2026, 7, 10).date()]
    assert purchase_day_events == []

    # Opening cash is the checking balance only -- the card never counted as cash.
    assert result["opening_balance"] == pytest.approx(50000.00)


def test_statement_payable_is_routed_to_its_payment_account(db, scenario):
    """A card whose payment account can't cover the statement reports a shortfall."""
    from decimal import Decimal

    scenario["checking"].balance = Decimal("5000.00")  # < the 12,000 statement
    db.commit()

    result = _timeline(db, scenario, reference=datetime(2026, 8, 1))

    shortfalls = [s for s in result["account_shortfalls"] if s["name"] == "Probe CC statement"]
    assert len(shortfalls) == 1
    assert shortfalls[0]["account_name"] == "Checking"
    assert shortfalls[0]["short_amount"] == pytest.approx(7000.00)  # 12,000 - 5,000


def test_statement_is_absent_once_the_due_date_passes(db, scenario):
    """A window starting after the due date must not re-bill an old statement."""
    result = _timeline(db, scenario, reference=datetime(2026, 8, 15))

    statements = [e for e in result["events"] if e["source"] == "statement"]
    assert all(e["date"] > datetime(2026, 8, 14).date() for e in statements)

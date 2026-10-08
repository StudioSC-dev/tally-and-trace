"""Loan payables in the projection (STU-199).

A loan due date not covered by a planned payment is a dated -payment leg on the
loan's paying account, with ``source`` "loan". It appears once in the timeline,
the monthly view, the upcoming/payables listings and the per-account closings.
Generic fixtures on a throwaway user. Skips without a database.
"""
import os
from datetime import date, datetime
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
END = datetime(2026, 12, 1)


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
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.models.user import User

    u = User(email=f"loanpay-{os.urandom(4).hex()}@example.com",
             password_hash=get_password_hash("password123"),
             first_name="Loan", last_name="Payables", is_verified=True)
    db.add(u)
    db.commit()
    db.refresh(u)

    yield u

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id == u.id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.user_id == u.id).delete()
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


def _bank(db, user, balance="50000", name="Bank"):
    from app.models.account import AccountType

    return _account(db, user, name, AccountType.CHECKING, balance)


def _loan(db, user, paying, **kw):
    from app.models.account import AccountType

    terms = dict(loan_kind="auto", loan_amortization="fixed", loan_annual_rate=Decimal("6"),
                 loan_term_months=12, loan_payment_amount=Decimal("8000"),
                 loan_first_payment_date=date(2026, 10, 4), loan_payments_made_offset=0,
                 payment_account_id=paying.id if paying else None)
    terms.update(kw)
    return _account(db, user, "Car loan", AccountType.LOAN, "-90000", **terms)


def _transfer(db, user, src, loan, amount, when, *, posted=False, kind="scheduled", fee="0"):
    from app.models.transaction import Transaction, TransactionType

    t = Transaction(user_id=user.id, account_id=src.id, amount=Decimal(amount),
                    transfer_fee=Decimal(fee), transaction_type=TransactionType.TRANSFER,
                    transaction_date=when, is_posted=posted,
                    transfer_from_account_id=src.id, transfer_to_account_id=loan.id,
                    loan_payment_kind=kind, description="Loan payment")
    db.add(t)
    db.commit()
    return t


def _loan_events(db, user, end=END):
    from app.services.forecast import collect_events

    return [e for e in collect_events(db, REF, end, user_id=user.id) if e["source"] == "loan"]


def _closings(timeline):
    return {a["account_name"]: a["closing_balance"] for a in timeline["by_account"]}


def test_loan_payment_on_the_4th_leaves_the_paying_account_exactly_once(db, user):
    from app.services.forecast import (
        get_payables, get_upcoming_items, project_cashflow, project_running_balance,
    )

    bank = _bank(db, user)
    loan = _loan(db, user, bank)

    events = _loan_events(db, user, datetime(2026, 11, 1))
    assert len(events) == 1
    ev = events[0]
    assert ev["source"] == "loan" and ev["source_id"] == loan.id
    assert ev["date"] == datetime(2026, 10, 4) and ev["type"] == "expense"
    assert ev["amount"] == Decimal("-8000.00") and ev["counts_as_cash"] is True
    assert [(leg["account_id"], leg["amount"], leg["cash"]) for leg in ev["legs"]] == [
        (bank.id, Decimal("-8000.00"), True)]

    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert timeline["closing_balance"] == Decimal("42000.00")
    assert [e["source"] for e in timeline["events"]] == ["loan"]
    assert _closings(timeline) == {"Bank": Decimal("42000.00")}

    months = project_cashflow(db, user.id, months=1, reference=REF)
    assert months[0]["net"] == -8000.0 and months[0]["closing_balance"] == 42000.0
    assert months[0]["closing_balance"] == float(timeline["closing_balance"])
    assert [a["closing_balance"] for a in months[0]["by_account"]] == [42000.0]

    upcoming = [i for i in get_upcoming_items(db, user.id, days=30, reference=REF)
                if i["source"] == "loan"]
    assert [(i["due_date"], i["amount"], i["source_id"]) for i in upcoming] == [
        ("2026-10-04", Decimal("8000.00"), loan.id)]

    payables = get_payables(db, user.id, days=30, reference=REF)
    assert [(p["source"], p["amount"], p["account_id"]) for p in payables] == [
        ("loan", 8000.0, bank.id)]


def test_timeline_closing_matches_monthly_end_balance_over_several_months(db, user):
    from app.services.forecast import project_cashflow, project_running_balance

    bank = _bank(db, user)
    _loan(db, user, bank)

    months = project_cashflow(db, user.id, months=3, reference=REF)
    timeline = project_running_balance(db, user.id, days=(datetime(2027, 1, 1) - REF).days,
                                       reference=REF)
    assert [m["net"] for m in months] == [-8000.0, -8000.0, -8000.0]
    assert months[-1]["closing_balance"] == float(timeline["closing_balance"]) == 26000.0


def test_shortfall_when_short_unless_a_recurring_transfer_funds_it(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency
    from app.services.forecast import project_running_balance

    secb = _account(db, user, "SecB", AccountType.SAVINGS, "20000.00")
    bdo = _account(db, user, "BDO", AccountType.CHECKING, "0.00")
    _loan(db, user, bdo)

    before = project_running_balance(db, user.id, days=30, reference=REF)
    assert [(s["account_name"], s["short_amount"]) for s in before["account_shortfalls"]] == [
        ("BDO", Decimal("8000.00"))]

    db.add(BudgetEntry(user_id=user.id, name="SecB to BDO", entry_type=BudgetEntryType.EXPENSE,
                       amount=Decimal("8000.00"), cadence=RecurrenceFrequency.MONTHLY,
                       next_occurrence=datetime(2026, 10, 1), account_id=secb.id,
                       transfer_to_account_id=bdo.id))
    db.commit()

    after = project_running_balance(db, user.id, days=30, reference=REF)
    assert after["account_shortfalls"] == []
    assert _closings(after) == {"SecB": Decimal("12000.00"), "BDO": Decimal("0.00")}
    assert after["closing_balance"] == Decimal("12000.00")


def test_unposted_scheduled_payment_replaces_that_dates_payable(db, user):
    from app.services.forecast import project_running_balance

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    # 5,500 principal + 2,500 interest = the full 8,000 payment.
    _transfer(db, user, bank, loan, "5500", datetime(2026, 10, 4), fee="2500")

    assert _loan_events(db, user, datetime(2026, 11, 1)) == []
    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert timeline["closing_balance"] == Decimal("42000.00")  # once, via the transfer
    assert [e["source"] for e in timeline["events"]] == ["transaction"]


def test_partial_planned_payment_suppresses_only_its_covered_amount(db, user):
    from app.services.forecast import project_running_balance

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _transfer(db, user, bank, loan, "3000", datetime(2026, 10, 4), fee="1000")

    events = _loan_events(db, user, datetime(2026, 11, 1))
    assert [e["amount"] for e in events] == [Decimal("-4000.00")]
    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert timeline["closing_balance"] == Decimal("42000.00")  # 4,000 + 4,000 out


def test_planned_payment_is_applied_to_the_oldest_due_date_first(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _transfer(db, user, bank, loan, "8000", datetime(2026, 10, 4))

    events = _loan_events(db, user, END)  # Oct 4 and Nov 4 are due
    assert [e["date"] for e in events] == [datetime(2026, 11, 4)]


def test_extra_principal_does_not_suppress_the_scheduled_payable(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home")
    _transfer(db, user, bank, loan, "20000", datetime(2026, 10, 4), kind="prepayment")

    events = _loan_events(db, user, datetime(2026, 11, 1))
    assert [e["amount"] for e in events] == [Decimal("-8000.00")]


def test_unposted_unmarked_transfer_into_the_loan_replaces_the_payable(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _transfer(db, user, bank, loan, "8000", datetime(2026, 10, 4), kind=None)

    assert _loan_events(db, user, datetime(2026, 11, 1)) == []


def test_recurring_transfer_into_the_loan_replaces_the_payable(db, user):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    db.add(BudgetEntry(user_id=user.id, name="Pay car loan", entry_type=BudgetEntryType.EXPENSE,
                       amount=Decimal("8000"), cadence=RecurrenceFrequency.MONTHLY,
                       next_occurrence=datetime(2026, 10, 4), account_id=bank.id,
                       transfer_to_account_id=loan.id))
    db.commit()

    assert _loan_events(db, user, END) == []


def test_posted_scheduled_payment_advances_the_due_date(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _transfer(db, user, bank, loan, "8000", datetime(2026, 9, 30), posted=True)

    events = _loan_events(db, user, END)
    assert [e["date"] for e in events] == [datetime(2026, 11, 4)]


def test_wallet_paying_account_gives_a_non_cash_funding_leg(db, user):
    from app.models.account import AccountType
    from app.services.forecast import project_running_balance

    _bank(db, user)
    wallet = _account(db, user, "GCash", AccountType.E_WALLET, "10000", is_spending_wallet=True)
    _loan(db, user, wallet)

    events = _loan_events(db, user, datetime(2026, 11, 1))
    assert len(events) == 1 and events[0]["counts_as_cash"] is False
    assert [(leg["account_id"], leg["cash"]) for leg in events[0]["legs"]] == [(wallet.id, False)]
    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert timeline["closing_balance"] == Decimal("50000.00")


def test_no_payable_after_the_last_payment(db, user):
    bank = _bank(db, user)
    _loan(db, user, bank, loan_term_months=2, loan_payments_made_offset=1)

    events = _loan_events(db, user, datetime(2027, 6, 1))
    assert [e["date"] for e in events] == [datetime(2026, 11, 4)]  # payment 2 of 2 only


def test_fixed_loan_with_every_payment_made_has_no_payable(db, user):
    bank = _bank(db, user)
    _loan(db, user, bank, loan_term_months=12, loan_payments_made_offset=12)

    assert _loan_events(db, user, END) == []


def test_reduce_term_loan_stops_when_the_balance_is_repaid(db, user):
    bank = _bank(db, user)
    # 90,000 owed at 8,000 a month, 0% interest: 12 payments, then nothing.
    _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home",
          loan_annual_rate=Decimal("0"), loan_term_months=None)

    events = _loan_events(db, user, datetime(2028, 6, 1))
    assert len(events) == 12
    assert events[0]["date"] == datetime(2026, 10, 4) and events[-1]["date"] == datetime(2027, 9, 4)


def test_loan_without_paying_account_or_payment_amount_has_no_payable(db, user):
    bank = _bank(db, user)
    _loan(db, user, None)
    _loan(db, user, bank, loan_payment_amount=None)

    assert _loan_events(db, user, END) == []


def test_overdue_loan_payment_is_emitted_on_the_window_start(db, user):
    bank = _bank(db, user)
    _loan(db, user, bank, loan_first_payment_date=date(2026, 9, 20))

    events = _loan_events(db, user, datetime(2026, 11, 1))
    assert events[0]["date"] == REF and events[0]["overdue"] is True
    assert events[0]["original_date"] == datetime(2026, 9, 20)


def test_loan_payables_follow_the_entity_scope(db, user):
    from app.models.account import Account, AccountType
    from app.models.entity import Entity, EntityType
    from app.services.forecast import collect_events

    entity = Entity(name=f"Biz {os.urandom(3).hex()}", entity_type=EntityType.BUSINESS)
    db.add(entity)
    db.commit()
    try:
        biz_bank = _account(db, user, "Biz bank", AccountType.CHECKING, "50000",
                            entity_id=entity.id)
        biz_loan = _loan(db, user, biz_bank, entity_id=entity.id)
        personal_loan = _loan(db, user, _bank(db, user))

        def loans(**kw):
            return {e["source_id"] for e in collect_events(
                db, REF, datetime(2026, 11, 1), user_id=user.id, **kw) if e["source"] == "loan"}

        assert loans(entity_id=entity.id) == {biz_loan.id}
        assert loans() == {biz_loan.id, personal_loan.id}
    finally:
        db.query(Account).filter(Account.entity_id == entity.id).update(
            {"payment_account_id": None})
        db.query(Account).filter(Account.entity_id == entity.id).delete()
        db.query(Entity).filter(Entity.id == entity.id).delete()
        db.commit()

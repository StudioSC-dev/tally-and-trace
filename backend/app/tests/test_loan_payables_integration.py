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


def _payables(db, user, days=30):
    from app.services.forecast import get_payables

    return [(p["due_date"], p["source"], p["amount"], p["account_id"])
            for p in get_payables(db, user.id, days=days, reference=REF)]


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
    assert _payables(db, user) == [("2026-10-04", "transaction", 8000.0, bank.id)]


def test_partial_planned_payment_suppresses_only_its_covered_amount(db, user):
    from app.services.forecast import project_running_balance

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _transfer(db, user, bank, loan, "3000", datetime(2026, 10, 4), fee="1000")

    events = _loan_events(db, user, datetime(2026, 11, 1))
    assert [e["amount"] for e in events] == [Decimal("-4000.00")]
    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert timeline["closing_balance"] == Decimal("42000.00")  # 4,000 + 4,000 out
    assert _payables(db, user) == [("2026-10-04", "transaction", 4000.0, bank.id),
                                   ("2026-10-04", "loan", 4000.0, bank.id)]


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
    assert _payables(db, user) == [("2026-10-04", "transaction", 8000.0, bank.id)]


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
    assert _payables(db, user, days=61) == [("2026-10-04", "budget_entry", 8000.0, bank.id),
                                            ("2026-11-04", "budget_entry", 8000.0, bank.id)]


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


# --- round-1 audit fixes -------------------------------------------------------

def _post(db, user, src, dst, amount, when, *, fee="0", posted=True):
    """A transfer through the generic POST /transactions path."""
    from app.routers.transactions import create_transaction
    from app.schemas.transaction import TransactionCreate

    return create_transaction(
        transaction=TransactionCreate(
            account_id=src.id, transfer_from_account_id=src.id, transfer_to_account_id=dst.id,
            transaction_type="transfer", amount=float(amount), transfer_fee=float(fee),
            transaction_date=when, is_posted=posted, currency=dst.currency),
        db=db, current_user=user, active_entity=None)


def _schedule(db, loan):
    from app.services.loans import build_schedule

    db.refresh(loan)
    return build_schedule(db, loan)


def _recurring(db, user, src, dst, amount, first, **kw):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    entry = BudgetEntry(user_id=user.id, name="Pay car loan", entry_type=BudgetEntryType.EXPENSE,
                        amount=Decimal(amount), cadence=RecurrenceFrequency.MONTHLY,
                        next_occurrence=first, account_id=src.id,
                        transfer_to_account_id=dst.id, **kw)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def _cash_out(db, user, days):
    """Every negative cash movement in the window, as (day, source, amount)."""
    from datetime import timedelta
    from app.services.forecast import collect_events

    end = REF + timedelta(days=days + 1)
    return sorted((e["date"].date().isoformat(), e["source"], e["amount"])
                  for e in collect_events(db, REF, end, user_id=user.id)
                  if e["counts_as_cash"] and e["amount"] < 0)


def test_materialised_recurring_loan_transfer_counts_once_and_advances_the_schedule(db, user):
    from app.routers.budget_entries import materialize_budget_entry
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services.forecast import (
        get_payables, get_upcoming_items, project_cashflow, project_running_balance,
    )

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    entry = _recurring(db, user, bank, loan, "8000", datetime(2026, 10, 4))

    txn = materialize_budget_entry(entry.id, BudgetEntryMaterialize(), db=db, current_user=user)
    assert txn.loan_payment_kind == "scheduled" and txn.is_posted

    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (1, "2026-11-04")

    # Oct 4 was paid by the materialised transfer; Nov 4 by the next occurrence.
    assert _loan_events(db, user, END) == []
    timeline = project_running_balance(db, user.id, days=61, reference=REF)
    assert timeline["closing_balance"] == Decimal("34000.00")  # 50,000 - 8,000 - 8,000
    assert [(e["date"].isoformat(), e["amount"]) for e in timeline["events"]] == [
        ("2026-11-04", Decimal("-8000.00"))]
    months = project_cashflow(db, user.id, months=2, reference=REF)
    assert [m["net"] for m in months] == [0.0, -8000.0]
    assert months[-1]["closing_balance"] == float(timeline["closing_balance"])
    upcoming = get_upcoming_items(db, user.id, days=61, reference=REF)
    assert [(i["due_date"], i["source"]) for i in upcoming] == [("2026-11-04", "budget_entry")]
    payables = get_payables(db, user.id, days=61, reference=REF)
    assert [(p["due_date"], p["source"], p["amount"]) for p in payables] == [
        ("2026-11-04", "budget_entry", 8000.0)]


def test_generic_transfer_into_a_loan_is_a_scheduled_payment(db, user):
    from app.services.forecast import get_payables, project_running_balance

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    txn = _post(db, user, bank, loan, "5500", datetime(2026, 10, 4), fee="2500")
    assert txn.loan_payment_kind == "scheduled"

    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (1, "2026-11-04")
    assert [e["date"] for e in _loan_events(db, user, END)] == [datetime(2026, 11, 4)]
    timeline = project_running_balance(db, user.id, days=61, reference=REF)
    assert timeline["closing_balance"] == Decimal("34000.00")
    assert [(p["due_date"], p["source"]) for p in get_payables(db, user.id, days=61,
                                                                 reference=REF)] == [
        ("2026-11-04", "loan")]


def test_generic_transfer_into_a_loan_keeps_the_loan_endpoint_rules(db, user):
    from fastapi import HTTPException
    from app.models.account import AccountType
    from app.models.transaction import Transaction
    from app.models.user import CurrencyType
    from app.routers.transactions import update_transaction
    from app.schemas.transaction import TransactionUpdate

    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    other_loan = _loan(db, user, bank)
    usd = _account(db, user, "USD", AccountType.SAVINGS, "1000", currency=CurrencyType.USD)

    # A card or a wallet may fund it (see the tests below); a loan may not.
    for src, amount in ((other_loan, "100"), (usd, "100"), (bank, "90000.01")):
        with pytest.raises(HTTPException) as exc:
            _post(db, user, src, loan, amount, datetime(2026, 10, 4))
        assert exc.value.status_code == 400, (src.name, exc.value.detail)
        db.rollback()
    assert db.query(Transaction).filter(Transaction.user_id == user.id).count() == 0
    db.refresh(loan)
    assert Decimal(str(loan.balance)) == Decimal("-90000.00")

    # A pending payment above what is owed is allowed until it is posted, as on
    # the loan endpoint; once created it follows the loan-payment edit rules.
    txn = _post(db, user, bank, loan, "100", datetime(2026, 10, 4), posted=False)
    with pytest.raises(HTTPException) as exc:
        update_transaction(txn.id, TransactionUpdate(transfer_to_account_id=bank.id),
                           db=db, current_user=user)
    assert exc.value.status_code == 400


def test_planned_prepayment_is_a_payable_and_does_not_cover_the_due_date(db, user):
    from app.services.forecast import get_payables

    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home")
    _transfer(db, user, bank, loan, "20000", datetime(2026, 10, 10), kind="prepayment")

    payables = get_payables(db, user.id, days=30, reference=REF)
    assert [(p["due_date"], p["source"], p["amount"]) for p in payables] == [
        ("2026-10-04", "loan", 8000.0), ("2026-10-10", "transaction", 20000.0)]


def test_reduce_term_payables_use_each_amortisation_payment(db, user):
    bank = _bank(db, user)
    _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home",
          loan_annual_rate=Decimal("0"), loan_term_months=None)

    events = _loan_events(db, user, datetime(2028, 6, 1))
    amounts = [-e["amount"] for e in events]
    assert amounts == [Decimal("8000.00")] * 11 + [Decimal("2000.00")]
    assert sum(amounts) == Decimal("90000.00")


def test_a_planned_payment_covers_the_oldest_open_due_date_whatever_the_window(db, user):
    from app.services.forecast import project_cashflow, project_running_balance

    bank = _bank(db, user, balance="10000")
    loan = _loan(db, user, bank)
    # One planned payment, dated Nov 4: it pays the oldest open due date, Oct 4,
    # in every window, and Nov 4 stays due.
    _transfer(db, user, bank, loan, "8000", datetime(2026, 11, 4))

    short, long_ = _cash_out(db, user, 30), _cash_out(db, user, 60)
    assert short == []
    assert [m for m in long_ if m[0] <= "2026-10-31"] == short
    assert long_ == [("2026-11-04", "loan", Decimal("-8000.00")),
                     ("2026-11-04", "transaction", Decimal("-8000.00"))]

    one, two, three = (project_cashflow(db, user.id, months=n, reference=REF) for n in (1, 2, 3))
    assert one[0] == two[0] == three[0]
    assert two[1] == three[1]
    t30 = project_running_balance(db, user.id, days=30, reference=REF)
    t60 = project_running_balance(db, user.id, days=60, reference=REF)
    assert t30["shortfalls"] == [s for s in t60["shortfalls"] if s["date"] <= date(2026, 10, 31)]
    assert [s["date"] for s in t60["shortfalls"]] == [date(2026, 11, 4)]


def test_early_recurring_payments_cover_their_own_due_dates(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _recurring(db, user, bank, loan, "8000", datetime(2026, 10, 1))  # 3 days early each month

    for days in (2, 30, 36, 45, 60):
        assert [m for m in _cash_out(db, user, days) if m[1] == "loan"] == [], days
    assert _loan_events(db, user, datetime(2027, 1, 1)) == []


def test_a_late_recurring_cover_after_the_window_still_covers_its_due_date(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _recurring(db, user, bank, loan, "8000", datetime(2026, 10, 6))

    for days in (3, 30, 60):
        assert [m for m in _cash_out(db, user, days) if m[1] == "loan"] == [], days


def test_planned_payment_excess_fills_the_next_due_date(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _transfer(db, user, bank, loan, "12000", datetime(2026, 11, 4))  # Oct 4 + 4,000 of Nov 4

    events = _loan_events(db, user, datetime(2027, 1, 1))
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 11, 4), Decimal("-4000.00")),
        (datetime(2026, 12, 4), Decimal("-8000.00"))]


def test_recurring_cover_excess_spills_forward_never_backward(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_first_payment_date=date(2026, 9, 4))
    _recurring(db, user, bank, loan, "12000", datetime(2026, 11, 4), max_occurrences=1,
               end_mode="after_occurrences")

    events = _loan_events(db, user, datetime(2027, 1, 1))
    assert [(e["date"], e.get("overdue"), e["amount"]) for e in events] == [
        (REF, True, Decimal("-8000.00")),                 # Sep 4: never reached back to
        (datetime(2026, 10, 4), None, Decimal("-8000.00")),
        (datetime(2026, 12, 4), None, Decimal("-4000.00"))]


def test_posted_partial_payment_leaves_its_remainder_projected(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank)
    _post(db, user, bank, loan, "3550", datetime(2026, 10, 4), fee="450")

    s = _schedule(db, loan)
    assert (s["payments_made"], s["payments_left"], str(s["next_due_date"])) == (
        0, 12, "2026-10-04")
    assert s["upcoming"][0]["payment"] == 4000.0
    events = _loan_events(db, user, END)
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 10, 4), Decimal("-4000.00")),
        (datetime(2026, 11, 4), Decimal("-8000.00"))]

    _post(db, user, bank, loan, "3600", datetime(2026, 10, 5), fee="400")
    s = _schedule(db, loan)
    assert (s["payments_made"], s["payments_left"], str(s["next_due_date"])) == (
        1, 11, "2026-11-04")
    assert [e["date"] for e in _loan_events(db, user, END)] == [datetime(2026, 11, 4)]


def test_posted_partial_payment_before_the_window_leaves_an_overdue_remainder(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_first_payment_date=date(2026, 9, 4))
    _post(db, user, bank, loan, "5000", datetime(2026, 9, 4))

    events = _loan_events(db, user, datetime(2026, 10, 10))
    assert [(e["date"], e.get("overdue"), e["amount"]) for e in events] == [
        (REF, True, Decimal("-3000.00")), (datetime(2026, 10, 4), None, Decimal("-8000.00"))]


def test_a_planned_payment_from_another_entity_covers_the_loan(db, user):
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
        personal = _bank(db, user, name="Personal")
        _transfer(db, user, personal, biz_loan, "8000", datetime(2026, 10, 4))  # stored personal
        _recurring(db, user, personal, biz_loan, "8000", datetime(2026, 11, 4))

        events = collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id,
                                entity_id=entity.id)
        assert [e for e in events if e["source"] == "loan"] == []
        # The paying legs belong to the personal scope, not this one.
        assert all(leg["account_id"] != personal.id for e in events for leg in e["legs"])
    finally:
        from app.models.budget_entry import BudgetEntry
        from app.models.transaction import Transaction

        db.query(Transaction).filter(Transaction.user_id == user.id).delete()
        db.query(BudgetEntry).filter(BudgetEntry.user_id == user.id).delete()
        db.query(Account).filter(Account.entity_id == entity.id).update(
            {"payment_account_id": None})
        db.query(Account).filter(Account.entity_id == entity.id).delete()
        db.query(Entity).filter(Entity.id == entity.id).delete()
        db.commit()


def test_reduce_term_part_payment_leaves_only_the_rest_of_that_payment(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home",
                 loan_annual_rate=Decimal("0"), loan_term_months=None)
    _post(db, user, bank, loan, "4000", datetime(2026, 10, 4))

    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (0, "2026-10-04")
    amounts = [-e["amount"] for e in _loan_events(db, user, datetime(2028, 6, 1))]
    assert amounts == [Decimal("4000.00")] + [Decimal("8000.00")] * 10 + [Decimal("2000.00")]
    assert sum(amounts) == Decimal("86000.00")  # what is still owed, at 0%
    assert s["payments_left"] == len(s["upcoming"]) == 12


def test_reduce_term_loan_that_never_repays_falls_back_to_its_term_everywhere(db, user):
    bank = _bank(db, user)
    # 6% on 90,000 is 450 a month: a 400 payment never repays it.
    loan = _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home",
                 loan_payment_amount=Decimal("400"), loan_term_months=12)

    s = _schedule(db, loan)
    assert s["payments_left"] == len(s["upcoming"]) == 12
    events = _loan_events(db, user, datetime(2028, 6, 1))
    assert [e["loan_due_date"] for e in events] == [r["due_date"] for r in s["upcoming"]]


def test_a_loan_without_a_first_payment_date_counts_payments_left_from_its_term(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_first_payment_date=None, loan_payments_made_offset=2)

    s = _schedule(db, loan)
    assert (s["payments_made"], s["payments_left"], s["upcoming"]) == (2, 10, [])
    assert _loan_events(db, user, END) == []


# --- round-2 audit fixes -------------------------------------------------------

def _put(db, user, txn, **changes):
    """An edit through the generic PUT /transactions path."""
    from app.routers.transactions import update_transaction
    from app.schemas.transaction import TransactionUpdate

    return update_transaction(txn.id, TransactionUpdate(**changes), db=db, current_user=user)


def _assert_paid_once_then_november(db, user, loan, bank):
    """Oct 4 is settled by the posted payment; only Nov 4 is still projected."""
    from app.services.forecast import get_payables, project_cashflow, project_running_balance

    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (1, "2026-11-04")
    assert [e["date"] for e in _loan_events(db, user, END)] == [datetime(2026, 11, 4)]
    timeline = project_running_balance(db, user.id, days=61, reference=REF)
    assert timeline["closing_balance"] == Decimal("34000.00")  # 42,000 - Nov 4
    assert [(e["date"].isoformat(), e["source"]) for e in timeline["events"]] == [
        ("2026-11-04", "loan")]
    months = project_cashflow(db, user.id, months=2, reference=REF)
    assert [m["net"] for m in months] == [0.0, -8000.0]
    assert months[-1]["closing_balance"] == float(timeline["closing_balance"])
    assert [(p["due_date"], p["source"], p["account_id"])
            for p in get_payables(db, user.id, days=61, reference=REF)] == [
        ("2026-11-04", "loan", bank.id)]


def test_an_unposted_transfer_retargeted_into_a_loan_settles_its_due_date_once_posted(db, user):
    from app.models.account import AccountType

    bank = _bank(db, user)
    savings = _account(db, user, "Savings", AccountType.SAVINGS, "0")
    loan = _loan(db, user, bank)
    txn = _post(db, user, bank, savings, "8000", datetime(2026, 10, 4), posted=False)
    assert txn.loan_payment_kind is None

    txn = _put(db, user, txn, transfer_to_account_id=loan.id, amount=7550, transfer_fee=450)
    assert txn.loan_payment_kind == "scheduled"
    txn = _put(db, user, txn, is_posted=True)
    assert txn.loan_payment_kind == "scheduled" and txn.is_posted
    db.refresh(bank)
    db.refresh(loan)
    assert (Decimal(str(bank.balance)), Decimal(str(loan.balance))) == (
        Decimal("42000.00"), Decimal("-82450.00"))
    _assert_paid_once_then_november(db, user, loan, bank)


def test_a_posted_transfer_retargeted_into_a_loan_settles_its_due_date(db, user):
    from app.models.account import AccountType

    bank = _bank(db, user)
    savings = _account(db, user, "Savings", AccountType.SAVINGS, "0")
    loan = _loan(db, user, bank)
    txn = _post(db, user, bank, savings, "8000", datetime(2026, 10, 4))

    txn = _put(db, user, txn, transfer_to_account_id=loan.id, amount=7550, transfer_fee=450)
    assert txn.loan_payment_kind == "scheduled" and txn.is_posted
    db.refresh(savings)
    db.refresh(loan)
    assert (Decimal(str(savings.balance)), Decimal(str(loan.balance))) == (
        Decimal("0.00"), Decimal("-82450.00"))
    _assert_paid_once_then_november(db, user, loan, bank)


def test_a_transfer_retargeted_into_a_loan_is_validated_before_any_change(db, user):
    from fastapi import HTTPException
    from app.models.account import AccountType

    bank = _bank(db, user, balance="200000")
    savings = _account(db, user, "Savings", AccountType.SAVINGS, "0")
    loan = _loan(db, user, bank)
    txn = _post(db, user, bank, savings, "95000", datetime(2026, 10, 4))

    with pytest.raises(HTTPException) as exc:
        _put(db, user, txn, transfer_to_account_id=loan.id)
    assert exc.value.status_code == 400 and "owed" in exc.value.detail
    db.rollback()
    for account, balance in ((bank, "105000.00"), (savings, "95000.00"), (loan, "-90000.00")):
        db.refresh(account)
        assert Decimal(str(account.balance)) == Decimal(balance), account.name
    db.refresh(txn)
    assert (txn.transfer_to_account_id, txn.loan_payment_kind) == (savings.id, None)


def _entry(db, user, src, dst, amount, first, **kw):
    """A recurring transfer entry through the POST /budget-entries path."""
    from app.routers.budget_entries import create_budget_entry
    from app.schemas.budget_entry import BudgetEntryCreate

    return create_budget_entry(
        BudgetEntryCreate(name="Pay car loan", entry_type="expense", amount=float(amount),
                          next_occurrence=first, account_id=src.id,
                          transfer_to_account_id=dst.id, **kw),
        db=db, current_user=user, active_entity=None)


def test_a_wallet_funded_recurring_loan_payment_covers_and_settles_its_due_date(db, user):
    from app.models.account import AccountType
    from app.routers.budget_entries import materialize_budget_entry
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services.forecast import collect_events, get_payables, project_running_balance

    bank = _bank(db, user)
    wallet = _account(db, user, "GCash", AccountType.E_WALLET, "10000", is_spending_wallet=True)
    loan = _loan(db, user, bank)
    entry = _entry(db, user, wallet, loan, "8000", datetime(2026, 10, 4))

    # The occurrence covers Oct 4; its wallet leg moves no projection cash.
    assert _loan_events(db, user, datetime(2026, 11, 1)) == []
    occ = [e for e in collect_events(db, REF, datetime(2026, 11, 1), user_id=user.id)
           if e["source"] == "budget_entry"]
    assert len(occ) == 1 and occ[0]["counts_as_cash"] is False
    assert [(leg["account_id"], leg["cash"]) for leg in occ[0]["legs"]] == [(wallet.id, False)]
    timeline = project_running_balance(db, user.id, days=30, reference=REF)
    assert timeline["closing_balance"] == Decimal("50000.00") and timeline["events"] == []
    assert get_payables(db, user.id, days=30, reference=REF) == []

    txn = materialize_budget_entry(entry.id, BudgetEntryMaterialize(), db=db, current_user=user)
    assert (txn.loan_payment_kind, txn.is_posted, txn.transfer_from_account_id) == (
        "scheduled", True, wallet.id)
    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (1, "2026-11-04")
    db.refresh(wallet)
    assert Decimal(str(wallet.balance)) == Decimal("2000.00")
    assert _loan_events(db, user, END) == []  # Nov 4: the next occurrence covers it


def test_a_card_funded_transfer_into_a_loan_settles_its_due_date_once(db, user):
    from app.models.account import AccountType
    from app.services.forecast import get_payables, project_running_balance

    bank = _bank(db, user)
    card = _account(db, user, "Card", AccountType.CREDIT, "0", billing_cycle_start=15,
                    days_until_due_date=20, payment_account_id=bank.id)
    loan = _loan(db, user, bank)
    txn = _post(db, user, card, loan, "7550", datetime(2026, 10, 4), fee="450")
    assert txn.loan_payment_kind == "scheduled"

    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (1, "2026-11-04")
    # The card's Oct 15 statement bills the 8,000 (due Nov 4); the loan's Oct 4
    # due date is not charged again, only Nov 4.
    timeline = project_running_balance(db, user.id, days=61, reference=REF)
    assert sorted((e["date"].isoformat(), e["source"], e["amount"])
                  for e in timeline["events"]) == [
        ("2026-11-04", "loan", Decimal("-8000.00")),
        ("2026-11-04", "statement", Decimal("-8000.00"))]
    assert timeline["closing_balance"] == Decimal("34000.00")
    assert sorted((p["due_date"], p["source"], p["amount"])
                  for p in get_payables(db, user.id, days=61, reference=REF)) == [
        ("2026-11-04", "loan", 8000.0), ("2026-11-04", "statement", 8000.0)]


def test_a_planned_card_funded_transfer_covers_the_loan_due_date(db, user):
    from app.models.account import AccountType

    bank = _bank(db, user)
    card = _account(db, user, "Card", AccountType.CREDIT, "0", billing_cycle_start=15,
                    days_until_due_date=20, payment_account_id=bank.id)
    loan = _loan(db, user, bank)
    _post(db, user, card, loan, "7550", datetime(2026, 10, 4), fee="450", posted=False)

    assert _loan_events(db, user, datetime(2026, 11, 1)) == []
    assert [m for m in _cash_out(db, user, 30)] == []  # billed on the card, paid Nov 4


def test_a_recurring_loan_payment_in_another_currency_is_rejected_at_save(db, user):
    from fastapi import HTTPException
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntry
    from app.models.user import CurrencyType
    from app.routers.budget_entries import update_budget_entry
    from app.schemas.budget_entry import BudgetEntryUpdate

    bank = _bank(db, user)
    usd = _account(db, user, "USD", AccountType.SAVINGS, "1000", currency=CurrencyType.USD)
    loan = _loan(db, user, bank)

    for src, kw in ((usd, {"currency": "USD"}), (usd, {}), (bank, {"currency": "USD"})):
        with pytest.raises(HTTPException) as exc:
            _entry(db, user, src, loan, "8000", datetime(2026, 10, 4), **kw)
        assert exc.value.status_code == 400 and "currency" in exc.value.detail, (src.name, kw)
        db.rollback()
    assert db.query(BudgetEntry).filter(BudgetEntry.user_id == user.id).count() == 0

    entry = _entry(db, user, bank, loan, "8000", datetime(2026, 10, 4))
    for change in ({"currency": "USD"}, {"account_id": usd.id}):
        with pytest.raises(HTTPException) as exc:
            update_budget_entry(entry.id, BudgetEntryUpdate(**change), db=db, current_user=user)
        assert exc.value.status_code == 400 and "currency" in exc.value.detail, change
        db.rollback()


def _balances(db, *accounts):
    for a in accounts:
        db.refresh(a)
    return tuple(Decimal(str(a.balance)) for a in accounts)


def test_a_materialised_loan_payment_without_a_fee_is_split_into_principal_and_interest(db, user):
    from app.routers.budget_entries import materialize_budget_entry
    from app.schemas.budget_entry import BudgetEntryMaterialize

    bank = _bank(db, user)
    loan = _loan(db, user, bank)  # 6% on 90,000: 450 interest this month
    entry = _entry(db, user, bank, loan, "8000", datetime(2026, 10, 4))

    txn = materialize_budget_entry(entry.id, BudgetEntryMaterialize(), db=db, current_user=user)
    assert (Decimal(str(txn.amount)), Decimal(str(txn.transfer_fee))) == (
        Decimal("7550.00"), Decimal("450.00"))
    assert _balances(db, bank, loan) == (Decimal("42000.00"), Decimal("-82450.00"))
    s = _schedule(db, loan)
    assert (s["payments_made"], s["owed"]) == (1, 82450.0)

    # A fee given with it is the caller's split, kept as is.
    txn = materialize_budget_entry(entry.id, BudgetEntryMaterialize(transfer_fee=100),
                                   db=db, current_user=user)
    assert (Decimal(str(txn.amount)), Decimal(str(txn.transfer_fee))) == (
        Decimal("8000.00"), Decimal("100.00"))


def test_a_generic_loan_payment_without_a_fee_is_split_and_an_explicit_fee_is_kept(db, user):
    from app.models.account import AccountType
    from app.routers.transactions import create_transaction
    from app.schemas.transaction import TransactionCreate

    bank = _bank(db, user)
    savings = _account(db, user, "Savings", AccountType.SAVINGS, "0")
    loan = _loan(db, user, bank)

    txn = create_transaction(
        transaction=TransactionCreate(
            account_id=bank.id, transfer_from_account_id=bank.id, transfer_to_account_id=loan.id,
            transaction_type="transfer", amount=8000, transaction_date=datetime(2026, 10, 4)),
        db=db, current_user=user, active_entity=None)
    assert (Decimal(str(txn.amount)), Decimal(str(txn.transfer_fee))) == (
        Decimal("7550.00"), Decimal("450.00"))
    assert _balances(db, bank, loan) == (Decimal("42000.00"), Decimal("-82450.00"))

    txn = _post(db, user, bank, loan, "8000", datetime(2026, 11, 4), fee="0")
    assert (Decimal(str(txn.amount)), Decimal(str(txn.transfer_fee))) == (
        Decimal("8000.00"), Decimal("0.00"))

    # An edit that lands a fee-less transfer in the loan is split the same way.
    moved = _post(db, user, bank, savings, "8000", datetime(2026, 12, 4), posted=False)
    moved = _put(db, user, moved, transfer_to_account_id=loan.id)
    db.refresh(loan)
    interest = (-Decimal(str(loan.balance)) * Decimal("0.005")).quantize(Decimal("0.01"))
    assert (Decimal(str(moved.amount)), Decimal(str(moved.transfer_fee))) == (
        Decimal("8000.00") - interest, interest)


def test_a_late_payment_settles_the_oldest_open_due_date_first(db, user):
    from app.services.forecast import collect_events

    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_first_payment_date=date(2026, 9, 4))
    _post(db, user, bank, loan, "7550", datetime(2026, 10, 10), fee="450")  # September's, late
    _post(db, user, bank, loan, "7550", datetime(2026, 10, 4), fee="450")   # October's, on time

    s = _schedule(db, loan)
    assert (s["payments_made"], str(s["next_due_date"])) == (2, "2026-11-04")
    events = [e for e in collect_events(db, datetime(2026, 10, 15), datetime(2026, 12, 1),
                                        user_id=user.id) if e["source"] == "loan"]
    assert [(e["date"], e.get("overdue")) for e in events] == [(datetime(2026, 11, 4), None)]


def test_a_planned_catch_up_covers_the_overdue_due_date_in_any_window(db, user):
    bank = _bank(db, user)
    loan = _loan(db, user, bank, loan_first_payment_date=date(2026, 9, 4))
    # Dated nearest Nov 4, but Sep 4 is the oldest open due date: it pays that.
    _transfer(db, user, bank, loan, "8000", datetime(2026, 10, 20))

    short = _loan_events(db, user, datetime(2026, 10, 31))
    long_ = _loan_events(db, user, datetime(2026, 11, 30))
    assert [(e["date"], e.get("overdue")) for e in short] == [(datetime(2026, 10, 4), None)]
    assert [(e["date"], e.get("overdue")) for e in long_] == [
        (datetime(2026, 10, 4), None), (datetime(2026, 11, 4), None)]
    assert _cash_out(db, user, 30) == [("2026-10-04", "loan", Decimal("-8000.00")),
                                       ("2026-10-20", "transaction", Decimal("-8000.00"))]


def test_a_reduce_term_part_payment_and_a_planned_cover_leave_cash_once(db, user):
    from app.services.forecast import collect_events

    bank = _bank(db, user)
    # 90,000 at 0%, 8,000 a month: Oct 4 unpaid, 4,000 posted on Nov 4 and 4,000 planned.
    loan = _loan(db, user, bank, loan_amortization="reduce_term", loan_kind="home",
                 loan_annual_rate=Decimal("0"), loan_term_months=None)
    _post(db, user, bank, loan, "4000", datetime(2026, 11, 4))
    _transfer(db, user, bank, loan, "4000", datetime(2026, 11, 20))

    s = _schedule(db, loan)
    assert [r["payment"] for r in s["upcoming"][:3]] == [4000.0, 8000.0, 8000.0]
    assert sum(r["payment"] for r in s["upcoming"]) == s["owed"] == 86000.0

    start = datetime(2026, 11, 5)
    out = sorted((e["date"].date().isoformat(), e["source"], e["amount"])
                 for e in collect_events(db, start, datetime(2026, 12, 1), user_id=user.id)
                 if e["counts_as_cash"] and e["amount"] < 0)
    # 16,000 owed for Oct 4 and Nov 4, 4,000 of it already paid: 12,000 leaves.
    assert out == [("2026-11-05", "loan", Decimal("-8000.00")),
                   ("2026-11-20", "transaction", Decimal("-4000.00"))]


def test_a_loan_paid_from_another_entitys_account_leaves_cash_only_in_that_entity(db, user):
    from app.models.account import Account, AccountType
    from app.models.entity import Entity, EntityType
    from app.services.forecast import (
        collect_events, get_payables, project_cashflow, project_running_balance,
    )

    owner, payer = (Entity(name=f"Biz {os.urandom(3).hex()}", entity_type=EntityType.BUSINESS)
                    for _ in range(2))
    db.add_all([owner, payer])
    db.commit()
    try:
        _account(db, user, "Owner bank", AccountType.CHECKING, "1000", entity_id=owner.id)
        payer_bank = _account(db, user, "Payer bank", AccountType.CHECKING, "50000",
                              entity_id=payer.id)
        loan = _loan(db, user, payer_bank, entity_id=owner.id)

        # The loan's own entity lists the due date but pays nothing from it.
        timeline = project_running_balance(db, user.id, owner.id, days=30, reference=REF)
        assert timeline["events"] == []
        assert timeline["closing_balance"] == Decimal("1000.00")
        assert timeline["unassigned_closing"] == Decimal("0")
        assert _closings(timeline) == {"Owner bank": Decimal("1000.00")}
        month = project_cashflow(db, user.id, owner.id, months=1, reference=REF)[0]
        assert (month["net"], month["closing_balance"], month["unassigned_closing"]) == (
            0.0, 1000.0, 0.0)
        assert get_payables(db, user.id, owner.id, days=30, reference=REF) == []
        listed = [e for e in collect_events(db, REF, datetime(2026, 11, 1), user_id=user.id,
                                            entity_id=owner.id) if e["source"] == "loan"]
        assert [(e["source_id"], e["counts_as_cash"], e["legs"]) for e in listed] == [
            (loan.id, False, [])]

        # The paying account's entity pays it, once.
        timeline = project_running_balance(db, user.id, payer.id, days=30, reference=REF)
        assert [(e["source"], e["amount"]) for e in timeline["events"]] == [
            ("loan", Decimal("-8000.00"))]
        assert timeline["closing_balance"] == Decimal("42000.00")
        assert timeline["unassigned_closing"] == Decimal("0")
        assert _closings(timeline) == {"Payer bank": Decimal("42000.00")}
        month = project_cashflow(db, user.id, payer.id, months=1, reference=REF)[0]
        assert (month["net"], month["closing_balance"], month["unassigned_closing"]) == (
            -8000.0, 42000.0, 0.0)
        assert [(p["source"], p["amount"], p["account_id"]) for p in get_payables(
            db, user.id, payer.id, days=30, reference=REF)] == [("loan", 8000.0, payer_bank.id)]

        # Unscoped, both accounts are in view: still once.
        timeline = project_running_balance(db, user.id, days=30, reference=REF)
        assert timeline["closing_balance"] == Decimal("43000.00")
        assert [e["source"] for e in timeline["events"]] == ["loan"]
    finally:
        db.query(Account).filter(Account.user_id == user.id).update({"payment_account_id": None})
        db.query(Account).filter(Account.entity_id.in_([owner.id, payer.id])).delete()
        db.query(Entity).filter(Entity.id.in_([owner.id, payer.id])).delete()
        db.commit()

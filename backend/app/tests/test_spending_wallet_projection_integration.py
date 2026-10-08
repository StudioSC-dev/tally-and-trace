"""Projection rules for spending wallets and recurring transfer budget entries.

One test per rule: wallets are not projection cash; a cash-to-wallet transfer
costs the source amount + fee and a wallet-to-cash transfer adds the amount;
a wallet's own transactions and wallet-funded budget entries are skipped; a
recurring transfer entry moves money between accounts with a leg on each, so it
can fund a payable on its destination before the payable is due. Generic
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

REF = datetime(2026, 11, 1)


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

    u = User(email=f"wallet-{os.urandom(4).hex()}@example.com",
             password_hash=get_password_hash("password123"),
             first_name="Wallet", last_name="Probe", is_verified=True)
    db.add(u)
    db.commit()
    db.refresh(u)

    yield u

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id == u.id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.user_id == u.id).delete()
    db.query(Account).filter(Account.user_id == u.id).update(
        {"payment_account_id": None, "payment_overflow_account_id": None})
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


def _wallet(db, user, name="GCash", balance="0"):
    from app.models.account import AccountType

    return _account(db, user, name, AccountType.E_WALLET, balance, is_spending_wallet=True)


def _entry(db, user, name, entry_type, amount, next_occurrence, account=None, **kw):
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import RecurrenceFrequency

    e = BudgetEntry(user_id=user.id, name=name, entry_type=entry_type, amount=Decimal(amount),
                    cadence=kw.pop("cadence", RecurrenceFrequency.MONTHLY),
                    next_occurrence=next_occurrence,
                    account_id=account.id if account else None, **kw)
    db.add(e)
    db.commit()
    return e


def _transfer(db, user, src, dst, amount, when, fee="0"):
    from app.models.transaction import Transaction, TransactionType

    t = Transaction(user_id=user.id, account_id=src.id, amount=Decimal(amount),
                    transaction_type=TransactionType.TRANSFER, transaction_date=when,
                    transfer_from_account_id=src.id, transfer_to_account_id=dst.id,
                    transfer_fee=Decimal(fee), is_posted=False, description="Move")
    db.add(t)
    db.commit()
    return t


def _closings(result):
    return {a["account_name"]: a["closing_balance"] for a in result["by_account"]}


def test_wallets_are_not_projection_cash(db, user):
    from types import SimpleNamespace

    from app.models.account import AccountType
    from app.services.forecast import (
        get_account_balances, get_available_cash, is_projection_cash, project_running_balance,
    )

    assert is_projection_cash(SimpleNamespace(account_type=AccountType.CASH,
                                              is_spending_wallet=True)) is False
    assert is_projection_cash(SimpleNamespace(account_type=AccountType.CASH,
                                              is_spending_wallet=False)) is True

    _account(db, user, "Bank", AccountType.SAVINGS, "10000.00")
    _wallet(db, user, "GCash", "700.00")
    _account(db, user, "Cash", AccountType.CASH, "300.00", is_spending_wallet=True)

    accounts = get_account_balances(db, user.id)
    assert get_available_cash(accounts) == Decimal("10000.00")
    r = project_running_balance(db, user.id, days=30, reference=REF)
    assert r["opening_balance"] == Decimal("10000.00")
    assert set(_closings(r)) == {"Bank"}


def test_cash_to_wallet_costs_amount_plus_fee_and_wallet_to_cash_adds_amount(db, user):
    from app.models.account import AccountType
    from app.services.forecast import project_running_balance

    bank = _account(db, user, "Bank", AccountType.SAVINGS, "10000.00")
    wallet = _wallet(db, user, "GCash", "1000.00")
    _transfer(db, user, bank, wallet, "2000.00", datetime(2026, 11, 5), fee="10.00")
    _transfer(db, user, wallet, bank, "400.00", datetime(2026, 11, 9), fee="15.00")

    r = project_running_balance(db, user.id, days=30, reference=REF)
    amounts = [e["amount"] for e in r["events"]]
    # Top-up: -(2,000 + 10) on the source. Cash-out: +400 on the destination;
    # the wallet's fee is the wallet's problem, not projection cash.
    assert amounts == [Decimal("-2010.00"), Decimal("400.00")]
    assert r["closing_balance"] == Decimal("8390.00")
    assert _closings(r) == {"Bank": Decimal("8390.00")}


def test_transfer_between_wallets_moves_no_projection_cash(db, user):
    from app.models.account import AccountType
    from app.services.forecast import collect_events, project_running_balance

    _account(db, user, "Bank", AccountType.SAVINGS, "5000.00")
    gcash = _wallet(db, user, "GCash", "1000.00")
    cash = _account(db, user, "Cash", AccountType.CASH, "0", is_spending_wallet=True)
    _transfer(db, user, gcash, cash, "500.00", datetime(2026, 11, 5), fee="15.00")

    events = collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id)
    assert len(events) == 1 and events[0]["counts_as_cash"] is False
    assert all(not leg["cash"] for leg in events[0]["legs"])
    assert project_running_balance(db, user.id, days=30, reference=REF)["events"] == []


def test_wallet_transactions_are_skipped(db, user):
    from app.models.account import AccountType
    from app.models.transaction import Transaction, TransactionType
    from app.services.forecast import collect_events

    _account(db, user, "Bank", AccountType.SAVINGS, "5000.00")
    wallet = _wallet(db, user, "GCash", "1000.00")
    for kind, when in ((TransactionType.DEBIT, datetime(2026, 11, 5)),
                       (TransactionType.CREDIT, datetime(2026, 11, 6)),
                       (TransactionType.DEBIT, datetime(2026, 10, 20))):  # overdue
        db.add(Transaction(user_id=user.id, account_id=wallet.id, amount=Decimal("250.00"),
                           transaction_type=kind, transaction_date=when, is_posted=False))
    db.commit()

    assert collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id) == []


def test_wallet_funded_budget_entries_are_skipped(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import collect_events, project_cashflow

    _account(db, user, "Bank", AccountType.SAVINGS, "5000.00")
    wallet = _wallet(db, user, "GCash", "1000.00")
    _entry(db, user, "Parking", BudgetEntryType.EXPENSE, "500.00", datetime(2026, 11, 3),
           account=wallet)

    assert collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id) == []
    month = project_cashflow(db, user.id, months=1, reference=REF)[0]
    assert month["expenses"] == 0 and month["closing_balance"] == 5000.0


def test_recurring_transfer_entry_funds_the_loan_payable_before_the_4th(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import collect_events, project_running_balance

    secb = _account(db, user, "SecB", AccountType.SAVINGS, "20000.00")
    bdo = _account(db, user, "BDO", AccountType.CHECKING, "0.00")
    _entry(db, user, "BDO loan", BudgetEntryType.EXPENSE, "8000.00", datetime(2026, 11, 4),
           account=bdo)

    # Without the recurring transfer, BDO cannot cover its loan on the 4th.
    before = project_running_balance(db, user.id, days=30, reference=REF)
    assert [(s["account_name"], s["short_amount"]) for s in before["account_shortfalls"]] == [
        ("BDO", Decimal("8000.00"))]

    _entry(db, user, "SecB to BDO", BudgetEntryType.EXPENSE, "8000.00", datetime(2026, 11, 1),
           account=secb, transfer_to_account_id=bdo.id)

    events = collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id)
    move = next(e for e in events if e["name"] == "SecB to BDO")
    assert move["type"] == "transfer" and move["source"] == "budget_entry"
    assert [(leg["account_id"], leg["amount"], leg["cash"]) for leg in move["legs"]] == [
        (secb.id, Decimal("-8000.00"), True), (bdo.id, Decimal("8000.00"), True)]
    assert move["amount"] == Decimal("0.00")  # pooled cash only moves by the loan

    after = project_running_balance(db, user.id, days=30, reference=REF)
    assert after["account_shortfalls"] == []
    assert _closings(after) == {"SecB": Decimal("12000.00"), "BDO": Decimal("0.00")}
    assert after["closing_balance"] == Decimal("12000.00")


def test_recurring_transfer_into_a_wallet_is_a_top_up(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import project_cashflow

    bank = _account(db, user, "Bank", AccountType.SAVINGS, "5000.00")
    wallet = _wallet(db, user)
    _entry(db, user, "Load GCash", BudgetEntryType.EXPENSE, "1000.00", datetime(2026, 11, 2),
           account=bank, transfer_to_account_id=wallet.id)

    month = project_cashflow(db, user.id, months=1, reference=REF)[0]
    assert month["expenses"] == 1000.0
    assert month["closing_balance"] == 4000.0
    assert [a["account_name"] for a in month["by_account"]] == ["Bank"]


def test_snapshot_shows_wallet_balances_but_does_not_count_them(client, db, user):
    from app.models.account import AccountType

    _account(db, user, "Bank", AccountType.SAVINGS, "10000.00")
    _wallet(db, user, "GCash", "700.00")

    login = client.post("/api/v1/auth/login",
                        json={"email": user.email, "password": "password123"})
    assert login.status_code == 200, login.text
    snap = client.get("/api/v1/dashboard/snapshot",
                      headers={"Authorization": f"Bearer {login.json()['access_token']}"}).json()

    flags = {a["name"]: a["is_spending_wallet"] for a in snap["balances"]["by_account"]}
    assert flags == {"Bank": False, "GCash": True}
    assert snap["available_cash"] == 10000.0


def test_disposable_income_expenses_top_ups_once_and_ignores_other_transfers(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import get_disposable_income

    secb = _account(db, user, "SecB", AccountType.SAVINGS, "20000.00")
    bdo = _account(db, user, "BDO", AccountType.CHECKING, "0.00")
    wallet = _wallet(db, user)
    _entry(db, user, "Salary", BudgetEntryType.INCOME, "50000.00", REF, account=secb)
    _entry(db, user, "BDO loan", BudgetEntryType.EXPENSE, "8000.00", REF, account=bdo)
    _entry(db, user, "SecB to BDO", BudgetEntryType.EXPENSE, "8000.00", REF,
           account=secb, transfer_to_account_id=bdo.id)
    _entry(db, user, "Load GCash", BudgetEntryType.EXPENSE, "2000.00", REF,
           account=secb, transfer_to_account_id=wallet.id)
    _entry(db, user, "Parking", BudgetEntryType.EXPENSE, "500.00", REF, account=wallet)

    result = get_disposable_income(db, user.id)
    # Loan 8,000 + top-up 2,000; the SecB->BDO move and wallet parking are not expenses.
    assert result == {"monthly_income": 50000.0, "monthly_expenses": 10000.0,
                      "monthly_disposable": 40000.0}


@pytest.fixture
def entities(db):
    """Two throwaway entities; rows tagged to them are removed afterwards."""
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.entity import Entity, EntityType
    from app.models.transaction import Transaction

    made = []
    for label in ("A", "B"):
        e = Entity(name=f"Wallet {label} {os.urandom(3).hex()}", entity_type=EntityType.BUSINESS)
        db.add(e)
        db.commit()
        db.refresh(e)
        made.append(e)

    yield made

    db.rollback()
    ids = [e.id for e in made]
    db.query(Transaction).filter(Transaction.entity_id.in_(ids)).delete(synchronize_session=False)
    db.query(BudgetEntry).filter(BudgetEntry.entity_id.in_(ids)).delete(synchronize_session=False)
    db.query(Account).filter(Account.entity_id.in_(ids)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.entity_id.in_(ids)).delete(synchronize_session=False)
    db.query(Entity).filter(Entity.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


def test_entry_and_transactions_on_an_inactive_wallet_are_still_wallet_spending(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.models.transaction import Transaction, TransactionType
    from app.services.forecast import collect_events, project_running_balance

    _account(db, user, "Bank", AccountType.SAVINGS, "5000.00")
    wallet = _account(db, user, "Old GCash", AccountType.E_WALLET, "800.00",
                      is_spending_wallet=True, is_active=False)
    _entry(db, user, "Parking", BudgetEntryType.EXPENSE, "500.00", datetime(2026, 11, 3),
           account=wallet)
    db.add(Transaction(user_id=user.id, account_id=wallet.id, amount=Decimal("250.00"),
                       transaction_type=TransactionType.DEBIT,
                       transaction_date=datetime(2026, 11, 5), is_posted=False))
    db.commit()

    assert collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id) == []
    r = project_running_balance(db, user.id, days=30, reference=REF)
    assert r["closing_balance"] == Decimal("5000.00") and r["unassigned_closing"] == 0


def test_entry_funded_from_an_out_of_scope_wallet_is_still_wallet_spending(db, user, entities):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import collect_events, project_running_balance

    biz = entities[0]
    _account(db, user, "Biz Bank", AccountType.SAVINGS, "5000.00", entity_id=biz.id)
    personal_wallet = _wallet(db, user, "Personal GCash", "800.00")  # no entity: out of scope
    _entry(db, user, "Parking", BudgetEntryType.EXPENSE, "500.00", datetime(2026, 11, 3),
           account=personal_wallet, entity_id=biz.id)

    assert collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id, entity_id=biz.id) == []
    r = project_running_balance(db, user.id, biz.id, days=30, reference=REF)
    assert r["closing_balance"] == Decimal("5000.00") and r["unassigned_closing"] == 0


def test_statement_paid_from_a_wallet_does_not_take_cash_twice(db, user):
    from app.models.account import AccountType
    from app.models.transaction import Transaction, TransactionType
    from app.services.forecast import collect_events, get_payables, project_running_balance

    _account(db, user, "Bank", AccountType.SAVINGS, "5000.00")
    wallet = _wallet(db, user, "Cash", "3000.00")
    card = _account(db, user, "Card", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21)
    # Pre-migration routing onto an account that is now a wallet (the API refuses it).
    card.payment_account_id = wallet.id
    db.commit()
    # Billed on the 24 Oct statement, due 14 Nov.
    db.add(Transaction(user_id=user.id, account_id=card.id, amount=Decimal("1200.00"),
                       transaction_type=TransactionType.DEBIT,
                       transaction_date=datetime(2026, 10, 10), is_posted=False))
    db.commit()

    events = collect_events(db, REF, datetime(2026, 12, 1), user_id=user.id)
    stmt = next(e for e in events if e["source"] == "statement")
    assert stmt["legs"][0]["account_id"] == wallet.id and stmt["legs"][0]["cash"] is False
    assert stmt["counts_as_cash"] is False

    r = project_running_balance(db, user.id, days=30, reference=REF)
    assert r["account_shortfalls"] == []
    assert r["closing_balance"] == Decimal("5000.00") and r["unassigned_closing"] == 0
    assert get_payables(db, user.id, days=30, reference=REF) == []

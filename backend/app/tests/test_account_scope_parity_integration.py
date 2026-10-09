"""The account-scoped projection equals the single-owner projection (STU-229).

The engine is keyed on the accounts the caller holds a role on, not on an
entity. For a single owner, every view must come out exactly as it did before
the re-key. ``data/account_scope_parity.json`` was captured by running
``build`` and ``views`` below against the pre-change code (origin/main
1eb87dc, unscoped calls) on the same fixtures; the test replays them on the
current code. Ids are replaced by names so the snapshot is stable.

It also pins the caller's own accountless entries (no ``account_id``), income
and expense, to the unassigned-cash behaviour, including for a user with no
accounts at all. Skips without a database.
"""
import json
import os
import pathlib
from datetime import date, datetime, timedelta
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
GOLDEN = pathlib.Path(__file__).parent / "data" / "account_scope_parity.json"


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
def fixtures(db):
    built = build(db)
    yield built
    teardown(db, built)


def build(db):
    """One owner with every kind of event, and a user with no accounts."""
    from app.core.auth import get_password_hash
    from app.models.account import Account, AccountType
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
    from app.models.user import User

    def user(name):
        u = User(email=f"parity-{name}-{os.urandom(4).hex()}@example.com",
                 password_hash=get_password_hash("password123"),
                 first_name="Parity", last_name=name, is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        return u

    owner, bare = user("Owner"), user("Bare")
    names = {}

    def account(name, account_type, balance, **kw):
        a = Account(user_id=owner.id, name=name, account_type=account_type,
                    balance=Decimal(balance), **kw)
        db.add(a)
        db.commit()
        db.refresh(a)
        names[("account", a.id)] = name
        return a

    def entry(who, name, entry_type, amount, first, account=None, **kw):
        e = BudgetEntry(user_id=who.id, name=name, entry_type=entry_type,
                        amount=Decimal(amount), cadence=RecurrenceFrequency.MONTHLY,
                        next_occurrence=first, account_id=account.id if account else None, **kw)
        db.add(e)
        db.commit()
        names[("entry", e.id)] = name
        return e

    def txn(name, account, txn_type, amount, when, **kw):
        t = Transaction(user_id=owner.id, account_id=account.id, amount=Decimal(amount),
                        transaction_type=txn_type, transaction_date=when, description=name,
                        is_posted=kw.pop("is_posted", False), **kw)
        db.add(t)
        db.commit()
        names[("txn", t.id)] = name
        return t

    bank = account("Bank", AccountType.CHECKING, "9000.00")
    savings = account("Savings", AccountType.SAVINGS, "5000.00")
    wallet = account("GCash", AccountType.E_WALLET, "300.00", is_spending_wallet=True)
    card = account("Card", AccountType.CREDIT, "-1500.00", billing_cycle_start=24,
                   days_until_due_date=21, payment_account_id=bank.id)
    loan = account("Car loan", AccountType.LOAN, "-60000.00", loan_kind="auto",
                   loan_amortization="fixed", loan_annual_rate=Decimal("6"),
                   loan_term_months=24, loan_payment_amount=Decimal("3000"),
                   loan_first_payment_date=date(2026, 10, 4), loan_payments_made_offset=0,
                   payment_account_id=bank.id)
    names[("loan", loan.id)] = "Car loan"

    INC, EXP = BudgetEntryType.INCOME, BudgetEntryType.EXPENSE
    entry(owner, "Salary", INC, "30000.00", datetime(2026, 10, 15), bank)
    entry(owner, "Rent", EXP, "8000.00", datetime(2026, 10, 5), bank,
          overflow_account_id=savings.id)
    entry(owner, "Load GCash", EXP, "1000.00", datetime(2026, 10, 2), bank,
          transfer_to_account_id=wallet.id)
    entry(owner, "Parking", EXP, "200.00", datetime(2026, 10, 9), wallet)
    entry(owner, "Side gig", INC, "2500.00", datetime(2026, 10, 20))
    entry(owner, "Gym", EXP, "1200.00", datetime(2026, 10, 12))
    entry(owner, "To savings", EXP, "2000.00", datetime(2026, 10, 25), bank,
          transfer_to_account_id=savings.id)
    entry(owner, "Streaming", EXP, "500.00", datetime(2026, 10, 8), card)
    entry(bare, "Bare income", INC, "5000.00", datetime(2026, 10, 10))
    entry(bare, "Bare expense", EXP, "3000.00", datetime(2026, 10, 3))

    T = TransactionType
    txn("Card charge posted", card, T.DEBIT, "1500.00", datetime(2026, 9, 10), is_posted=True)
    txn("Card charge pending", card, T.DEBIT, "700.00", datetime(2026, 10, 10))
    txn("Groceries", bank, T.DEBIT, "450.00", datetime(2026, 10, 7))
    txn("Overdue bill", bank, T.DEBIT, "300.00", datetime(2026, 9, 28))
    txn("Refund", bank, T.CREDIT, "250.00", datetime(2026, 10, 11))
    txn("Move to savings", bank, T.TRANSFER, "1000.00", datetime(2026, 10, 18),
        transfer_fee=Decimal("15.00"), transfer_from_account_id=bank.id,
        transfer_to_account_id=savings.id)
    txn("Pay card", bank, T.TRANSFER, "600.00", datetime(2026, 10, 13),
        transfer_from_account_id=bank.id, transfer_to_account_id=card.id)

    return {"owner": owner.id, "bare": bare.id, "names": names}


def teardown(db, built):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.models.user import User

    db.rollback()
    ids = [built["owner"], built["bare"]]
    db.query(Transaction).filter(Transaction.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(BudgetEntry).filter(BudgetEntry.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(ids)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


def _canonical(value, names):
    """JSON-ready, with every id replaced by the name it was built with."""
    def sub(key, v):
        if v is None or not isinstance(v, int) or isinstance(v, bool):
            return walk(v)
        if key.endswith("account_id"):
            return names.get(("account", v), f"account:{v}")
        if key == "source_id":
            for kind in ("entry", "txn", "loan", "account"):
                if (kind, v) in names:
                    return f"{kind}:{names[(kind, v)]}"
            return f"unknown:{v}"
        return v

    def walk(v):
        if isinstance(v, dict):
            out = {k: sub(k, x) for k, x in v.items()}
            if isinstance(out.get("by_account"), list):
                # Account order is not part of the contract (the query has no ORDER BY).
                out["by_account"] = sorted(out["by_account"], key=lambda a: str(a))
            return out
        if isinstance(v, (list, tuple)):
            return [walk(x) for x in v]
        if isinstance(v, Decimal):
            return str(v)
        if isinstance(v, (datetime, date)):
            return v.isoformat()
        return v

    return json.loads(json.dumps(walk(value), default=str))


def views(db, built):
    """Every projection view, for both users, unscoped (the single-owner case)."""
    from app.services.forecast import (
        collect_events, get_disposable_income, get_payables, get_upcoming_items,
        project_cashflow, project_running_balance, serialize_timeline,
    )

    out = {}
    for who in ("owner", "bare"):
        uid = built[who]
        out[who] = {
            # collect_events is unordered (the queries have no ORDER BY).
            "events": sorted(collect_events(db, REF, REF + timedelta(days=60), user_id=uid),
                             key=lambda e: (e["date"], e["name"], e["source"])),
            "timeline": serialize_timeline(project_running_balance(
                db, uid, days=60, reference=REF)),
            "cashflow": project_cashflow(db, uid, months=2, reference=REF),
            "upcoming": get_upcoming_items(db, uid, days=60, reference=REF),
            "payables": get_payables(db, uid, days=60, reference=REF),
            "disposable": get_disposable_income(db, uid),
        }
    return _canonical(out, built["names"])


def _differences(expected, actual, path=""):
    """Paths where two JSON values differ, for a readable failure."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        out = []
        for key in sorted(set(expected) | set(actual)):
            out += _differences(expected.get(key), actual.get(key), f"{path}.{key}")
        return out
    if isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        out = []
        for i, (e, a) in enumerate(zip(expected, actual)):
            out += _differences(e, a, f"{path}[{i}]")
        return out
    return [] if expected == actual else [(path, expected, actual)]


def test_account_scoped_projection_matches_the_single_owner_baseline(db, fixtures):
    expected = json.loads(GOLDEN.read_text())
    actual = views(db, fixtures)
    assert _differences(expected, actual) == []


def test_own_accountless_entries_stay_unassigned_cash(db, fixtures):
    from app.services.forecast import collect_events, project_running_balance

    events = collect_events(db, REF, datetime(2026, 11, 1), user_id=fixtures["owner"])
    accountless = sorted(
        (e["name"], e["amount"], [(leg["account_id"], leg["amount"], leg["cash"])
                                  for leg in e["legs"]])
        for e in events if e["name"] in ("Side gig", "Gym"))
    assert accountless == [
        ("Gym", Decimal("-1200.00"), [(None, Decimal("-1200.00"), True)]),
        ("Side gig", Decimal("2500.00"), [(None, Decimal("2500.00"), True)]),
    ]
    timeline = project_running_balance(db, fixtures["owner"], days=30, reference=REF)
    assert timeline["unassigned_closing"] == Decimal("1300.00")


def test_a_user_with_no_accounts_keeps_accountless_income_and_expense(db, fixtures):
    from app.services.forecast import (
        get_disposable_income, project_cashflow, project_running_balance,
    )

    uid = fixtures["bare"]
    timeline = project_running_balance(db, uid, days=30, reference=REF)
    assert [(e["name"], e["amount"]) for e in timeline["events"]] == [
        ("Bare expense", Decimal("-3000.00")), ("Bare income", Decimal("5000.00"))]
    assert timeline["by_account"] == []
    assert timeline["unassigned_closing"] == Decimal("2000.00")
    assert timeline["closing_balance"] == Decimal("2000.00")
    (october,) = project_cashflow(db, uid, months=1, reference=REF)
    assert (october["net"], october["unassigned_closing"]) == (2000.0, 2000.0)
    assert get_disposable_income(db, uid) == {
        "monthly_income": 5000.0, "monthly_expenses": 3000.0, "monthly_disposable": 2000.0}

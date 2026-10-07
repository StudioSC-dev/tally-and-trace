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


# ---------------------------------------------------------------------------
# Transfers that leave or enter the projection's account set
# ---------------------------------------------------------------------------

@pytest.fixture
def entities(db, user):
    """Two throwaway entities; the user's accounts, entries and transactions go first on teardown."""
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.entity import Entity, EntityType
    from app.models.transaction import Transaction

    created = []
    for label in ("A", "B"):
        e = Entity(name=f"Proj {label} {os.urandom(3).hex()}", entity_type=EntityType.BUSINESS)
        db.add(e)
        created.append(e)
    db.commit()
    ids = [e.id for e in created]

    yield created

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id == user.id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.user_id == user.id).delete()
    db.query(Account).filter(Account.user_id == user.id).update(
        {"payment_account_id": None, "payment_overflow_account_id": None}
    )
    db.commit()
    db.query(Account).filter(Account.user_id == user.id).delete()
    db.query(Entity).filter(Entity.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


def _cross_entity_transfer(db, user, entities, row_entity):
    """5,000 + 15 fee from entity A's 10,000 account to an empty entity-B account."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType

    ent_a, ent_b = entities
    acc_a = _account(db, user, "Savings A", AccountType.SAVINGS, "10000.00", entity_id=ent_a.id)
    acc_b = _account(db, user, "Checking B", AccountType.CHECKING, "0.00", entity_id=ent_b.id)
    _txn(db, user, acc_a, TransactionType.TRANSFER, "5000.00", datetime(2026, 8, 5),
         transfer_fee=Decimal("15.00"), description="Move to B",
         transfer_from_account_id=acc_a.id, transfer_to_account_id=acc_b.id,
         entity_id=row_entity.id)
    return acc_a, acc_b


@pytest.mark.parametrize("row_owner", ["source", "destination"])
def test_transfer_out_of_scope_costs_the_pool_amount_and_fee(db, user, entities, row_owner):
    from app.services.forecast import project_cashflow, project_running_balance

    ent_a, ent_b = entities
    acc_a, _ = _cross_entity_transfer(
        db, user, entities, ent_a if row_owner == "source" else ent_b)

    r = project_running_balance(db, user.id, ent_a.id, days=30, reference=datetime(2026, 8, 1))
    assert r["closing_balance"] == Decimal("4985.00")
    assert [(a["account_id"], a["closing_balance"]) for a in r["by_account"]] == [
        (acc_a.id, Decimal("4985.00")),
    ]
    assert r["unassigned_closing"] == Decimal("0")

    (aug,) = project_cashflow(db, user.id, ent_a.id, months=1, reference=datetime(2026, 8, 1))
    assert aug["closing_balance"] == 4985.0
    assert aug["unassigned_closing"] == 0.0


@pytest.mark.parametrize("row_owner", ["source", "destination"])
def test_transfer_into_scope_from_outside_adds_the_amount(db, user, entities, row_owner):
    from app.services.forecast import (
        get_upcoming_items, project_cashflow, project_running_balance, serialize_timeline,
    )

    ent_a, ent_b = entities
    _, acc_b = _cross_entity_transfer(
        db, user, entities, ent_a if row_owner == "source" else ent_b)

    r = project_running_balance(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1))
    assert r["closing_balance"] == Decimal("5000.00")
    assert [(a["account_id"], a["closing_balance"]) for a in r["by_account"]] == [
        (acc_b.id, Decimal("5000.00")),
    ]
    assert r["unassigned_closing"] == Decimal("0")
    # Entity A's account is never named in B's view.
    assert "Savings A" not in repr(serialize_timeline(r))

    (aug,) = project_cashflow(db, user.id, ent_b.id, months=1, reference=datetime(2026, 8, 1))
    assert aug["closing_balance"] == 5000.0
    assert "Savings A" not in repr(aug)

    items = get_upcoming_items(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1))
    assert [(i["due_date"], i["name"], float(i["amount"])) for i in items] == [
        ("2026-08-05", "Move to B", 5000.0),
    ]


def test_same_day_inbound_transfer_funds_a_bill_in_the_pooled_timeline_too(db, user, entities):
    """Zero opening cash: the pooled trough and shortfalls agree with account routing."""
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import project_running_balance

    ent_a, ent_b = entities
    _, acc_b = _cross_entity_transfer(db, user, entities, ent_a)
    _entry(db, user, "Bill from B", BudgetEntryType.EXPENSE, "4000.00", datetime(2026, 8, 5),
           account=acc_b, entity_id=ent_b.id, end_mode="after_occurrences", max_occurrences=1)

    r = project_running_balance(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1))
    assert r["opening_balance"] == Decimal("0.00")
    assert r["account_shortfalls"] == []
    assert r["shortfall"] is False
    assert r["shortfalls"] == []
    assert r["lowest_balance"] == Decimal("0.00")
    assert r["trough_date"] is None
    assert r["closing_balance"] == Decimal("1000.00")


@pytest.mark.parametrize("row_owner", ["outside", "card"])
@pytest.mark.parametrize("direction", ["into_card", "from_card"])
def test_cross_scope_transfer_touching_an_in_scope_card_is_listed_but_not_cash(
        db, user, entities, direction, row_owner):
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import (
        collect_events, get_payables, get_upcoming_items, project_running_balance,
    )

    ent_a, ent_b = entities
    outside = _account(db, user, "Savings A", AccountType.SAVINGS, "10000.00", entity_id=ent_a.id)
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00", entity_id=ent_b.id,
                    billing_cycle_start=24, days_until_due_date=21)
    checking = _account(db, user, "Checking B", AccountType.CHECKING, "1000.00",
                        entity_id=ent_b.id)
    card.payment_account_id = checking.id
    db.commit()
    src, dst = (outside, card) if direction == "into_card" else (card, outside)
    _txn(db, user, src, TransactionType.TRANSFER, "3000.00", datetime(2026, 8, 5),
         transfer_fee=Decimal("20.00"), description="Card move",
         transfer_from_account_id=src.id, transfer_to_account_id=dst.id,
         entity_id=(ent_a if row_owner == "outside" else ent_b).id)

    events = collect_events(db, datetime(2026, 8, 1), datetime(2026, 9, 1),
                            user_id=user.id, entity_id=ent_b.id)
    assert len(events) == 1
    (ev,) = events
    assert ev["counts_as_cash"] is False
    assert ev["amount"] == Decimal("0")
    leg_amount = Decimal("3000.00") if direction == "into_card" else Decimal("-3020.00")
    assert [(leg["account_id"], leg["amount"], leg["cash"]) for leg in ev["legs"]] == [
        (card.id, leg_amount, False),
    ]

    items = get_upcoming_items(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1))
    assert [(i["due_date"], i["name"], float(i["amount"])) for i in items] == [
        ("2026-08-05", "Card move", 3000.0),
    ]
    r = project_running_balance(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1))
    assert r["events"] == []
    assert r["closing_balance"] == Decimal("1000.00")
    assert get_payables(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1)) == []


@pytest.mark.parametrize("direction", ["from_card"])
def test_overdue_card_transfer_is_listed_at_the_window_start_but_not_cash(db, user, direction):
    """Same as an in-window cash advance: listed, non-cash. Statements don't bill it."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import (
        collect_events, get_payables, project_cashflow, project_running_balance,
    )

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "1000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking.id)
    src, dst = (checking, card) if direction == "into_card" else (card, checking)
    yesterday = datetime(2026, 8, 9, 14)
    _txn(db, user, src, TransactionType.TRANSFER, "300.00", yesterday,
         description="Overdue card move",
         transfer_from_account_id=src.id, transfer_to_account_id=dst.id)

    start = datetime(2026, 8, 10)
    events = collect_events(db, start, datetime(2026, 9, 1), user_id=user.id)
    assert [(e["name"], e["date"], e.get("overdue"), e.get("original_date"), e["counts_as_cash"])
            for e in events] == [("Overdue card move", start, True, yesterday, False)]

    reference = datetime(2026, 8, 10, 9)
    r = project_running_balance(db, user.id, days=22, reference=reference)
    assert r["events"] == []
    assert r["closing_balance"] == Decimal("1000.00")
    (aug,) = project_cashflow(db, user.id, months=1, reference=reference)
    assert aug["closing_balance"] == 1000.0
    assert aug["statement_payables"] == 0.0
    assert get_payables(db, user.id, days=30, reference=reference) == []


def test_transfer_into_an_inactive_account_leaves_the_pool(db, user):
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import project_cashflow, project_running_balance

    savings_a = _account(db, user, "Savings A", AccountType.SAVINGS, "10000.00")
    closed = _account(db, user, "Closed account", AccountType.CHECKING, "0.00", is_active=False)
    _txn(db, user, savings_a, TransactionType.TRANSFER, "5000.00", datetime(2026, 8, 5),
         transfer_fee=Decimal("15.00"),
         transfer_from_account_id=savings_a.id, transfer_to_account_id=closed.id)

    r = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
    assert r["closing_balance"] == Decimal("4985.00")
    assert r["unassigned_closing"] == Decimal("0")

    (aug,) = project_cashflow(db, user.id, months=1, reference=datetime(2026, 8, 1))
    assert aug["closing_balance"] == 4985.0
    assert aug["unassigned_closing"] == 0.0


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


# ---------------------------------------------------------------------------
# Monthly projection on the shared event engine
# ---------------------------------------------------------------------------

def test_monthly_projection_respects_end_date_and_max_occurrences(db, user):
    """A finished or capped installment stops producing events month to month."""
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import project_cashflow

    _account(db, user, "Checking B", AccountType.CHECKING, "10000.00")
    # Fully paid installment: 0 occurrences remaining.
    _entry(db, user, "Finished installment", BudgetEntryType.EXPENSE, "500.00",
           datetime(2026, 8, 15), end_mode="after_occurrences", max_occurrences=0)
    # One payment remaining.
    _entry(db, user, "Last installment", BudgetEntryType.EXPENSE, "300.00",
           datetime(2026, 8, 15), end_mode="after_occurrences", max_occurrences=1)
    # Ends after September.
    _entry(db, user, "Ending subscription", BudgetEntryType.EXPENSE, "100.00",
           datetime(2026, 8, 20), end_mode="on_date", end_date=datetime(2026, 9, 30))

    periods = project_cashflow(db, user.id, months=4, reference=datetime(2026, 8, 1))

    assert [p["expenses"] for p in periods] == [400.0, 100.0, 0.0, 0.0]
    assert periods[-1]["closing_balance"] == 9500.0


def test_monthly_projection_does_not_count_unposted_card_charges_as_cash(db, user):
    """The charge leaves cash when the statement is paid, not on the purchase date."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import project_cashflow

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "50000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21)
    card.payment_account_id = checking.id
    db.commit()
    # Charged 10 Aug -> closes on the 24 Aug statement -> due 14 Sep.
    _txn(db, user, card, TransactionType.DEBIT, "12000.00", datetime(2026, 8, 10),
         description="Card charge")

    aug, sep = project_cashflow(db, user.id, months=2, reference=datetime(2026, 8, 1))

    assert aug["unposted_expenses"] == 0.0
    assert aug["statement_payables"] == 0.0
    assert aug["closing_balance"] == 50000.0
    assert sep["unposted_expenses"] == 0.0
    assert sep["statement_payables"] == 12000.0
    assert sep["closing_balance"] == 38000.0
    assert sep["by_account"] == [
        {"account_id": checking.id, "account_name": "Checking B", "closing_balance": 38000.0}
    ]


def test_monthly_projection_bills_a_midday_closing_day_charge_on_that_statement(db, user):
    """12,000 at noon on the 24 Jul closing day is due 14 Aug, so August closes at 38,000."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import project_cashflow

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "50000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking.id)
    _txn(db, user, card, TransactionType.DEBIT, "12000.00", datetime(2026, 7, 24, 12),
         description="Card charge")

    aug, sep = project_cashflow(db, user.id, months=2, reference=datetime(2026, 8, 1))

    assert aug["statement_payables"] == 12000.0
    assert aug["closing_balance"] == 38000.0
    assert sep["statement_payables"] == 0.0
    assert sep["closing_balance"] == 38000.0


def test_monthly_projection_does_not_count_a_card_cash_advance_as_cash(db, user):
    """Nothing repays the advance until statements net transfers, so it adds no cash."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import get_payables, project_cashflow, project_running_balance

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "1000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking.id)
    _txn(db, user, card, TransactionType.TRANSFER, "3000.00", datetime(2026, 8, 5),
         transfer_fee=Decimal("50.00"), description="Cash advance",
         transfer_from_account_id=card.id, transfer_to_account_id=checking.id)

    (aug,) = project_cashflow(db, user.id, months=1, reference=datetime(2026, 8, 1))
    assert aug["closing_balance"] == 1000.0
    assert aug["by_account"] == [
        {"account_id": checking.id, "account_name": "Checking B", "closing_balance": 1000.0}
    ]
    r = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
    assert r["closing_balance"] == Decimal("1000.00")
    assert r["events"] == []
    assert get_payables(db, user.id, days=30, reference=datetime(2026, 8, 1)) == []


def test_overdue_unposted_transactions_land_at_the_window_start_in_every_view(db, user):
    """Balances move only on posting, so an unposted item dated before today is still pending."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import (
        collect_events, get_upcoming_items, project_cashflow, project_running_balance,
    )

    savings_a = _account(db, user, "Savings A", AccountType.SAVINGS, "10000.00")
    checking_b = _account(db, user, "Checking B", AccountType.CHECKING, "1000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking_b.id)
    yesterday = datetime(2026, 8, 9, 14)
    _txn(db, user, checking_b, TransactionType.DEBIT, "500.00", yesterday,
         description="Overdue bill")
    _txn(db, user, savings_a, TransactionType.TRANSFER, "2000.00", yesterday,
         transfer_fee=Decimal("10.00"), description="Overdue move",
         transfer_from_account_id=savings_a.id, transfer_to_account_id=checking_b.id)
    # A card charge reaches cash through its statement; posted items are in the balance.
    _txn(db, user, card, TransactionType.DEBIT, "700.00", yesterday, description="Card charge")
    _txn(db, user, checking_b, TransactionType.DEBIT, "80.00", yesterday,
         description="Posted bill", is_posted=True)

    reference = datetime(2026, 8, 10, 9)
    start = datetime(2026, 8, 10)

    events = collect_events(db, start, datetime(2026, 9, 1), user_id=user.id)
    overdue = sorted((e["name"], e["date"], e["overdue"], e["original_date"])
                     for e in events if e.get("overdue"))
    assert overdue == [
        ("Overdue bill", start, True, yesterday),
        ("Overdue move", start, True, yesterday),
    ]

    (aug,) = project_cashflow(db, user.id, months=1, reference=reference)
    assert aug["unposted_expenses"] == 510.0
    assert aug["closing_balance"] == 10490.0
    assert {a["account_name"]: a["closing_balance"] for a in aug["by_account"]} == {
        "Savings A": 7990.0, "Checking B": 2500.0,
    }

    timeline = project_running_balance(db, user.id, days=22, reference=reference)
    assert timeline["window_end"] == datetime(2026, 9, 1).date()
    assert sorted((e["date"].isoformat(), e["name"]) for e in timeline["events"]) == [
        ("2026-08-10", "Overdue bill"), ("2026-08-10", "Overdue move"),
    ]
    assert float(timeline["closing_balance"]) == aug["closing_balance"]
    assert [float(a["closing_balance"]) for a in timeline["by_account"]] == [
        a["closing_balance"] for a in aug["by_account"]
    ]

    items = get_upcoming_items(db, user.id, days=30, reference=reference)
    assert sorted((i["due_date"], i["name"]) for i in items) == [
        ("2026-08-10", "Overdue bill"), ("2026-08-10", "Overdue move"),
    ]


def test_overdue_debit_with_stale_transfer_fields_still_counts(db, user):
    """A transfer edited into a debit keeps its old transfer_* fields; only account_id matters."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import collect_events, project_cashflow, project_running_balance

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "1000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking.id)
    yesterday = datetime(2026, 8, 9, 14)
    t = _txn(db, user, checking, TransactionType.TRANSFER, "500.00", yesterday,
             description="Was a card payment",
             transfer_from_account_id=checking.id, transfer_to_account_id=card.id)
    # The update path changes the type but leaves the transfer fields behind.
    t.transaction_type = TransactionType.DEBIT
    db.commit()

    start = datetime(2026, 8, 10)
    events = collect_events(db, start, datetime(2026, 9, 1), user_id=user.id)
    assert [(e["name"], e["date"], e.get("overdue"), e["amount"], e["counts_as_cash"])
            for e in events] == [("Was a card payment", start, True, Decimal("-500.00"), True)]

    reference = datetime(2026, 8, 10, 9)
    r = project_running_balance(db, user.id, days=22, reference=reference)
    assert r["closing_balance"] == Decimal("500.00")
    (aug,) = project_cashflow(db, user.id, months=1, reference=reference)
    assert aug["closing_balance"] == 500.0
    assert aug["unposted_expenses"] == 500.0


def test_timeline_closing_equals_monthly_end_balance_over_the_same_window(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.models.transaction import RecurrenceFrequency, TransactionType
    from app.services.forecast import project_cashflow, project_running_balance

    savings_a = _account(db, user, "Savings A", AccountType.SAVINGS, "20000.00")
    checking_b = _account(db, user, "Checking B", AccountType.CHECKING, "3000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking_b.id)
    _entry(db, user, "Salary", BudgetEntryType.INCOME, "40000.00", datetime(2026, 8, 15),
           account=checking_b, cadence=RecurrenceFrequency.SEMI_MONTHLY,
           semi_monthly_day_1=15, semi_monthly_day_2=30)
    _entry(db, user, "Rent", BudgetEntryType.EXPENSE, "25000.00", datetime(2026, 8, 5),
           account=checking_b, overflow_account_id=savings_a.id)
    _entry(db, user, "Loose expense", BudgetEntryType.EXPENSE, "1200.00", datetime(2026, 8, 12),
           cadence=RecurrenceFrequency.WEEKLY)
    _txn(db, user, card, TransactionType.DEBIT, "8000.00", datetime(2026, 7, 30), is_posted=True)
    _txn(db, user, card, TransactionType.DEBIT, "2500.00", datetime(2026, 8, 20))
    _txn(db, user, checking_b, TransactionType.DEBIT, "999.99", datetime(2026, 8, 18))
    _txn(db, user, savings_a, TransactionType.TRANSFER, "6000.00", datetime(2026, 9, 3),
         transfer_fee=Decimal("25.00"),
         transfer_from_account_id=savings_a.id, transfer_to_account_id=checking_b.id)

    reference = datetime(2026, 8, 10)
    periods = project_cashflow(db, user.id, months=2, reference=reference)
    window_end = datetime.fromisoformat(periods[-1]["period_end"])
    days = (window_end - reference).days
    timeline = project_running_balance(db, user.id, days=days, reference=reference)

    # Like windows: same start, same end.
    assert datetime.fromisoformat(periods[0]["period_start"]).date() == timeline["window_start"]
    assert window_end.date() == timeline["window_end"]
    assert periods[0]["opening_balance"] == float(timeline["opening_balance"])
    assert periods[-1]["closing_balance"] == float(timeline["closing_balance"])
    # Per-account month-end closings agree too, and sum to the pooled closing.
    assert periods[-1]["by_account"] == [
        {"account_id": a["account_id"], "account_name": a["account_name"],
         "closing_balance": float(a["closing_balance"])}
        for a in timeline["by_account"]
    ]
    assert round(
        sum(a["closing_balance"] for a in periods[-1]["by_account"])
        + periods[-1]["unassigned_closing"], 2,
    ) == periods[-1]["closing_balance"]
    # The window really did contain each kind of event.
    sources = {e["source"] for e in timeline["events"]}
    assert sources == {"budget_entry", "transaction", "statement"}


# ---------------------------------------------------------------------------
# Card payments netted against statements
#
# Card C closes on the 24th with a 21-day grace period, paid from Checking B.
# A 12,000 charge on 10 Jul is on the 24 Jul statement, due 14 Aug.
# ---------------------------------------------------------------------------

@pytest.fixture
def card_setup(db, user):
    from app.models.account import AccountType
    from app.models.transaction import TransactionType

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "50000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking.id)
    _txn(db, user, card, TransactionType.DEBIT, "12000.00", datetime(2026, 7, 10),
         description="Card charge", is_posted=True)
    return checking, card


def _pay_card(db, user, checking, card, amount, when, **kw):
    from app.models.transaction import TransactionType

    return _txn(db, user, checking, TransactionType.TRANSFER, amount, when,
                description="Card payment", transfer_from_account_id=checking.id,
                transfer_to_account_id=card.id, **kw)


def _cash_events(r):
    return [(e["date"].isoformat(), e["name"], e["amount"]) for e in r["events"]]


@pytest.mark.parametrize("amount,owed", [("12000.00", None), ("5000.00", "-7000.00")])
def test_posted_card_payment_nets_its_statement(db, user, card_setup, amount, owed):
    """A posted payment is already out of Checking's balance; only the rest is owed."""
    from app.services.forecast import project_running_balance

    checking, card = card_setup
    checking.balance = Decimal("50000.00") - Decimal(amount)
    db.commit()
    _pay_card(db, user, checking, card, amount, datetime(2026, 7, 30), is_posted=True)

    r = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
    expected = [] if owed is None else [("2026-08-14", "Card C statement", Decimal(owed))]
    assert _cash_events(r) == expected
    assert r["closing_balance"] == Decimal("38000.00")


@pytest.mark.parametrize("amount,owed", [("12000.00", None), ("5000.00", "-7000.00")])
def test_planned_card_payment_is_the_cash_and_nets_the_statement(db, user, card_setup, amount, owed):
    """The 12,000 leaves Checking exactly once: as the payment plus any remainder."""
    from app.services.forecast import get_payables, project_cashflow, project_running_balance

    checking, card = card_setup
    _pay_card(db, user, checking, card, amount, datetime(2026, 8, 12))

    r = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
    expected = [("2026-08-12", "Card payment", -Decimal(amount))]
    if owed is not None:
        expected.append(("2026-08-14", "Card C statement", Decimal(owed)))
    assert _cash_events(r) == expected
    assert r["closing_balance"] == Decimal("38000.00")
    assert r["account_shortfalls"] == []

    (aug,) = project_cashflow(db, user.id, months=1, reference=datetime(2026, 8, 1))
    assert aug["statement_payables"] == 12000.0
    assert aug["unposted_expenses"] == 0.0
    assert aug["closing_balance"] == 38000.0

    payables = get_payables(db, user.id, days=30, reference=datetime(2026, 8, 1))
    assert [(p["due_date"], p["name"], p["amount"], p["account_id"]) for p in payables] == [
        (d, n, float(-a), checking.id) for d, n, a in expected
    ]


def test_planned_card_payment_outside_the_window_nets_its_statement(db, user, card_setup):
    """Paid late on 5 Sep: August owes nothing; the cash leaves on 5 Sep, once."""
    from app.services.forecast import project_running_balance

    checking, card = card_setup
    _pay_card(db, user, checking, card, "12000.00", datetime(2026, 9, 5))

    aug = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
    assert _cash_events(aug) == []
    assert aug["closing_balance"] == Decimal("50000.00")

    longer = project_running_balance(db, user.id, days=40, reference=datetime(2026, 8, 1))
    assert _cash_events(longer) == [("2026-09-05", "Card payment", Decimal("-12000.00"))]
    assert longer["closing_balance"] == Decimal("38000.00")


def test_overdue_planned_card_payment_stays_in_cash_and_nets_its_statement(db, user, card_setup):
    """Planned for 9 Aug, not yet posted on 10 Aug: still cash, on the window start."""
    from app.services.forecast import collect_events, project_cashflow, project_running_balance

    checking, card = card_setup
    yesterday = datetime(2026, 8, 9, 14)
    _pay_card(db, user, checking, card, "12000.00", yesterday)

    start = datetime(2026, 8, 10)
    events = collect_events(db, start, datetime(2026, 9, 1), user_id=user.id)
    assert [(e["name"], e["date"], e.get("overdue"), e.get("original_date"), e["amount"])
            for e in events] == [("Card payment", start, True, yesterday, Decimal("-12000.00"))]

    reference = datetime(2026, 8, 10, 9)
    r = project_running_balance(db, user.id, days=22, reference=reference)
    assert _cash_events(r) == [("2026-08-10", "Card payment", Decimal("-12000.00"))]
    (aug,) = project_cashflow(db, user.id, months=1, reference=reference)
    assert aug["closing_balance"] == 38000.0 == float(r["closing_balance"])


def test_overdue_planned_payment_of_a_statement_due_before_the_window_stays_in_cash(
        db, user, card_setup):
    """June's statement (due 15 Jul) planned-paid 14 Jul, never posted: the cash is
    still pending on 10 Aug, and the payment does not also net July's statement."""
    from app.models.transaction import TransactionType
    from app.services.forecast import project_running_balance

    checking, card = card_setup
    _txn(db, user, card, TransactionType.DEBIT, "3000.00", datetime(2026, 6, 10), is_posted=True)
    _pay_card(db, user, checking, card, "3000.00", datetime(2026, 7, 14))

    r = project_running_balance(db, user.id, days=22, reference=datetime(2026, 8, 10, 9))
    assert _cash_events(r) == [
        ("2026-08-10", "Card payment", Decimal("-3000.00")),
        ("2026-08-14", "Card C statement", Decimal("-12000.00")),
    ]


def test_cross_entity_bank_transfer_into_the_card_nets_its_statement(db, user, entities):
    """The row and its source live in another entity; only transfer_to names the card."""
    from app.models.account import AccountType
    from app.models.transaction import TransactionType
    from app.services.forecast import project_running_balance

    ent_a, ent_b = entities
    outside = _account(db, user, "Savings A", AccountType.SAVINGS, "10000.00", entity_id=ent_a.id)
    checking = _account(db, user, "Checking B", AccountType.CHECKING, "50000.00",
                        entity_id=ent_b.id)
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00", entity_id=ent_b.id,
                    billing_cycle_start=24, days_until_due_date=21,
                    payment_account_id=checking.id)
    _txn(db, user, card, TransactionType.DEBIT, "12000.00", datetime(2026, 7, 10),
         entity_id=ent_b.id, is_posted=True)
    _txn(db, user, outside, TransactionType.TRANSFER, "4000.00", datetime(2026, 7, 30),
         entity_id=ent_a.id, is_posted=True,
         transfer_from_account_id=outside.id, transfer_to_account_id=card.id)

    r = project_running_balance(db, user.id, ent_b.id, days=30, reference=datetime(2026, 8, 1))
    assert _cash_events(r) == [("2026-08-14", "Card C statement", Decimal("-8000.00"))]


def test_card_payment_edit_and_delete_reprice_the_statement(db, user, client, card_setup):
    from app.services.forecast import project_running_balance

    checking, card = card_setup
    login = client.post("/api/v1/auth/login",
                        json={"email": user.email, "password": "password123"})
    assert login.status_code == 200, login.text
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}

    created = client.post("/api/v1/transactions/", headers=auth, json={
        "account_id": checking.id, "amount": 12000, "transaction_type": "transfer",
        "transfer_from_account_id": checking.id, "transfer_to_account_id": card.id,
        "transaction_date": "2026-08-12T00:00:00", "description": "Card payment",
        "is_posted": False,
    })
    assert created.status_code == 200, created.text
    txn_id = created.json()["id"]

    def timeline():
        db.expire_all()
        r = project_running_balance(db, user.id, days=30, reference=datetime(2026, 8, 1))
        assert r["closing_balance"] == Decimal("38000.00")
        return _cash_events(r)

    assert timeline() == [("2026-08-12", "Card payment", Decimal("-12000.00"))]

    edited = client.put(f"/api/v1/transactions/{txn_id}", headers=auth, json={"amount": 5000})
    assert edited.status_code == 200, edited.text
    assert timeline() == [
        ("2026-08-12", "Card payment", Decimal("-5000.00")),
        ("2026-08-14", "Card C statement", Decimal("-7000.00")),
    ]

    deleted = client.delete(f"/api/v1/transactions/{txn_id}", headers=auth)
    assert deleted.status_code == 200, deleted.text
    assert timeline() == [("2026-08-14", "Card C statement", Decimal("-12000.00"))]


def test_unpaid_statement_due_before_the_window_is_overdue_on_the_start_in_every_view(
        db, user, card_setup):
    """14 Aug statement, partly paid (posted) 4,000, viewed on 20 Aug: 8,000 overdue today."""
    from app.services.forecast import (
        get_payables, get_upcoming_items, project_cashflow, project_running_balance,
    )

    checking, card = card_setup
    checking.balance = Decimal("46000.00")
    db.commit()
    _pay_card(db, user, checking, card, "4000.00", datetime(2026, 8, 14), is_posted=True)

    reference = datetime(2026, 8, 20, 9)
    r = project_running_balance(db, user.id, days=12, reference=reference)
    assert _cash_events(r) == [("2026-08-20", "Card C statement", Decimal("-8000.00"))]
    (aug,) = project_cashflow(db, user.id, months=1, reference=reference)
    assert aug["statement_payables"] == 8000.0
    assert aug["closing_balance"] == 38000.0 == float(r["closing_balance"])
    assert [(p["due_date"], p["amount"]) for p in get_payables(
        db, user.id, days=10, reference=reference)] == [("2026-08-20", 8000.0)]
    assert [(i["due_date"], i["source"], float(i["amount"])) for i in get_upcoming_items(
        db, user.id, days=10, reference=reference)] == [("2026-08-20", "statement", 8000.0)]


# ---------------------------------------------------------------------------
# Upcoming items on the shared event engine
# ---------------------------------------------------------------------------

def test_upcoming_items_come_from_collect_events(db, user):
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType
    from app.models.transaction import RecurrenceFrequency, TransactionType
    from app.services.forecast import get_upcoming_items

    checking = _account(db, user, "Checking B", AccountType.CHECKING, "5000.00")
    card = _account(db, user, "Card C", AccountType.CREDIT, "0.00",
                    billing_cycle_start=1, days_until_due_date=20,
                    payment_account_id=checking.id)
    # Weekly, but only one occurrence remaining: listed once, not four times.
    _entry(db, user, "Last weekly installment", BudgetEntryType.EXPENSE, "250.00",
           datetime(2026, 8, 3), cadence=RecurrenceFrequency.WEEKLY,
           end_mode="after_occurrences", max_occurrences=1)
    _txn(db, user, card, TransactionType.DEBIT, "700.00", datetime(2026, 7, 15), is_posted=True)
    _txn(db, user, card, TransactionType.DEBIT, "90.00", datetime(2026, 8, 12),
         description="Card charge")
    # On the cutoff day itself: still inside the window.
    _txn(db, user, checking, TransactionType.DEBIT, "40.00", datetime(2026, 8, 31, 18),
         description="Cutoff-day bill")

    items = get_upcoming_items(db, user.id, days=30, reference=datetime(2026, 8, 1, 9))

    assert [(i["due_date"], i["name"], float(i["amount"]), i["entry_type"], i["source"])
            for i in items] == [
        ("2026-08-03", "Last weekly installment", 250.0, "expense", "budget_entry"),
        ("2026-08-12", "Card charge", 90.0, "debit", "transaction"),
        # 1 Aug close (charges 2 Jul..1 Aug) due 21 Aug.
        ("2026-08-21", "Card C statement", 700.0, "expense", "statement"),
        ("2026-08-31", "Cutoff-day bill", 40.0, "debit", "transaction"),
    ]


# ---------------------------------------------------------------------------
# /dashboard/snapshot additions
# ---------------------------------------------------------------------------

def test_snapshot_returns_available_cash_closings_and_payables(db, user, client):
    from datetime import timedelta

    from app.core.time import naive_utc_now
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntryType

    checking_b = _account(db, user, "Checking B", AccountType.CHECKING, "5000.00")
    savings_a = _account(db, user, "Savings A", AccountType.SAVINGS, "1000.00")
    _account(db, user, "Card C", AccountType.CREDIT, "300.00", billing_cycle_start=5)
    due = (naive_utc_now() + timedelta(days=5)).replace(hour=0, minute=0, second=0, microsecond=0)
    _entry(db, user, "Bill from B", BudgetEntryType.EXPENSE, "1200.00", due,
           account=checking_b, overflow_account_id=savings_a.id,
           end_mode="after_occurrences", max_occurrences=1)

    login = client.post("/api/v1/auth/login",
                        json={"email": user.email, "password": "password123"})
    assert login.status_code == 200, login.text
    r = client.get("/api/v1/dashboard/snapshot",
                   headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert r.status_code == 200, r.text
    body = r.json()

    # Existing fields are still there.
    for key in ("balances", "upcoming_this_month", "monthly_summary",
                "forecast_next_3_months", "goals_progress", "wishlist_next_up"):
        assert key in body

    # Card balances are owed, not cash.
    assert body["available_cash"] == 6000.0

    assert body["payables"] == [{
        "due_date": due.date().isoformat(), "name": "Bill from B", "amount": 1200.0,
        "source": "budget_entry", "source_id": body["payables"][0]["source_id"],
        "account_id": checking_b.id, "account_name": "Checking B",
        "overflow_account_id": savings_a.id, "overflow_account_name": "Savings A",
    }]

    closings = body["account_closings"]
    assert len(closings) == 3
    assert [c["period_label"] for c in closings] == [
        p["period_label"] for p in body["forecast_next_3_months"]
    ]
    final = {a["account_name"]: a["closing_balance"] for a in closings[-1]["by_account"]}
    assert final == {"Checking B": 3800.0, "Savings A": 1000.0}  # no card, no overflow pull
    assert closings[-1]["unassigned_closing"] == 0.0
    assert all(c["overflow_moves"] == [] for c in closings)

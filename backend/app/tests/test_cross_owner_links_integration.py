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


# --- Materialised occurrences --------------------------------------------------
#
# A transaction linked to a recurring entry by ``budget_entry_id`` and dated on
# an occurrence's day stands in for that occurrence. Only the entry creator's
# transactions do: another user's private row naming the entry suppresses
# nothing, and isn't counted as a paid installment.

WINDOW = (datetime(2026, 8, 1), datetime(2026, 9, 1))
OCCURRENCE = datetime(2026, 8, 10)


def _entry_events(db, who, entry_id):
    from app.services.forecast import collect_events

    events = collect_events(db, *WINDOW, user_id=who["id"])
    return [e for e in events if e["source"] == "budget_entry" and e["source_id"] == entry_id]


def _owner_entry_with_stale_link(client, db, people, a, **entry_kw):
    """A's recurring entry, and another user B's own row naming it on its occurrence day."""
    from app.models.account import AccountType
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    b = people()
    b_bank = _account(db, b, "B bank", AccountType.CHECKING, "0")
    entry = BudgetEntry(
        user_id=a["id"], name="A entry", entry_type=BudgetEntryType.EXPENSE,
        amount=Decimal("100"), currency="PHP", cadence=RecurrenceFrequency.MONTHLY,
        next_occurrence=OCCURRENCE, **entry_kw)
    db.add(entry)
    db.commit()
    _stale_txn(db, b, b_bank.id, OCCURRENCE, amount="100", budget_entry_id=entry.id,
               is_posted=False)
    return a, entry


def test_another_users_linked_row_does_not_suppress_a_recurring_transfer(client, db, people):
    from app.models.account import AccountType

    owner = people()
    bank = _account(db, owner, "A bank", AccountType.CHECKING, "1000")
    savings = _account(db, owner, "A savings", AccountType.SAVINGS, "0")
    a, entry = _owner_entry_with_stale_link(
        client, db, people, owner, account_id=bank.id, transfer_to_account_id=savings.id)
    assert len(_entry_events(db, a, entry.id)) == 1


def test_another_users_linked_row_does_not_suppress_a_card_charge(client, db, people):
    from app.models.account import AccountType

    owner = people()
    bank = _account(db, owner, "A bank", AccountType.CHECKING, "1000")
    card = _account(db, owner, "A card", AccountType.CREDIT, "0", billing_cycle_start=15,
                    days_until_due_date=21, payment_account_id=bank.id)
    a, entry = _owner_entry_with_stale_link(client, db, people, owner, account_id=card.id)
    assert len(_entry_events(db, a, entry.id)) == 1


def test_another_users_linked_row_is_not_a_paid_installment(client, db, people):
    from app.models.account import AccountType

    owner = people()
    bank = _account(db, owner, "A bank", AccountType.CHECKING, "1000")
    a, entry = _owner_entry_with_stale_link(
        client, db, people, owner, account_id=bank.id, end_mode="after_occurrences",
        max_occurrences=3)
    r = client.get(f"{API}/budget-entries/{entry.id}", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["occurrences_paid"] == 0


def test_the_creators_own_linked_row_still_suppresses_its_occurrence(client, db, people):
    """The control: a materialised row of the entry's creator stands in for it."""
    from app.models.account import AccountType

    owner = people()
    bank = _account(db, owner, "A bank", AccountType.CHECKING, "1000")
    savings = _account(db, owner, "A savings", AccountType.SAVINGS, "0")
    a, entry = _owner_entry_with_stale_link(
        client, db, people, owner, account_id=bank.id, transfer_to_account_id=savings.id)
    _stale_txn(db, a, bank.id, OCCURRENCE, amount="100", budget_entry_id=entry.id,
               is_posted=False)
    assert _entry_events(db, a, entry.id) == []

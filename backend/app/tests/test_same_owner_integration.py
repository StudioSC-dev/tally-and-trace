"""The same-owner rule, one test per reference column (STU-229).

Every account and every non-account record a record references must belong to
the caller and to the record's owner: routing targets, transaction and
recurring-entry accounts, categories, allocations, recurring entries, the ids
in an allocation's configuration and a wishlist item's category. Pointing any
of them at another user's record is a 404 (never a 403) and stores nothing; the
same request with the caller's own record succeeds.

Everything goes through the HTTP layer, on throwaway users. Skips without a
database.
"""
import os
import secrets

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
WHEN = "2026-10-05T00:00:00"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _post(client, headers, path, body):
    r = client.post(f"{API}{path}", json=body, headers=headers)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture
def world(client, db):
    """Two users, each with a bank, savings, card, category, allocation and recurring entry."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    made, sides = [], {}
    for side in ("mine", "theirs"):
        email = f"sameowner-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Same", last_name="Owner", is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        made.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        bank = _post(client, h, "/accounts/", {
            "name": "Bank", "account_type": "checking", "balance": 10_000})
        sides[side] = {
            "headers": h, "bank": bank,
            "savings": _post(client, h, "/accounts/", {
                "name": "Savings", "account_type": "savings", "balance": 10_000}),
            "card": _post(client, h, "/accounts/", {
                "name": "Card", "account_type": "credit", "balance": 0}),
            "category": _post(client, h, "/categories/", {"name": f"Cat {secrets.token_hex(3)}"}),
            "allocation": _post(client, h, "/allocations/", {
                "account_id": bank, "name": "Fund", "allocation_type": "savings"}),
            "entry": _post(client, h, "/budget-entries/", {
                "name": "Rent", "entry_type": "expense", "amount": 10,
                "next_occurrence": WHEN, "account_id": bank}),
        }

    yield sides

    db.rollback()
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation, Category):
        db.query(model).filter(model.user_id.in_(made)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(made)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(made)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made)).delete(synchronize_session=False)
    db.commit()


# Each case: (resource path, column, create body, update (existing-record body, change)).
# ``m`` holds the caller's ids; ``r`` the referenced side (the caller's, or the other user's).

def _debit(m, **kw):
    return {"account_id": m["bank"], "amount": 10, "transaction_type": "debit",
            "transaction_date": WHEN, **kw}


def _transfer(src, dst):
    return {"account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": dst,
            "amount": 10, "transaction_type": "transfer", "transaction_date": WHEN}


def _entry(m, **kw):
    return {"name": "Bill", "entry_type": "expense", "amount": 10, "next_occurrence": WHEN,
            "account_id": m["bank"], **kw}


def _allocation(m, **kw):
    return {"account_id": m["bank"], "name": "Budget", "allocation_type": "budget", **kw}


CASES = {
    "transactions.account_id": (
        "/transactions/",
        lambda m, r: _debit(m, account_id=r["bank"]),
        lambda m: _debit(m), lambda r: {"account_id": r["bank"]}),
    "transactions.transfer_from_account_id": (
        "/transactions/",
        lambda m, r: _transfer(r["bank"], m["savings"]),
        lambda m: _transfer(m["bank"], m["savings"]),
        lambda r: {"account_id": r["bank"], "transfer_from_account_id": r["bank"]}),
    "transactions.transfer_to_account_id": (
        "/transactions/",
        lambda m, r: _transfer(m["bank"], r["savings"]),
        lambda m: _transfer(m["bank"], m["card"]),
        lambda r: {"transfer_to_account_id": r["savings"]}),
    "transactions.category_id": (
        "/transactions/",
        lambda m, r: _debit(m, category_id=r["category"]),
        lambda m: _debit(m), lambda r: {"category_id": r["category"]}),
    "transactions.allocation_id": (
        "/transactions/",
        lambda m, r: _debit(m, allocation_id=r["allocation"]),
        lambda m: _debit(m), lambda r: {"allocation_id": r["allocation"]}),
    "transactions.budget_entry_id": (
        "/transactions/",
        lambda m, r: _debit(m, budget_entry_id=r["entry"]),
        lambda m: _debit(m), lambda r: {"budget_entry_id": r["entry"]}),
    "budget_entries.account_id": (
        "/budget-entries/",
        lambda m, r: _entry(m, account_id=r["bank"]),
        lambda m: _entry(m), lambda r: {"account_id": r["bank"]}),
    "budget_entries.transfer_to_account_id": (
        "/budget-entries/",
        lambda m, r: _entry(m, transfer_to_account_id=r["savings"]),
        lambda m: _entry(m), lambda r: {"transfer_to_account_id": r["savings"]}),
    "budget_entries.overflow_account_id": (
        "/budget-entries/",
        lambda m, r: _entry(m, overflow_account_id=r["savings"]),
        lambda m: _entry(m), lambda r: {"overflow_account_id": r["savings"]}),
    "budget_entries.category_id": (
        "/budget-entries/",
        lambda m, r: _entry(m, category_id=r["category"]),
        lambda m: _entry(m), lambda r: {"category_id": r["category"]}),
    "budget_entries.allocation_id": (
        "/budget-entries/",
        lambda m, r: _entry(m, allocation_id=r["allocation"]),
        lambda m: _entry(m), lambda r: {"allocation_id": r["allocation"]}),
    "allocations.account_id": (
        "/allocations/",
        lambda m, r: _allocation(m, account_id=r["bank"]),
        lambda m: _allocation(m), lambda r: {"account_id": r["bank"]}),
    "allocations.configuration.category_ids": (
        "/allocations/",
        lambda m, r: _allocation(m, configuration={"category_ids": [r["category"]]}),
        lambda m: _allocation(m),
        lambda r: {"configuration": {"category_ids": [r["category"]]}}),
    "allocations.configuration.account_ids": (
        "/allocations/",
        lambda m, r: _allocation(m, configuration={"account_ids": [r["savings"]]}),
        lambda m: _allocation(m),
        lambda r: {"configuration": {"account_ids": [r["savings"]]}}),
    "allocations.configuration.savings_category_id": (
        "/allocations/",
        lambda m, r: _allocation(m, configuration={"savings_category_id": r["category"]}),
        lambda m: _allocation(m),
        lambda r: {"configuration": {"savings_category_id": r["category"]}}),
    "wishlist_items.category_id": (
        "/wishlist/",
        lambda m, r: {"name": "Bike", "estimated_cost": 5, "category_id": r["category"]},
        lambda m: {"name": "Bike", "estimated_cost": 5},
        lambda r: {"category_id": r["category"]}),
    "accounts.payment_account_id": (
        "/accounts/",
        lambda m, r: {"name": "Card 2", "account_type": "credit", "balance": 0,
                      "payment_account_id": r["bank"]},
        lambda m: {"name": "Card 2", "account_type": "credit", "balance": 0},
        lambda r: {"payment_account_id": r["bank"]}),
    "accounts.payment_overflow_account_id": (
        "/accounts/",
        lambda m, r: {"name": "Card 2", "account_type": "credit", "balance": 0,
                      "payment_account_id": m["bank"],
                      "payment_overflow_account_id": r["savings"]},
        lambda m: {"name": "Card 2", "account_type": "credit", "balance": 0,
                   "payment_account_id": m["bank"]},
        lambda r: {"payment_overflow_account_id": r["savings"]}),
}
COLUMNS = sorted(CASES)


def _count(client, headers, path):
    r = client.get(f"{API}{path}", headers=headers, params={"limit": 200})
    assert r.status_code == 200, r.text
    body = r.json()
    return len(body["items"] if isinstance(body, dict) else body)


@pytest.mark.parametrize("column", COLUMNS)
def test_creating_with_another_users_reference_is_rejected(client, world, column):
    path, create, _, _ = CASES[column]
    mine, theirs = world["mine"], world["theirs"]
    before = _count(client, mine["headers"], path)

    r = client.post(f"{API}{path}", json=create(mine, theirs), headers=mine["headers"])

    assert r.status_code == 404, (column, r.status_code, r.text)
    assert _count(client, mine["headers"], path) == before
    # The caller's own reference is accepted.
    r = client.post(f"{API}{path}", json=create(mine, mine), headers=mine["headers"])
    assert r.status_code in (200, 201), (column, r.text)


@pytest.mark.parametrize("column", COLUMNS)
def test_updating_to_another_users_reference_is_rejected(client, world, column):
    path, _, existing, change = CASES[column]
    mine, theirs = world["mine"], world["theirs"]
    record_id = _post(client, mine["headers"], path, existing(mine))
    before = client.get(f"{API}{path}{record_id}", headers=mine["headers"]).json()

    r = client.put(f"{API}{path}{record_id}", json=change(theirs), headers=mine["headers"])

    assert r.status_code == 404, (column, r.status_code, r.text)
    after = client.get(f"{API}{path}{record_id}", headers=mine["headers"]).json()
    assert {k: v for k, v in after.items() if k != "updated_at"} == {
        k: v for k, v in before.items() if k != "updated_at"}
    # The caller's own reference is accepted.
    r = client.put(f"{API}{path}{record_id}", json=change(mine), headers=mine["headers"])
    assert r.status_code == 200, (column, r.text)


def test_every_reference_column_has_a_case():
    """Each column the same-owner rule names (STU-229 plan, section 1) is covered."""
    assert set(CASES) == {
        "transactions.account_id", "transactions.transfer_from_account_id",
        "transactions.transfer_to_account_id", "transactions.category_id",
        "transactions.allocation_id", "transactions.budget_entry_id",
        "budget_entries.account_id", "budget_entries.transfer_to_account_id",
        "budget_entries.overflow_account_id", "budget_entries.category_id",
        "budget_entries.allocation_id", "allocations.account_id",
        "allocations.configuration.category_ids", "allocations.configuration.account_ids",
        "allocations.configuration.savings_category_id", "wishlist_items.category_id",
        "accounts.payment_account_id", "accounts.payment_overflow_account_id",
    }


# --- A debit or credit's transfer_* fields name no account it touches ---------
#
# Only a transfer touches its transfer_from/transfer_to accounts. A debit or
# credit carrying one (stored by an older client, or left behind by an edit
# from a transfer) must not reach the user who owns that account: not in their
# list, search, period summary, upcoming list, dashboard, projections or export.

STRAY = "Zq7Stray"


def _soon(days=3):
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) + timedelta(days=days)).replace(
        tzinfo=None, hour=0, minute=0, second=0, microsecond=0).isoformat()


def _assert_victim_sees_nothing(client, victim):
    h = victim["headers"]
    for path, params in (
        ("/transactions/", {"limit": 200}),
        ("/transactions/", {"search": STRAY}),
        ("/forecast/upcoming", {"days": 60}),
        ("/forecast/timeline", {"days": 60}),
        ("/forecast/cashflow", {}),
        ("/dashboard/snapshot", {}),
        ("/data/export.json", {}),
    ):
        r = client.get(f"{API}{path}", headers=h, params=params)
        assert r.status_code == 200, (path, r.text)
        assert STRAY not in r.text, path
    assert client.get(f"{API}/transactions/", headers=h).json()["total"] == 0
    assert client.get(f"{API}/data/export.json", headers=h).json()["others_transactions"] == []
    r = client.get(f"{API}/transactions/summary/period", headers=h, params={
        "start_date": "2000-01-01T00:00:00", "end_date": "2100-01-01T00:00:00"})
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["transaction_count"] == 0
    assert r.json()["category_breakdown"] == {}


@pytest.mark.parametrize("txn_type", ["debit", "credit"])
@pytest.mark.parametrize("column", ["transfer_from_account_id", "transfer_to_account_id"])
def test_a_stored_stray_transfer_account_on_a_debit_or_credit_reaches_no_one(
        client, db, world, txn_type, column):
    """Rows already stored with a stray transfer_* id (not just new requests)."""
    from datetime import datetime

    from app.models.transaction import Transaction, TransactionType

    mine, theirs = world["mine"], world["theirs"]
    my_id = db.execute(text("SELECT user_id FROM accounts WHERE id = :a"),
                       {"a": mine["bank"]}).scalar()
    for posted, when in ((True, datetime.fromisoformat(WHEN)),
                         (False, datetime.fromisoformat(_soon()))):
        db.add(Transaction(
            user_id=my_id, account_id=mine["bank"], amount=77, currency="PHP",
            transaction_type=TransactionType(txn_type), transaction_date=when,
            description=f"{STRAY} {txn_type}", is_posted=posted, transfer_fee=0,
            **{column: theirs["bank"]}))
    db.commit()

    _assert_victim_sees_nothing(client, theirs)
    # The victim cannot open it either; its creator still can.
    rows = client.get(f"{API}/transactions/", headers=mine["headers"],
                      params={"search": STRAY}).json()["items"]
    assert len(rows) == 2
    for row in rows:
        r = client.get(f"{API}/transactions/{row['id']}", headers=theirs["headers"])
        assert r.status_code == 404
        assert client.get(f"{API}/transactions/{row['id']}",
                          headers=mine["headers"]).status_code == 200
    # The creator, owner of the row's only touched account, may delete it.
    r = client.delete(f"{API}/transactions/{rows[0]['id']}", headers=mine["headers"])
    assert r.status_code == 200, r.text


MISSING_ACCOUNT = 2_000_000_000  # no such account


@pytest.mark.parametrize("txn_type", ["debit", "credit"])
@pytest.mark.parametrize("column", ["transfer_from_account_id", "transfer_to_account_id"])
def test_creating_a_debit_or_credit_drops_its_transfer_accounts(client, world, txn_type, column):
    mine, theirs = world["mine"], world["theirs"]
    for target in (theirs["bank"], MISSING_ACCOUNT):
        for posted, when in ((True, WHEN), (False, _soon())):
            r = client.post(f"{API}/transactions/", headers=mine["headers"], json={
                "account_id": mine["bank"], "amount": 77, "transaction_type": txn_type,
                "transaction_date": when, "is_posted": posted,
                "description": f"{STRAY} {txn_type}", column: target})
            assert r.status_code == 200, (target, r.status_code, r.text)
            body = r.json()
            assert body["transfer_from_account_id"] is None
            assert body["transfer_to_account_id"] is None
    _assert_victim_sees_nothing(client, theirs)


@pytest.mark.parametrize("txn_type", ["debit", "credit"])
@pytest.mark.parametrize("column", ["transfer_from_account_id", "transfer_to_account_id"])
def test_updating_a_debit_or_credit_drops_its_transfer_accounts(client, world, txn_type, column):
    mine, theirs = world["mine"], world["theirs"]
    for target in (theirs["bank"], MISSING_ACCOUNT):
        for posted, when in ((True, WHEN), (False, _soon())):
            txn_id = _post(client, mine["headers"], "/transactions/", {
                "account_id": mine["bank"], "amount": 77, "transaction_type": txn_type,
                "transaction_date": when, "is_posted": posted,
                "description": f"{STRAY} {txn_type}"})
            r = client.put(f"{API}/transactions/{txn_id}", headers=mine["headers"],
                           json={column: target, "amount": 78})
            assert r.status_code == 200, (target, r.status_code, r.text)
            body = r.json()
            assert body["transfer_from_account_id"] is None
            assert body["transfer_to_account_id"] is None
            assert body["amount"] == 78
    _assert_victim_sees_nothing(client, theirs)


@pytest.mark.parametrize("txn_type", ["debit", "credit"])
def test_editing_a_transfer_into_a_debit_or_credit_clears_its_transfer_accounts(
        client, world, txn_type):
    mine = world["mine"]
    txn_id = _post(client, mine["headers"], "/transactions/",
                   _transfer(mine["bank"], mine["savings"]))
    r = client.put(f"{API}/transactions/{txn_id}", headers=mine["headers"],
                   json={"transaction_type": txn_type})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["account_id"] == mine["bank"]
    assert body["transfer_from_account_id"] is None
    assert body["transfer_to_account_id"] is None

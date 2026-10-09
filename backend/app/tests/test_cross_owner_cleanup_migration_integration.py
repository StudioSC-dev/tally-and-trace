"""Migration e5b7c9d1f3a6 (clear cross-owner links, STU-229).

The entity era left rows that reference another user's category, allocation
or recurring entry. The migration nulls every such non-account reference,
strips another user's ids from ``allocations.configuration``, and clears stray
``transfer_*`` accounts on non-transfers. Account references are kept: a
cross-owner account reference is a legitimate pool row.

The first test runs alembic in a subprocess on a throwaway database (on the
same server as ``DATABASE_URL``) seeded at d1e3a5c7b9f2. The two regression
tests plant stale rows in the test database, run the migration's ``upgrade``
in-process, and then drive the routers. Skips without a database; the head
check needs none.
"""
import importlib.util
import json
import os
import secrets
import subprocess
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[2]
DEMO_STATE = "d1e3a5c7b9f2"
CLEANUP = "e5b7c9d1f3a6"
MIGRATION = BACKEND_DIR / "migrations" / "versions" / f"{CLEANUP}_clear_cross_owner_links.py"
API = "/api/v1"
PASSWORD = "Password123!"


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


needs_db = pytest.mark.skipif(not _db_reachable(), reason="no database available")


def test_cleanup_follows_demo_state_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert CLEANUP in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(CLEANUP).down_revision == DEMO_STATE


# --- Migration on a scratch database -------------------------------------------


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_links_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


def _insert(c, table, **values):
    cols = ", ".join(values)
    params = ", ".join(
        f"CAST(:{k} AS jsonb)" if k == "configuration" else f":{k}" for k in values)
    if "configuration" in values and values["configuration"] is not None:
        values = {**values, "configuration": json.dumps(values["configuration"])}
    return c.execute(text(
        f"INSERT INTO {table} ({cols}) VALUES ({params}) RETURNING id"), values).scalar_one()


def _row(c, table, row_id, *cols):
    return dict(c.execute(text(
        f"SELECT {', '.join(cols)} FROM {table} WHERE id = :i"), {"i": row_id}).mappings().one())


SNAPSHOT_TABLES = ("transactions", "budget_entries", "wishlist_items", "allocations", "accounts")


def _snapshot(c):
    """Every row of the touched tables, with ``xmin`` so a rewrite shows."""
    return {
        table: c.execute(text(
            f"SELECT xmin::text AS xmin, t.* FROM {table} t ORDER BY id")).mappings().all()
        for table in SNAPSHOT_TABLES
    }


def _seed(c):
    """Two users with cross-owner links of every kind, plus same-owner controls."""
    ids = {}
    for who in ("a", "b"):
        ids[who] = _insert(c, "users", email=f"{who}-links@example.com", password_hash="x",
                           first_name="Links", last_name=who.upper())
    a, b = ids["a"], ids["b"]
    ids["a_bank"] = _insert(c, "accounts", user_id=a, name="A bank",
                            account_type="checking", balance=0, currency="PHP")
    ids["b_bank"] = _insert(c, "accounts", user_id=b, name="B bank",
                            account_type="checking", balance=0, currency="PHP")
    # Card routing onto another user's account: an account reference, kept.
    ids["a_card"] = _insert(c, "accounts", user_id=a, name="A card", account_type="credit",
                            balance=0, currency="PHP", payment_account_id=ids["b_bank"],
                            payment_overflow_account_id=ids["b_bank"])
    ids["a_cat"] = _insert(c, "categories", user_id=a, name="A cat")
    ids["b_cat"] = _insert(c, "categories", user_id=b, name="B cat")
    ids["b_alloc"] = _insert(c, "allocations", user_id=b, account_id=ids["b_bank"],
                             name="B fund", allocation_type="budget",
                             configuration={"category_ids": [ids["b_cat"]]})
    ids["a_alloc"] = _insert(
        c, "allocations", user_id=a, account_id=ids["a_bank"], name="A budget",
        allocation_type="budget",
        configuration={
            "category_ids": [ids["a_cat"], ids["b_cat"], str(ids["b_cat"]), 999999, "junk"],
            "account_ids": [ids["a_bank"], ids["b_bank"], str(ids["b_bank"])],
            "savings_category_id": ids["b_cat"],
            "start_date": "2026-01-01",
        })
    # Same-owner config, on another user's account (an account reference, kept).
    ids["a_alloc_ok"] = _insert(
        c, "allocations", user_id=a, account_id=ids["b_bank"], name="A savings",
        allocation_type="savings",
        configuration={"savings_category_id": str(ids["a_cat"]),
                       "account_ids": [ids["a_bank"]], "category_ids": [ids["a_cat"]]})
    ids["a_alloc_null"] = _insert(c, "allocations", user_id=a, account_id=ids["a_bank"],
                                  name="A plain", allocation_type="savings",
                                  configuration=None)

    entry = dict(entry_type="expense", amount=100, currency="PHP",
                 next_occurrence=datetime(2026, 8, 10), end_mode="indefinite")
    ids["b_entry"] = _insert(c, "budget_entries", user_id=b, name="B entry",
                             account_id=ids["b_bank"], **entry)
    ids["a_entry_x"] = _insert(c, "budget_entries", user_id=a, name="A cross",
                               account_id=ids["a_bank"], category_id=ids["b_cat"],
                               allocation_id=ids["b_alloc"], **entry)
    ids["a_entry_ok"] = _insert(c, "budget_entries", user_id=a, name="A own",
                                account_id=ids["a_bank"], category_id=ids["a_cat"],
                                allocation_id=ids["a_alloc"], **entry)
    # Every account reference on an entry pointing at B's account: kept.
    ids["a_entry_pool"] = _insert(c, "budget_entries", user_id=a, name="A pool",
                                  account_id=ids["b_bank"], overflow_account_id=ids["b_bank"],
                                  transfer_to_account_id=ids["b_bank"], **entry)

    txn = dict(amount=5, transfer_fee=0, transaction_date=datetime(2026, 8, 10))
    ids["a_txn_x"] = _insert(c, "transactions", user_id=a, account_id=ids["a_bank"],
                             transaction_type="debit", category_id=ids["b_cat"],
                             allocation_id=ids["b_alloc"], budget_entry_id=ids["b_entry"],
                             **txn)
    ids["a_txn_ok"] = _insert(c, "transactions", user_id=a, account_id=ids["a_bank"],
                              transaction_type="debit", category_id=ids["a_cat"],
                              allocation_id=ids["a_alloc"], budget_entry_id=ids["a_entry_ok"],
                              **txn)
    ids["a_txn_pool"] = _insert(c, "transactions", user_id=a, account_id=ids["b_bank"],
                                transaction_type="credit", **txn)
    ids["a_debit_stray"] = _insert(c, "transactions", user_id=a, account_id=ids["a_bank"],
                                   transaction_type="debit",
                                   transfer_from_account_id=ids["a_bank"],
                                   transfer_to_account_id=ids["b_bank"], **txn)
    ids["a_credit_stray"] = _insert(c, "transactions", user_id=a, account_id=ids["a_bank"],
                                    transaction_type="credit",
                                    transfer_to_account_id=ids["a_bank"], **txn)
    ids["a_transfer"] = _insert(c, "transactions", user_id=a, account_id=ids["a_bank"],
                                transaction_type="transfer",
                                transfer_from_account_id=ids["a_bank"],
                                transfer_to_account_id=ids["b_bank"], **txn)

    ids["a_wish_x"] = _insert(c, "wishlist_items", user_id=a, name="A wish",
                              estimated_cost=10, category_id=ids["b_cat"])
    ids["a_wish_ok"] = _insert(c, "wishlist_items", user_id=a, name="A own wish",
                               estimated_cost=10, category_id=ids["a_cat"])
    return ids


def _config(c, allocation_id):
    return _row(c, "allocations", allocation_id, "configuration")["configuration"]


@needs_db
def test_cleanup_clears_cross_owner_links_and_keeps_everything_else(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", DEMO_STATE)
        with engine.begin() as c:
            ids = _seed(c)

        _alembic(scratch_url, "upgrade", CLEANUP)
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == CLEANUP

            # Every cross-owner non-account reference is gone.
            assert _row(c, "transactions", ids["a_txn_x"],
                        "category_id", "allocation_id", "budget_entry_id", "account_id") == {
                "category_id": None, "allocation_id": None, "budget_entry_id": None,
                "account_id": ids["a_bank"]}
            assert _row(c, "budget_entries", ids["a_entry_x"],
                        "category_id", "allocation_id", "account_id") == {
                "category_id": None, "allocation_id": None, "account_id": ids["a_bank"]}
            assert _row(c, "wishlist_items", ids["a_wish_x"], "category_id") == {
                "category_id": None}
            # Another user's ids leave the lists (order and the rest kept), and a
            # savings category of theirs leaves the object.
            assert _config(c, ids["a_alloc"]) == {
                "category_ids": [ids["a_cat"], 999999, "junk"],
                "account_ids": [ids["a_bank"]],
                "start_date": "2026-01-01",
            }

            # Same-owner references are unchanged.
            assert _row(c, "transactions", ids["a_txn_ok"],
                        "category_id", "allocation_id", "budget_entry_id") == {
                "category_id": ids["a_cat"], "allocation_id": ids["a_alloc"],
                "budget_entry_id": ids["a_entry_ok"]}
            assert _row(c, "budget_entries", ids["a_entry_ok"],
                        "category_id", "allocation_id") == {
                "category_id": ids["a_cat"], "allocation_id": ids["a_alloc"]}
            assert _row(c, "wishlist_items", ids["a_wish_ok"], "category_id") == {
                "category_id": ids["a_cat"]}
            assert _config(c, ids["a_alloc_ok"]) == {
                "savings_category_id": str(ids["a_cat"]), "account_ids": [ids["a_bank"]],
                "category_ids": [ids["a_cat"]]}
            assert _config(c, ids["b_alloc"]) == {"category_ids": [ids["b_cat"]]}
            assert _config(c, ids["a_alloc_null"]) is None

            # Account references are unchanged, cross-owner ones included.
            assert _row(c, "transactions", ids["a_txn_pool"], "account_id") == {
                "account_id": ids["b_bank"]}
            assert _row(c, "budget_entries", ids["a_entry_pool"], "account_id",
                        "overflow_account_id", "transfer_to_account_id") == {
                "account_id": ids["b_bank"], "overflow_account_id": ids["b_bank"],
                "transfer_to_account_id": ids["b_bank"]}
            assert _row(c, "accounts", ids["a_card"], "payment_account_id",
                        "payment_overflow_account_id") == {
                "payment_account_id": ids["b_bank"],
                "payment_overflow_account_id": ids["b_bank"]}
            assert _row(c, "allocations", ids["a_alloc_ok"], "account_id") == {
                "account_id": ids["b_bank"]}

            # Stray transfer accounts leave non-transfers; a transfer keeps its own.
            for stray in ("a_debit_stray", "a_credit_stray"):
                assert _row(c, "transactions", ids[stray], "transfer_from_account_id",
                            "transfer_to_account_id", "account_id") == {
                    "transfer_from_account_id": None, "transfer_to_account_id": None,
                    "account_id": ids["a_bank"]}
            assert _row(c, "transactions", ids["a_transfer"], "transfer_from_account_id",
                        "transfer_to_account_id") == {
                "transfer_from_account_id": ids["a_bank"],
                "transfer_to_account_id": ids["b_bank"]}
            clean = _snapshot(c)

        # Downgrade is a no-op on data; upgrading again over clean data rewrites
        # no row (``xmin`` included).
        _alembic(scratch_url, "downgrade", "-1")
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == DEMO_STATE
            assert _snapshot(c) == clean
        _alembic(scratch_url, "upgrade", CLEANUP)
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == CLEANUP
            assert _snapshot(c) == clean
    finally:
        engine.dispose()


# --- Regression: the stale links the audits found ------------------------------


def _run_cleanup():
    """Apply the migration's ``upgrade`` to the test database in-process."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from app.core.database import engine

    spec = importlib.util.spec_from_file_location("cleanup_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()


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
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.models.user import User

    users = []

    def make():
        email = f"cleanup-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Cleanup", last_name="Probe", is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        users.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": u.id, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    yield make

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id.in_(users)).delete(
        synchronize_session=False)
    db.query(BudgetEntry).filter(BudgetEntry.user_id.in_(users)).delete(
        synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
    db.commit()


def _bank(db, who, name):
    from app.models.account import Account, AccountType

    a = Account(user_id=who["id"], name=name, account_type=AccountType.CHECKING,
                balance=Decimal("0"))
    db.add(a)
    db.commit()
    return a.id


def _entry(db, who, account_id):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    e = BudgetEntry(user_id=who["id"], name="Entry", entry_type=BudgetEntryType.EXPENSE,
                    amount=Decimal("100"), currency="PHP", account_id=account_id,
                    cadence=RecurrenceFrequency.MONTHLY, next_occurrence=datetime(2026, 8, 10))
    db.add(e)
    db.commit()
    return e.id


def _stale_txn(db, who, account_id, budget_entry_id):
    """A row of ``who``'s naming another user's recurring entry, as the entity era left it."""
    from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType

    t = Transaction(user_id=who["id"], account_id=account_id, amount=Decimal("100"),
                    currency="PHP", transaction_type=TransactionType.DEBIT,
                    transaction_date=datetime(2026, 8, 10), description="Stale link",
                    transfer_fee=0, budget_entry_id=budget_entry_id, is_recurring=True,
                    recurrence_frequency=RecurrenceFrequency.MONTHLY)
    db.add(t)
    db.commit()
    return t.id


def _txn_row(db, txn_id):
    return dict(db.execute(text("SELECT xmin::text AS xmin, * FROM transactions WHERE id = :i"),
                           {"i": txn_id}).mappings().one())


@needs_db
def test_another_users_cadence_change_never_reaches_a_cleaned_row(client, db, people):
    """After the upgrade, A's row no longer names B's entry, so B's cadence stays B's.

    Before the cleanup, A resubmitting the stored ``budget_entry_id`` unchanged
    copied B's current cadence into A's ``recurrence_frequency``. That code path
    (``routers/transactions.py``) is unchanged; this passes because the
    migration removed the stale link it followed, and the same-owner rule stops
    a new one.
    """
    a, b = people(), people()
    a_bank, b_bank = _bank(db, a, "A bank"), _bank(db, b, "B bank")
    b_entry = _entry(db, b, b_bank)
    txn = _stale_txn(db, a, a_bank, b_entry)

    _run_cleanup()
    r = client.put(f"{API}/budget-entries/{b_entry}", json={"cadence": "weekly"},
                   headers=b["headers"])
    assert r.status_code == 200, r.text

    r = client.get(f"{API}/transactions/{txn}", headers=a["headers"])
    assert r.status_code == 200, r.text
    r = client.put(f"{API}/transactions/{txn}", headers=a["headers"], json={
        "budget_entry_id": r.json()["budget_entry_id"], "description": "Edited"})
    assert r.status_code == 200, r.text
    assert r.json()["recurrence_frequency"] != "weekly"
    assert r.json()["budget_entry_id"] is None
    # Naming B's entry again is a new reference, refused by the same-owner rule.
    r = client.put(f"{API}/transactions/{txn}", headers=a["headers"],
                   json={"budget_entry_id": b_entry})
    assert r.status_code == 404, r.text
    assert _txn_row(db, txn)["budget_entry_id"] is None


@needs_db
def test_deleting_an_entry_leaves_another_users_row_untouched(client, db, people):
    """After the upgrade, deleting A's entry changes nothing on B's row.

    Before the cleanup, B's row still named A's entry, and the delete nulled
    its ``budget_entry_id`` through ``BudgetEntry.transactions``. That
    relationship is unchanged; this passes because the migration removed the
    stale link, so the delete has nothing of B's to reach.
    """
    a, b = people(), people()
    a_bank, b_bank = _bank(db, a, "A bank"), _bank(db, b, "B bank")
    a_entry = _entry(db, a, a_bank)
    b_txn = _stale_txn(db, b, b_bank, a_entry)

    _run_cleanup()
    before = _txn_row(db, b_txn)

    r = client.delete(f"{API}/budget-entries/{a_entry}", headers=a["headers"])
    assert r.status_code == 204, r.text
    db.expire_all()
    assert _txn_row(db, b_txn) == before  # not rewritten (xmin included)
    assert before["budget_entry_id"] is None

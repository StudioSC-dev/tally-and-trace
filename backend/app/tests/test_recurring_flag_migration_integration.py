"""Migration e7a1d3f5b9c2 (sync the transaction recurring flag, STU-485).

``is_recurring`` must equal ``budget_entry_id IS NOT NULL`` on every row:
shared views read the flag because they do not see the link. The migration
clears a stale flag (and its ``recurrence_frequency``) on unlinked rows and
sets it on linked rows that read ``False``.

The test runs alembic in a subprocess on a throwaway database (on the same
server as ``DATABASE_URL``) seeded at d9a1c3e5f7b2. Skips without a database;
the head check needs none.
"""
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[2]
PAGE_OPEN = "d9a1c3e5f7b2"
SYNC = "e7a1d3f5b9c2"

# The gate 0b query: every row whose flag contradicts its link.
MISMATCHES = ("SELECT count(*) FROM transactions "
              "WHERE is_recurring <> (budget_entry_id IS NOT NULL)")


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


def test_sync_follows_page_open_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert SYNC in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(SYNC).down_revision == PAGE_OPEN


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_recurflag_{os.urandom(3).hex()}"
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
    params = ", ".join(f":{k}" for k in values)
    return c.execute(text(
        f"INSERT INTO {table} ({cols}) VALUES ({params}) RETURNING id"), values).scalar_one()


def _row(c, row_id):
    return dict(c.execute(text(
        "SELECT xmin::text AS xmin, is_recurring, recurrence_frequency::text AS frequency, "
        "budget_entry_id, is_posted FROM transactions WHERE id = :i"),
        {"i": row_id}).mappings().one())


def _snapshot(c):
    """Every transaction, with ``xmin`` so a rewrite shows."""
    return c.execute(text(
        "SELECT xmin::text AS xmin, t.* FROM transactions t ORDER BY id")).mappings().all()


def _seed(c):
    """One row of each kind the table in the plan names, (a) to (e)."""
    ids = {}
    ids["user"] = _insert(c, "users", email="recurflag@example.com", password_hash="x",
                          first_name="Flag", last_name="Probe")
    ids["bank"] = _insert(c, "accounts", user_id=ids["user"], name="Bank",
                          account_type="checking", balance=0, currency="PHP")
    ids["entry"] = _insert(c, "budget_entries", user_id=ids["user"], name="Water",
                           entry_type="expense", amount=100, currency="PHP",
                           account_id=ids["bank"], next_occurrence=datetime(2026, 8, 10),
                           end_mode="indefinite")
    txn = dict(user_id=ids["user"], account_id=ids["bank"], amount=5, transfer_fee=0,
               transaction_type="debit", transaction_date=datetime(2026, 8, 10))
    # (a) stale: the entry was deleted, the flag and frequency stayed.
    ids["a"] = _insert(c, "transactions", is_posted=False, is_recurring=True,
                       recurrence_frequency="monthly", **txn)
    # (b) legacy: linked, but the flag was never set.
    ids["b"] = _insert(c, "transactions", is_posted=False, is_recurring=False,
                       recurrence_frequency="quarterly", budget_entry_id=ids["entry"], **txn)
    # (c) linked and flagged: already right.
    ids["c"] = _insert(c, "transactions", is_posted=False, is_recurring=True,
                       recurrence_frequency="monthly", budget_entry_id=ids["entry"], **txn)
    # (d) a plain one-off: already right.
    ids["d"] = _insert(c, "transactions", is_posted=False, is_recurring=False, **txn)
    # (e) posted and stale: fixed like (a).
    ids["e"] = _insert(c, "transactions", is_posted=True, is_recurring=True,
                       recurrence_frequency="monthly", **txn)
    return ids


@needs_db
def test_sync_makes_the_flag_follow_the_link(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PAGE_OPEN)
        with engine.begin() as c:
            ids = _seed(c)
        with engine.connect() as c:
            assert c.execute(text(MISMATCHES)).scalar_one() == 3  # (a), (b), (e)
            before = {k: _row(c, ids[k]) for k in "abcde"}

        _alembic(scratch_url, "upgrade", SYNC)
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == SYNC
            after = {k: _row(c, ids[k]) for k in "abcde"}

            # (a) and (e): the stale flag and its frequency are cleared, posted or not.
            for k, posted in (("a", False), ("e", True)):
                assert {key: after[k][key] for key in
                        ("is_recurring", "frequency", "budget_entry_id", "is_posted")} == {
                    "is_recurring": False, "frequency": None, "budget_entry_id": None,
                    "is_posted": posted}
            # (b): the flag is set; the frequency is left as it was.
            assert {key: after["b"][key] for key in
                    ("is_recurring", "frequency", "budget_entry_id")} == {
                "is_recurring": True, "frequency": "quarterly",
                "budget_entry_id": ids["entry"]}
            # (c) and (d): untouched, not even rewritten (xmin included).
            assert after["c"] == before["c"]
            assert after["d"] == before["d"]
            assert (after["c"]["is_recurring"], after["c"]["frequency"]) == (True, "monthly")

            # The gate 0b query finds nothing.
            assert c.execute(text(MISMATCHES)).scalar_one() == 0
            clean = _snapshot(c)

        # The downgrade is a no-op on data; upgrading again over clean data
        # rewrites no row.
        _alembic(scratch_url, "downgrade", "-1")
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == PAGE_OPEN
            assert _snapshot(c) == clean
        _alembic(scratch_url, "upgrade", SYNC)
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == SYNC
            assert _snapshot(c) == clean
    finally:
        engine.dispose()

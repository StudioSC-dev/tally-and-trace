"""Migration M2 (spending wallets + recurring transfer entries).

Runs alembic in a subprocess against a throwaway database created on the same
server as ``DATABASE_URL``: a fresh database upgrades to head, downgrades to the
merged M1 head, and upgrades again from it with existing cash, e-wallet and bank
accounts, which must backfill ``is_spending_wallet`` by account type, except
cash / e-wallet accounts a routing rule draws on (card statement payment or
overflow, budget entry overflow), which stay non-wallets. Skips without a
database; the single-head check needs none.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[2]
M1_HEAD = "a4d8e2c6f1b9"
M2 = "b9e3f1a7c5d2"


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


def test_alembic_has_a_single_head_which_is_m2():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    assert script.get_heads() == [M2]
    assert script.get_revision(M2).down_revision == M1_HEAD


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_m2_{os.urandom(3).hex()}"
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


def _columns(conn, table):
    return {
        row[0] for row in conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ), {"t": table})
    }


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_m2_applies_fresh_and_from_m1_head_backfills_and_downgrades(scratch_url):
    # Fresh database straight to head.
    _alembic(scratch_url, "upgrade", "head")
    engine = create_engine(scratch_url)
    try:
        with engine.connect() as c:
            assert "is_spending_wallet" in _columns(c, "accounts")
            assert "transfer_to_account_id" in _columns(c, "budget_entries")

        # Back to the merged M1 head, which must drop both columns cleanly.
        _alembic(scratch_url, "downgrade", M1_HEAD)
        with engine.begin() as c:
            assert "is_spending_wallet" not in _columns(c, "accounts")
            assert "transfer_to_account_id" not in _columns(c, "budget_entries")
            user_id = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('m2@example.com', 'x', 'M', 'Two') RETURNING id"
            )).scalar_one()
            ids = {}
            for name, kind in (("Cash", "cash"), ("GCash", "e_wallet"),
                               ("Bank", "savings"), ("Chk", "checking"), ("Card", "credit"),
                               ("PayCash", "cash"), ("OverGCash", "e_wallet"),
                               ("EntryCash", "cash")):
                ids[name] = c.execute(text(
                    "INSERT INTO accounts (user_id, name, account_type, balance, currency) "
                    "VALUES (:u, :n, CAST(:t AS accounttype), 0, 'PHP') RETURNING id"
                ), {"u": user_id, "n": name, "t": kind}).scalar_one()
            # Pre-existing routing onto a cash and an e-wallet account.
            c.execute(text(
                "UPDATE accounts SET payment_account_id = :p, payment_overflow_account_id = :o "
                "WHERE id = :card"
            ), {"p": ids["PayCash"], "o": ids["OverGCash"], "card": ids["Card"]})
            c.execute(text(
                "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, "
                "cadence, next_occurrence, account_id, overflow_account_id, is_autopay, "
                "is_active, lead_time_days, end_mode) "
                "VALUES (:u, 'expense', 'Rent', 100, 'PHP', 'monthly', '2026-11-01', "
                ":a, :o, false, true, 0, 'indefinite')"
            ), {"u": user_id, "a": ids["Bank"], "o": ids["EntryCash"]})

        # From the M1 head with existing rows: backfill by account type, skipping
        # routing targets.
        _alembic(scratch_url, "upgrade", "head")
        with engine.connect() as c:
            flags = dict(c.execute(text("SELECT name, is_spending_wallet FROM accounts")).all())
            assert flags == {"Cash": True, "GCash": True, "Bank": False,
                             "Chk": False, "Card": False,
                             # Routing targets stay funding accounts.
                             "PayCash": False, "OverGCash": False, "EntryCash": False}
            current = c.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            assert current == M2
    finally:
        engine.dispose()

"""``wishlist_items`` payment plan migration (STU-779).

Upgrading from the previous revision adds ``account_id``, ``payment_plan`` (every
existing row reads ``full``), ``installment_months`` and ``installment_entry_id``
(unique, cleared when its entry is deleted); the check constraint ties the months to
the plan. The downgrade drops them and keeps the rows. Run on a scratch database
that already holds an item. Skips without a database.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "f5905076b019"
PAYMENT_PLAN = "a7c3e5f9b1d2"
NEW_COLUMNS = {"account_id", "payment_plan", "installment_months", "installment_entry_id"}


def test_payment_plan_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert PAYMENT_PLAN in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(PAYMENT_PLAN).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_wishplan_{os.urandom(3).hex()}"
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
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _columns(c):
    return {col["name"]: col for col in inspect(c).get_columns("wishlist_items")}


def _entry(c, user):
    return c.execute(text(
        "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, cadence, "
        "next_occurrence, lead_time_days, semi_monthly_day_1, semi_monthly_day_2, end_mode, "
        "max_occurrences) VALUES (:u, 'expense', 'Laptop', 1000, 'PHP', 'monthly', "
        "'2026-12-15T00:00:00Z', 0, 1, 15, 'after_occurrences', 6) RETURNING id"),
        {"u": user}).scalar_one()


def test_payment_plan_migration_round_trip(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert not NEW_COLUMNS & set(_columns(c))
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
                "is_verified) VALUES ('wish-plan@example.com', 'x', 'Wish', 'Probe', true, "
                "true) RETURNING id")).scalar_one()
            item = c.execute(text(
                "INSERT INTO wishlist_items (user_id, name, estimated_cost, currency, priority, "
                "is_purchased) VALUES (:u, 'Laptop', 6000, 'PHP', 'medium', false) RETURNING id"),
                {"u": user}).scalar_one()
            card = c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, currency, balance, is_active) "
                "VALUES (:u, 'Card', 'credit', 'PHP', 0, true) RETURNING id"),
                {"u": user}).scalar_one()

        _alembic(scratch_url, "upgrade", PAYMENT_PLAN)
        with engine.begin() as c:
            columns = _columns(c)
            assert NEW_COLUMNS <= set(columns)
            assert columns["payment_plan"]["nullable"] is False
            assert all(columns[n]["nullable"] for n in NEW_COLUMNS - {"payment_plan"})
            row = c.execute(text(
                "SELECT payment_plan, installment_months, account_id, installment_entry_id "
                "FROM wishlist_items WHERE id = :i"), {"i": item}).one()
            assert tuple(row) == ("full", None, None, None)
            entry = _entry(c, user)
            c.execute(text(
                "UPDATE wishlist_items SET payment_plan = 'installment', installment_months = 6, "
                "account_id = :a, installment_entry_id = :e WHERE id = :i"),
                {"a": card, "e": entry, "i": item})

        # The months follow the plan: 2 to 60 on an installment, none on a full payment.
        for months, plan in ((None, "installment"), (1, "installment"), (61, "installment"),
                             (6, "full")):
            with pytest.raises(IntegrityError, match="ck_wishlist_items_installment_months"):
                with engine.begin() as c:
                    c.execute(text(
                        "UPDATE wishlist_items SET payment_plan = :p, installment_months = :m "
                        "WHERE id = :i"), {"p": plan, "m": months, "i": item})
        # One item per entry.
        with pytest.raises(IntegrityError, match="uq_wishlist_items_installment_entry_id"):
            with engine.begin() as c:
                c.execute(text(
                    "INSERT INTO wishlist_items (user_id, name, estimated_cost, currency, "
                    "priority, is_purchased, installment_entry_id) VALUES (:u, 'Again', 1, "
                    "'PHP', 'medium', false, :e)"), {"u": user, "e": entry})
        # Deleting the entry (or the account) clears the link and keeps the item.
        with engine.begin() as c:
            c.execute(text("DELETE FROM budget_entries WHERE id = :e"), {"e": entry})
            c.execute(text("DELETE FROM accounts WHERE id = :a"), {"a": card})
            row = c.execute(text(
                "SELECT account_id, installment_entry_id FROM wishlist_items WHERE id = :i"),
                {"i": item}).one()
            assert tuple(row) == (None, None)

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert not NEW_COLUMNS & set(_columns(c))
            assert c.execute(text("SELECT name FROM wishlist_items WHERE id = :i"),
                             {"i": item}).scalar_one() == "Laptop"
            assert c.execute(text(
                "SELECT count(*) FROM pg_type WHERE typname = 'wishlistpaymentplan'")
            ).scalar_one() == 0

        _alembic(scratch_url, "upgrade", "head")
    finally:
        engine.dispose()

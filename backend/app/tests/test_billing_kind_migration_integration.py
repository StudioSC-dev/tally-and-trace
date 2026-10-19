"""``budget_entries.billing_kind`` migration and backfill (STU-343, plan section 2.1).

Upgrading from the previous revision backfills open-ended card expenses: ``bill``
when the creator's own active category is Utilities (any case), ``subscription``
otherwise. Capped card expenses, cash expenses and income on a card stay null. The
check constraint admits only ``subscription`` and ``bill``; the downgrade drops the
column. Run on a scratch database with rows. Skips without a database.
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
PREVIOUS = "c4e8a2f6b1d9"
BILLING_KIND = "b7d3f1a9c5e2"


def test_billing_kind_follows_main_account_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert BILLING_KIND in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(BILLING_KIND).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_billingkind_{os.urandom(3).hex()}"
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
    return {col["name"]: col for col in inspect(c).get_columns("budget_entries")}


def _version(c):
    return c.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def _user(c, email):
    return c.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
        "is_verified) VALUES (:e, 'x', 'Bill', 'Probe', true, true) RETURNING id"),
        {"e": email}).scalar_one()


def _account(c, user, name, kind):
    return c.execute(text(
        "INSERT INTO accounts (user_id, name, account_type) VALUES (:u, :n, :k) RETURNING id"),
        {"u": user, "n": name, "k": kind}).scalar_one()


def _category(c, user, name, active=True):
    return c.execute(text(
        "INSERT INTO categories (user_id, name, is_active) VALUES (:u, :n, :a) RETURNING id"),
        {"u": user, "n": name, "a": active}).scalar_one()


def _entry(c, user, name, account, category=None, entry_type="expense", end_mode="indefinite",
           max_occurrences=None):
    return c.execute(text(
        "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, cadence, "
        "next_occurrence, lead_time_days, semi_monthly_day_1, semi_monthly_day_2, end_mode, "
        "max_occurrences, account_id, category_id) VALUES (:u, :t, :n, 1, 'PHP', 'monthly', "
        "'2026-10-31T00:00:00Z', 0, 1, 15, :m, :x, :a, :c) RETURNING id"),
        {"u": user, "t": entry_type, "n": name, "m": end_mode, "x": max_occurrences,
         "a": account, "c": category}).scalar_one()


def test_upgrade_backfills_card_expenses_and_downgrades(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert "billing_kind" not in _columns(c)
            me = _user(c, "billing-me@example.com")
            other = _user(c, "billing-other@example.com")
            card = _account(c, me, "Card", "credit")
            checking = _account(c, me, "Checking", "checking")
            utilities = _category(c, me, "UTILITIES")
            entertainment = _category(c, me, "Entertainment")
            others_utilities = _category(c, other, "Utilities")
            deleted_utilities = _category(c, me, "Utilities", active=False)
            ids = {
                "utilities": _entry(c, me, "Meralco", card, utilities),
                "entertainment": _entry(c, me, "Netflix", card, entertainment),
                "uncategorised": _entry(c, me, "Misc", card),
                "others_utilities": _entry(c, me, "Borrowed", card, others_utilities),
                "deleted_utilities": _entry(c, me, "Old", card, deleted_utilities),
                "capped": _entry(c, me, "iPhone", card, end_mode="after_occurrences",
                                 max_occurrences=24),
                "cash": _entry(c, me, "Rent", checking, utilities),
                "income_on_card": _entry(c, me, "Cashback", card, entry_type="income"),
            }

        _alembic(scratch_url, "upgrade", BILLING_KIND)
        with engine.begin() as c:
            assert _version(c) == BILLING_KIND
            column = _columns(c)["billing_kind"]
            assert column["nullable"] and column["type"].length == 16
            stored = dict(c.execute(text("SELECT id, billing_kind FROM budget_entries")).all())
            assert {name: stored[i] for name, i in ids.items()} == {
                "utilities": "bill",
                "entertainment": "subscription",
                "uncategorised": "subscription",
                "others_utilities": "subscription",
                "deleted_utilities": "subscription",
                "capped": None,
                "cash": None,
                "income_on_card": None,
            }

        with pytest.raises(IntegrityError):
            with engine.begin() as c:
                c.execute(text("UPDATE budget_entries SET billing_kind = 'other' "
                               "WHERE id = :e"), {"e": ids["utilities"]})
        with engine.begin() as c:
            c.execute(text("UPDATE budget_entries SET billing_kind = NULL WHERE id = :e"),
                      {"e": ids["utilities"]})

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert "billing_kind" not in _columns(c)
            assert c.execute(text("SELECT name FROM budget_entries WHERE id = :e"),
                             {"e": ids["cash"]}).scalar_one() == "Rent"
    finally:
        engine.dispose()

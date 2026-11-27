"""The budget periods migration (STU-795) on a scratch database.

``d9b3f5a7c2e8`` adds ``allocations.carry_over_from`` and the ``budget_periods``
table (with the data version trigger) and strips ``account_ids`` from every
budget's configuration, leaving other types' configurations alone. There is no
backfill. The downgrade drops both; a stripped key is not restored. Skips without
a database.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.core import data_version
from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "c4e8a2d6f1b9"
PERIODS = "d9b3f5a7c2e8"


def test_budget_period_migration_has_one_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert PERIODS in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(PERIODS).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_budgetperiods_{os.urandom(3).hex()}"
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
    return result


def _allocation(c, user, kind, configuration):
    return c.execute(text(
        "INSERT INTO allocations (user_id, name, allocation_type, current_amount, "
        "configuration, is_active) VALUES (:u, 'Fund', :k, 0, CAST(:c AS jsonb), true) "
        "RETURNING id"), {"u": user, "k": kind, "c": configuration}).scalar_one()


def _configuration(c, allocation):
    return c.execute(text("SELECT configuration FROM allocations WHERE id = :a"),
                     {"a": allocation}).scalar_one()


def _has_table(c):
    return "budget_periods" in inspect(c).get_table_names()


def _columns(c):
    return {col["name"] for col in inspect(c).get_columns("allocations")}


def test_budget_period_migration_up_and_down(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
                "is_verified) VALUES ('periods@example.com', 'x', 'Budget', 'Probe', true, "
                "true) RETURNING id")).scalar_one()
            selected = _allocation(c, user, "budget",
                                   '{"category_ids": [1], "account_ids": [7, 8]}')
            emptied = _allocation(c, user, "budget", '{"account_ids": []}')
            plain = _allocation(c, user, "budget", '{"category_ids": [2]}')
            savings = _allocation(c, user, "savings",
                                  '{"goal_mode": "multi_account", "account_ids": [7]}')
            assert not _has_table(c) and "carry_over_from" not in _columns(c)

        _alembic(scratch_url, "upgrade", PERIODS)
        with engine.begin() as c:
            assert _has_table(c) and "carry_over_from" in _columns(c)
            # Every budget's account_ids is stripped, unconditionally; savings keep theirs.
            assert _configuration(c, selected) == {"category_ids": [1]}
            assert _configuration(c, emptied) == {}
            assert _configuration(c, plain) == {"category_ids": [2]}
            assert _configuration(c, savings) == {"goal_mode": "multi_account",
                                                  "account_ids": [7]}
            # No backfill: no stored windows, carry off everywhere.
            assert c.execute(text("SELECT count(*) FROM budget_periods")).scalar_one() == 0
            assert c.execute(text(
                "SELECT count(*) FROM allocations WHERE carry_over_from IS NOT NULL")
            ).scalar_one() == 0
            assert c.execute(text(
                "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'budget_periods'::regclass "
                "AND tgname = :t"), {"t": data_version.TRIGGER}).scalar_one() == 1
            unique = {tuple(u["column_names"])
                      for u in inspect(c).get_unique_constraints("budget_periods")}
            assert ("allocation_id", "start") in unique
            (fk,) = inspect(c).get_foreign_keys("budget_periods")
            assert (fk["referred_table"], fk["options"].get("ondelete")) == (
                "allocations", "CASCADE")
            c.execute(text(
                'INSERT INTO budget_periods (allocation_id, start, "end", "limit", currency) '
                "VALUES (:a, '2026-01-01', '2026-02-01', 100, 'PHP')"), {"a": plain})

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert not _has_table(c) and "carry_over_from" not in _columns(c)
            assert _configuration(c, selected) == {"category_ids": [1]}  # not restored
            assert _configuration(c, savings) == {"goal_mode": "multi_account",
                                                  "account_ids": [7]}

        _alembic(scratch_url, "upgrade", "head")
        with engine.begin() as c:
            assert _has_table(c)
    finally:
        engine.dispose()

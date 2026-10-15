"""``budget_entries.anchor_day`` and ``day_rule`` (STU-315, plan section 2.1).

Two nullable columns, no backfill: a row from before the migration keeps both
null (the legacy clamp-from-current schedule). ``anchor_day`` is limited to
1-31 by a CHECK; ``day_rule`` is a plain string validated by the API. The
downgrade drops both and keeps the row. Run on a scratch database with rows.
Skips without a database.
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
PREVIOUS = "f8b2d4a6c1e3"
DAY_RULE = "a3c9e5d7f1b4"


def test_day_rule_follows_occurrence_date_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert DAY_RULE in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(DAY_RULE).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_dayrule_{os.urandom(3).hex()}"
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


def test_upgrade_adds_nullable_columns_without_backfill_and_downgrades(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert {"anchor_day", "day_rule"}.isdisjoint(_columns(c))
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
                "is_verified) "
                "VALUES ('day-rule@example.com', 'x', 'Day', 'Probe', true, true) "
                "RETURNING id")).scalar_one()
            entry = c.execute(text(
                "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, "
                "cadence, next_occurrence, lead_time_days, semi_monthly_day_1, "
                "semi_monthly_day_2, end_mode) VALUES (:u, 'expense', 'Rent', 1, 'PHP', "
                "'monthly', '2026-10-31T00:00:00Z', 0, 1, 15, 'indefinite') RETURNING id"),
                {"u": user}).scalar_one()

        _alembic(scratch_url, "upgrade", DAY_RULE)
        with engine.begin() as c:
            assert _version(c) == DAY_RULE
            columns = _columns(c)
            assert columns["anchor_day"]["nullable"] and columns["day_rule"]["nullable"]
            assert columns["anchor_day"]["type"].python_type is int
            assert columns["day_rule"]["type"].length == 20
            assert c.execute(text(
                "SELECT anchor_day, day_rule FROM budget_entries WHERE id = :e"),
                {"e": entry}).one() == (None, None)
            c.execute(text("UPDATE budget_entries SET anchor_day = 31, day_rule = NULL "
                           "WHERE id = :e"), {"e": entry})
            c.execute(text("UPDATE budget_entries SET anchor_day = 1 WHERE id = :e"),
                      {"e": entry})
            c.execute(text("UPDATE budget_entries SET anchor_day = NULL, "
                           "day_rule = 'last_weekday' WHERE id = :e"), {"e": entry})

        for bad in (0, 32):
            with pytest.raises(IntegrityError):
                with engine.begin() as c:
                    c.execute(text("UPDATE budget_entries SET anchor_day = :d WHERE id = :e"),
                              {"d": bad, "e": entry})

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert {"anchor_day", "day_rule"}.isdisjoint(_columns(c))
            assert c.execute(text("SELECT name FROM budget_entries WHERE id = :e"),
                             {"e": entry}).scalar_one() == "Rent"
    finally:
        engine.dispose()

"""``budget_entries.final_amount`` migration (STU-658 AC2).

Upgrading from the previous revision adds a nullable ``final_amount``: every
existing entry reads null (no backfill), the check constraint refuses a value
of 0 or less, and the downgrade drops the column and keeps the rows. Run on a
scratch database that already holds entries. Skips without a database.
"""
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "e2b4d6f8a1c3"
FINAL_AMOUNT = "b3f7d9a1c5e8"


def test_final_amount_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert FINAL_AMOUNT in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(FINAL_AMOUNT).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_finalamount_{os.urandom(3).hex()}"
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


def _entry(c, user, name, amount, end_mode="after_occurrences", max_occurrences=3):
    return c.execute(text(
        "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, cadence, "
        "next_occurrence, lead_time_days, semi_monthly_day_1, semi_monthly_day_2, end_mode, "
        "max_occurrences) VALUES (:u, 'expense', :n, :amt, 'PHP', 'monthly', "
        "'2026-12-02T00:00:00Z', 0, 1, 15, :m, :x) RETURNING id"),
        {"u": user, "n": name, "amt": amount, "m": end_mode, "x": max_occurrences}).scalar_one()


def test_final_amount_migration_round_trip(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert "final_amount" not in _columns(c)
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
                "is_verified) VALUES ('final-amount@example.com', 'x', 'Final', 'Probe', true, "
                "true) RETURNING id")).scalar_one()
            # An STU-631 installment (remainder on the first, so 3,333.33 after it) and an
            # open-ended entry: rows the upgrade must leave as they are.
            installment = _entry(c, user, "Laptop", "3333.33", max_occurrences=2)
            open_ended = _entry(c, user, "Streaming", "549.00", "indefinite", None)

        _alembic(scratch_url, "upgrade", FINAL_AMOUNT)
        with engine.begin() as c:
            assert _version(c) == FINAL_AMOUNT
            column = _columns(c)["final_amount"]
            assert column["nullable"] is True
            assert (column["type"].precision, column["type"].scale) == (15, 2)
            rows = c.execute(text(
                "SELECT id, amount, final_amount FROM budget_entries ORDER BY id")).all()
            assert [(r.id, r.amount, r.final_amount) for r in rows] == [
                (installment, Decimal("3333.33"), None), (open_ended, Decimal("549.00"), None)]
            c.execute(text("UPDATE budget_entries SET final_amount = 3333.34 WHERE id = :i"),
                      {"i": installment})
        for bad in ("0", "-1.00"):
            with pytest.raises(IntegrityError, match="ck_budget_entries_final_amount_positive"):
                with engine.begin() as c:
                    c.execute(text("UPDATE budget_entries SET final_amount = :v WHERE id = :i"),
                              {"v": bad, "i": installment})

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert "final_amount" not in _columns(c)
            rows = c.execute(text("SELECT id, amount FROM budget_entries ORDER BY id")).all()
            assert [(r.id, r.amount) for r in rows] == [
                (installment, Decimal("3333.33")), (open_ended, Decimal("549.00"))]

        _alembic(scratch_url, "upgrade", "head")
        with engine.begin() as c:
            assert c.execute(text(
                "SELECT count(*) FROM budget_entries WHERE final_amount IS NOT NULL")).scalar_one() == 0
    finally:
        engine.dispose()

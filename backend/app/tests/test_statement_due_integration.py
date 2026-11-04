"""A statement's printed due date (``card_statement_due_overrides``).

The bank's printed due replaces the rolled due of one statement, identified by
its close. The migration sits on the single Alembic head and its downgrade
drops the table. Skips without a database.
"""
from pathlib import Path

import pytest

from app.tests.conftest import sw_db_reachable
from app.tests.test_minimum_due_rule_integration import _alembic, scratch_url  # noqa: F401

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "e7a1d3f5b9c2"
DUE_REVISION = "8f4493e073df"


# --- migration --------------------------------------------------------------------------------

def test_due_override_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert DUE_REVISION in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(DUE_REVISION).down_revision == PREVIOUS


def test_upgrade_adds_the_due_override_table_and_downgrade_drops_it(scratch_url):  # noqa: F811
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.exc import IntegrityError

    def tables():
        engine = create_engine(scratch_url)
        try:
            with engine.connect() as c:
                return set(inspect(c).get_table_names())
        finally:
            engine.dispose()

    _alembic(scratch_url, "upgrade", DUE_REVISION)
    assert "card_statement_due_overrides" in tables()
    engine = create_engine(scratch_url)
    try:
        with engine.begin() as c:
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('due@example.com', 'x', 'D', 'U') RETURNING id")).scalar_one()
            card = c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, balance) "
                "VALUES (:u, 'Card', 'credit', 0) RETURNING id"), {"u": user}).scalar_one()
        # The due is strictly after the close.
        with pytest.raises(IntegrityError):
            with engine.begin() as c:
                c.execute(text(
                    "INSERT INTO card_statement_due_overrides (account_id, statement_close, "
                    "due_date) VALUES (:a, '2026-11-04', '2026-11-04')"), {"a": card})
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO card_statement_due_overrides (account_id, statement_close, "
                "due_date) VALUES (:a, '2026-11-04', '2026-12-02')"), {"a": card})
        # One per statement.
        with pytest.raises(IntegrityError):
            with engine.begin() as c:
                c.execute(text(
                    "INSERT INTO card_statement_due_overrides (account_id, statement_close, "
                    "due_date) VALUES (:a, '2026-11-04', '2026-12-03')"), {"a": card})
    finally:
        engine.dispose()
    _alembic(scratch_url, "downgrade", PREVIOUS)
    assert "card_statement_due_overrides" not in tables()

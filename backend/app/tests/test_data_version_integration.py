"""The data version (STU-602, PERF-7): the triggers, the bump's transaction rules and
the migration. Skips without a database.

Invalidation bugs covered here (the plan's list): a writer that does not bump (a
table with no trigger, raw SQL, ``TRUNCATE``) and an uncommitted or rolled-back
write made visible. The ETag side is ``test_conditional_get_integration.py``.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
REVISION = "a7c2e4f6b8d1"
PARENT = "c3d5e7a9b1f4"

# pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h).
ROW, BEFORE, INSERT, DELETE, UPDATE, TRUNCATE, INSTEAD = 1, 2, 4, 8, 16, 32, 64
EVENTS = INSERT | DELETE | UPDATE | TRUNCATE


def _bump_triggers(conn) -> dict:
    """``{table: tgtype}`` of every ``data_version_bump`` trigger in the schema."""
    return {table: tgtype for table, tgtype in conn.execute(text(
        "SELECT c.relname, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = current_schema() AND t.tgname = 'data_version_bump' "
        "AND NOT t.tgisinternal"))}


def _well_formed(tgtype: int) -> bool:
    """Statement-level, AFTER, on all four events."""
    return (tgtype & (ROW | BEFORE | INSTEAD)) == 0 and (tgtype & EVENTS) == EVENTS


def uncovered(conn, tables) -> list:
    """Tables with no well-formed trigger that are not excluded."""
    from app.core.data_version import EXCLUDED_TABLES

    triggers = _bump_triggers(conn)
    return sorted(t for t in tables
                  if t not in EXCLUDED_TABLES and not _well_formed(triggers.get(t, 0)))


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(os.environ["DATABASE_URL"])
    yield eng
    eng.dispose()


def _version(conn) -> int:
    return conn.execute(text("SELECT version FROM data_version WHERE id = 1")).scalar_one()


# --- a writer that does not bump ---------------------------------------------------------

def test_every_model_table_has_the_trigger_or_is_excluded(engine):
    import app.main  # noqa: F401  every model registered on Base.metadata
    from app.core.data_version import EXCLUDED_TABLES, schema_tables
    from app.core.database import Base

    with engine.connect() as c:
        assert uncovered(c, Base.metadata.tables) == []
        # Tables only a migration made (none today) are held to the same rule.
        assert uncovered(c, schema_tables(c)) == []
        # And an excluded table really is left alone.
        triggers = _bump_triggers(c)
    assert not (set(triggers) & EXCLUDED_TABLES)
    assert {"transactions", "accounts", "users", "budget_entries"} <= set(triggers)


def test_raw_sql_update_of_transactions_bumps(engine):
    with engine.connect() as c:
        before = _version(c)
    with engine.begin() as c:
        c.execute(text("UPDATE transactions SET description = description "
                       "WHERE id IN (SELECT id FROM transactions ORDER BY id LIMIT 1)"))
    with engine.connect() as c:
        assert _version(c) == before + 1


def test_one_bump_per_transaction_however_many_statements(engine):
    with engine.connect() as c:
        before = _version(c)
    with engine.begin() as c:
        for _ in range(5):
            c.execute(text("UPDATE users SET first_name = first_name WHERE id = -1"))
        c.execute(text("UPDATE accounts SET name = name WHERE id = -1"))
    with engine.connect() as c:
        assert _version(c) == before + 1
        assert c.execute(text("SELECT count(*) FROM data_version_pending")).scalar_one() == 0


def test_an_excluded_table_does_not_bump(engine):
    with engine.connect() as c:
        before = _version(c)
    with engine.begin() as c:
        c.execute(text("UPDATE refresh_tokens SET revoked_at = revoked_at WHERE id = -1"))
    with engine.connect() as c:
        assert _version(c) == before


# --- uncommitted / rolled-back writes ----------------------------------------------------

def test_a_rolled_back_write_leaves_the_version_unchanged(engine):
    with engine.connect() as c:
        before = _version(c)
    with engine.connect() as c:
        tx = c.begin()
        c.execute(text("UPDATE users SET first_name = first_name WHERE id = -1"))
        tx.rollback()
    with engine.connect() as c:
        assert _version(c) == before


def test_another_session_never_sees_an_uncommitted_bump(engine):
    with engine.connect() as writer, engine.connect() as reader:
        before = _version(reader)
        tx = writer.begin()
        writer.execute(text("UPDATE users SET first_name = first_name WHERE id = -1"))
        assert _version(reader) == before
        tx.commit()
        assert _version(reader) == before + 1


def test_a_savepoint_rolled_back_then_a_write_still_bumps(engine):
    """The mark is undone with the savepoint, so the next write marks again."""
    with engine.connect() as c:
        before = _version(c)
    with engine.connect() as c:
        tx = c.begin()
        sp = c.begin_nested()
        c.execute(text("UPDATE users SET first_name = first_name WHERE id = -1"))
        sp.rollback()
        c.execute(text("UPDATE accounts SET name = name WHERE id = -1"))
        tx.commit()
    with engine.connect() as c:
        assert _version(c) == before + 1


def test_two_writers_do_not_wait_on_the_version_before_commit(engine):
    """The version row is locked at commit only: a second writer's statement does not
    queue behind the first writer's open transaction (nor deadlock with it)."""
    with engine.connect() as one, engine.connect() as two:
        t1 = one.begin()
        one.execute(text("UPDATE users SET first_name = first_name WHERE id = -1"))
        t2 = two.begin()
        two.execute(text("SET LOCAL lock_timeout = '300ms'"))
        two.execute(text("UPDATE accounts SET name = name WHERE id = -1"))  # no wait
        t2.commit()
        t1.commit()


# --- the migration, TRUNCATE and the helper, on a scratch database ------------------------

def test_the_migration_is_on_the_single_chain():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PARENT
    assert len(script.get_heads()) == 1
    assert REVISION in {rev.revision for rev in script.walk_revisions(head=script.get_heads()[0])}


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_dv_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    try:
        yield base.set(database=name)
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _has(conn, relation: str) -> bool:
    return conn.execute(text("SELECT to_regclass(:r)"), {"r": relation}).scalar() is not None


def test_upgrade_downgrade_upgrade(scratch_url):
    from app.core.data_version import schema_tables

    _alembic(scratch_url, "upgrade", PARENT)
    eng = create_engine(scratch_url)
    try:
        with eng.connect() as c:
            assert not _has(c, "data_version")
        _alembic(scratch_url, "upgrade", REVISION)
        with eng.connect() as c:
            assert _version(c) == 1
            assert uncovered(c, schema_tables(c)) == []
        _alembic(scratch_url, "downgrade", PARENT)
        with eng.connect() as c:
            assert not _has(c, "data_version") and not _has(c, "data_version_pending")
            assert _bump_triggers(c) == {}
            assert c.execute(text(
                "SELECT count(*) FROM pg_proc WHERE proname LIKE 'data_version_%'")).scalar() == 0
        _alembic(scratch_url, "upgrade", "head")
        with eng.connect() as c:
            assert uncovered(c, schema_tables(c)) == []
    finally:
        eng.dispose()


def test_truncate_of_a_covered_table_bumps(scratch_url):
    _alembic(scratch_url, "upgrade", "head")
    eng = create_engine(scratch_url)
    try:
        with eng.connect() as c:
            before = _version(c)
        with eng.begin() as c:
            c.execute(text("TRUNCATE wishlist_items"))
        with eng.connect() as c:
            assert _version(c) == before + 1
    finally:
        eng.dispose()


def test_a_new_table_without_the_trigger_is_caught_and_the_helper_covers_it(scratch_url):
    from app.core.data_version import add_bump_trigger, schema_tables

    _alembic(scratch_url, "upgrade", "head")
    eng = create_engine(scratch_url)
    try:
        with eng.begin() as c:
            c.execute(text("CREATE TABLE zz_new_table (id serial PRIMARY KEY)"))
        with eng.connect() as c:
            assert uncovered(c, schema_tables(c)) == ["zz_new_table"]
        with eng.begin() as c:
            add_bump_trigger(c, "zz_new_table")
        with eng.connect() as c:
            assert uncovered(c, schema_tables(c)) == []
            before = _version(c)
        with eng.begin() as c:
            c.execute(text("INSERT INTO zz_new_table DEFAULT VALUES"))
        with eng.connect() as c:
            assert _version(c) == before + 1
    finally:
        eng.dispose()

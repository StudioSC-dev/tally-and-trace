"""The card_statements migration (STU-601, PERF-6, AC6): on the single chain, and upgrade,
downgrade, upgrade on a throwaway database. Skips without a database."""
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
REVISION = "d6f8a2c4e1b7"
PARENT = "c3d5e7a9b1f4"
TABLES = ("card_statements", "card_statement_state")


def test_the_migration_is_on_the_single_chain():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PARENT
    assert REVISION in {rev.revision for rev in script.walk_revisions(head=script.get_heads()[0])}


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_cs_{os.urandom(3).hex()}"
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


def _tables(engine) -> set:
    with engine.connect() as c:
        return {t for t in TABLES
                if c.execute(text(f"SELECT to_regclass('public.{t}')")).scalar() is not None}


def _primary_key(engine, table) -> list:
    with engine.connect() as c:
        return [r[0] for r in c.execute(text(
            "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid "
            "AND a.attnum = ANY(i.indkey) WHERE i.indrelid = CAST(:t AS regclass) "
            "AND i.indisprimary ORDER BY a.attnum"), {"t": table})]


def test_upgrade_downgrade_upgrade(scratch_url):
    _alembic(scratch_url, "upgrade", PARENT)
    engine = create_engine(scratch_url)
    try:
        assert _tables(engine) == set()
        _alembic(scratch_url, "upgrade", REVISION)
        assert _tables(engine) == set(TABLES)
        assert _primary_key(engine, "card_statements") == ["card_id", "close"]
        assert _primary_key(engine, "card_statement_state") == ["card_id"]
        with engine.connect() as c:
            cols = {r[0] for r in c.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'card_statements'"))}
            # Empty tables: reads catch up lazily, so nothing is backfilled.
            assert not c.execute(text("SELECT count(*) FROM card_statements")).scalar()
        assert cols >= {"card_id", "close", "window_start", "line_balance", "line_count",
                        "close_day", "computed_at"}
        _alembic(scratch_url, "downgrade", PARENT)
        assert _tables(engine) == set()
        _alembic(scratch_url, "upgrade", "head")
        assert _tables(engine) == set(TABLES)
    finally:
        engine.dispose()

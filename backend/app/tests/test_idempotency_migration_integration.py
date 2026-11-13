"""The idempotency_keys migration (STU-604, PERF-9, AC5): on the single chain, and upgrade,
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
REVISION = "c3d5e7a9b1f4"
PARENT = "e5a1c7b3d9f2"


def test_the_migration_is_on_the_single_chain():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    assert script.get_revision(REVISION).down_revision == PARENT
    assert REVISION in {rev.revision for rev in script.walk_revisions(head=script.get_heads()[0])}


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_idem_{os.urandom(3).hex()}"
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


def _has_table(engine) -> bool:
    with engine.connect() as c:
        return c.execute(text("SELECT to_regclass('public.idempotency_keys')")).scalar() is not None


def test_upgrade_downgrade_upgrade(scratch_url):
    _alembic(scratch_url, "upgrade", PARENT)
    engine = create_engine(scratch_url)
    try:
        assert not _has_table(engine)
        _alembic(scratch_url, "upgrade", REVISION)
        assert _has_table(engine)
        with engine.connect() as c:
            cols = {r[0]: r[1] for r in c.execute(text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'idempotency_keys'"))}
            pk = [r[0] for r in c.execute(text(
                "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid "
                "AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'idempotency_keys'::regclass "
                "AND i.indisprimary ORDER BY a.attnum"))]
        assert set(cols) >= {"user_id", "key", "route", "request_hash", "status_code",
                             "response_json", "created_at"}
        assert pk == ["user_id", "key"]
        _alembic(scratch_url, "downgrade", PARENT)
        assert not _has_table(engine)
        _alembic(scratch_url, "upgrade", "head")
        assert _has_table(engine)
    finally:
        engine.dispose()

"""The is_autopay drop (d7b3f1a9c5e2).

Drops ``budget_entries.is_autopay``; the downgrade adds it back, not null and false.
Runs alembic in a subprocess on a throwaway database, seeded raw at the parent
revision. Skips without a database; the chain check needs none.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[2]
PARENT = "a2c6e8f0b4d1"
REVISION = "d7b3f1a9c5e2"


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


def test_the_migration_is_on_the_single_chain():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert REVISION in {rev.revision for rev in script.walk_revisions(head=head)}
    assert script.get_revision(REVISION).down_revision == PARENT


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_settle_{os.urandom(3).hex()}"
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


def _column(c):
    return c.execute(text(
        "SELECT is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = 'budget_entries' AND column_name = 'is_autopay'")).one_or_none()


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_upgrade_drops_the_column_and_downgrade_restores_it(scratch_url):
    _alembic(scratch_url, "upgrade", PARENT)
    engine = create_engine(scratch_url)
    try:
        with engine.begin() as c:
            assert _column(c) is not None
            u = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('drop@example.com', 'x', 'D', 'A') RETURNING id"
            )).scalar_one()
            c.execute(text(
                "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, "
                "cadence, next_occurrence, end_mode, is_autopay) VALUES (:u, 'expense', 'rent', 100, "
                "'PHP', 'monthly', now(), 'indefinite', true)"), {"u": u})

        _alembic(scratch_url, "upgrade", REVISION)
        with engine.begin() as c:
            assert _column(c) is None
            # The row survives, and an insert that names no such column works.
            assert c.execute(text("SELECT count(*) FROM budget_entries")).scalar_one() == 1
            c.execute(text(
                "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, "
                "cadence, next_occurrence, end_mode) VALUES (:u, 'expense', 'new', 5, 'PHP', "
                "'monthly', now(), 'indefinite')"), {"u": u})

        _alembic(scratch_url, "downgrade", PARENT)
        with engine.connect() as c:
            column = _column(c)
            assert (column.is_nullable, column.column_default) == ("NO", "false")
            assert c.execute(text(
                "SELECT count(*) FROM budget_entries WHERE is_autopay")).scalar_one() == 0
            assert c.execute(text("SELECT count(*) FROM budget_entries")).scalar_one() == 2

        _alembic(scratch_url, "upgrade", REVISION)
        with engine.connect() as c:
            assert _column(c) is None
    finally:
        engine.dispose()

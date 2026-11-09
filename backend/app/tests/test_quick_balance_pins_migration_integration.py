"""``users.quick_balance_account_ids`` (STU-578, PR 2).

One nullable JSON column, no default, no backfill: existing rows read null and
the code serving during the build never touches it. The downgrade drops it and
keeps the user row. Run on a scratch database with rows. Skips without a database.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "b9e4c2a7d1f3"
PINS = "e5a1c7b3d9f2"


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_pins_{os.urandom(3).hex()}"
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
    return {col["name"]: col for col in inspect(c).get_columns("users")}


def _version(c):
    return c.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def test_pins_migration_follows_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert PINS in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(PINS).down_revision == PREVIOUS


def test_pins_migration_up_and_down(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert "quick_balance_account_ids" not in _columns(c)
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
                "is_verified) VALUES ('pins@example.com', 'x', 'Pins', 'Probe', "
                "true, true) RETURNING id")).scalar_one()

        _alembic(scratch_url, "upgrade", PINS)
        with engine.begin() as c:
            assert _version(c) == PINS
            column = _columns(c)["quick_balance_account_ids"]
            assert column["nullable"]
            assert column["default"] is None
            assert c.execute(text("SELECT quick_balance_account_ids FROM users WHERE id = :u"),
                             {"u": user}).scalar_one() is None
            c.execute(text("UPDATE users SET quick_balance_account_ids = '[3, 1, 2]' "
                           "WHERE id = :u"), {"u": user})
            assert c.execute(text("SELECT quick_balance_account_ids FROM users WHERE id = :u"),
                             {"u": user}).scalar_one() == [3, 1, 2]

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert "quick_balance_account_ids" not in _columns(c)
            assert c.execute(text("SELECT email FROM users WHERE id = :u"),
                             {"u": user}).scalar_one() == "pins@example.com"

        _alembic(scratch_url, "upgrade", PINS)
        with engine.begin() as c:
            assert _version(c) == PINS
    finally:
        engine.dispose()

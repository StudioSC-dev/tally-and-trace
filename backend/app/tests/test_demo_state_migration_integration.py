"""Migration d1e3a5c7b9f2 (the one-row ``demo_state`` table, STU-229).

It is the single head, straight after M3. Runs alembic in a subprocess against
a throwaway database on the same server as ``DATABASE_URL``: upgrade creates
the table (one row only), downgrade -1 drops it and leaves M3 in place, and
upgrade applies again. Skips without a database; the head check needs none.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

BACKEND_DIR = Path(__file__).resolve().parents[2]
M3 = "c4e8a2f6b1d3"
DEMO_STATE = "d1e3a5c7b9f2"


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


def test_demo_state_is_the_single_head_after_m3():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    assert script.get_heads() == [DEMO_STATE]
    assert script.get_revision(DEMO_STATE).down_revision == M3


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_demo_{os.urandom(3).hex()}"
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


def _version(conn):
    return conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_demo_state_upgrades_downgrades_and_upgrades_again(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", "head")
        with engine.begin() as c:
            assert _version(c) == DEMO_STATE
            assert {col["name"] for col in inspect(c).get_columns("demo_state")} == {
                "id", "shape_version", "seeded_at"}
            c.execute(text("INSERT INTO demo_state (id, shape_version) VALUES (1, 1)"))
        with pytest.raises(IntegrityError):
            with engine.begin() as c:
                c.execute(text("INSERT INTO demo_state (id, shape_version) VALUES (2, 1)"))

        _alembic(scratch_url, "downgrade", "-1")
        with engine.connect() as c:
            assert _version(c) == M3
            assert not inspect(c).has_table("demo_state")
            assert inspect(c).has_table("accounts")

        _alembic(scratch_url, "upgrade", "head")
        with engine.connect() as c:
            assert _version(c) == DEMO_STATE
            assert c.execute(text("SELECT count(*) FROM demo_state")).scalar_one() == 0
    finally:
        engine.dispose()

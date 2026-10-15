"""Every engine pins its Postgres session to UTC (STU-315, plan section 2.0).

The date columns are ``timestamptz``: a naive value is written, and an aware
one read back, in the session's time zone. With every session on UTC a naive
value is stored as those UTC components and read back unchanged, whatever the
server's default zone, so the day rules and the cutover tools agree on dates.
Each engine factory is checked against a scratch database whose default zone
is Asia/Manila (UTC+8), where an unpinned session would shift a midnight to the
previous day. Skips without a database.
"""
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

APP_DIR = Path(__file__).resolve().parents[1]
DAY_START = datetime(2026, 10, 31, 0, 0)  # naive: UTC components


def _canon(value: datetime) -> datetime:
    """UTC components of a value read back from a ``timestamptz``."""
    return value.astimezone(timezone.utc).replace(tzinfo=None)


@pytest.fixture(scope="module")
def manila_url():
    """A scratch database whose default session zone is Asia/Manila."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_tz_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
        c.execute(text(f"ALTER DATABASE \"{name}\" SET timezone = 'Asia/Manila'"))
    url = base.set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _core(url):
    from app.core.database import make_engine
    return make_engine(url)


def _loader(url):
    from app.cutover_load.loader import make_engine
    return make_engine(url)


def _reset(url):
    from app.cutover_load.reset import reset_engine
    return reset_engine(url)


def _check(url):
    from app.cutover_check.check import make_engine
    return make_engine(url)


FACTORIES = {"core": _core, "loader": _loader, "reset": _reset, "check": _check}


def test_an_unpinned_session_on_the_scratch_database_is_on_manila(manila_url):
    """The control: without the pin the scratch database's sessions are not on UTC."""
    engine = create_engine(manila_url)
    try:
        with engine.connect() as c:
            assert c.execute(text("SHOW TimeZone")).scalar() == "Asia/Manila"
            stored = c.execute(text("SELECT CAST(:d AS timestamptz)"), {"d": DAY_START}).scalar()
            assert _canon(stored) == datetime(2026, 10, 30, 16, 0)
    finally:
        engine.dispose()


@pytest.mark.parametrize("factory", sorted(FACTORIES))
def test_each_engine_factory_pins_utc(manila_url, factory):
    engine = FACTORIES[factory](manila_url)
    try:
        with engine.connect() as c:
            assert c.execute(text("SHOW TimeZone")).scalar() == "UTC"
            stored = c.execute(text("SELECT CAST(:d AS timestamptz)"), {"d": DAY_START}).scalar()
            assert _canon(stored) == DAY_START
            assert stored.replace(tzinfo=None) == DAY_START
    finally:
        engine.dispose()


def test_the_reset_engine_keeps_its_snapshot_isolation(manila_url):
    engine = _reset(manila_url)
    try:
        with engine.connect() as c:
            assert c.execute(text("SHOW transaction_isolation")).scalar() == "repeatable read"
    finally:
        engine.dispose()


def test_the_check_engine_stays_read_only(manila_url):
    engine = _check(manila_url)
    try:
        with engine.connect() as c:
            assert c.execute(text("SHOW default_transaction_read_only")).scalar() == "on"
    finally:
        engine.dispose()


def test_the_application_engine_is_on_utc():
    from app.core.database import engine

    with engine.connect() as c:
        assert c.execute(text("SHOW TimeZone")).scalar() == "UTC"


@pytest.mark.parametrize("module, expected", [
    ("core/database.py", 1), ("cutover_load/loader.py", 1),
    ("cutover_load/reset.py", 0), ("cutover_check/check.py", 1),
])
def test_engines_are_made_only_by_the_pinned_factories(module, expected):
    """Every engine in these modules comes from its factory, so none skips the pin."""
    source = (APP_DIR / module).read_text()
    assert len(re.findall(r"\bcreate_engine\(", source)) == expected

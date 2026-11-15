"""Migration e2b4d6f8a1c3: a unique index on lower(users.email) (STU-241).

Runs alembic in a subprocess against a throwaway database on the same server as
``DATABASE_URL``. Upgrade refuses, changing nothing and naming no email, while
emails differing only by case exist; once they are resolved it adds the index,
which then refuses such an email; downgrade drops it and upgrade applies again.
The index itself is also checked on the test database. Skips without a
database; the revision check needs none.
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

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "d6f8a2c4e1b7"
REVISION = "e2b4d6f8a1c3"
INDEX = "uq_users_lower_email"

needs_db = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


def test_alembic_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert REVISION in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(REVISION).down_revision == PREVIOUS


@needs_db
def test_lower_email_unique_index_refuses_case_duplicate(sw_db, sw_people):
    from app.models.user import User

    taken = sw_people("Tia", "Taken")["email"]
    for variant in (taken.upper(), taken.title(), taken):
        sw_db.add(User(email=variant, password_hash="x", first_name="Eve",
                       last_name="Variant", is_verified=True))
        with pytest.raises(IntegrityError, match=INDEX if variant != taken else "users"):
            sw_db.commit()
        sw_db.rollback()
    from sqlalchemy import func
    assert sw_db.query(User).filter(func.lower(User.email) == taken.lower()).count() == 1


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_lower_email_{os.urandom(3).hex()}"
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
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True,
    )


def _ok(url, *args):
    result = _alembic(url, *args)
    assert result.returncode == 0, result.stderr


def _version(conn):
    return conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def _has_index(conn):
    return INDEX in {ix["name"] for ix in inspect(conn).get_indexes("users")}


def _user(conn, email):
    conn.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name) "
        "VALUES (:e, 'x', 'Mig', 'Ration')"), {"e": email})


def _emails(conn):
    return sorted(conn.execute(text("SELECT email FROM users")).scalars())


@needs_db
def test_migration_refuses_when_case_duplicates_exist(scratch_url):
    engine = create_engine(scratch_url)
    dupes = ("Dup.One@Example.com", "dup.one@example.com", "DUP.ONE@EXAMPLE.COM",
             "Pair.Two@example.com", "pair.two@example.com")
    try:
        _ok(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            for email in (*dupes, "solo@example.com"):
                _user(c, email)
            before = _emails(c)

        refused = _alembic(scratch_url, "upgrade", REVISION)
        assert refused.returncode != 0
        output = refused.stdout + refused.stderr
        assert (f"{INDEX}: refusing to upgrade: 2 email address(es) differing only by "
                "case are held by 5 users. Nothing was changed.") in output
        for email in (*dupes, "solo@example.com"):
            assert email.lower() not in output.lower(), "the abort message names an email"
        with engine.connect() as c:
            assert _version(c) == PREVIOUS
            assert not _has_index(c)
            assert _emails(c) == before

        with engine.begin() as c:  # resolved: the upgrade now applies
            c.execute(text("DELETE FROM users WHERE email <> lower(email)"))
            c.execute(text("DELETE FROM users WHERE email = 'pair.two@example.com'"))
        _ok(scratch_url, "upgrade", REVISION)
        with engine.connect() as c:
            assert _version(c) == REVISION
            assert _has_index(c)
    finally:
        engine.dispose()


@needs_db
def test_upgrade_downgrade_and_upgrade_again(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _ok(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            _user(c, "Alice@example.com")
            _user(c, "bob@example.com")

        _ok(scratch_url, "upgrade", REVISION)
        with engine.connect() as c:
            assert _version(c) == REVISION
            assert _has_index(c)
        with pytest.raises(IntegrityError, match=INDEX):
            with engine.begin() as c:
                _user(c, "ALICE@EXAMPLE.COM")

        _ok(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert not _has_index(c)
            assert _emails(c) == ["Alice@example.com", "bob@example.com"]
            _user(c, "carol@example.com")

        _ok(scratch_url, "upgrade", REVISION)
        with engine.connect() as c:
            assert _version(c) == REVISION
            assert _has_index(c)
            assert len(_emails(c)) == 3
    finally:
        engine.dispose()

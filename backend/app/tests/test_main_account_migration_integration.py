"""``users.main_account_id`` (STU-326, plan section 1).

One nullable column, no backfill, with an ``ON DELETE SET NULL`` foreign key
to ``accounts``: a hard-deleted account clears the pin instead of blocking the
delete. The downgrade drops the constraint and the column and keeps the user
row. Run on a scratch database with rows. Skips without a database.
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
PREVIOUS = "a3c9e5d7f1b4"
MAIN_ACCOUNT = "c4e8a2f6b1d9"


def test_main_account_follows_day_rule_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert MAIN_ACCOUNT in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(MAIN_ACCOUNT).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_mainacct_{os.urandom(3).hex()}"
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


def _account(c, user, name):
    return c.execute(text(
        "INSERT INTO accounts (user_id, name, account_type, balance, currency, is_active, "
        "is_spending_wallet) VALUES (:u, :n, 'checking', 100, 'PHP', true, false) "
        "RETURNING id"), {"u": user, "n": name}).scalar_one()


def test_upgrade_adds_a_set_null_pin_and_downgrades(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert "main_account_id" not in _columns(c)
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
                "is_verified) VALUES ('main-account@example.com', 'x', 'Main', 'Probe', "
                "true, true) RETURNING id")).scalar_one()
            kept = _account(c, user, "Kept")
            doomed = _account(c, user, "Doomed")

        _alembic(scratch_url, "upgrade", MAIN_ACCOUNT)
        with engine.begin() as c:
            assert _version(c) == MAIN_ACCOUNT
            column = _columns(c)["main_account_id"]
            assert column["nullable"]
            assert column["type"].python_type is int
            assert c.execute(text("SELECT main_account_id FROM users WHERE id = :u"),
                             {"u": user}).scalar_one() is None
            (fk,) = [fk for fk in inspect(c).get_foreign_keys("users")
                     if fk["name"] == "fk_users_main_account_id"]
            assert fk["referred_table"] == "accounts"
            assert fk["constrained_columns"] == ["main_account_id"]
            assert fk["options"].get("ondelete") == "SET NULL"

            c.execute(text("UPDATE users SET main_account_id = :a WHERE id = :u"),
                      {"a": doomed, "u": user})
            c.execute(text("DELETE FROM accounts WHERE id = :a"), {"a": doomed})
            assert c.execute(text("SELECT main_account_id FROM users WHERE id = :u"),
                             {"u": user}).scalar_one() is None
            c.execute(text("UPDATE users SET main_account_id = :a WHERE id = :u"),
                      {"a": kept, "u": user})

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert "main_account_id" not in _columns(c)
            assert c.execute(text("SELECT email FROM users WHERE id = :u"),
                             {"u": user}).scalar_one() == "main-account@example.com"

        _alembic(scratch_url, "upgrade", MAIN_ACCOUNT)
        with engine.begin() as c:
            assert _version(c) == MAIN_ACCOUNT
    finally:
        engine.dispose()


def test_mappers_configure_with_two_user_account_foreign_keys():
    """A second FK between users and accounts must not make the relationships ambiguous."""
    from sqlalchemy.orm import configure_mappers

    import app.models  # noqa: F401  (registers every mapper)
    from app.models.account import Account
    from app.models.user import User

    configure_mappers()
    assert list(User.accounts.property.local_remote_pairs)[0][1].name == "user_id"
    assert Account.user.property.mapper.class_ is User

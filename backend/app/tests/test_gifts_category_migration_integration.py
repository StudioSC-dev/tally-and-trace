"""The "Gifts & Donations" default expense category migration (STU-384, plan Ruling 4).

Upgrading from the previous revision gives each user without a same-name expense
category one active expense "Gifts & Donations". A same-name expense category,
active or inactive, blocks it and stays as it was. A same-name income category
blocks it only when the migration's ``SKIP_WHEN_OTHER_KIND_EXISTS`` is true; the
test reads the constant. The downgrade leaves every category row as it is. Run on
a scratch database with rows. Skips without a database.
"""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "b7d3f1a9c5e2"
GIFTS = "1b678ac2c4f3"
NAME = "Gifts & Donations"


def _migration():
    path = BACKEND_DIR / "migrations" / "versions" / f"{GIFTS}_add_gifts_given_category.py"
    spec = importlib.util.spec_from_file_location("gifts_given_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_gifts_follows_billing_kind_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert GIFTS in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(GIFTS).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_gifts_{os.urandom(3).hex()}"
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


def _version(c):
    return c.execute(text("SELECT version_num FROM alembic_version")).scalar_one()


def _user(c, email):
    return c.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
        "is_verified) VALUES (:e, 'x', 'Gift', 'Probe', true, true) RETURNING id"),
        {"e": email}).scalar_one()


def _category(c, user, kind, active=True, color="#123456"):
    return c.execute(text(
        "INSERT INTO categories (user_id, name, description, color, kind, is_expense, "
        "is_active) VALUES (:u, :n, 'mine', :col, :k, :x, :a) RETURNING id"),
        {"u": user, "n": NAME, "col": color, "k": kind, "x": kind == "expense",
         "a": active}).scalar_one()


def _all_categories(c):
    return c.execute(text(
        "SELECT id, user_id, name, description, color, kind::text, is_expense, is_active, "
        "created_at FROM categories ORDER BY id")).all()


def _gifts(c, user):
    return c.execute(text(
        "SELECT id, description, color, kind::text, is_expense, is_active FROM categories "
        "WHERE user_id = :u AND name = :n ORDER BY id"), {"u": user, "n": NAME}).all()


def test_upgrade_adds_the_expense_default_where_missing_and_downgrade_keeps_rows(scratch_url):
    skip_other_kind = _migration().SKIP_WHEN_OTHER_KIND_EXISTS
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            bare = _user(c, "gifts-bare@example.com")
            active = _user(c, "gifts-active@example.com")
            inactive = _user(c, "gifts-inactive@example.com")
            income = _user(c, "gifts-income@example.com")
            active_row = _category(c, active, "expense")
            inactive_row = _category(c, inactive, "expense", active=False)
            income_row = _category(c, income, "income")
            before = {
                active: _gifts(c, active),
                inactive: _gifts(c, inactive),
                income: _gifts(c, income),
            }

        _alembic(scratch_url, "upgrade", GIFTS)
        with engine.begin() as c:
            assert _version(c) == GIFTS
            (row,) = _gifts(c, bare)
            assert tuple(row)[1:] == ("Gifts and donations given", "#E599F7", "expense", True,
                                      True)

            assert _gifts(c, active) == before[active]
            assert [r.id for r in before[active]] == [active_row]
            assert _gifts(c, inactive) == before[inactive]
            assert [(r.id, r.is_active) for r in before[inactive]] == [(inactive_row, False)]

            rows = _gifts(c, income)
            assert rows[0] == before[income][0] and rows[0].id == income_row
            if skip_other_kind:
                assert rows == before[income]
            else:
                assert len(rows) == 2
                assert tuple(rows[1])[1:] == ("Gifts and donations given", "#E599F7",
                                              "expense", True, True)
            after_upgrade = _all_categories(c)

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert _version(c) == PREVIOUS
            assert _all_categories(c) == after_upgrade
    finally:
        engine.dispose()

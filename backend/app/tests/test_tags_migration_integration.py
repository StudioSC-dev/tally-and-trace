"""Migration 4c8e1f6a2d97 (tags and their links, STU-231).

It follows the entity-schema drop on the single head. Runs alembic in a
subprocess against a throwaway database on the same server as
``DATABASE_URL``: upgrade creates the four tables and gives every existing user
exactly one Household system tag; the constraints hold (one system tag per
user, names unique per user ignoring case, links cascade from both sides);
downgrade drops the four tables and leaves the previous head in place; upgrade
applies again. Skips without a database; the revision check needs none.
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
PREVIOUS = "7b3d9f1a5c82"
TAGS = "4c8e1f6a2d97"
TABLES = ("tags", "account_tags", "transaction_tags", "budget_entry_tags")


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


def test_tags_follow_the_entity_drop_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert TAGS in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(TAGS).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_tags_{os.urandom(3).hex()}"
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


def _user(conn, email):
    return conn.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name) "
        "VALUES (:e, 'x', 'Mig', 'Ration') RETURNING id"), {"e": email}).scalar_one()


def _household_counts(conn):
    return dict(conn.execute(text(
        "SELECT u.id, count(t.id) FILTER (WHERE t.is_system AND t.name = 'Household') "
        "FROM users u LEFT JOIN tags t ON t.user_id = u.id GROUP BY u.id")).all())


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_tags_upgrade_backfill_constraints_downgrade_and_upgrade_again(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            alice, bob = _user(c, "alice@example.com"), _user(c, "bob@example.com")

        _alembic(scratch_url, "upgrade", TAGS)
        with engine.begin() as c:
            assert _version(c) == TAGS
            for table in TABLES:
                assert inspect(c).has_table(table), table
            assert _household_counts(c) == {alice: 1, bob: 1}
            assert c.execute(text("SELECT count(*) FROM tags")).scalar_one() == 2
            bank = c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, balance, currency) "
                "VALUES (:u, 'Bank', 'checking', 0, 'PHP') RETURNING id"), {"u": alice}).scalar_one()
            txn = c.execute(text(
                "INSERT INTO transactions (user_id, account_id, amount, transfer_fee, "
                "transaction_type, transaction_date) "
                "VALUES (:u, :a, 1, 0, 'debit', now()) RETURNING id"),
                {"u": alice, "a": bank}).scalar_one()
            entry = c.execute(text(
                "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, "
                "cadence, next_occurrence, lead_time_days, semi_monthly_day_1, "
                "semi_monthly_day_2, end_mode) VALUES (:u, 'expense', 'Rent', 1, 'PHP', "
                "'monthly', now(), 0, 1, 15, 'indefinite') RETURNING id"),
                {"u": alice}).scalar_one()
            biz = c.execute(text(
                "INSERT INTO tags (user_id, name) VALUES (:u, 'Business') RETURNING id"),
                {"u": alice}).scalar_one()
            c.execute(text("INSERT INTO account_tags VALUES (:t, :r)"), {"t": biz, "r": bank})
            c.execute(text("INSERT INTO transaction_tags VALUES (:t, :r)"), {"t": biz, "r": txn})
            c.execute(text("INSERT INTO budget_entry_tags VALUES (:t, :r)"),
                      {"t": biz, "r": entry})

        refused = (
            "INSERT INTO tags (user_id, name, is_system) VALUES ({u}, 'Second', true)",
            "INSERT INTO tags (user_id, name) VALUES ({u}, 'BUSINESS')",
            "INSERT INTO tags (user_id, name) VALUES ({u}, 'household')",
        )
        for sql in refused:
            with pytest.raises(IntegrityError):
                with engine.begin() as c:
                    c.execute(text(sql.format(u=alice)))
        with engine.begin() as c:  # another user may reuse the name
            c.execute(text("INSERT INTO tags (user_id, name) VALUES (:u, 'Business')"),
                      {"u": bob})

        with engine.begin() as c:  # deleting a record deletes its links
            c.execute(text("DELETE FROM transactions WHERE id = :i"), {"i": txn})
            assert c.execute(text("SELECT count(*) FROM transaction_tags")).scalar_one() == 0
            c.execute(text("DELETE FROM tags WHERE id = :i"), {"i": biz})  # and the tag's
            for table in ("account_tags", "budget_entry_tags"):
                assert c.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.connect() as c:
            assert _version(c) == PREVIOUS
            for table in TABLES:
                assert not inspect(c).has_table(table), table
            assert inspect(c).has_table("accounts")

        with engine.begin() as c:
            carol = _user(c, "carol@example.com")
        _alembic(scratch_url, "upgrade", TAGS)
        with engine.connect() as c:
            assert _version(c) == TAGS
            assert _household_counts(c) == {alice: 1, bob: 1, carol: 1}
    finally:
        engine.dispose()

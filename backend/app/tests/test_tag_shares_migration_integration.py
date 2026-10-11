"""Migration c9e4a7d2f5b8 (Household tag shares, STU-233).

It follows the account-shares migration on the single head. Runs alembic in a
subprocess against a throwaway database on the same server as
``DATABASE_URL``: upgrade creates ``tag_shares`` with the constraint names the
ORM uses; the constraints hold (one share per tag and user, shares cascade
from the tag and the user); downgrade drops the table and leaves the
account-shares head; upgrade applies again. Skips without a database; the
revision checks need none.
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
PREVIOUS = "b5d2e8f4a1c6"
TAG_SHARES = "c9e4a7d2f5b8"


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


def test_tag_shares_follow_the_account_shares_migration_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert TAG_SHARES in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(TAG_SHARES).down_revision == PREVIOUS


def test_the_orm_names_every_tag_share_constraint_as_the_migration_does():
    from app.models.tag_share import TagShare

    table = TagShare.__table__
    names = {c.name for c in table.constraints} | {i.name for i in table.indexes}
    assert names == {
        "pk_tag_shares", "fk_tag_shares_tag_id_tags", "fk_tag_shares_user_id_users",
        "uq_tag_shares_tag_id_user_id", "ix_tag_shares_user_id",
    }


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_tagshares_{os.urandom(3).hex()}"
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


def _user(conn, email):
    return conn.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name) "
        "VALUES (:e, 'x', 'Mig', 'Ration') RETURNING id"), {"e": email}).scalar_one()


def _household(conn, user):
    return conn.execute(text(
        "SELECT id FROM tags WHERE user_id = :u AND is_system"), {"u": user}).scalar_one()


def _share(conn, tag, user):
    return conn.execute(text(
        "INSERT INTO tag_shares (tag_id, user_id) VALUES (:t, :u) RETURNING id"),
        {"t": tag, "u": user}).scalar_one()


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_tag_shares_upgrade_constraints_downgrade_and_upgrade_again(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            alice, bob = _user(c, "alice@example.com"), _user(c, "bob@example.com")
            c.execute(text("INSERT INTO tags (user_id, name, is_system) "
                           "VALUES (:a, 'Household', true), (:b, 'Household', true)"),
                      {"a": alice, "b": bob})

        _alembic(scratch_url, "upgrade", TAG_SHARES)
        with engine.begin() as c:
            insp = inspect(c)
            assert insp.has_table("tag_shares")
            assert insp.get_pk_constraint("tag_shares")["name"] == "pk_tag_shares"
            assert {fk["name"] for fk in insp.get_foreign_keys("tag_shares")} == {
                "fk_tag_shares_tag_id_tags", "fk_tag_shares_user_id_users"}
            assert [u["name"] for u in insp.get_unique_constraints("tag_shares")] == [
                "uq_tag_shares_tag_id_user_id"]
            assert [i["name"] for i in insp.get_indexes("tag_shares")
                    if not i.get("duplicates_constraint")] == ["ix_tag_shares_user_id"]
            household = _household(c, alice)
            _share(c, household, bob)

        with pytest.raises(IntegrityError):  # one share per tag and user
            with engine.begin() as c:
                _share(c, household, bob)

        with engine.begin() as c:
            c.execute(text("DELETE FROM users WHERE id = :u"), {"u": bob})
            assert c.execute(text("SELECT count(*) FROM tag_shares")).scalar_one() == 0
            carol = _user(c, "carol@example.com")
            _share(c, household, carol)
            c.execute(text("DELETE FROM tags WHERE id = :t"), {"t": household})
            assert c.execute(text("SELECT count(*) FROM tag_shares")).scalar_one() == 0
            c.execute(text("INSERT INTO tags (user_id, name, is_system) "
                           "VALUES (:a, 'Household', true)"), {"a": alice})
            _share(c, _household(c, alice), carol)

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert not inspect(c).has_table("tag_shares")
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == PREVIOUS
            assert c.execute(text("SELECT count(*) FROM users")).scalar_one() == 2

        _alembic(scratch_url, "upgrade", TAG_SHARES)
        with engine.begin() as c:
            assert inspect(c).has_table("tag_shares")
            assert c.execute(text("SELECT count(*) FROM tag_shares")).scalar_one() == 0
    finally:
        engine.dispose()

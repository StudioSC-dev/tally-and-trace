"""Migration b5d2e8f4a1c6 (account shares and transactions.created_by_actor, STU-232).

It follows the tags migration on the single head. Runs alembic in a subprocess
against a throwaway database on the same server as ``DATABASE_URL``: upgrade
creates ``account_shares`` and the nullable ``created_by_actor`` column with
the constraint names the ORM uses; the constraints hold (one share per
account and user, roles limited to viewer, editor and admin, shares cascade
from the account and the user); downgrade drops both and leaves the tags head;
upgrade applies again. Skips without a database; the revision check needs none.
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
PREVIOUS = "4c8e1f6a2d97"
SHARES = "b5d2e8f4a1c6"


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


def test_shares_follow_the_tags_migration_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert SHARES in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(SHARES).down_revision == PREVIOUS


def test_the_orm_names_every_new_constraint_as_the_migration_does():
    from app.models.account_share import AccountShare
    from app.models.transaction import Transaction

    table = AccountShare.__table__
    names = {c.name for c in table.constraints} | {i.name for i in table.indexes}
    assert names == {
        "pk_account_shares", "fk_account_shares_account_id_accounts",
        "fk_account_shares_user_id_users", "fk_account_shares_created_by_users",
        "uq_account_shares_account_id_user_id", "ck_account_shares_role",
        "ix_account_shares_user_id",
    }
    (fk,) = Transaction.__table__.c.created_by_actor.foreign_keys
    assert fk.name == "fk_transactions_created_by_actor_users"


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_shares_{os.urandom(3).hex()}"
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


def _account(conn, user):
    return conn.execute(text(
        "INSERT INTO accounts (user_id, name, account_type, balance, currency) "
        "VALUES (:u, 'Joint', 'checking', 0, 'PHP') RETURNING id"), {"u": user}).scalar_one()


def _share(conn, account, user, role="editor"):
    return conn.execute(text(
        "INSERT INTO account_shares (account_id, user_id, role, created_by) "
        "VALUES (:a, :u, :r, :u) RETURNING id"), {"a": account, "u": user, "r": role}).scalar_one()


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_shares_upgrade_constraints_downgrade_and_upgrade_again(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            alice, bob = _user(c, "alice@example.com"), _user(c, "bob@example.com")
            joint = _account(c, alice)
            txn = c.execute(text(
                "INSERT INTO transactions (user_id, account_id, amount, transfer_fee, "
                "transaction_type, transaction_date) "
                "VALUES (:u, :a, 1, 0, 'debit', now()) RETURNING id"),
                {"u": alice, "a": joint}).scalar_one()

        _alembic(scratch_url, "upgrade", SHARES)
        with engine.begin() as c:
            insp = inspect(c)
            assert insp.has_table("account_shares")
            assert insp.get_pk_constraint("account_shares")["name"] == "pk_account_shares"
            assert {fk["name"] for fk in insp.get_foreign_keys("account_shares")} == {
                "fk_account_shares_account_id_accounts", "fk_account_shares_user_id_users",
                "fk_account_shares_created_by_users"}
            assert [u["name"] for u in insp.get_unique_constraints("account_shares")] == [
                "uq_account_shares_account_id_user_id"]
            assert [k["name"] for k in insp.get_check_constraints("account_shares")] == [
                "ck_account_shares_role"]
            assert [i["name"] for i in insp.get_indexes("account_shares")
                    if not i.get("duplicates_constraint")] == ["ix_account_shares_user_id"]
            columns = {col["name"]: col for col in insp.get_columns("transactions")}
            assert columns["created_by_actor"]["nullable"] is True
            assert "fk_transactions_created_by_actor_users" in {
                fk["name"] for fk in insp.get_foreign_keys("transactions")}
            assert c.execute(text("SELECT created_by_actor FROM transactions WHERE id = :t"),
                             {"t": txn}).scalar_one() is None
            _share(c, joint, bob)

        for bad in (lambda c: _share(c, joint, bob, "viewer"),   # one share per account/user
                    lambda c: _share(c, joint, alice, "owner")):  # not a share role
            with pytest.raises(IntegrityError):
                with engine.begin() as c:
                    bad(c)

        with engine.begin() as c:
            c.execute(text("DELETE FROM users WHERE id = :u"), {"u": bob})
            assert c.execute(text("SELECT count(*) FROM account_shares")).scalar_one() == 0
            carol = _user(c, "carol@example.com")
            _share(c, joint, carol, "viewer")
            c.execute(text("DELETE FROM transactions WHERE account_id = :a"), {"a": joint})
            c.execute(text("DELETE FROM accounts WHERE id = :a"), {"a": joint})
            assert c.execute(text("SELECT count(*) FROM account_shares")).scalar_one() == 0

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            insp = inspect(c)
            assert not insp.has_table("account_shares")
            assert "created_by_actor" not in {col["name"] for col in insp.get_columns("transactions")}
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == PREVIOUS

        _alembic(scratch_url, "upgrade", SHARES)
        with engine.begin() as c:
            assert inspect(c).has_table("account_shares")
    finally:
        engine.dispose()

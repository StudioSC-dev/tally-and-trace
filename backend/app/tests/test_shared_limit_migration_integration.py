"""The shared credit limit column (b9e4c2a7d1f3).

Adds ``accounts.shares_limit_with_account_id``: nullable, a foreign key to
``accounts`` with ``ON DELETE SET NULL``, the two CHECKs and an index. The
downgrade removes all of it. Runs alembic in a subprocess on a throwaway
database, seeded raw at the parent revision. Skips without a database; the
chain check needs none.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

BACKEND_DIR = Path(__file__).resolve().parents[2]
PARENT = "d7b3f1a9c5e2"
REVISION = "b9e4c2a7d1f3"
COLUMN = "shares_limit_with_account_id"
CHECKS = {"ck_accounts_shared_limit_not_self", "ck_accounts_shared_limit_no_own_limit"}
FK = "fk_accounts_shares_limit_with_account_id"
INDEX = "ix_accounts_shares_limit_with_account_id"


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
    name = f"{base.database}_slim_{os.urandom(3).hex()}"
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
        "SELECT is_nullable, data_type FROM information_schema.columns "
        "WHERE table_name = 'accounts' AND column_name = :col"), {"col": COLUMN}).one_or_none()


def _constraints(c):
    return {name: kind for name, kind in c.execute(text(
        "SELECT conname, contype FROM pg_constraint "
        "WHERE conrelid = 'accounts'::regclass AND conname = ANY(:names)"),
        {"names": sorted(CHECKS | {FK})})}


def _fk_delete_rule(c):
    return c.execute(text(
        "SELECT confdeltype FROM pg_constraint WHERE conname = :fk"), {"fk": FK}).scalar()


def _index(c):
    return c.execute(text(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'accounts' AND indexname = :ix"),
        {"ix": INDEX}).scalar()


def _card(c, user_id, name, limit):
    return c.execute(text(
        "INSERT INTO accounts (user_id, name, account_type, balance, currency, credit_limit, "
        "is_active) VALUES (:u, :n, 'credit', 0, 'PHP', :l, true) RETURNING id"),
        {"u": user_id, "n": name, "l": limit}).scalar_one()


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_shared_limit_migration_up_and_down(scratch_url):
    _alembic(scratch_url, "upgrade", PARENT)
    engine = create_engine(scratch_url)
    try:
        with engine.begin() as c:
            assert _column(c) is None
            u = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('slim@example.com', 'x', 'S', 'L') RETURNING id")).scalar_one()
            amex = _card(c, u, "Amex", 480000)
            other = _card(c, u, "Other", 50000)

        _alembic(scratch_url, "upgrade", REVISION)
        with engine.begin() as c:
            assert tuple(_column(c)) == ("YES", "integer")
            assert _constraints(c) == {
                "ck_accounts_shared_limit_not_self": "c",
                "ck_accounts_shared_limit_no_own_limit": "c",
                FK: "f",
            }
            assert _fk_delete_rule(c) == "n"  # SET NULL
            assert COLUMN in _index(c)
            # Existing rows read null and keep their limits.
            rows = c.execute(text(
                f"SELECT id, {COLUMN}, credit_limit FROM accounts ORDER BY id")).all()
            assert [(r[0], r[1], int(r[2])) for r in rows] == [
                (amex, None, 480000), (other, None, 50000)]
            platinum = _card(c, u, "Platinum", None)
            c.execute(text(f"UPDATE accounts SET {COLUMN} = :p WHERE id = :id"),
                      {"p": amex, "id": platinum})

        # The CHECKs hold: no self-link, no own limit on a linked card.
        for sql, params in (
            (f"UPDATE accounts SET credit_limit = NULL, {COLUMN} = id WHERE id = :id",
             {"id": other}),
            ("UPDATE accounts SET credit_limit = 1 WHERE id = :id", {"id": platinum}),
        ):
            with pytest.raises(IntegrityError):
                with engine.begin() as c:
                    c.execute(text(sql), params)

        # The primary's row going nulls the pointer.
        with engine.begin() as c:
            c.execute(text("DELETE FROM accounts WHERE id = :id"), {"id": amex})
            assert c.execute(text(f"SELECT {COLUMN} FROM accounts WHERE id = :id"),
                             {"id": platinum}).scalar() is None

        _alembic(scratch_url, "downgrade", PARENT)
        with engine.connect() as c:
            assert _column(c) is None
            assert _constraints(c) == {}
            assert _index(c) is None
            assert c.execute(text("SELECT count(*) FROM accounts")).scalar_one() == 2

        _alembic(scratch_url, "upgrade", REVISION)
        with engine.connect() as c:
            assert _column(c) is not None
    finally:
        engine.dispose()

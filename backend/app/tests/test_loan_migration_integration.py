"""Migration M3 (loan accounts + loan payment kind).

Runs alembic in a subprocess against a throwaway database created on the same
server as ``DATABASE_URL``: a fresh database upgrades to head, downgrades to M2,
and upgrades again from it with an existing account and transaction, which keep
null loan columns. The CHECK constraints reject unknown loan kinds, amortisation
modes and payment kinds. Skips without a database; the single-head check needs
none.
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
M2 = "b9e3f1a7c5d2"
M3 = "c4e8a2f6b1d3"

LOAN_COLUMNS = {
    "loan_kind", "loan_annual_rate", "loan_term_months", "loan_payment_amount",
    "loan_first_payment_date", "loan_amortization", "loan_payments_made_offset",
}


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


def test_alembic_has_a_single_head_descending_from_m3():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert M3 in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(M3).down_revision == M2


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_m3_{os.urandom(3).hex()}"
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


def _columns(conn, table):
    return {
        row[0] for row in conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"
        ), {"t": table})
    }


def _enum_values(conn):
    return {
        row[0] for row in conn.execute(text(
            "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
            "WHERE t.typname = 'accounttype'"
        ))
    }


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_m3_applies_fresh_and_from_m2_and_downgrades(scratch_url):
    _alembic(scratch_url, "upgrade", "head")
    engine = create_engine(scratch_url)
    try:
        with engine.connect() as c:
            assert LOAN_COLUMNS <= _columns(c, "accounts")
            assert "loan_payment_kind" in _columns(c, "transactions")
            assert "loan" in _enum_values(c)

        _alembic(scratch_url, "downgrade", M2)
        with engine.connect() as c:
            assert not (LOAN_COLUMNS & _columns(c, "accounts"))
            assert "loan_payment_kind" not in _columns(c, "transactions")
            # PostgreSQL cannot drop an enum value; it is left in place (as b7c1e2f3a4d5).
            uid = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('m3@example.com', 'x', 'M', 'Three') RETURNING id"
            )).scalar()
            acc = c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, balance, currency) "
                "VALUES (:u, 'Bank', 'savings', 100, 'PHP') RETURNING id"
            ), {"u": uid}).scalar()
            c.execute(text(
                "INSERT INTO transactions (user_id, account_id, amount, transfer_fee, "
                "transaction_type, transaction_date) "
                "VALUES (:u, :a, 5, 0, 'debit', now())"
            ), {"u": uid, "a": acc})
            c.commit()

        _alembic(scratch_url, "upgrade", "head")
        with engine.connect() as c:
            row = c.execute(text(
                "SELECT loan_kind, loan_amortization, loan_payments_made_offset "
                "FROM accounts WHERE id = :a"
            ), {"a": acc}).one()
            assert tuple(row) == (None, None, None)
            assert c.execute(text(
                "SELECT loan_payment_kind FROM transactions WHERE account_id = :a"
            ), {"a": acc}).scalar() is None

            c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, balance, currency, "
                "loan_kind, loan_amortization, loan_term_months) "
                "VALUES (:u, 'Car', 'loan', -1000, 'PHP', 'auto', 'fixed', 60)"
            ), {"u": uid})
            c.commit()

            for column, value in (
                ("loan_kind", "boat"),
                ("loan_amortization", "reduce_payment"),
            ):
                with pytest.raises(IntegrityError):
                    c.execute(text(
                        f"UPDATE accounts SET {column} = :v WHERE id = :a"
                    ), {"v": value, "a": acc})
                c.rollback()
            with pytest.raises(IntegrityError):
                c.execute(text(
                    "UPDATE transactions SET loan_payment_kind = 'bonus' WHERE account_id = :a"
                ), {"a": acc})
            c.rollback()
    finally:
        engine.dispose()

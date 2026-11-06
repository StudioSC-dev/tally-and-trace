"""The settlement flag migration (c4e1a7d92b36).

Adds ``accounts.auto_post_enabled``, off everywhere, and clears a stray
``budget_entries.auto_post_enabled`` on any row failing the full eligibility
rule. Nothing else moves: ``is_autopay`` is not copied, so no entry changes
settlement. Runs alembic in a subprocess on a throwaway database, seeded raw at
the parent revision. Skips without a database; the chain check needs none.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[2]
PARENT = "8f4493e073df"
REVISION = "c4e1a7d92b36"


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
    name = f"{base.database}_settle_{os.urandom(3).hex()}"
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


def _account(c, user, name, kind, currency="PHP"):
    return c.execute(text(
        "INSERT INTO accounts (user_id, name, account_type, balance, currency) "
        "VALUES (:u, :n, CAST(:t AS accounttype), 0, CAST(:c AS currencytype)) RETURNING id"
    ), {"u": user, "n": name, "t": kind, "c": currency}).scalar_one()


REVIEWED = "2026-10-01T00:00:00+00:00"
STAMP = "2026-10-02T00:00:00+00:00"


def _entry(c, user, name, account, *, entry_type="expense", flag=True, reviewed=REVIEWED,
           capped=True, billing_kind=None, transfer_to=None, is_autopay=False, is_active=True,
           currency="PHP"):
    c.execute(text(
        "INSERT INTO budget_entries (user_id, entry_type, name, amount, currency, cadence, "
        "next_occurrence, account_id, transfer_to_account_id, is_autopay, is_active, "
        "lead_time_days, end_mode, max_occurrences, billing_kind, auto_post_enabled, "
        "installment_reviewed_at, updated_at) "
        "VALUES (:u, CAST(:type AS budgetentrytype), :n, 100, CAST(:cur AS currencytype), "
        "'monthly', '2026-11-15', :a, :to, :autopay, :active, 0, :mode, :max, :bk, :flag, "
        ":rev, :stamp)"
    ), {"u": user, "type": entry_type, "n": name, "cur": currency, "a": account,
        "to": transfer_to, "autopay": is_autopay, "active": is_active,
        "mode": "after_occurrences" if capped else "indefinite", "max": 12 if capped else None,
        "bk": billing_kind, "flag": flag, "rev": reviewed, "stamp": STAMP})


@pytest.mark.skipif(not _db_reachable(), reason="no database available")
def test_no_entry_changes_settlement_and_stray_flags_are_cleared(scratch_url):
    _alembic(scratch_url, "upgrade", PARENT)
    engine = create_engine(scratch_url)
    try:
        with engine.begin() as c:
            u = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('settle@example.com', 'x', 'S', 'F') RETURNING id"
            )).scalar_one()
            bank = _account(c, u, "Bank", "checking")
            card = _account(c, u, "Card", "credit")
            loan = _account(c, u, "Loan", "loan")

            # Off stays off, whatever is_autopay says.
            _entry(c, u, "autopay rent", bank, flag=False, reviewed=None, capped=False,
                   is_autopay=True)
            _entry(c, u, "autopay card sub", card, flag=False, reviewed=None, capped=False,
                   billing_kind="subscription", is_autopay=True)
            # Passes the full rule: stays on. Being paused, foreign or marked
            # subscription is not part of it.
            _entry(c, u, "keep installment", card)
            _entry(c, u, "keep paused", card, is_active=False)
            _entry(c, u, "keep foreign", card, currency="USD")
            _entry(c, u, "keep capped subscription", card, billing_kind="subscription")
            # Fails one part of the rule each: cleared.
            _entry(c, u, "stray unreviewed", card, reviewed=None)
            _entry(c, u, "stray bank", bank)
            _entry(c, u, "stray bank unreviewed", bank, reviewed=None, capped=False)
            _entry(c, u, "stray no account", None)
            _entry(c, u, "stray income", card, entry_type="income")
            _entry(c, u, "stray transfer", card, transfer_to=bank)
            _entry(c, u, "stray open-ended", card, capped=False)
            _entry(c, u, "stray card bill", card, billing_kind="bill")

        _alembic(scratch_url, "upgrade", REVISION)
        with engine.begin() as c:
            rows = c.execute(text(
                "SELECT name, auto_post_enabled, is_autopay, installment_reviewed_at, updated_at "
                "FROM budget_entries")).all()
            on = {r.name for r in rows if r.auto_post_enabled}
            assert on == {"keep installment", "keep paused", "keep foreign",
                          "keep capped subscription"}
            # is_autopay is left alone, the review too, and no open edit goes stale.
            assert {r.name for r in rows if r.is_autopay} == {"autopay rent", "autopay card sub"}
            assert {r.name for r in rows if r.installment_reviewed_at is None} == {
                "autopay rent", "autopay card sub", "stray unreviewed", "stray bank unreviewed"}
            assert {r.updated_at.isoformat() for r in rows} == {"2026-10-02T00:00:00+00:00"}

            # No loan starts on, and the old code's insert (no such column) still works.
            column = c.execute(text(
                "SELECT is_nullable, column_default FROM information_schema.columns "
                "WHERE table_name = 'accounts' AND column_name = 'auto_post_enabled'")).one()
            assert (column.is_nullable, column.column_default) == ("NO", "false")
            late = _account(c, u, "Late loan", "loan")
            flags = c.execute(text(
                "SELECT id, auto_post_enabled FROM accounts WHERE id IN (:a, :b)"
            ), {"a": loan, "b": late}).all()
            assert dict(flags) == {loan: False, late: False}

        # The way back only drops the column, and a second pass clears nothing more.
        _alembic(scratch_url, "downgrade", PARENT)
        with engine.connect() as c:
            assert c.execute(text(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'accounts' AND column_name = 'auto_post_enabled'"
            )).scalar_one() == 0
            assert c.execute(text(
                "SELECT count(*) FROM budget_entries WHERE auto_post_enabled")).scalar_one() == 4
        _alembic(scratch_url, "upgrade", REVISION)
        with engine.connect() as c:
            assert c.execute(text(
                "SELECT count(*) FROM budget_entries WHERE auto_post_enabled")).scalar_one() == 4
    finally:
        engine.dispose()

"""``transactions.occurrence_date``: the occurrence a materialised row fulfils (STU-224).

``materialize`` records the entry's ``next_occurrence`` (read before the advance)
on the row it posts, whatever ``transaction_date`` the caller chose. The column
is ``timestamptz`` like ``transaction_date``, so a row written under one session
time zone and read under another keeps both on the same instant. All accounts
and amounts are generic fixtures. Skips without a database.
"""
import os
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "e7a3c5f9b2d4"
OCCURRENCE_DATE = "f8b2d4a6c1e3"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def user(db):
    """A throwaway user; everything it owns is deleted afterwards."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.models.user import User

    u = User(email=f"occ-{os.urandom(4).hex()}@example.com",
             password_hash=get_password_hash("password123"),
             first_name="Occ", last_name="Probe", is_verified=True)
    db.add(u)
    db.commit()
    db.refresh(u)

    yield u

    db.rollback()
    db.query(Transaction).filter(Transaction.user_id == u.id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.user_id == u.id).delete()
    db.commit()
    db.query(Account).filter(Account.user_id == u.id).delete()
    db.query(User).filter(User.id == u.id).delete()
    db.commit()


def _checking(db, user, balance="10000.00"):
    from app.models.account import Account, AccountType

    a = Account(user_id=user.id, name="Checking B", account_type=AccountType.CHECKING,
                balance=Decimal(balance))
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _monthly(db, user, name, next_occurrence, account):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    e = BudgetEntry(user_id=user.id, name=name, entry_type=BudgetEntryType.EXPENSE,
                    amount=Decimal("1000.00"), cadence=RecurrenceFrequency.MONTHLY,
                    next_occurrence=next_occurrence, account_id=account.id)
    db.add(e)
    db.commit()
    return e


def _login(client, user):
    r = client.post("/api/v1/auth/login",
                    json={"email": user.email, "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _naive(dt):
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def test_occurrence_date_migration_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert OCCURRENCE_DATE in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(OCCURRENCE_DATE).down_revision == PREVIOUS


def test_materialize_records_the_occurrence_it_fulfils(db, user, client):
    """A monthly 1,000 bill due 1 Sep, paid late on 1 Oct and advanced: the row is
    dated 1 Oct and fulfils 1 Sep. The schedule is now on 1 Oct; recorded without
    a custom date and without advancing, that row fulfils 1 Oct."""
    from app.models.transaction import Transaction

    checking = _checking(db, user)
    entry = _monthly(db, user, "Rent", datetime(2026, 9, 1), checking)
    auth = _login(client, user)

    late = client.post(f"/api/v1/budget-entries/{entry.id}/materialize", headers=auth,
                       json={"transaction_date": "2026-10-01T00:00:00", "advance": True})
    assert late.status_code == 201, late.text
    on_time = client.post(f"/api/v1/budget-entries/{entry.id}/materialize", headers=auth,
                          json={"advance": False})
    assert on_time.status_code == 201, on_time.text

    db.expire_all()
    rows = {t.id: t for t in db.query(Transaction).filter(Transaction.budget_entry_id == entry.id)}
    late_row, on_time_row = rows[late.json()["id"]], rows[on_time.json()["id"]]
    assert _naive(late_row.transaction_date) == datetime(2026, 10, 1)
    assert _naive(late_row.occurrence_date) == datetime(2026, 9, 1)
    assert _naive(on_time_row.transaction_date) == datetime(2026, 10, 1)
    assert _naive(on_time_row.occurrence_date) == datetime(2026, 10, 1)


def test_occurrence_date_has_the_type_of_transaction_date(db):
    types = dict(db.execute(text(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'transactions' "
        "AND column_name IN ('transaction_date', 'occurrence_date')")).all())
    assert types == {"transaction_date": "timestamp with time zone",
                     "occurrence_date": "timestamp with time zone"}


def test_occurrence_date_round_trips_across_session_time_zones(db, user):
    """Written in a session on Asia/Manila (UTC+8) with the same naive value in
    both columns, read in a session on UTC: still the same instant, and the row
    matches the same day as an identical row with no ``occurrence_date``.
    3:00 on 5 Aug in Manila is 19:00 on 4 Aug in UTC, so a column without a
    time zone would be 8 hours off and on another day."""
    from app.models.transaction import Transaction, TransactionType
    from app.services.forecast import linked_transactions

    checking = _checking(db, user)
    with_occurrence = _monthly(db, user, "Rent", datetime(2026, 8, 5), checking)
    without = _monthly(db, user, "Water", datetime(2026, 8, 5), checking)
    when = datetime(2026, 8, 5, 3, 0)

    engine = create_engine(os.environ["DATABASE_URL"], poolclass=NullPool)
    Session = sessionmaker(bind=engine)
    try:
        manila = Session()
        try:
            manila.execute(text("SET TIME ZONE 'Asia/Manila'"))
            fulfilled = Transaction(
                user_id=user.id, account_id=checking.id, amount=Decimal("1000.00"),
                transaction_type=TransactionType.DEBIT, transaction_date=when,
                occurrence_date=when, budget_entry_id=with_occurrence.id, is_posted=False)
            plain = Transaction(
                user_id=user.id, account_id=checking.id, amount=Decimal("1000.00"),
                transaction_type=TransactionType.DEBIT, transaction_date=when,
                budget_entry_id=without.id, is_posted=False)
            manila.add_all([fulfilled, plain])
            manila.commit()
            fulfilled_id = fulfilled.id
        finally:
            manila.close()

        utc = Session()
        try:
            utc.execute(text("SET TIME ZONE 'UTC'"))
            assert utc.execute(text(
                "SELECT occurrence_date = transaction_date FROM transactions WHERE id = :id"),
                {"id": fulfilled_id}).scalar_one() is True
            days = {entry_id: _naive(day).date() for entry_id, day in
                    linked_transactions(utc, [with_occurrence.id, without.id])}
            assert days[with_occurrence.id] == days[without.id]
        finally:
            utc.close()
    finally:
        engine.dispose()

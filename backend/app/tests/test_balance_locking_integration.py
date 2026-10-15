"""Concurrent ledger writes keep every balance update (STU-226). Skips without a database.

Each race holds a write open in a holder session, starts a second write in a worker
thread, probes ``pg_blocking_pids`` until the worker waits on the holder (10 s
deadline), then commits the holder and joins the worker with a timeout. The worker
must then build on the holder's committed figures, not a stale read: an unlocked
read followed by ``balance = old ± x`` would overwrite the holder's change.

Every holder is rolled back in ``finally`` and every worker joined with a timeout,
so a hung race fails rather than hanging the suite.
"""
import os
import threading
import time
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

PROBE_DEADLINE = 10  # seconds the probe waits for the worker to block
JOIN_TIMEOUT = 20
WHEN = "2026-10-05T12:00:00"


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def holder(sw_client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


class Worker:
    """A thread that records its result or the exception it raised."""

    def __init__(self, fn):
        self.fn = fn
        self.result = None
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            self.result = self.fn()
        except BaseException as exc:  # recorded, re-raised in the test thread
            self.error = exc


def _pid(session) -> int:
    return session.execute(text("SELECT pg_backend_pid()")).scalar()


def _wait_blocked(engine, holder_pid: int, worker: Worker) -> bool:
    """Whether some backend ends up waiting on ``holder_pid`` before the deadline.

    Each poll is its own transaction: ``pg_stat_activity`` is snapshotted once per
    transaction, so polling inside one would never see the worker arrive.
    """
    deadline = time.monotonic() + PROBE_DEADLINE
    with engine.connect() as probe:
        while True:
            waiting = probe.execute(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE pg_blocking_pids(pid) @> ARRAY[CAST(:holder AS integer)]"),
                {"holder": holder_pid}).scalar()
            probe.rollback()
            if waiting or not worker.thread.is_alive() or time.monotonic() > deadline:
                return bool(waiting)
            time.sleep(0.05)


def _race(engine, holder, fn):
    """Run ``fn`` in a worker while ``holder`` is open; commit the holder once it waits."""
    holder_pid = _pid(holder)
    worker = Worker(fn)
    try:
        worker.thread.start()
        blocked = _wait_blocked(engine, holder_pid, worker)
        assert blocked, ("the worker did not wait on the holder", worker.result, worker.error)
        holder.commit()
    finally:
        holder.rollback()  # a no-op once committed
        worker.thread.join(JOIN_TIMEOUT)
    assert not worker.thread.is_alive(), "the worker did not finish"
    if worker.error is not None:
        raise worker.error
    return worker.result


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _checking(client, who, balance=10_000, name="Checking"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "balance": balance})["id"]


def _debit(account_id, amount):
    return {"account_id": account_id, "amount": amount, "transaction_type": "debit",
            "description": "locking probe", "transaction_date": WHEN}


def _hold_debit(holder, user_id, account_id, amount):
    """``add_transaction`` a posted debit in the holder session, flushed, uncommitted."""
    from app.models.user import User
    from app.routers.transactions import add_transaction
    from app.schemas.transaction import TransactionCreate

    txn = add_transaction(holder, holder.get(User, user_id),
                          TransactionCreate(**_debit(account_id, amount)))
    holder.flush()
    return txn


def _loan(client, who, bank_id, balance=-1_000):
    return sw_post(client, who, "/accounts/", {
        "name": "Probe Loan", "account_type": "loan", "loan_kind": "auto",
        "balance": balance, "loan_annual_rate": 10, "loan_term_months": 60,
        "loan_payment_amount": 100, "loan_first_payment_date": "2026-03-04",
        "payment_account_id": bank_id})["id"]


# --- 1, 2: two creates ----------------------------------------------------------

def test_two_creates_on_one_account_keep_both_debits(sw_client, sw_people, engine, holder):
    """Main: the worker reads 10,000 unlocked, writes 9,800 over the holder's 9,900."""
    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    _hold_debit(holder, me["id"], checking, 100)

    r = _race(engine, holder, lambda: client.post(
        f"{API}/transactions/", json=_debit(checking, 200), headers=me["headers"]))

    assert r.status_code == 200, r.text
    assert _balance(client, me, checking) == Decimal("9700.00")


def test_two_owners_on_one_shared_account_keep_both_debits(sw_client, sw_db, sw_people,
                                                           engine, holder):
    """Different owners take different owner keys: the account lock alone serialises them."""
    client = sw_client
    owner, partner = sw_people(), sw_people()
    joint = _checking(client, owner, name="Joint")
    sw_share(sw_db, joint, partner["id"], "editor", owner["id"])
    _hold_debit(holder, owner["id"], joint, 100)

    r = _race(engine, holder, lambda: client.post(
        f"{API}/transactions/", json=_debit(joint, 200), headers=partner["headers"]))

    assert r.status_code == 200, r.text
    assert _balance(client, owner, joint) == Decimal("9700.00")


# --- 3: update and delete against a concurrent create ---------------------------

def _posted_debit(client, who, account_id, amount):
    r = client.post(f"{API}/transactions/", json=_debit(account_id, amount),
                    headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_an_update_against_a_concurrent_create_keeps_both(sw_client, sw_people, engine, holder):
    """10,000 - 50 - 300. Main reverses onto the stale 9,900 and gives 9,700."""
    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    txn = _posted_debit(client, me, checking, 100)
    _hold_debit(holder, me["id"], checking, 50)

    r = _race(engine, holder, lambda: client.put(
        f"{API}/transactions/{txn}", json={"amount": 300}, headers=me["headers"]))

    assert r.status_code == 200, r.text
    assert _balance(client, me, checking) == Decimal("9650.00")


def test_a_delete_against_a_concurrent_create_keeps_both(sw_client, sw_people, engine, holder):
    """10,000 - 50. Main reverses onto the stale 9,900 and gives 10,000."""
    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    txn = _posted_debit(client, me, checking, 100)
    _hold_debit(holder, me["id"], checking, 50)

    r = _race(engine, holder, lambda: client.delete(
        f"{API}/transactions/{txn}", headers=me["headers"]))

    assert r.status_code == 200, r.text
    assert _balance(client, me, checking) == Decimal("9950.00")


# --- 4: loan edit against a concurrent payment ----------------------------------

def test_a_loan_payment_edit_reads_the_locked_loan(sw_client, sw_people, engine, holder):
    """Owed is read under the lock: 300 left + 100 reversed allows 400, not 500.

    Main validates against 900 owed read unlocked, accepts, and writes a stale loan
    balance over the holder's payment.
    """
    client = sw_client
    me = sw_people()
    bank = _checking(client, me, name="Bank")
    loan = _loan(client, me, bank)
    r = client.post(f"{API}/accounts/{loan}/loan-payment",
                    json={"principal": 100, "interest": 0}, headers=me["headers"])
    assert r.status_code == 200, r.text
    payment = r.json()["id"]
    assert _balance(client, me, loan) == Decimal("-900.00")

    holder.execute(text("SELECT id FROM accounts WHERE id IN (:a, :b) ORDER BY id FOR UPDATE"),
                   {"a": loan, "b": bank})
    holder.execute(text("UPDATE accounts SET balance = balance + 600 WHERE id = :id"),
                   {"id": loan})
    holder.execute(text("UPDATE accounts SET balance = balance - 600 WHERE id = :id"),
                   {"id": bank})

    r = _race(engine, holder, lambda: client.put(
        f"{API}/transactions/{payment}", json={"amount": 500}, headers=me["headers"]))

    assert r.status_code == 400 and "owed" in r.text, r.text
    assert _balance(client, me, loan) == Decimal("-300.00")
    assert _balance(client, me, bank) == Decimal("9300.00")


# --- 5: update and delete on the same transaction -------------------------------

def test_an_update_queued_behind_a_delete_of_its_row_is_not_found(sw_client, sw_people,
                                                                   engine, holder):
    """Main reverses and applies against stale reads, then fails on the vanished row."""
    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    txn = _posted_debit(client, me, checking, 100)

    holder.execute(text("DELETE FROM transactions WHERE id = :id"), {"id": txn})
    holder.execute(text("UPDATE accounts SET balance = balance + 100 WHERE id = :id"),
                   {"id": checking})

    r = _race(engine, holder, lambda: client.put(
        f"{API}/transactions/{txn}", json={"amount": 300}, headers=me["headers"]))

    assert r.status_code == 404, r.text
    assert _balance(client, me, checking) == Decimal("10000.00")
    assert client.get(f"{API}/transactions/{txn}", headers=me["headers"]).status_code == 404


def test_a_delete_queued_behind_an_update_reverses_the_updated_row(sw_client, sw_people,
                                                                  engine, holder):
    """9,650 after the holder, + 300 reversed. Main reverses the stale 100 onto 9,900."""
    from app.models.transaction import Transaction, TransactionType
    from app.models.user import CurrencyType

    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    txn = _posted_debit(client, me, checking, 100)

    holder.execute(text("UPDATE transactions SET amount = 300 WHERE id = :id"), {"id": txn})
    holder.execute(text("UPDATE accounts SET balance = balance - 200 WHERE id = :id"),
                   {"id": checking})
    holder.add(Transaction(
        user_id=me["id"], created_by_actor=me["id"], account_id=checking, amount=50,
        currency=CurrencyType.PHP, transfer_fee=0, transaction_type=TransactionType.DEBIT,
        is_posted=True, transaction_date=datetime(2026, 10, 5, 12, 0),
        description="unrelated"))
    holder.flush()
    holder.execute(text("UPDATE accounts SET balance = balance - 50 WHERE id = :id"),
                   {"id": checking})

    r = _race(engine, holder, lambda: client.delete(
        f"{API}/transactions/{txn}", headers=me["headers"]))

    assert r.status_code == 200, r.text
    assert _balance(client, me, checking) == Decimal("9950.00")


# --- 6, 7: materialize and the loan endpoints -----------------------------------

def test_a_materialize_against_a_concurrent_create_keeps_both(sw_client, sw_people,
                                                             engine, holder):
    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    entry = sw_post(client, me, "/budget-entries/", {
        "name": "Probe rent", "entry_type": "expense", "amount": 200,
        "cadence": "monthly", "next_occurrence": "2026-11-01T00:00:00",
        "account_id": checking})["id"]
    _hold_debit(holder, me["id"], checking, 100)

    r = _race(engine, holder, lambda: client.post(
        f"{API}/budget-entries/{entry}/materialize", json={}, headers=me["headers"]))

    assert r.status_code == 201, r.text
    assert _balance(client, me, checking) == Decimal("9700.00")


def test_a_create_against_a_concurrent_loan_payment_keeps_both(sw_client, sw_people,
                                                              engine, holder):
    """The holder runs the loan-payment endpoint's path: ``_lock`` then ``record_payment``."""
    from app.models.account import Account
    from app.routers.accounts import _lock
    from app.services import loans as loan_svc

    client = sw_client
    me = sw_people()
    bank = _checking(client, me, name="Bank")
    loan = _loan(client, me, bank)

    loan_row, funding = holder.get(Account, loan), holder.get(Account, bank)
    _lock(holder, loan_row, funding)
    loan_svc.record_payment(
        holder, user_id=me["id"], loan=loan_row, funding=funding,
        principal=Decimal("100"), interest=Decimal("0"), kind=loan_svc.SCHEDULED,
        when=datetime(2026, 10, 5, 12, 0), is_posted=True, description=None)
    holder.flush()

    r = _race(engine, holder, lambda: client.post(
        f"{API}/transactions/", json=_debit(bank, 200), headers=me["headers"]))

    assert r.status_code == 200, r.text
    assert _balance(client, me, bank) == Decimal("9700.00")
    assert _balance(client, me, loan) == Decimal("-900.00")


# --- 8: lock mode, and no selectin reload ---------------------------------------

def test_lock_accounts_takes_no_key_update_and_reloads_no_collections(sw_client, sw_people,
                                                                     holder):
    from app.core import locking
    from app.core.database import engine as app_engine
    from app.models.account import Account

    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    for amount in (10, 20, 30):
        _posted_debit(client, me, checking, amount)

    account = holder.get(Account, checking)
    assert len(account.transactions) == 3
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(app_engine, "before_cursor_execute", record)
    try:
        locked = locking.lock_accounts(holder, [checking])
    finally:
        event.remove(app_engine, "before_cursor_execute", record)

    assert locked == {checking: account}
    assert sum("FOR NO KEY UPDATE" in s for s in statements) == 1, statements
    for table in ("transactions", "account_shares", "account_tags"):
        assert not any(f"FROM {table}" in s for s in statements), (table, statements)


def test_a_locked_account_still_takes_new_references(sw_client, sw_people, holder):
    """NO KEY UPDATE lets an insert's foreign-key key-share on the account through."""
    from app.core import locking
    from app.core.database import SessionLocal
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    client = sw_client
    me = sw_people()
    checking = _checking(client, me)
    locking.lock_accounts(holder, [checking])

    other = SessionLocal()
    try:
        other.execute(text("SET LOCAL lock_timeout = '500ms'"))
        other.add(BudgetEntry(
            user_id=me["id"], name="Key share probe", entry_type=BudgetEntryType.EXPENSE,
            amount=10, cadence=RecurrenceFrequency.MONTHLY,
            next_occurrence=datetime(2026, 11, 1), account_id=checking))
        other.flush()
    finally:
        other.rollback()
        other.close()

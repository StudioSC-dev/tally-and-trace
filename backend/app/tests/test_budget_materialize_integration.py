"""
Integration test for POST /budget-entries/{id}/materialize.

Skips when no database is reachable. Uses the seeded demo user: picks an active
budget entry that has an account, posts it, and asserts a linked transaction was
created, the account balance moved by the amount, and the schedule advanced.
"""
import os
import threading
import time
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, text

from app.tests.conftest import sw_post


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


pytestmark = pytest.mark.skipif(not _db_reachable(), reason="no database available")

API = "/api/v1"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _account_balance(client, headers, account_id):
    accts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    for a in items:
        if a["id"] == account_id:
            return a["balance"]
    return None


def test_materialize_posts_transaction_and_advances(client):
    h = _auth(client)

    entries = client.get(f"{API}/budget-entries/", headers=h, params={"is_active": True, "limit": 200}).json()["items"]
    accounts = client.get(f"{API}/accounts/", headers=h, params={"limit": 1000}).json()
    accounts = accounts["items"] if isinstance(accounts, dict) else accounts
    currency_of = {a["id"]: a["currency"] for a in accounts}
    # An entry in another currency than its account's needs the amount charged (F1).
    entry = next((e for e in entries if e.get("account_id")
                  and e["currency"] == currency_of.get(e["account_id"])), None)
    if entry is None:
        pytest.skip("no seeded budget entry with an account to post to")

    before_balance = _account_balance(client, h, entry["account_id"])
    before_next = entry["next_occurrence"]
    amount = entry["amount"]
    expect_type = "credit" if entry["entry_type"] == "income" else "debit"

    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=h, json={})
    assert r.status_code == 201, r.text
    txn = r.json()
    assert txn["budget_entry_id"] == entry["id"]
    assert txn["is_posted"] is True
    assert txn["is_recurring"] is True
    assert txn["transaction_type"] == expect_type
    assert txn["amount"] == pytest.approx(amount, abs=0.01)

    # Account balance moved by the amount in the right direction.
    after_balance = _account_balance(client, h, entry["account_id"])
    delta = after_balance - before_balance
    expected = amount if expect_type == "credit" else -amount
    assert delta == pytest.approx(expected, abs=0.01)

    # Schedule advanced (entry still active in these seeds).
    after = client.get(f"{API}/budget-entries/{entry['id']}", headers=h).json()
    assert after["next_occurrence"] != before_next


# --- STU-215: an installment's payment never passes its total -------------------
#
# These use throwaway users (``sw_people``), not the seeded demo user above.

PROBE_DEADLINE = 10  # seconds a probe waits for a worker to block
JOIN_TIMEOUT = 20


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


def _checking(client, who, balance=10_000):
    return sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": balance})["id"]


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _installment(client, who, account_id, remaining=3, active=True, **extra):
    body = {"name": "Phone installment", "entry_type": "expense", "amount": 1000,
            "cadence": "monthly", "next_occurrence": "2026-11-01T00:00:00",
            "account_id": account_id, "end_mode": "after_occurrences",
            "max_occurrences": remaining, "is_active": active}
    body.update(extra)
    return sw_post(client, who, "/budget-entries/", body)["id"]


def _open_ended(client, who, account_id, **extra):
    body = {"name": "Probe utilities", "entry_type": "expense", "amount": 100,
            "cadence": "monthly", "next_occurrence": "2026-11-01T00:00:00",
            "account_id": account_id}
    body.update(extra)
    return sw_post(client, who, "/budget-entries/", body)["id"]


def _entry_state(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _materialize(client, who, entry_id, **body):
    return client.post(f"{API}/budget-entries/{entry_id}/materialize",
                       json=body, headers=who["headers"])


def _linked_rows(engine, entry_id) -> int:
    with engine.connect() as c:
        return c.execute(text("SELECT count(*) FROM transactions WHERE budget_entry_id = :e"),
                         {"e": entry_id}).scalar()


def test_a_finished_installment_refuses_another_payment(sw_client, sw_people, engine):
    """Main posts a seventh row: 201 and the entry reads '1 of 1'."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=0, active=False)

    r = _materialize(client, me, entry)

    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "This installment is finished or inactive"
    assert _linked_rows(engine, entry) == 0
    assert _balance(client, me, checking) == Decimal("10000.00")
    assert _entry_state(client, me, entry)["occurrences_paid"] == 0


def test_an_installment_payment_without_advancing_is_refused(sw_client, sw_people, engine):
    """Main posts the row without using up an occurrence, so n + m grows."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=3)

    r = _materialize(client, me, entry, advance=False)

    assert r.status_code == 400, r.text
    assert _linked_rows(engine, entry) == 0
    assert _entry_state(client, me, entry)["max_occurrences"] == 3
    assert _balance(client, me, checking) == Decimal("10000.00")


def test_the_last_payment_finishes_the_installment_and_a_second_is_refused(
        sw_client, sw_people, engine):
    """Main: the second call posts again."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=1)

    first = _materialize(client, me, entry)
    assert first.status_code == 201, first.text
    state = _entry_state(client, me, entry)
    assert (state["is_active"], state["max_occurrences"], state["occurrences_paid"]) == (False, 0, 1)

    second = _materialize(client, me, entry)

    assert second.status_code == 409, second.text
    assert _linked_rows(engine, entry) == 1
    assert _balance(client, me, checking) == Decimal("9000.00")


@pytest.mark.parametrize("advance", [True, False])
def test_an_uncapped_after_occurrences_entry_is_paid_like_an_open_ended_one(
        sw_client, sw_people, engine, advance):
    """No cap means open-ended everywhere else (projection, advance, the web app)."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=None)
    assert _entry_state(client, me, entry)["max_occurrences"] is None

    r = _materialize(client, me, entry, advance=advance)

    assert r.status_code == 201, r.text
    assert _linked_rows(engine, entry) == 1
    assert _balance(client, me, checking) == Decimal("9000.00")
    state = _entry_state(client, me, entry)
    assert state["max_occurrences"] is None and state["is_active"] is True


def test_a_default_payment_uses_one_occurrence_and_moves_the_schedule(sw_client, sw_people):
    """Guard: passes before and after."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=3)

    r = _materialize(client, me, entry)

    assert r.status_code == 201, r.text
    state = _entry_state(client, me, entry)
    assert state["max_occurrences"] == 2
    assert state["occurrences_paid"] == 1
    assert state["is_active"] is True
    assert state["next_occurrence"].startswith("2026-12-01")


# --- STU-215: the lock order and the single commit ------------------------------

def _statements_during(fn):
    from app.core.database import engine as app_engine

    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(" ".join(statement.split()))

    event.listen(app_engine, "before_cursor_execute", record)
    try:
        result = fn()
    finally:
        event.remove(app_engine, "before_cursor_execute", record)
    return result, statements


def _first(statements, predicate):
    return next((i for i, s in enumerate(statements) if predicate(s)), None)


def test_materialize_takes_the_owner_lock_then_the_entry_then_the_account(sw_client, sw_people):
    """Main emits no lock statements at all."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _open_ended(client, me, checking)

    r, statements = _statements_during(lambda: _materialize(client, me, entry))
    assert r.status_code == 201, r.text

    owner_lock = _first(statements, lambda s: "pg_advisory_xact_lock" in s)
    entry_locks = [i for i, s in enumerate(statements)
                   if s.startswith("SELECT") and "FROM budget_entries" in s
                   and "FOR NO KEY UPDATE" in s]
    account_lock = _first(statements, lambda s: s.startswith("SELECT") and "FROM accounts" in s
                          and "FOR NO KEY UPDATE" in s)
    assert owner_lock is not None and account_lock is not None, statements
    assert len(entry_locks) == 1, statements
    assert owner_lock < entry_locks[0] < account_lock, (owner_lock, entry_locks, account_lock)
    plain = [s for s in statements if "FROM budget_entries" in s and "FOR UPDATE" in s
             and "FOR NO KEY UPDATE" not in s]
    assert plain == []


def _lock_waiters(engine) -> int:
    """Backends in this database waiting on a lock, polled in a fresh transaction."""
    with engine.connect() as probe:
        n = probe.execute(text(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND wait_event_type = 'Lock'")).scalar()
        probe.rollback()
    return n


def _wait_waiters(engine, target, workers) -> bool:
    """Whether ``target`` backends wait on a lock before the deadline (or a worker ends)."""
    deadline = time.monotonic() + PROBE_DEADLINE
    while True:
        waiting = _lock_waiters(engine)
        if waiting >= target:
            return True
        started = [w for w in workers if w.thread.ident is not None]
        if any(not w.thread.is_alive() for w in started) or time.monotonic() > deadline:
            return False
        time.sleep(0.05)


class _Worker:
    def __init__(self, fn):
        self.fn = fn
        self.result = None
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            self.result = self.fn()
        except BaseException as exc:  # recorded for the test thread
            self.error = exc


def test_two_concurrent_payments_of_the_last_installment_post_one(sw_client, sw_people, engine):
    """Main: both read the entry unlocked, pass every check, and post twice."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=1)
    holder = engine.connect()
    workers = [_Worker(lambda: _materialize(client, me, entry)) for _ in range(2)]
    try:
        holder.execute(text("SELECT id FROM accounts WHERE id = :a FOR UPDATE"), {"a": checking})
        for w in workers:
            w.thread.start()
        assert _wait_waiters(engine, 2, workers), "two requests did not queue behind the holder"
        holder.rollback()
    finally:
        holder.rollback()
        holder.close()
        for w in workers:
            w.thread.join(JOIN_TIMEOUT)
    assert not any(w.thread.is_alive() for w in workers)
    assert [w.error for w in workers] == [None, None]

    assert sorted(w.result.status_code for w in workers) == [201, 409]
    assert _linked_rows(engine, entry) == 1
    assert _balance(client, me, checking) == Decimal("9000.00")
    state = _entry_state(client, me, entry)
    assert (state["max_occurrences"], state["is_active"]) == (0, False)


def test_a_failure_while_advancing_rolls_the_whole_payment_back(sw_client, sw_people, engine,
                                                                monkeypatch):
    """Main commits the row and the balance before the advance runs."""
    from fastapi.testclient import TestClient
    from app.main import app
    import app.routers.budget_entries as entries_router

    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    tag = sw_post(client, me, "/tags/", {"name": "Installment tag"}, expect=(201,))["id"]
    entry = _installment(client, me, checking, remaining=3, tag_ids=[tag])
    before = _entry_state(client, me, entry)

    def boom(*args, **kwargs):
        raise RuntimeError("advance failed")

    monkeypatch.setattr(entries_router, "_advance_occurrence", boom)
    quiet = TestClient(app, raise_server_exceptions=False)
    r = quiet.post(f"{API}/budget-entries/{entry}/materialize", json={}, headers=me["headers"])

    assert r.status_code == 500, r.text
    assert _linked_rows(engine, entry) == 0
    assert _balance(client, me, checking) == Decimal("10000.00")
    after = _entry_state(client, me, entry)
    assert after["next_occurrence"] == before["next_occurrence"]
    assert after["max_occurrences"] == before["max_occurrences"] == 3
    with engine.connect() as c:
        links = c.execute(text(
            "SELECT count(*) FROM transaction_tags tt JOIN transactions t "
            "ON t.id = tt.transaction_id WHERE t.user_id = :u"), {"u": me["id"]}).scalar()
    assert links == 0


def _three_requests(client, engine, me, entry, txn, order):
    """Hold the owner lock, queue U / M / D in ``order`` one at a time, then release."""
    from app.core import locking

    calls = {
        "U": lambda: client.put(f"{API}/transactions/{txn}", json={"amount": 300},
                                headers=me["headers"]),
        "M": lambda: _materialize(client, me, entry),
        "D": lambda: client.delete(f"{API}/budget-entries/{entry}", headers=me["headers"]),
    }
    workers = {name: _Worker(calls[name]) for name in order}
    holder = engine.connect()
    try:
        holder.execute(text("SELECT pg_advisory_xact_lock(:ns, :owner)"),
                       {"ns": locking.OWNER_BUDGET_LOCK_NS, "owner": me["id"]})
        for count, name in enumerate(order, start=1):
            workers[name].thread.start()
            assert _wait_waiters(engine, count, list(workers.values())), (
                name, "did not queue", {n: (w.result, w.error) for n, w in workers.items()})
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        for w in workers.values():
            if w.thread.ident is not None:
                w.thread.join(JOIN_TIMEOUT)
    assert not any(w.thread.is_alive() for w in workers.values()), "a request is still running"
    return workers


@pytest.mark.parametrize("order", [["U", "M", "D"], ["D", "M", "U"]])
def test_materialize_entry_delete_and_transaction_update_cannot_deadlock(
        sw_client, sw_people, engine, order):
    """Regression guard for the lock order: owner, entry, transaction, account.

    It reproduces no bug on main (see the PR body): with the owner lock first on
    every path, whichever request gets it runs to its commit while the others wait
    holding nothing. With materialize taking the entry before the owner lock,
    ``[D, M, U]`` is a deadlock cycle (``40P01``) and ``[U, M, D]`` the three-session
    one: D holds the transaction and waits for the entry, M holds the entry and
    waits for the owner lock, U holds the owner lock and waits for the transaction.
    """
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _open_ended(client, me, checking)
    first = _materialize(client, me, entry)
    assert first.status_code == 201, first.text
    txn = first.json()["id"]
    assert _balance(client, me, checking) == Decimal("9900.00")

    workers = _three_requests(client, engine, me, entry, txn, order)

    assert {n: w.error for n, w in workers.items()} == {n: None for n in order}
    codes = {n: w.result.status_code for n, w in workers.items()}
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT id, amount, budget_entry_id FROM transactions WHERE user_id = :u "
            "ORDER BY id"), {"u": me["id"]}).all()
        entry_left = c.execute(text("SELECT count(*) FROM budget_entries WHERE id = :e"),
                               {"e": entry}).scalar()
    if order == ["U", "M", "D"]:
        assert codes == {"U": 200, "M": 201, "D": 204}
        assert entry_left == 0
        assert [(r[0], Decimal(r[1]), r[2]) for r in rows][0] == (txn, Decimal("300"), None)
        assert len(rows) == 2 and rows[1][2] is None
        assert _balance(client, me, checking) == Decimal("9600.00")
    else:
        assert codes == {"D": 204, "M": 404, "U": 200}
        assert entry_left == 0
        assert [(r[0], Decimal(r[1]), r[2]) for r in rows] == [(txn, Decimal("300"), None)]
        assert _balance(client, me, checking) == Decimal("9700.00")

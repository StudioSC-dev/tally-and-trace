"""Idempotent creates (STU-604, PERF-9): ``Idempotency-Key`` on every create the save outbox sends.

A repeated request with the same key makes no second record and returns the first answer
byte for byte (status, body and, for Mark paid, the ``X-Occurrence*`` headers). One test per
route (AC1), the key's scope (AC2), a lost response and the one-transaction rule (AC3), the
concurrent race and the outbox coverage (AC4). The migration (AC5) and the retention job have their own modules.
Skips without a database.

Reference: Wednesday 2026-11-04, 02:00 UTC (10:00 in Manila).
"""
import json
import os
import uuid
from datetime import datetime

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_balance_locking_integration import JOIN_TIMEOUT, Worker, _pid, _wait_blocked
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 4, 2, 0)
TODAY = "2026-11-04"


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people("Ida", "Idem")
    checking = sw_post(sw_client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    card = sw_post(sw_client, me, "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 2,
        "days_until_due_date": 21, "credit_limit": 200_000,
        "payment_account_id": checking})["id"]
    return {"client": sw_client, "db": sw_db, "me": me, "people": sw_people,
            "checking": checking, "card": card, "mp": monkeypatch}


def _key() -> str:
    return str(uuid.uuid4())


def _post(w, path, body=None, key=None, who=None, expect=None):
    who = who or w["me"]
    headers = dict(who["headers"])
    if key:
        headers["Idempotency-Key"] = key
    kwargs = {} if body is None else {"json": body}
    r = w["client"].post(f"{API}{path}", headers=headers, **kwargs)
    if expect is not None:
        assert r.status_code == expect, r.text
    return r


def _twice(w, path, body=None, expect=201):
    """The same request twice under one key: both answers, the retry's must equal the first."""
    key = _key()
    first = _post(w, path, body, key, expect=expect)
    again = _post(w, path, body, key)
    assert again.status_code == first.status_code
    assert again.content == first.content, "the retry is not the original, byte for byte"
    assert again.headers["content-type"] == first.headers["content-type"]
    return first, again


def _count(w, model, **filters) -> int:
    w["db"].expire_all()
    return w["db"].query(model).filter_by(**filters).count()


def _txn(account_id, description, amount=549, kind="debit", posted=True):
    return {"account_id": account_id, "transaction_type": kind, "amount": amount,
            "description": description, "transaction_date": f"{TODAY}T00:00:00",
            "is_posted": posted}


def _entry_body(account_id, name, next_day=TODAY, amount=500):
    return {"name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
            "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id}


def _entry(w, name, next_day=TODAY, amount=500) -> int:
    return sw_post(w["client"], w["me"], "/budget-entries/",
                   _entry_body(w["checking"], name, next_day, amount))["id"]


def _get(w, path):
    r = w["client"].get(f"{API}{path}", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _txns(w, description):
    from app.models.transaction import Transaction

    return _count(w, Transaction, user_id=w["me"]["id"], description=description)


# --- AC1: one test per route ---------------------------------------------------------------

def test_post_transactions_creates_once(world):
    first, _ = _twice(world, "/transactions/", _txn(world["checking"], "Once", 700), expect=200)
    assert _txns(world, "Once") == 1
    assert _get(world, f"/accounts/{world['checking']}")["balance"] == 49_300
    assert first.json()["description"] == "Once"


def test_post_repeating_creates_one_transaction_and_one_entry(world):
    from app.models.budget_entry import BudgetEntry

    body = {"transaction": _txn(world["checking"], "Gym"),
            "repeat": {"cadence": "monthly", "end_mode": "indefinite"}}
    first, _ = _twice(world, "/transactions/repeating", body)
    assert _txns(world, "Gym") == 1
    assert _count(world, BudgetEntry, user_id=world["me"]["id"], name="Gym") == 1
    assert first.json()["entry"]["name"] == "Gym"


def test_post_transaction_repeat_makes_one_entry(world):
    from app.models.budget_entry import BudgetEntry

    txn_id = sw_post(world["client"], world["me"], "/transactions/",
                     _txn(world["checking"], "Netflix"))["id"]
    body = {"repeat": {"cadence": "monthly", "end_mode": "indefinite"}}
    first, _ = _twice(world, f"/transactions/{txn_id}/repeat", body)
    assert _count(world, BudgetEntry, user_id=world["me"]["id"], name="Netflix") == 1
    assert first.json()["entry"]["name"] == "Netflix"
    # Without the key the same request is refused: the first one linked the row.
    assert _post(world, f"/transactions/{txn_id}/repeat", body).status_code == 409


def test_post_card_payment_makes_one_transfer(world):
    from app.models.transaction import Transaction

    body = {"from_account_id": world["checking"], "amount": 1_000, "payment_date": TODAY,
            "description": "Paid once"}
    _twice(world, f"/cards/{world['card']}/payments", body)
    assert _count(world, Transaction, user_id=world["me"]["id"], description="Paid once") == 1
    assert _get(world, f"/accounts/{world['checking']}")["balance"] == 49_000


def test_post_budget_entry_creates_once(world):
    from app.models.budget_entry import BudgetEntry

    first, _ = _twice(world, "/budget-entries/", _entry_body(world["checking"], "Rent"))
    assert _count(world, BudgetEntry, user_id=world["me"]["id"], name="Rent") == 1
    assert first.json()["name"] == "Rent"


def test_materialize_records_once_advances_once_and_replays_the_headers(world):
    entry = _entry(world, "Spotify")
    first, again = _twice(world, f"/budget-entries/{entry}/materialize", {})
    assert _txns(world, "Spotify") == 1
    assert _get(world, f"/budget-entries/{entry}")["next_occurrence"].startswith("2026-12-04")
    assert first.headers["x-occurrence-outcome"] == "created"
    for name in ("x-occurrence-outcome", "x-occurrence-recorded", "x-occurrences-skipped-count"):
        assert again.headers[name] == first.headers[name]


def test_materialize_due_posts_once_and_advances_once(world):
    entry = _entry(world, "Water", next_day="2026-09-04")
    first, _ = _twice(world, f"/budget-entries/{entry}/materialize-due", expect=200)
    assert len(first.json()["results"]) == 3  # Sep, Oct, Nov
    assert _txns(world, "Water") == 3
    assert _get(world, f"/budget-entries/{entry}")["next_occurrence"].startswith("2026-12-04")
    assert _get(world, f"/accounts/{world['checking']}")["balance"] == 48_500


def test_a_key_does_not_change_what_the_route_answers(world):
    """The stored answer is the route's own: same JSON with and without a key."""
    plain = _post(world, "/transactions/", _txn(world["checking"], "Plain"), expect=200).json()
    keyed = _post(world, "/transactions/", _txn(world["checking"], "Keyed"), _key(), expect=200).json()
    for field in ("id", "description", "created_at", "updated_at"):
        plain.pop(field, None), keyed.pop(field, None)
    assert plain == keyed


# --- no header, bad header -----------------------------------------------------------------

def test_without_a_key_every_request_creates(world):
    for _ in range(2):
        _post(world, "/transactions/", _txn(world["checking"], "Twice"), expect=200)
    assert _txns(world, "Twice") == 2


def test_a_key_that_is_not_a_uuid_is_a_422(world):
    r = _post(world, "/transactions/", _txn(world["checking"], "Bad"), "not-a-uuid")
    assert r.status_code == 422
    assert _txns(world, "Bad") == 0


# --- AC2: the key's scope ------------------------------------------------------------------

def test_the_same_key_for_two_users_is_two_creates(world):
    other = world["people"]("Omar", "Other")
    acct = sw_post(world["client"], other, "/accounts/", {
        "name": "Other bank", "account_type": "checking", "balance": 1_000})["id"]
    key = _key()
    a = _post(world, "/transactions/", _txn(world["checking"], "Shared key"), key, expect=200)
    b = _post(world, "/transactions/", _txn(acct, "Shared key"), key, who=other, expect=200)
    assert a.json()["id"] != b.json()["id"]
    assert _txns(world, "Shared key") == 1


def test_the_same_key_with_another_body_is_a_422(world):
    key = _key()
    _post(world, "/transactions/", _txn(world["checking"], "First body"), key, expect=200)
    r = _post(world, "/transactions/", _txn(world["checking"], "Other body"), key)
    assert r.status_code == 422
    assert "different request" in r.json()["detail"]
    assert _txns(world, "Other body") == 0


def test_the_same_key_on_another_route_is_a_422(world):
    key = _key()
    entry = _entry(world, "Route probe")
    _post(world, f"/budget-entries/{entry}/materialize", {}, key, expect=201)
    r = _post(world, f"/budget-entries/{entry}/materialize-due", None, key)
    assert r.status_code == 422


def test_the_same_key_on_another_row_of_the_same_route_is_a_422(world):
    a, b = _entry(world, "Entry A"), _entry(world, "Entry B")
    key = _key()
    _post(world, f"/budget-entries/{a}/materialize", {}, key, expect=201)
    assert _post(world, f"/budget-entries/{b}/materialize", {}, key).status_code == 422
    assert _txns(world, "Entry B") == 0


def test_the_body_hash_ignores_key_order_and_spacing(world):
    key = _key()
    body = _txn(world["checking"], "Ordered")
    first = _post(world, "/transactions/", body, key, expect=200)
    reordered = world["client"].post(
        f"{API}/transactions/", content="  " + json.dumps(dict(reversed(list(body.items())))),
        headers={**world["me"]["headers"], "Idempotency-Key": key, "Content-Type": "application/json"})
    assert reordered.status_code == 200 and reordered.content == first.content
    assert _txns(world, "Ordered") == 1


# --- AC3: an unknown outcome, one transaction ----------------------------------------------

def test_a_lost_response_is_answered_from_the_store(world):
    key = _key()
    _post(world, "/transactions/", _txn(world["checking"], "Lost"), key, expect=200)  # dropped
    retry = _post(world, "/transactions/", _txn(world["checking"], "Lost"), key)
    assert retry.status_code == 200 and retry.json()["description"] == "Lost"
    assert _txns(world, "Lost") == 1


def test_a_failed_attempt_stores_nothing_and_the_key_can_be_retried(world):
    from app.models.idempotency_key import IdempotencyKey

    key = _key()
    bad = _txn(world["checking"], "Retried")
    bad["account_id"] = 0  # refused
    assert _post(world, "/transactions/", bad, key).status_code >= 400
    assert _count(world, IdempotencyKey, key=uuid.UUID(key)) == 0
    ok = _post(world, "/transactions/", _txn(world["checking"], "Retried"), key, expect=200)
    assert ok.json()["description"] == "Retried"
    assert _txns(world, "Retried") == 1


def test_the_key_and_the_record_commit_together(world, monkeypatch):
    """A crash at the commit leaves neither the record nor the key; the retry then works."""
    from app.models.idempotency_key import IdempotencyKey
    from sqlalchemy.orm import Session

    key = _key()
    real_commit = Session.commit
    calls = []

    def failing_commit(self):
        calls.append(1)
        if len(calls) == 1:
            self.rollback()
            raise RuntimeError("the database went away")
        return real_commit(self)

    monkeypatch.setattr(Session, "commit", failing_commit)
    with pytest.raises(RuntimeError):
        _post(world, "/transactions/", _txn(world["checking"], "Crash"), key)
    monkeypatch.setattr(Session, "commit", real_commit)
    assert _txns(world, "Crash") == 0
    assert _count(world, IdempotencyKey, key=uuid.UUID(key)) == 0
    ok = _post(world, "/transactions/", _txn(world["checking"], "Crash"), key, expect=200)
    assert ok.status_code == 200 and _txns(world, "Crash") == 1


def test_every_stored_row_is_complete(world):
    from app.models.idempotency_key import IdempotencyKey

    key = _key()
    _post(world, "/transactions/", _txn(world["checking"], "Complete"), key, expect=200)
    world["db"].expire_all()
    row = world["db"].get(IdempotencyKey, (world["me"]["id"], uuid.UUID(key)))
    assert row.status_code == 200 and row.response_json["description"] == "Complete"
    assert row.route == "POST /api/v1/transactions/" and len(row.request_hash) == 64


# --- the concurrent same-key race ----------------------------------------------------------

def _hold_key(engine, user_id, key, body_hash, route):
    """A session standing in for request A: it holds the key's row, uncommitted."""
    from app.core.database import SessionLocal

    holder = SessionLocal()
    holder.execute(text(
        "INSERT INTO idempotency_keys (user_id, key, route, request_hash) "
        "VALUES (:u, :k, :r, :h)"), {"u": user_id, "k": key, "r": route, "h": body_hash})
    return holder


def _body_hash(body: dict) -> str:
    from app.core.idempotency import request_hash

    return request_hash(json.dumps(body).encode())


def test_a_concurrent_same_key_request_waits_then_replays_the_winner(world, engine):
    """B arrives while A holds the key: B must wait, then answer with A's stored response."""
    key = _key()
    body = _txn(world["checking"], "Raced")
    holder = _hold_key(engine, world["me"]["id"], key, _body_hash(body),
                       "POST /api/v1/transactions/")
    worker = Worker(lambda: _post(world, "/transactions/", body, key))
    try:
        worker.thread.start()
        assert _wait_blocked(engine, _pid(holder), worker), "B did not wait on A's key"
        stored = {"id": 424242, "description": "Raced"}
        holder.execute(text(
            "UPDATE idempotency_keys SET status_code = 200, response_json = CAST(:j AS jsonb) "
            "WHERE key = :k"), {"j": json.dumps(stored), "k": key})
        holder.commit()
    finally:
        holder.rollback()
        worker.thread.join(JOIN_TIMEOUT)
        holder.close()
    assert not worker.thread.is_alive() and worker.error is None
    assert worker.result.status_code == 200 and worker.result.json() == stored
    assert _txns(world, "Raced") == 0  # B never ran the handler


def test_a_concurrent_same_key_request_takes_over_when_the_first_fails(world, engine):
    """A rolls back (it failed): B then owns the key and creates, once."""
    key = _key()
    body = _txn(world["checking"], "Took over")
    holder = _hold_key(engine, world["me"]["id"], key, _body_hash(body),
                       "POST /api/v1/transactions/")
    worker = Worker(lambda: _post(world, "/transactions/", body, key))
    try:
        worker.thread.start()
        assert _wait_blocked(engine, _pid(holder), worker), "B did not wait on A's key"
        holder.rollback()
    finally:
        holder.rollback()
        worker.thread.join(JOIN_TIMEOUT)
        holder.close()
    assert not worker.thread.is_alive() and worker.error is None
    assert worker.result.status_code == 200
    assert _txns(world, "Took over") == 1


def test_two_requests_in_flight_with_one_key_create_one_record(world, engine, monkeypatch):
    """Both real requests: A is held inside the handler, B arrives; one record results."""
    import threading
    from app.routers import transactions as routes

    key = _key()
    body = _txn(world["checking"], "Both")
    inside, release = threading.Event(), threading.Event()
    real = routes.add_transaction
    first_call = []

    def slow_add(*args, **kwargs):
        if not first_call:
            first_call.append(1)
            inside.set()
            assert release.wait(JOIN_TIMEOUT)
        return real(*args, **kwargs)

    monkeypatch.setattr(routes, "add_transaction", slow_add)
    a = Worker(lambda: _post(world, "/transactions/", body, key))
    b = Worker(lambda: _post(world, "/transactions/", body, key))
    a.thread.start()
    assert inside.wait(JOIN_TIMEOUT)
    b.thread.start()
    with engine.connect() as probe:
        import time
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            waiting = probe.execute(text(
                "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'")).scalar()
            probe.rollback()
            if waiting:
                break
            time.sleep(0.05)
        assert waiting, "B did not wait on A's key"
    release.set()
    a.thread.join(JOIN_TIMEOUT), b.thread.join(JOIN_TIMEOUT)
    assert a.error is None and b.error is None
    assert a.result.status_code == b.result.status_code == 200
    assert a.result.content == b.result.content
    assert _txns(world, "Both") == 1


# --- AC4: coverage -------------------------------------------------------------------------

def _keyed_operations():
    """Every (method, path) the app declares with the Idempotency-Key header parameter, read from
    the OpenAPI spec, where only the ``idempotency`` dependency declares it (it does not depend
    on how the installed FastAPI stores included routers)."""
    from app.main import app

    found = set()
    for path, operations in app.openapi()["paths"].items():
        for method, operation in operations.items():
            if any(p["name"] == "Idempotency-Key" and p["in"] == "header"
                   for p in operation.get("parameters", [])):
                found.add((method.upper(), path.removeprefix(API)))
    return found


def test_every_outbox_endpoint_has_the_idempotency_dependency():
    from app.core.idempotency import OUTBOX_ENDPOINTS

    assert set(OUTBOX_ENDPOINTS) >= {
        ("POST", "/transactions/"), ("POST", "/transactions/repeating"),
        ("POST", "/transactions/{transaction_id}/repeat"), ("POST", "/cards/{account_id}/payments"),
        ("POST", "/budget-entries/"), ("POST", "/budget-entries/{entry_id}/materialize"),
        ("POST", "/budget-entries/{entry_id}/materialize-due")}
    keyed = _keyed_operations()
    lacking = [e for e in OUTBOX_ENDPOINTS if e not in keyed]
    assert not lacking, f"outbox endpoints without the Idempotency-Key dependency: {lacking}"
    # And the reverse: nothing carries the dependency without being listed.
    assert keyed == set(OUTBOX_ENDPOINTS)


def test_the_header_is_in_the_openapi_spec():
    from app.main import app

    params = app.openapi()["paths"][f"{API}/transactions/"]["post"]["parameters"]
    assert any(p["name"] == "Idempotency-Key" and p["in"] == "header" for p in params)


# --- the Due card's Post: PUT /transactions/{id} --------------------------------------------

def test_a_repeated_post_of_a_pending_row_changes_nothing(world):
    """The Due card's Post is ``PUT /transactions/{id}`` with ``is_posted`` (idempotent by body,
    so it carries no key): sending it again after a lost response leaves the one posted row."""
    txn_id = sw_post(world["client"], world["me"], "/transactions/",
                     _txn(world["checking"], "Pending", 600, posted=False))["id"]
    body = {"is_posted": True}
    for _ in range(2):
        r = world["client"].put(f"{API}/transactions/{txn_id}", json=body,
                                headers=world["me"]["headers"])
        assert r.status_code == 200, r.text
        assert r.json()["is_posted"] is True
    assert _get(world, f"/accounts/{world['checking']}")["balance"] == 49_400

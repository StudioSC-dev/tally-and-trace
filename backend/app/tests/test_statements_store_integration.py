"""Stored card statements: write-through, races, billing changes, bulk paths, the read
API and the command (STU-601, PERF-6: AC2, AC3, AC3b, AC4, AC5, AC6, the kill switch).

On the realistic dataset (``app/tests/fixtures/realistic.py``, clock pinned to its
day). ``statements_store.verify_card`` is the check throughout: the stored rows
equal the rows, and the summaries read from the store equal the full replay.
Skips without a database.
"""
import calendar
import os
import subprocess
import sys
import threading
import time as clock
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import text

from app.tests.conftest import sw_db_reachable
from app.tests.statements_store_checks import first_difference

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

API = "/api/v1"
BACKEND = Path(__file__).resolve().parents[2]


# --- helpers ---------------------------------------------------------------------------------

def _card(db, card_id):
    from app.models.account import Account

    db.expire_all()
    return db.get(Account, card_id)


def _owner_view(db, card):
    from app.core.access import viewable_account_ids
    from app.models.user import User

    return viewable_account_ids(db, db.get(User, card.user_id))


def _verify(db, card_id, today):
    from app.services import statements_store

    card = _card(db, card_id)
    got = statements_store.verify_card(db, card, _owner_view(db, card), today)
    db.rollback()
    return got


def _read(db, card_id, today):
    """A read through the store (it catches the card up)."""
    from app.services import statements

    card = _card(db, card_id)
    out = statements.statement_summaries(db, card, datetime.combine(today, time()),
                                         _owner_view(db, card))
    db.rollback()
    return out


def _stored(db, card_id):
    """``{close: (balance, count)}`` straight from the table."""
    db.rollback()
    return {r.close: (Decimal(r.line_balance), r.line_count) for r in db.execute(text(
        "SELECT close, line_balance, line_count FROM card_statements WHERE card_id = :c"),
        {"c": card_id})}


def _state(db, card_id):
    db.rollback()
    return db.execute(text("SELECT materialized_through, close_day FROM card_statement_state "
                           "WHERE card_id = :c"), {"c": card_id}).first()


def _closed_cycles(card, today, count):
    """The last ``count`` closed cycles of ``card`` on ``today``, oldest first."""
    from app.services.statements import iter_cycles_from

    cycles = list(iter_cycles_from(card, today - timedelta(days=40 * count), datetime.min,
                                   through=today, due_overrides={}))
    return [c for c in cycles if c["close"].date() < today][-count:]


def _free_to_rekey(db, card_id):
    """Clear what makes the API refuse a close-day change (installments with payments
    left, printed dues): the fixture gives every card both."""
    db.execute(text("UPDATE budget_entries SET max_occurrences = 0 WHERE account_id = :c"),
               {"c": card_id})
    db.execute(text("DELETE FROM card_statement_due_overrides WHERE account_id = :c"),
               {"c": card_id})
    db.commit()


def _good(got):
    return got["materialized"] and got["rows_equal"] and got["summaries_equal"]


# --- AC3: write-through is synchronous --------------------------------------------------------

def test_a_back_dated_edit_is_stored_before_the_call_returns(realistic, sw_client, sw_db):
    w, today = realistic, realistic.today
    card_id = w.accounts["card_a"]
    _read(sw_db, card_id, today)
    card = _card(sw_db, card_id)
    cycle = _closed_cycles(card, today, 3)[0]
    close = cycle["close"].date()
    before = _stored(sw_db, card_id)[close]
    when = datetime.combine(close - timedelta(days=2), time(10))
    r = sw_client.post(f"{API}/transactions/", headers=w.callers["owner"].headers, json={
        "account_id": card_id, "amount": 1234.56, "transaction_type": "debit",
        "description": "Back-dated", "transaction_date": when.isoformat(), "is_posted": True})
    assert r.status_code in (200, 201), r.text
    # No read in between: the row was written in the create's own transaction.
    assert _stored(sw_db, card_id)[close] == (before[0] + Decimal("1234.56"), before[1] + 1)
    txn = r.json()["id"]
    r = sw_client.put(f"{API}/transactions/{txn}", headers=w.callers["owner"].headers,
                      json={"amount": 34.56})
    assert r.status_code == 200, r.text
    assert _stored(sw_db, card_id)[close] == (before[0] + Decimal("34.56"), before[1] + 1)
    r = sw_client.delete(f"{API}/transactions/{txn}", headers=w.callers["owner"].headers)
    assert r.status_code in (200, 204), r.text
    assert _stored(sw_db, card_id)[close] == before
    assert _good(_verify(sw_db, card_id, today))


# --- AC3b: a billing change re-keys the card's stored statements -----------------------------

def test_a_close_day_change_rekeys_the_stored_statements(realistic, sw_client, sw_db):
    w, today = realistic, realistic.today
    headers = w.callers["owner"].headers
    card_id = w.accounts["card_a"]
    _free_to_rekey(sw_db, card_id)
    _read(sw_db, card_id, today)
    assert {c.day for c in _stored(sw_db, card_id)} == {12}
    r = sw_client.put(f"{API}/accounts/{card_id}", headers=headers,
                      json={"billing_cycle_start": 28})
    assert r.status_code == 200, r.text
    stored = _stored(sw_db, card_id)  # no read in between
    assert stored and {c.day for c in stored} == {28}
    assert _state(sw_db, card_id).close_day == 28
    r = sw_client.get(f"{API}/cards/{card_id}/statements?from=2000-01-01&to=2100-01-01",
                      headers=headers)
    assert r.status_code == 200, r.text
    assert {date.fromisoformat(s["close_date"]).day for s in r.json()["statements"]} == {28}
    assert _good(_verify(sw_db, card_id, today))
    r = sw_client.put(f"{API}/accounts/{card_id}", headers=headers,
                      json={"billing_cycle_start": 12})
    assert r.status_code == 200, r.text
    assert {c.day for c in _stored(sw_db, card_id)} == {12}
    assert _good(_verify(sw_db, card_id, today))


def test_a_legacy_due_day_change_rekeys_the_stored_statements(realistic, sw_client, sw_db):
    from app.services.statements import resolve_cycle_fields

    w, today = realistic, realistic.today
    card_id = w.accounts["card_c"]
    _free_to_rekey(sw_db, card_id)
    _read(sw_db, card_id, today)
    old_day = resolve_cycle_fields(_card(sw_db, card_id))[0]
    r = sw_client.put(f"{API}/accounts/{card_id}", headers=w.callers["owner"].headers,
                      json={"due_date": 20})
    assert r.status_code == 200, r.text
    new_day = resolve_cycle_fields(_card(sw_db, card_id))[0]
    assert new_day != old_day
    stored = _stored(sw_db, card_id)
    # The closes the new settings give (a day past a month's end is clamped).
    want = {c["close"].date() for c in _closed_cycles(_card(sw_db, card_id), today, 200)}
    assert stored and set(stored) <= want
    assert all(c.day == min(new_day, calendar.monthrange(c.year, c.month)[1]) for c in stored)
    assert _good(_verify(sw_db, card_id, today))
    r = sw_client.put(f"{API}/accounts/{card_id}", headers=w.callers["owner"].headers,
                      json={"due_date": 5})
    assert r.status_code == 200, r.text
    assert _good(_verify(sw_db, card_id, today))


def test_a_failure_mid_repopulate_rolls_back_to_the_old_rows(realistic, sw_db, monkeypatch):
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.services import statements_store

    w, today = realistic, realistic.today
    card_id = w.accounts["card_d"]
    _read(sw_db, card_id, today)
    before, state = _stored(sw_db, card_id), _state(sw_db, card_id)
    assert before

    def broken(*args, **kwargs):
        raise RuntimeError("injected")

    monkeypatch.setattr(statements_store, "cycle_rows", broken)
    db = SessionLocal()
    try:
        db.get(Account, card_id).billing_cycle_start = 15
        with pytest.raises(RuntimeError, match="injected"):
            db.commit()  # the repopulate deleted the rows, then failed
        db.rollback()
    finally:
        db.close()
    monkeypatch.undo()
    assert _card(sw_db, card_id).billing_cycle_start == 31
    assert _stored(sw_db, card_id) == before
    assert tuple(_state(sw_db, card_id)) == tuple(state)
    assert _good(_verify(sw_db, card_id, today))


# --- AC2: a catch-up racing a back-dated write -------------------------------------------------

def _behind(db, card_id, close):
    """Make the card's state one cycle behind, so a catch-up recomputes ``close``."""
    from app.services.statements_store import last_close_before

    card = _card(db, card_id)
    db.execute(text("UPDATE card_statement_state SET materialized_through = :t "
                    "WHERE card_id = :c"), {"t": last_close_before(card, close), "c": card_id})
    db.commit()


def _back_date(card_id, close, amount, gate=None):
    """A writer: a posted charge on the cycle closing on ``close``, committed."""
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.models.transaction import Transaction, TransactionType

    db = SessionLocal()
    try:
        card = db.get(Account, card_id)
        db.add(Transaction(user_id=card.user_id, created_by_actor=card.user_id,
                           account_id=card_id, amount=amount, description="Race",
                           transaction_type=TransactionType.DEBIT, is_posted=True,
                           transfer_fee=Decimal("0"),
                           transaction_date=datetime.combine(close, time(9))))
        db.flush()  # the hook locks the card here
        if gate is not None:
            gate()
        db.commit()
    finally:
        db.close()


def test_a_catch_up_computed_before_a_write_is_overwritten_by_it(realistic, sw_db,
                                                                    monkeypatch):
    """Catch-up first: it computes the cycle from the old rows and holds the lock;
    the writer's recompute waits for it, then overwrites it."""
    from app.core.database import SessionLocal
    from app.services import statements_store

    today, card_id = realistic.today, realistic.accounts["card_b"]
    _read(sw_db, card_id, today)
    close = _closed_cycles(_card(sw_db, card_id), today, 1)[0]["close"].date()
    _behind(sw_db, card_id, close)
    computed, go = threading.Event(), threading.Event()
    original = statements_store.materialize

    def paused(*args, **kwargs):
        original(*args, **kwargs)
        computed.set()
        assert go.wait(20)

    monkeypatch.setattr(statements_store, "materialize", paused)
    errors = []

    def catch_up():
        db = SessionLocal()
        try:
            statements_store.catch_up(db, [_card(db, card_id)], today)
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            db.close()

    reader = threading.Thread(target=catch_up)
    reader.start()
    assert computed.wait(20)
    writer = threading.Thread(target=_back_date, args=(card_id, close, Decimal("777.00")))
    writer.start()
    clock.sleep(0.5)
    assert writer.is_alive(), "the writer did not wait for the catch-up's lock"
    go.set()
    reader.join(20)
    writer.join(20)
    monkeypatch.undo()
    assert not errors and not reader.is_alive() and not writer.is_alive()
    assert _good(_verify(sw_db, card_id, today))


def test_a_catch_up_during_an_open_write_leaves_the_cycle_to_it(realistic, sw_db):
    """Writer first: it holds the card's lock until it commits, so the catch-up
    skips the card (no stale cycle); the next read catches up from the new rows."""
    from app.core.database import SessionLocal
    from app.services import statements_store

    today, card_id = realistic.today, realistic.accounts["card_b"]
    _read(sw_db, card_id, today)
    close = _closed_cycles(_card(sw_db, card_id), today, 1)[0]["close"].date()
    _behind(sw_db, card_id, close)
    behind = _state(sw_db, card_id)

    def catch_up_meanwhile():
        db = SessionLocal()
        try:
            statements_store.catch_up(db, [_card(db, card_id)], today)
        finally:
            db.close()
        assert tuple(_state(sw_db, card_id)) == tuple(behind)  # skipped, nothing stale

    _back_date(card_id, close, Decimal("555.00"), gate=catch_up_meanwhile)
    _read(sw_db, card_id, today)
    assert _state(sw_db, card_id).materialized_through == close
    assert _good(_verify(sw_db, card_id, today))


# --- time-based closing ------------------------------------------------------------------------

def test_a_read_after_a_close_catches_up_once(realistic, sw_db, monkeypatch):
    from app.services import statements_store
    from app.tests.fixtures.realistic import REF, pin_clock

    card_id = realistic.accounts["card_a"]
    _read(sw_db, card_id, realistic.today)
    first = _state(sw_db, card_id).materialized_through
    later = REF + timedelta(days=45)
    pin_clock(monkeypatch, later)
    day = (later + timedelta(hours=8)).date()
    _read(sw_db, card_id, day)
    assert _state(sw_db, card_id).materialized_through == statements_store.last_close_before(
        _card(sw_db, card_id), day) > first
    assert _good(_verify(sw_db, card_id, day))


# --- the kill switch -----------------------------------------------------------------------------

def test_with_the_store_off_reads_replay_and_writes_still_go_through(realistic, sw_client,
                                                                     sw_db, monkeypatch):
    from app.services import statements_store

    w, today = realistic, realistic.today
    card_id = w.accounts["card_d"]
    _read(sw_db, card_id, today)
    monkeypatch.setenv("STATEMENTS_STORE", "off")
    card = _card(sw_db, card_id)
    assert statements_store.read_card_rows(sw_db, [card], [card_id], today)[1] == {}
    close = _closed_cycles(card, today, 2)[0]["close"].date()
    before = _stored(sw_db, card_id)[close]
    r = sw_client.post(f"{API}/transactions/", headers=w.callers["owner"].headers, json={
        "account_id": card_id, "amount": 10, "transaction_type": "debit",
        "description": "While off", "transaction_date": f"{close}T08:00:00", "is_posted": True})
    assert r.status_code in (200, 201), r.text
    assert _stored(sw_db, card_id)[close] == (before[0] + 10, before[1] + 1)
    monkeypatch.delenv("STATEMENTS_STORE")
    assert _good(_verify(sw_db, card_id, today))


# --- AC4: bulk paths ----------------------------------------------------------------------------

def _foreign_row(db, card_id, user_id, close):
    """A posted charge by ``user_id`` on another user's card, in a stored cycle."""
    from app.models.transaction import Transaction, TransactionType

    db.add(Transaction(user_id=user_id, created_by_actor=user_id, account_id=card_id,
                       amount=Decimal("4321.00"), description="Bulk-deleted",
                       transaction_type=TransactionType.DEBIT, is_posted=True,
                       transfer_fee=Decimal("0"), transaction_date=datetime.combine(close, time())))
    db.commit()


def test_the_cutover_reset_leaves_stored_equal_to_replay(realistic, sw_db, sw_people):
    from app.core.tags import ensure_household_tag
    from app.cutover_load.reset import delete_owner_rows

    today, card_id = realistic.today, realistic.accounts["card_a"]
    other = sw_people("Cutover", "Owner")
    household = ensure_household_tag(sw_db, other["id"]).id
    sw_db.commit()
    close = _closed_cycles(_card(sw_db, card_id), today, 2)[0]["close"].date()
    _foreign_row(sw_db, card_id, other["id"], close)
    _read(sw_db, card_id, today)
    assert _good(_verify(sw_db, card_id, today))
    delete_owner_rows(sw_db, other["id"], household)  # raw DELETE FROM transactions
    sw_db.commit()
    _read(sw_db, card_id, today)
    assert _good(_verify(sw_db, card_id, today))


def test_the_demo_reset_leaves_stored_equal_to_replay(realistic, sw_db, monkeypatch):
    from app.core import seed
    from app.models.account import Account, AccountType
    from app.models.user import User

    today, card_id = realistic.today, realistic.accounts["card_b"]
    seed.seed_database()
    demo = sw_db.query(User).filter(User.email == seed.DEMO_EMAIL).one()
    close = _closed_cycles(_card(sw_db, card_id), today, 2)[0]["close"].date()
    _foreign_row(sw_db, card_id, demo.id, close)
    _read(sw_db, card_id, today)
    demo_cards = [a.id for a in sw_db.query(Account).filter(
        Account.user_id == demo.id, Account.account_type == AccountType.CREDIT)]
    for cid in demo_cards:
        _read(sw_db, cid, today)
    monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
    seed.seed_database()  # query(Transaction).delete() over the demo users' rows
    monkeypatch.undo()
    seed.seed_database()
    sw_db.rollback()
    assert not sw_db.execute(text("SELECT count(*) FROM card_statements WHERE card_id = ANY(:c)"),
                             {"c": demo_cards}).scalar()  # the old demo cards' rows went
    _read(sw_db, card_id, today)
    assert _good(_verify(sw_db, card_id, today))
    for cid in [a.id for a in sw_db.query(Account).filter(
            Account.user_id == demo.id, Account.account_type == AccountType.CREDIT)]:
        _read(sw_db, cid, today)
        assert _good(_verify(sw_db, cid, today))


# --- AC5: the read API ---------------------------------------------------------------------------

def test_the_statements_api_by_role(realistic, sw_client, sw_people):
    w, acc = realistic, realistic.accounts
    full_keys = {"balance", "clear_through", "outstanding", "paid_since_close"}

    def get(caller_headers, card, suffix=""):
        return sw_client.get(f"{API}/cards/{card}/statements{suffix}", headers=caller_headers)

    for caller, card in (("owner", acc["card_a"]), ("editor", acc["card_a"])):
        r = get(w.callers[caller].headers, card)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["view"] == "full" and body["card_id"] == card
        statements = body["statements"]
        assert statements and all(full_keys <= set(s) for s in statements)
        assert [s["is_closed"] for s in statements][-1] is False  # the open cycle last
        closed = [s for s in statements if s["is_closed"]][-1]
        detail = get(w.callers[caller].headers, card, f"/{closed['close_date']}").json()
        assert detail["statement"] == closed
        assert len(detail["lines"]) == closed["line_count"]
        assert all("transaction_id" in line for line in detail["lines"])
        assert round(sum(line["amount"] for line in detail["lines"]), 2) == closed["balance"]

    for caller, card in (("viewer", acc["card_d"]),):
        r = get(w.callers[caller].headers, card)
        assert r.status_code == 200, (caller, r.text)
        body = r.json()
        assert body["view"] == "limited" and "card_id" not in body
        assert body["statements"] and not any(full_keys & set(s) for s in body["statements"])
        close = body["statements"][0]["close_date"]
        detail = get(w.callers[caller].headers, card, f"/{close}").json()
        assert "unconverted_lines" not in detail
        assert not any("transaction_id" in line for line in detail["lines"])

    # A tag viewer is not on the card, as with GET /accounts/{id}/statements.
    assert get(w.callers["household"].headers, acc["card_b"]).status_code == 404
    assert sw_client.get(f"{API}/accounts/{acc['card_b']}/statements",
                         headers=w.callers["household"].headers).status_code == 404
    stranger = sw_people("Sam", "Stranger")["headers"]
    assert get(stranger, acc["card_a"]).status_code == 404
    assert get(stranger, acc["card_a"], "/2026-10-12").status_code == 404
    assert get(w.callers["viewer"].headers, acc["card_a"]).status_code == 404
    # A close that is not one of the card's statements, or not a date.
    assert get(w.callers["owner"].headers, acc["card_a"], "/2026-10-13").status_code == 404
    assert get(w.callers["owner"].headers, acc["card_a"], "/latest").status_code == 404


def test_the_statements_api_range(realistic, sw_client):
    w, card = realistic, realistic.accounts["card_a"]
    headers = w.callers["owner"].headers
    every = sw_client.get(f"{API}/cards/{card}/statements", headers=headers).json()["statements"]
    lo, hi = every[3]["close_date"], every[6]["close_date"]
    some = sw_client.get(f"{API}/cards/{card}/statements?from={lo}&to={hi}",
                         headers=headers).json()["statements"]
    assert some == every[3:7]


# --- AC6: the migration and the command ---------------------------------------------------------

def test_the_dry_run_reports_all_equal_and_writes_nothing(realistic, sw_db):
    from app.services import statements_store

    today = realistic.today
    for key in ("card_a", "card_b", "card_c", "card_d"):
        _read(sw_db, realistic.accounts[key], today)
    sw_db.rollback()
    counts = "SELECT (SELECT count(*) FROM card_statements), " \
             "(SELECT count(*) FROM card_statement_state), " \
             "(SELECT coalesce(max(computed_at), 'epoch') FROM card_statements)"
    before = tuple(sw_db.execute(text(counts)).one())
    url = sw_db.get_bind().url
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run(
        [sys.executable, "-m", "app.scripts.statements_store", "--expect-host", url.host,
         "--expect-db", url.database, "--dry-run",
         *[a for key in ("card_a", "card_b", "card_c", "card_d")
           for a in ("--card", str(realistic.accounts[key]))]],
        cwd=BACKEND, env=env, capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stdout + result.stderr
    out = result.stdout
    assert "mode: dry run" in out and "all_equal: yes (4/4)" in out
    assert "rows_equal=no" not in out and "summaries_equal=no" not in out
    sw_db.rollback()
    assert tuple(sw_db.execute(text(counts)).one()) == before
    # The report carries ids, counts and yes/no only: no amount.
    for line in out.splitlines():
        if line.startswith("card "):
            assert "." not in line, line
    # The reads above caught the card up, and the dry run left it so.
    card = _card(sw_db, realistic.accounts["card_a"])
    assert statements_store.verify_card(sw_db, card, _owner_view(sw_db, card),
                                        today)["behind"] is False
    sw_db.rollback()


def test_the_apply_is_idempotent(realistic, sw_db):
    from app.scripts.statements_store import run

    card_id = realistic.accounts["card_c"]
    sw_db.rollback()
    first = run(sw_db, [card_id], apply=True)
    rows = _stored(sw_db, card_id)
    second = run(sw_db, [card_id], apply=True)
    assert _stored(sw_db, card_id) == rows
    assert first[1:] == second[1:] and first[-1] == "all_equal: yes (1/1)"


def test_an_unused_card_lists_its_open_cycle_at_zero(realistic, sw_client):
    """A card with no line item still has the cycle open today (balance 0); a
    payment into it shows as there (nothing owed either way)."""
    w, today = realistic, realistic.today
    headers = w.callers["owner"].headers
    r = sw_client.post(f"{API}/accounts/", headers=headers, json={
        "name": "Unused card", "account_type": "credit", "balance": 0,
        "billing_cycle_start": 12, "days_until_due_date": 21,
        "payment_account_id": w.accounts["bank0"]})
    assert r.status_code in (200, 201), r.text
    card_id = r.json()["id"]
    statements = sw_client.get(f"{API}/cards/{card_id}/statements",
                               headers=headers).json()["statements"]
    assert len(statements) == 1, statements
    (s,) = statements
    assert s["is_closed"] is False and s["line_count"] == 0
    assert s["balance"] == 0 and s["owed"] == 0 and s["outstanding"] == 0
    assert date.fromisoformat(s["window_start"]) < today <= date.fromisoformat(s["close_date"])
    detail = sw_client.get(f"{API}/cards/{card_id}/statements/{s['close_date']}",
                           headers=headers).json()
    assert detail["statement"] == s and detail["lines"] == []
    r = sw_client.post(f"{API}/transactions/", headers=headers, json={
        "account_id": w.accounts["bank0"], "amount": 500, "transaction_type": "transfer",
        "transfer_from_account_id": w.accounts["bank0"], "transfer_to_account_id": card_id,
        "description": "Prepay", "transaction_date": f"{today}T01:00:00", "is_posted": True})
    assert r.status_code in (200, 201), r.text
    (s,) = sw_client.get(f"{API}/cards/{card_id}/statements",
                         headers=headers).json()["statements"]
    assert s["balance"] == 0 and s["owed"] == 0 and s["outstanding"] == -500


# --- the data version (STU-602) ----------------------------------------------------------------
# card_statements and card_statement_state carry no data_version trigger by design
# (data_version.EXCLUDED_TABLES): what they hold is derived from rows whose writes bump.

def _version(db) -> int:
    db.rollback()
    return db.execute(text("SELECT version FROM data_version WHERE id = 1")).scalar_one()


def test_the_store_tables_carry_no_data_version_trigger(sw_db):
    from app.core.data_version import EXCLUDED_TABLES, TRIGGER

    sw_db.rollback()
    found = {t for (t,) in sw_db.execute(text(
        "SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid "
        "WHERE t.tgname = :name AND c.relname IN ('card_statements', 'card_statement_state')"),
        {"name": TRIGGER})}
    assert found == set()
    assert {"card_statements", "card_statement_state"} <= EXCLUDED_TABLES


def test_a_catch_up_read_leaves_the_data_version_alone(realistic, sw_db):
    """A read that stores newly closed cycles changes no answer, so no ETag."""
    today, card_id = realistic.today, realistic.accounts["card_b"]
    _read(sw_db, card_id, today)
    close = _closed_cycles(_card(sw_db, card_id), today, 1)[0]["close"].date()
    _behind(sw_db, card_id, close)  # an UPDATE of card_statement_state, committed
    before = _version(sw_db)
    _read(sw_db, card_id, today)  # catches up: writes both tables, commits
    assert _state(sw_db, card_id).materialized_through == close
    assert _version(sw_db) == before


def test_a_write_through_bumps_the_data_version_with_the_stored_rows(realistic, sw_client,
                                                                     sw_db):
    """The stored rows change in the same commit as the row write that bumps."""
    w, today = realistic, realistic.today
    card_id = w.accounts["card_a"]
    _read(sw_db, card_id, today)
    close = _closed_cycles(_card(sw_db, card_id), today, 2)[0]["close"].date()
    stored, before = _stored(sw_db, card_id)[close], _version(sw_db)
    r = sw_client.post(f"{API}/transactions/", headers=w.callers["owner"].headers, json={
        "account_id": card_id, "amount": 42, "transaction_type": "debit",
        "description": "Bump", "transaction_date": f"{close}T03:00:00", "is_posted": True})
    assert r.status_code in (200, 201), r.text
    assert _version(sw_db) == before + 1
    assert _stored(sw_db, card_id)[close] == (stored[0] + 42, stored[1] + 1)


# --- one view: a write committing between the stored rows and the rows ------------------------

def test_a_write_between_the_stored_rows_and_the_rows_is_not_half_seen(realistic, sw_db,
                                                                       monkeypatch):
    """A back-dated edit committed after the read took the stored cycles and before
    it took the rows: the read sees the world before the edit or after it, never
    the stored cycle before it and the moved row after it (counted twice)."""
    from app.core.database import SessionLocal
    from app.models.transaction import Transaction, TransactionType
    from app.services import statements, statements_store

    today, card_id = realistic.today, realistic.accounts["card_a"]
    _read(sw_db, card_id, today)
    through = _state(sw_db, card_id).materialized_through
    sw_db.rollback()
    moved = (sw_db.query(Transaction)
             .filter(Transaction.account_id == card_id, Transaction.is_posted.is_(True),
                     Transaction.transaction_type == TransactionType.DEBIT,
                     Transaction.posting_date.is_(None),
                     Transaction.transaction_date < datetime.combine(through, time()))
             .order_by(Transaction.transaction_date.desc()).first()).id
    card = _card(sw_db, card_id)
    midnight, viewable = datetime.combine(today, time()), _owner_view(sw_db, card)
    monkeypatch.setenv("STATEMENTS_STORE", "off")
    before = statements.statement_summaries(sw_db, card, midnight, viewable)
    monkeypatch.delenv("STATEMENTS_STORE")
    sw_db.rollback()

    def move_to_today():
        db = SessionLocal()
        try:
            db.get(Transaction, moved).transaction_date = datetime.combine(today, time(9))
            db.commit()  # the hook waits for the card's lock
        finally:
            db.close()

    writer = threading.Thread(target=move_to_today)
    original = statements_store._card_rows

    def rows_after_a_write(*args, **kwargs):
        writer.start()
        writer.join(1.5)  # committed unless the read holds the card
        return original(*args, **kwargs)

    monkeypatch.setattr(statements_store, "_card_rows", rows_after_a_write)
    card = _card(sw_db, card_id)
    got = statements.statement_summaries(sw_db, card, midnight, viewable)
    monkeypatch.undo()
    sw_db.rollback()  # the read's transaction ends: the writer goes on
    writer.join(20)
    assert not writer.is_alive()
    assert repr(got) == repr(before), first_difference(got, before)
    assert _good(_verify(sw_db, card_id, today))


# --- read, then write: two transactions on one card (STU-623) ---------------------------------

def test_two_reads_then_two_writes_of_one_card_both_commit(realistic, sw_db):
    """Two transactions each read the card's statements through the store and then
    each change a posted row of it. Neither may abort with a deadlock: a read must
    not keep a hold on the card that a write of another transaction then waits for
    while that one waits for it."""
    from app.core.database import SessionLocal
    from app.models.transaction import Transaction, TransactionType
    from app.services import statements_store

    today, card_id = realistic.today, realistic.accounts["card_a"]
    _read(sw_db, card_id, today)
    through = _state(sw_db, card_id).materialized_through
    sw_db.rollback()
    rows = [t.id for t in (sw_db.query(Transaction)
                           .filter(Transaction.account_id == card_id,
                                   Transaction.is_posted.is_(True),
                                   Transaction.transaction_type == TransactionType.DEBIT,
                                   Transaction.transaction_date
                                   < datetime.combine(through, time()))
                           .order_by(Transaction.id).limit(2))]
    assert len(rows) == 2
    amounts = {i: sw_db.get(Transaction, i).amount for i in rows}
    sw_db.rollback()
    read, errors = threading.Barrier(2, timeout=30), []

    def read_then_write(txn_id):
        db = SessionLocal()
        try:
            card = _card(db, card_id)
            _, stored = statements_store.read_card_rows(db, [card], _owner_view(db, card), today)
            assert card_id in stored  # read from the store, not replayed
            read.wait()  # both have read before either writes
            db.get(Transaction, txn_id).amount += Decimal("1.00")
            db.commit()
        except Exception as exc:
            errors.append(exc)
            read.abort()
        finally:
            db.close()

    writers = [threading.Thread(target=read_then_write, args=(i,)) for i in rows]
    for t in writers:
        t.start()
    for t in writers:
        t.join(40)
    try:
        assert not any(t.is_alive() for t in writers)
        assert not errors, errors
        assert _good(_verify(sw_db, card_id, today))
    finally:
        sw_db.rollback()
        for txn_id, amount in amounts.items():
            sw_db.get(Transaction, txn_id).amount = amount  # through the hook
        sw_db.commit()


def _shared_holds(db, card_id):
    """The modes in which ``db``'s backend holds the card's statements lock."""
    from app.services.statements_store import LOCK_NS

    return sorted(m for (m,) in db.execute(text(
        "SELECT mode FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() "
        "AND granted AND classid = CAST(:ns AS oid) AND objsubid = 2 "
        "AND objid = CAST(:c AS oid)"), {"ns": LOCK_NS, "c": card_id}))


def test_the_lock_and_read_round_trip_runs_on_the_app_driver(realistic, sw_db):
    """``_lock_and_read`` sends the savepoint, the shared holds and the stored read as
    one multi-statement execute with bound parameters. psycopg2 binds parameters on
    the client and sends a simple query, so Postgres runs all three; this runs it
    through the application's own engine and driver and checks each one took effect."""
    from app.core.database import engine
    from app.services import statements_store

    assert engine.dialect.driver == "psycopg2"
    today, card_id = realistic.today, realistic.accounts["card_a"]
    _read(sw_db, card_id, today)  # stored and current
    card = _card(sw_db, card_id)
    conn = sw_db.connection()
    assert _shared_holds(sw_db, card_id) == []
    locked, states, stored = statements_store._lock_and_read(conn, [card], today, [card_id],
                                                             True)
    assert locked == {card_id}
    assert states[card_id].materialized_through is not None
    assert stored[card_id].cycles  # the stored rows came back from the last statement
    assert _shared_holds(sw_db, card_id) == ["ShareLock"]  # the second statement ran
    statements_store._release_read(conn)  # the first one set the savepoint
    assert _shared_holds(sw_db, card_id) == []
    sw_db.rollback()


def test_a_read_that_fails_after_the_lock_releases_it(realistic, sw_db, monkeypatch):
    """An exception after the shared hold is taken (here from the rows query) rolls
    back to the savepoint before it propagates: the hold is gone, and a write of the
    card from another session commits at once while this transaction stays open."""
    from app.core.database import SessionLocal
    from app.models.transaction import Transaction, TransactionType
    from app.services import statements_store

    today, card_id = realistic.today, realistic.accounts["card_a"]
    _read(sw_db, card_id, today)
    row = (sw_db.query(Transaction)
           .filter(Transaction.account_id == card_id, Transaction.is_posted.is_(True),
                   Transaction.transaction_type == TransactionType.DEBIT)
           .order_by(Transaction.id).first())
    row_id, amount = row.id, row.amount
    sw_db.rollback()

    def fails(*args, **kwargs):
        assert _shared_holds(sw_db, card_id) == ["ShareLock"]  # taken before the failure
        raise RuntimeError("rows query failed")

    monkeypatch.setattr(statements_store, "_card_rows", fails)
    card = _card(sw_db, card_id)
    with pytest.raises(RuntimeError, match="rows query failed"):
        statements_store.read_card_rows(sw_db, [card], _owner_view(sw_db, card), today)
    monkeypatch.undo()
    try:
        assert _shared_holds(sw_db, card_id) == []  # same transaction, still open
        other = SessionLocal()
        try:
            other.execute(text("SET LOCAL lock_timeout = '2s'"))
            other.get(Transaction, row_id).amount = amount + 1
            other.commit()  # the write-through takes the card's lock exclusive
        finally:
            other.close()
    finally:
        sw_db.rollback()
        sw_db.get(Transaction, row_id).amount = amount
        sw_db.commit()
    assert _good(_verify(sw_db, card_id, today))

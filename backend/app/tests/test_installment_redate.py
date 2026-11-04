"""The re-date of existing card installments onto the statement close (PR3).

``services/installment_redate.run`` (driven by
``scripts/redate_card_installments.py``) converts each legacy card installment
whole or refuses it and leaves it unchanged. Rows are written straight to the
database as an older version stored them. Skips without a database.

Reference: Wednesday 2026-11-04, 02:00 UTC (10:00 in Manila). "Card C" closes
on the 2nd (due 21 days later), "Card B" on the 5th (20 days), "Card A" on the
4th (25 days).
"""
import os
import subprocess
import sys
import threading
import time
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 4, 2, 0)
TODAY = date(2026, 11, 4)
AMOUNT = 1_234
BACKEND_DIR = Path(__file__).resolve().parents[2]


# --- helpers ----------------------------------------------------------------------------------

def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, close, days, name):
    return _account(client, who, name, "credit", 0, billing_cycle_start=close,
                    days_until_due_date=days, credit_limit=500_000)


def _entry(db, who, card, next_day, *, anchor="day", cadence="monthly", payments=3,
           active=True, reviewed=False, rule=None, offset=0):
    """A card installment as stored before PR3: anchored on its own day."""
    from app.core.time import utc_now
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    entry = BudgetEntry(
        user_id=who["id"], name="Plan", entry_type=BudgetEntryType.EXPENSE, amount=AMOUNT,
        cadence=RecurrenceFrequency(cadence), next_occurrence=datetime.combine(
            next_day, datetime.min.time()),
        anchor_day=next_day.day if anchor == "day" else anchor, day_rule=rule,
        account_id=card, end_mode="after_occurrences", max_occurrences=payments,
        occurrences_paid_offset=offset, is_active=active,
        installment_reviewed_at=utc_now() if reviewed else None,
        auto_post_enabled=reviewed)
    db.add(entry)
    db.commit()
    return entry.id


def _txn(db, who, account, day, *, entry=None, occurrence="same", posted=True,
         amount=AMOUNT, allocation=None):
    from app.models.transaction import Transaction, TransactionType

    when = datetime.combine(day, datetime.min.time())
    txn = Transaction(
        user_id=who["id"], account_id=account, transaction_type=TransactionType.DEBIT,
        amount=amount, description="Charge", transaction_date=when, is_posted=posted,
        budget_entry_id=entry, is_recurring=entry is not None, allocation_id=allocation,
        occurrence_date=(when if occurrence == "same" else occurrence) if entry else None)
    db.add(txn)
    db.commit()
    return txn.id


def _run(apply, mine=None):
    """The service as the script runs it, in its own session; results for ``mine`` only."""
    from app.core.database import SessionLocal
    from app.services import installment_redate

    db = SessionLocal()
    try:
        results = installment_redate.run(db, apply=apply, today=TODAY)
    finally:
        db.close()
    if mine is not None:
        results = [r for r in results if r.entry_id in mine]
    return {r.entry_id: r for r in results}


def _state(db, entry_id):
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    db.expire_all()
    e = db.get(BudgetEntry, entry_id)
    rows = db.query(Transaction).filter(Transaction.budget_entry_id == entry_id).order_by(
        Transaction.id).all()
    return ((e.next_occurrence.date(), e.anchor_day, e.day_rule, e.cadence.value,
             e.is_active, e.max_occurrences, e.occurrences_paid_offset),
            [(t.id, t.transaction_date.date(),
              t.occurrence_date.date() if t.occurrence_date else None) for t in rows])


def _billed(db, card_id):
    from app.models.account import Account
    from app.services.installment_redate import _billed as billed

    db.expire_all()
    return billed(db, db.get(Account, card_id), TODAY)


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    return {"client": sw_client, "db": sw_db, "me": me,
            "card_c": _card(sw_client, me, 2, 21, "Card C"),
            "card_b": _card(sw_client, me, 5, 20, "Card B"),
            "card_a": _card(sw_client, me, 4, 25, "Card A")}


@pytest.fixture
def card_c_plans(world):
    """Two plans on Card C (the 25th and the 27th); the 27th has two posted months."""
    db, me, card = world["db"], world["me"], world["card_c"]
    e25 = _entry(db, me, card, date(2026, 11, 25))
    e27 = _entry(db, me, card, date(2026, 11, 27), payments=4)
    rows = [_txn(db, me, card, date(2026, 9, 27), entry=e27),
            _txn(db, me, card, date(2026, 10, 27), entry=e27)]
    return e25, e27, rows


# --- conversions ------------------------------------------------------------------------------

def test_dry_run_writes_nothing(world, card_c_plans):
    db = world["db"]
    e25, e27, _ = card_c_plans
    before = [_state(db, e25), _state(db, e27)]
    results = _run(False, {e25, e27})
    assert {r.status for r in results.values()} == {"converted"}
    assert [_state(db, e25), _state(db, e27)] == before


def test_card_c_entries_and_two_links_move_to_next_close(world, card_c_plans):
    db = world["db"]
    e25, e27, (sep, oct_) = card_c_plans
    results = _run(True, {e25, e27})
    assert results[e25].status == results[e27].status == "converted"
    assert _state(db, e25) == ((date(2026, 12, 2), 2, None, "monthly", True, 3, 0), [])
    assert _state(db, e27) == ((date(2026, 12, 2), 2, None, "monthly", True, 4, 0), [
        (sep, date(2026, 10, 2), date(2026, 10, 2)),
        (oct_, date(2026, 11, 2), date(2026, 11, 2))])
    assert [(r.txn_id, r.old_date, r.new_date) for r in results[e27].rows] == [
        (sep, date(2026, 9, 27), date(2026, 10, 2)),
        (oct_, date(2026, 10, 27), date(2026, 11, 2))]


def test_card_a_is_noop(world):
    db, me, card = world["db"], world["me"], world["card_a"]
    entry = _entry(db, me, card, date(2026, 12, 4))
    _txn(db, me, card, date(2026, 11, 4), entry=entry)
    before = _state(db, entry)
    assert _run(True, {entry}) == {}
    assert _state(db, entry) == before


def test_card_b_28_moves_to_5(world):
    db, me, card = world["db"], world["me"], world["card_b"]
    entry = _entry(db, me, card, date(2026, 11, 28), payments=6)
    assert _run(True, {entry})[entry].status == "converted"
    assert _state(db, entry) == ((date(2026, 12, 5), 5, None, "monthly", True, 6, 0), [])


def test_counts_unchanged_after_apply(world, card_c_plans):
    client, me = world["client"], world["me"]
    _, e27, _ = card_c_plans

    def counts():
        r = client.get(f"{API}/budget-entries/{e27}", headers=me["headers"])
        assert r.status_code == 200, r.text
        body = r.json()
        return body["max_occurrences"], body["occurrences_paid_offset"], body["occurrences_paid"]

    before = counts()
    assert before == (4, 0, 2)
    _run(True, {e27})
    assert counts() == before


def test_statement_balances_unchanged(world, card_c_plans):
    client, me, card = world["client"], world["me"], world["card_c"]

    def balances():
        r = client.get(f"{API}/cards/{card}/credit", headers=me["headers"])
        assert r.status_code == 200, r.text
        return [(s["close_date"], s["owed"], s["outstanding"], s["status"])
                for s in r.json()["statements"]]

    before = balances()
    assert ("2026-10-02", AMOUNT) in [(c, float(owed)) for c, owed, _, _ in before]
    assert ("2026-11-02", AMOUNT) in [(c, float(owed)) for c, owed, _, _ in before]
    _run(True, set(card_c_plans[:2]))
    assert balances() == before


def test_paused_entry_is_converted_and_stays_paused(world):
    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 25), active=False)
    assert _run(True, {entry})[entry].status == "converted"
    assert _state(db, entry)[0] == (date(2026, 12, 2), 2, None, "monthly", False, 3, 0)


def test_last_weekday_monthly_entry_is_normalised(world):
    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 30), anchor=None, rule="last_weekday")
    assert _run(True, {entry})[entry].status == "converted"
    assert _state(db, entry)[0] == (date(2026, 12, 2), 2, None, "monthly", True, 3, 0)


def test_second_run_is_noop(world, card_c_plans):
    db = world["db"]
    e25, e27, _ = card_c_plans
    _run(True, {e25, e27})
    after = [_state(db, e25), _state(db, e27)]
    assert _run(True, {e25, e27}) == {}
    assert [_state(db, e25), _state(db, e27)] == after


# --- refusals ---------------------------------------------------------------------------------

def _refused(db, entry, contains):
    before = _state(db, entry)
    result = _run(True, {entry})[entry]
    assert result.status == "refused", result
    assert contains in result.reason, result.reason
    assert _state(db, entry) == before
    return result


def test_apply_refuses_when_forecast_would_bill_twice_at_today(world):
    """One month left on Nov 3, held today by an unlinked charge on Nov 4. On
    Nov 5 it is not yet due, so today's forecast would bill it and the charge."""
    db, me, card = world["db"], world["me"], world["card_b"]
    entry = _entry(db, me, card, date(2026, 11, 3), payments=1, reviewed=True)
    _txn(db, me, card, date(2026, 11, 4))
    billed = _billed(db, card)
    _refused(db, entry, "the forecast from 2026-11-04")
    assert _billed(db, card) == billed


def test_apply_refuses_hand_linked_bank_row(world):
    db, client, me, card = world["db"], world["client"], world["me"], world["card_b"]
    bank = _account(client, me, "Bank", balance=50_000)
    entry = _entry(db, me, card, date(2026, 11, 28))
    _txn(db, me, bank, date(2026, 10, 28), entry=entry, occurrence=None, posted=False)
    _refused(db, entry, "is not on the installment's card")


def test_collision_refuses_entry(world):
    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 27))
    _txn(db, me, card, date(2026, 10, 27), entry=entry)
    _txn(db, me, card, date(2026, 10, 30), entry=entry, occurrence=None)
    _refused(db, entry, "are on the same statement")


def test_identity_and_date_in_different_cycles_refuses_entry(world):
    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 27))
    _txn(db, me, card, date(2026, 11, 3), entry=entry, occurrence=datetime(2026, 10, 27))
    _refused(db, entry, "occurrence and date are on different statements")


def test_posted_row_on_or_after_new_next_refuses_entry(world):
    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 27))
    _txn(db, me, card, date(2026, 11, 30), entry=entry)
    _refused(db, entry, "on or after the new next occurrence")
    pending = _entry(db, me, card, date(2026, 11, 27))
    _txn(db, me, card, date(2026, 12, 5), entry=pending, posted=False)
    _refused(db, pending, "after the new next occurrence")


def test_apply_refuses_entry_losing_unlinked_hold(world):
    """An unlinked charge on Oct 29 holds the Oct 28 month; Nov 5 is 7 days away."""
    db, me, card = world["db"], world["me"], world["card_b"]
    entry = _entry(db, me, card, date(2026, 10, 28), reviewed=True)
    _txn(db, me, card, date(2026, 10, 29))
    billed = _billed(db, card)
    assert billed[(entry, date(2026, 10, 28))] == 0
    _refused(db, entry, "a possible duplicate would hold a different month")
    assert _billed(db, card) == billed


def test_apply_refuses_entry_whose_hold_moves_to_other_candidate(world):
    """Nov 2 is held by an Oct 31 charge; on Nov 5 a Nov 6 charge would hold it."""
    db, me, card = world["db"], world["me"], world["card_b"]
    entry = _entry(db, me, card, date(2026, 11, 2), reviewed=True)
    _txn(db, me, card, date(2026, 10, 31))
    _txn(db, me, card, date(2026, 11, 6))
    _refused(db, entry, "a possible duplicate would hold a different month")


def test_non_monthly_entries_reported_and_refused(world):
    db, me, card = world["db"], world["me"], world["card_c"]
    weekly = _entry(db, me, card, date(2026, 11, 25), anchor=None, cadence="weekly")
    quarterly = _entry(db, me, card, date(2026, 11, 25), cadence="quarterly")
    _refused(db, weekly, "cadence is weekly, not monthly")
    _refused(db, quarterly, "cadence is quarterly, not monthly")


@pytest.mark.parametrize("card_key, inside, outside, close", [
    # Card C closes on the 2nd: the Nov 2 statement is (Oct 2, Nov 2].
    ("card_c", [date(2026, 10, 3), date(2026, 10, 31), date(2026, 11, 2)],
     [date(2026, 10, 2), date(2026, 11, 3)], date(2026, 11, 2)),
    # Card B closes on the 5th: the Nov 5 statement is (Oct 5, Nov 5].
    ("card_b", [date(2026, 10, 6), date(2026, 11, 1), date(2026, 11, 5)],
     [date(2026, 10, 5), date(2026, 11, 6)], date(2026, 11, 5)),
])
def test_balance_snapshot_sums_the_whole_statement(world, card_key, inside, outside, close):
    """The snapshot's window is the real previous close, not an empty one."""
    from app.models.account import Account
    from app.services.installment_redate import _statement_balances

    db, me, card = world["db"], world["me"], world[card_key]
    for n, day in enumerate(inside, 1):
        _txn(db, me, card, day, amount=100 * n)
    for day in outside:
        _txn(db, me, card, day, amount=7)
    db.expire_all()
    assert _statement_balances(db, db.get(Account, card), [close]) == {close: Decimal("600")}


def test_apply_refuses_entry_whose_row_would_cross_a_statement(world, monkeypatch):
    """A write that put a row on the next statement is caught by the balance
    check and the whole entry is rolled back."""
    from datetime import timedelta

    from app.services import installment_redate

    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 27), payments=4)
    _txn(db, me, card, date(2026, 9, 27), entry=entry)
    real = installment_redate.redate_row

    def one_day_late(session, txn, new_date):
        real(session, txn, new_date + timedelta(days=1))

    monkeypatch.setattr(installment_redate, "redate_row", one_day_late)
    _refused(db, entry, "a statement balance would change")


def test_dry_run_holds_no_lock_into_the_next_entry(world, monkeypatch):
    """While a dry run works on its second entry, another session can lock
    the first entry's row and card: the first entry's transaction has ended."""
    from app.services import installment_redate

    db, me = world["db"], world["me"]
    first = _entry(db, me, world["card_c"], date(2026, 11, 25))
    second = _entry(db, me, world["card_b"], date(2026, 11, 28))
    real = installment_redate._redate_entry
    probes = {}
    engine = create_engine(os.environ["DATABASE_URL"])

    def probing(session, entry_id, today):
        if entry_id == second:
            with engine.connect() as other:
                other.execute(text("SET lock_timeout = '1s'"))
                for name, table, row_id in (("entry", "budget_entries", first),
                                            ("card", "accounts", world["card_c"])):
                    try:
                        other.execute(text(f"SELECT id FROM {table} WHERE id = :i "
                                           "FOR UPDATE NOWAIT"), {"i": row_id})
                        probes[name] = "free"
                    except Exception as exc:  # LockNotAvailable
                        probes[name] = type(exc).__name__
                        other.rollback()
                other.rollback()
        return real(session, entry_id, today)

    monkeypatch.setattr(installment_redate, "_redate_entry", probing)
    try:
        results = _run(False, {first, second})
    finally:
        engine.dispose()
    assert results[first].status == results[second].status == "converted"
    assert probes == {"entry": "free", "card": "free"}


# --- the row helper and the card lock ---------------------------------------------------------

def test_redate_row_recomputes_allocations_at_old_and_new_dates(world):
    from app.core.database import SessionLocal
    from app.models.allocation import Allocation
    from app.models.transaction import Transaction
    from app.services.installment_redate import redate_row

    client, db, me, card = world["client"], world["db"], world["me"], world["card_b"]
    savings = _account(client, me, "Savings", "savings", balance=10_000)
    budget = sw_post(client, me, "/allocations/", {
        "account_id": savings, "name": "Gadgets", "allocation_type": "budget",
        "target_amount": 5_000, "period_frequency": "monthly",
        "period_start": "2026-11-01T00:00:00", "period_end": "2026-12-01T00:00:00"})["id"]
    txn_id = _txn(db, me, card, date(2026, 10, 28), amount=300, allocation=budget)
    db.expire_all()
    assert Decimal(db.get(Allocation, budget).current_amount) == 0
    stamp = db.get(Transaction, txn_id).updated_at

    session = SessionLocal()
    try:
        redate_row(session, session.get(Transaction, txn_id), datetime(2026, 11, 2))
        session.commit()
    finally:
        session.close()
    db.expire_all()
    assert Decimal(db.get(Allocation, budget).current_amount) == Decimal("300")
    moved = db.get(Transaction, txn_id)
    assert moved.transaction_date.date() == date(2026, 11, 2)
    assert moved.updated_at is not None and moved.updated_at != stamp


def test_script_reads_cycle_settings_under_card_lock(world):
    """The close day changes in another transaction holding the card: the run
    waits for it and maps onto the committed close day."""
    from app.core import locking
    from app.core.database import SessionLocal

    db, me, card = world["db"], world["me"], world["card_c"]
    entry = _entry(db, me, card, date(2026, 11, 25))
    holder = SessionLocal()
    engine = create_engine(os.environ["DATABASE_URL"])
    outcome = {}

    def run():
        try:
            outcome["result"] = _run(True, {entry})
        except BaseException as exc:
            outcome["error"] = exc

    try:
        locking.lock_accounts(holder, [card])[card].billing_cycle_start = 28
        holder.flush()
        pid = holder.execute(text("SELECT pg_backend_pid()")).scalar()
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        deadline, blocked = time.monotonic() + 10, False
        with engine.connect() as probe:
            while not blocked and worker.is_alive() and time.monotonic() < deadline:
                blocked = bool(probe.execute(text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE pg_blocking_pids(pid) @> ARRAY[CAST(:h AS integer)]"),
                    {"h": pid}).scalar())
                probe.rollback()
                time.sleep(0.05)
        assert blocked, outcome
        holder.commit()
        worker.join(30)
    finally:
        holder.rollback()
        holder.close()
        engine.dispose()
    assert "error" not in outcome, outcome
    assert outcome["result"][entry].status == "converted"
    assert _state(db, entry)[0][:3] == (date(2026, 11, 28), 28, None)


# --- output -----------------------------------------------------------------------------------

def test_output_has_no_amounts(world, card_c_plans):
    """The driver, as the owner runs it (a dry run, then an expectation it refuses)."""
    from app.services.installment_redate import summary

    e25, e27, rows = card_c_plans
    lines = "\n".join(summary(list(_run(False, {e25, e27}).values())))
    assert f"entry {e27}" in lines and f"txn {rows[0]}" in lines
    assert str(AMOUNT) not in lines and "1,234" not in lines

    url = os.environ["DATABASE_URL"]
    from sqlalchemy.engine.url import make_url

    parsed = make_url(url)
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    script = str(BACKEND_DIR / "scripts" / "redate_card_installments.py")
    out = subprocess.run(
        [sys.executable, script, "--expect-host", parsed.host, "--expect-db", parsed.database],
        env=env, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stdout + out.stderr
    assert out.stdout.startswith(f"target: host={parsed.host} db={parsed.database}\n")
    assert "mode: dry run" in out.stdout and "changes: " in out.stdout
    assert str(AMOUNT) not in out.stdout and "password" not in out.stdout
    wrong = subprocess.run(
        [sys.executable, script, "--expect-host", parsed.host, "--expect-db", "other_db"],
        env=env, capture_output=True, text=True, timeout=300)
    assert wrong.returncode == 2 and wrong.stdout.startswith("refused:")

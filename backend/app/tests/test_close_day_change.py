"""A card's closing day changed whole or not at all (STU-744).

``services/close_day_change.run`` (driven by ``scripts/change_card_close_day.py``)
moves one card from one close day to another: the card, its printed and
minimum dues, and its open installments with their linked rows, in one
transaction. Skips without a database.

Reference: Wednesday 2026-11-18, 02:00 UTC (10:00 in Manila). "Card" closes on
the 14th with its due 21 days later; the bank moves it to the 15th.
"""
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_installment_redate import _account, _card, _entry, _txn

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 18, 2, 0)
TODAY = date(2026, 11, 18)
# Distinctive amounts, so the report can be searched for them.
PLAN = "4321.87"
PURCHASE = "6543.19"
MINIMUM = "987.65"
BACKEND_DIR = Path(__file__).resolve().parents[2]


# --- helpers ----------------------------------------------------------------------------------

def _run(card, day, *, apply=True, accept=False):
    """The service as the script runs it, in its own session."""
    from app.core.database import SessionLocal
    from app.services import close_day_change

    db = SessionLocal()
    try:
        return close_day_change.run(db, card, day, apply=apply, accept_history_shift=accept,
                                    today=TODAY)
    finally:
        db.close()


def _put(world, path, body):
    r = world["client"].put(f"{API}{path}", json=body, headers=world["me"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _snapshot(db, card):
    """Every stored row the change may write, read straight from the tables."""
    db.rollback()
    queries = {
        "card": "SELECT * FROM accounts WHERE id = :c",
        "entries": "SELECT * FROM budget_entries WHERE account_id = :c ORDER BY id",
        "rows": "SELECT * FROM transactions WHERE account_id = :c ORDER BY id",
        "dues": "SELECT * FROM card_statement_due_overrides WHERE account_id = :c ORDER BY id",
        "minimums": "SELECT * FROM card_statement_minimums WHERE account_id = :c ORDER BY id",
        "statements": "SELECT * FROM card_statements WHERE card_id = :c ORDER BY close",
        "state": "SELECT * FROM card_statement_state WHERE card_id = :c",
        "forced": "SELECT p.* FROM payment_date_overrides p JOIN budget_entries e "
                  "ON e.id = p.budget_entry_id WHERE e.account_id = :c ORDER BY p.id",
    }
    out = {name: [tuple(r) for r in db.execute(text(sql), {"c": card})]
           for name, sql in queries.items()}
    db.rollback()
    return out


def _materialise(world):
    """A read through the store, so the card's closed statements are stored."""
    r = world["client"].get(f"{API}/cards/{world['card']}/statements",
                            headers=world["me"]["headers"])
    assert r.status_code == 200, r.text
    db = world["db"]
    db.rollback()
    assert db.execute(text("SELECT count(*) FROM card_statements WHERE card_id = :c"),
                      {"c": world["card"]}).scalar() > 0


def _entry_state(db, entry_id):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.services.installment_redate import _linked, _paid
    from app.services.recurring_kinds import is_normalised_installment

    db.expire_all()
    e = db.get(BudgetEntry, entry_id)
    rows = db.query(Transaction).filter(Transaction.budget_entry_id == entry_id).order_by(
        Transaction.id).all()
    return {
        "normalised": is_normalised_installment(e, db.get(Account, e.account_id)),
        "next": e.next_occurrence.date(), "anchor": e.anchor_day,
        "counts": (e.max_occurrences, e.occurrences_paid_offset, _paid(db, e)),
        "linked": _linked(db, entry_id),
        "rows": [(t.id, t.transaction_date.date(), t.occurrence_date.date()) for t in rows],
        "active": e.is_active,
    }


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    """Card closing on the 14th with an open installment on the close: two paid
    months (Oct 14, Nov 14), the next on Dec 14; a purchase on Oct 5."""
    pin_clock(monkeypatch, REF)
    me = sw_people()
    card = _card(sw_client, me, 14, 21, "Card")
    db = sw_db
    entry = _entry(db, me, card, date(2026, 12, 14), payments=6)
    db.execute(text("UPDATE budget_entries SET amount = :a WHERE id = :e"),
               {"a": PLAN, "e": entry})
    db.commit()
    paid = [_txn(db, me, card, date(2026, 10, 14), entry=entry, amount=PLAN),
            _txn(db, me, card, date(2026, 11, 14), entry=entry, amount=PLAN)]
    purchase = _txn(db, me, card, date(2026, 10, 5), amount=PURCHASE)
    return {"client": sw_client, "db": db, "me": me, "card": card, "entry": entry,
            "paid": paid, "purchase": purchase, "people": sw_people}


# --- AC1-AC3: the change ----------------------------------------------------------------------

def test_open_installments_move_onto_the_new_close(world):
    """AC1: every open installment, active or paused, any creator's, is on the new
    close; its counts, paid count and linked rows are unchanged but for the dates."""
    db, me, card, entry = world["db"], world["me"], world["card"], world["entry"]
    other = world["people"]("Partner", "Editor")
    sw_share(db, card, other["id"], "editor", created_by=me["id"])
    paused = _entry(db, other, card, date(2026, 12, 14), payments=2, active=False)
    done = _entry(db, me, card, date(2026, 12, 14), payments=0)
    done_row = _txn(db, me, card, date(2026, 9, 14), entry=done)
    before = {e: _entry_state(db, e) for e in (entry, paused, done)}
    assert before[entry]["normalised"] and before[paused]["normalised"]

    result = _run(card, 15)

    assert result.status == "changed", result.lines()
    assert {r.entry_id: r.status for r in result.entries} == {
        entry: "converted", paused: "converted"}
    after = {e: _entry_state(db, e) for e in (entry, paused, done)}
    sep, oct_ = world["paid"]
    assert after[entry] == {
        **before[entry], "next": date(2026, 12, 15), "anchor": 15,
        "rows": [(sep, date(2026, 10, 15), date(2026, 10, 15)),
                 (oct_, date(2026, 11, 15), date(2026, 11, 15))],
        "linked": {(sep, date(2026, 10, 15)), (oct_, date(2026, 11, 15))}}
    assert after[entry]["normalised"] and after[entry]["counts"] == (6, 0, 2)
    assert after[paused] == {**before[paused], "next": date(2026, 12, 15), "anchor": 15}
    assert after[paused]["normalised"] and after[paused]["active"] is False
    # A completed installment and its row are left alone.
    assert after[done] == {**before[done], "normalised": False}
    assert after[done]["rows"] == [(done_row, date(2026, 9, 14), date(2026, 9, 14))]


def test_printed_and_minimum_dues_follow_their_statements(world):
    """AC2: each printed due and minimum due is keyed by the new close of the
    same statement month, its value unchanged."""
    db, card = world["db"], world["card"]
    _put(world, f"/cards/{card}/statements/2026-10-14/due-date", {"due_date": "2026-11-06"})
    _put(world, f"/cards/{card}/statements/2026-12-14/due-date", {"due_date": "2027-01-06"})
    _put(world, f"/cards/{card}/statements/2026-10-14/minimum-due", {"amount": MINIMUM})
    _put(world, f"/cards/{card}/statements/2026-11-14/minimum-due", {"amount": MINIMUM})
    before = _snapshot(db, card)

    result = _run(card, 15)

    assert result.status == "changed", result.lines()
    after = _snapshot(db, card)
    db.rollback()
    dues = db.execute(text("SELECT id, statement_close, due_date FROM "
                           "card_statement_due_overrides WHERE account_id = :c ORDER BY id"),
                      {"c": card}).all()
    minimums = db.execute(text("SELECT id, statement_close, amount FROM "
                               "card_statement_minimums WHERE account_id = :c ORDER BY id"),
                          {"c": card}).all()
    assert [(d.statement_close, d.due_date) for d in dues] == [
        (date(2026, 10, 15), date(2026, 11, 6)), (date(2026, 12, 15), date(2027, 1, 6))]
    assert [(m.statement_close, str(m.amount)) for m in minimums] == [
        (date(2026, 10, 15), MINIMUM), (date(2026, 11, 15), MINIMUM)]
    assert [d.id for d in dues] == [r[0] for r in before["dues"]]
    assert [m.id for m in minimums] == [r[0] for r in before["minimums"]]
    assert [(m.row_id, m.old_close, m.new_close) for m in result.dues] == [
        (dues[0].id, date(2026, 10, 14), date(2026, 10, 15)),
        (dues[1].id, date(2026, 12, 14), date(2026, 12, 15))]
    assert len(after["minimums"]) == 2
    # The card's statements read them under the new closes.
    r = world["client"].get(f"{API}/cards/{card}/statements", headers=world["me"]["headers"])
    by_close = {s["close_date"]: s for s in r.json()["statements"]}
    assert by_close["2026-10-15"]["due_date"] == "2026-11-06"
    assert by_close["2026-10-15"]["due_overridden"] is True


def test_line_total_is_unchanged_and_the_store_verifies(world):
    """AC3: the card's total of statement line items is the same and its stored
    statements match its rows (``statements_store.verify_card``)."""
    from app.core.access import viewable_account_ids
    from app.models.account import Account
    from app.models.user import User
    from app.services import statements_store
    from app.services.close_day_change import _lines, _total, _view

    db, card = world["db"], world["card"]
    _materialise(world)

    def total():
        db.expire_all()
        account = db.get(Account, card)
        return _total(_lines(db, account), _view(account, account.billing_cycle_start), TODAY)

    before = total()
    assert _run(card, 15).status == "changed"
    assert total() == before
    db.expire_all()
    account = db.get(Account, card)
    got = statements_store.verify_card(
        db, account, viewable_account_ids(db, db.get(User, account.user_id)), TODAY)
    db.rollback()
    assert got["materialized"] and got["rows_equal"] and got["summaries_equal"], got
    assert db.execute(text("SELECT close_day FROM card_statement_state WHERE card_id = :c"),
                      {"c": card}).scalar() == 15


# --- AC4: refusals write nothing --------------------------------------------------------------

def _refused(world, contains, *, card=None, day=15, accept=False):
    db, card = world["db"], card or world["card"]
    before = _snapshot(db, card)
    result = _run(card, day, accept=accept)
    assert result.status == "refused", result.lines()
    assert any(contains in reason for reason in result.reasons), result.reasons
    assert _snapshot(db, card) == before
    return result


def test_forced_date_refuses_the_whole_change(world):
    db, card = world["db"], world["card"]
    _materialise(world)
    _put(world, f"/cards/{card}/statements/2026-10-14/due-date", {"due_date": "2026-11-06"})
    _put(world, f"/budget-entries/{world['entry']}/occurrences/2026-12-14/date",
         {"effective_date": "2026-12-16"})
    second = _entry(db, world["me"], card, date(2026, 12, 14), payments=3)
    result = _refused(world, f"entry {world['entry']}: it has forced dates")
    # The other entry converted inside the transaction, then was rolled back with it.
    assert {r.entry_id: r.status for r in result.entries} == {
        world["entry"]: "refused", second: "converted"}


def test_legacy_due_date_only_card_is_refused(world):
    db = world["db"]
    legacy = _account(world["client"], world["me"], "Legacy card", "credit", 0, due_date=5,
                      days_until_due_date=21, credit_limit=10_000)
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL WHERE id = :c"),
               {"c": legacy})
    db.commit()
    _refused(world, "only a legacy due day", card=legacy)


def test_other_card_states_are_refused(world):
    checking = _account(world["client"], world["me"], "Checking")
    _refused(world, "not a credit card", card=checking)
    _refused(world, "already closes on day 14", day=14)
    _refused(world, "from 1 to 31", day=32)


def test_printed_due_left_out_of_order_refuses(world):
    """Nov 15 is after the Nov 14 close, but not after the Nov 15 one."""
    card = world["card"]
    _put(world, f"/cards/{card}/statements/2026-11-14/due-date", {"due_date": "2026-11-15"})
    result = _refused(world, "would not be after its new close 2026-11-15")
    assert any("would be out of order" in r or "not be after" in r for r in result.reasons)


def test_earlier_day_refuses_installments_on_the_close(world):
    """On the 13th, a charge on the 14th is on the next month's statement: the
    re-date would move each paid month a month on. Refused even when the
    history shift is accepted."""
    sep, oct_ = world["paid"]
    result = _refused(world, f"linked transaction {sep} on 2026-10-14 would move to "
                             "2026-11-13, not to 2026-10-13", day=13, accept=True)
    assert any(f"entry {world['entry']}: its next occurrence on 2026-12-14 would move to "
               "2027-01-13" in r for r in result.reasons), result.reasons


def test_past_statement_change_refuses_without_the_accept_flag(world):
    """A purchase on Oct 15 is on the Nov 14 statement; on the 15th it is on Oct 15's."""
    _materialise(world)
    moved = _txn(world["db"], world["me"], world["card"], date(2026, 10, 15), amount=PURCHASE)
    result = _refused(world, "past statements would change")
    assert [(s.old_close, s.new_close, s.moved_in, s.moved_out) for s in result.shifts] == [
        (date(2026, 10, 14), date(2026, 10, 15), [moved], []),
        (date(2026, 11, 14), date(2026, 11, 15), [], [moved])]


# --- AC5: accepting the history shift ---------------------------------------------------------

def test_accepted_history_shift_applies_and_lists_each_statement(world):
    db, card = world["db"], world["card"]
    _materialise(world)
    moved = _txn(db, world["me"], card, date(2026, 10, 15), amount=PURCHASE)
    result = _run(card, 15, accept=True)
    assert result.status == "changed", result.lines()
    assert result.history_accepted
    assert [(s.old_close, s.new_close, s.moved_in, s.moved_out) for s in result.shifts] == [
        (date(2026, 10, 14), date(2026, 10, 15), [moved], []),
        (date(2026, 11, 14), date(2026, 11, 15), [], [moved])]
    lines = "\n".join(result.lines())
    assert (f"past statement 2026-10-14 -> 2026-10-15: moved in txn {moved}; moved out none"
            in lines)
    assert (f"past statement 2026-11-14 -> 2026-11-15: moved in none; moved out txn {moved}"
            in lines)
    assert "past statements change: accepted" in lines
    db.rollback()
    assert db.execute(text("SELECT billing_cycle_start FROM accounts WHERE id = :c"),
                      {"c": card}).scalar() == 15


# --- AC6, AC7: dry run and report -------------------------------------------------------------

def test_dry_run_reports_what_apply_does_and_writes_nothing(world):
    db, card = world["db"], world["card"]
    _materialise(world)
    _put(world, f"/cards/{card}/statements/2026-10-14/due-date", {"due_date": "2026-11-06"})
    _put(world, f"/cards/{card}/statements/2026-10-14/minimum-due", {"amount": MINIMUM})
    _txn(db, world["me"], card, date(2026, 10, 15), amount=PURCHASE)
    before = _snapshot(db, card)
    dry = _run(card, 15, apply=False, accept=True)
    assert dry.status == "changed", dry.lines()
    assert _snapshot(db, card) == before
    applied = _run(card, 15, accept=True)
    assert applied.lines() == dry.lines()
    assert _snapshot(db, card) != before


def test_report_has_no_amounts(world):
    """AC7: the service's report and the script, as the owner runs it."""
    db, card = world["db"], world["card"]
    _put(world, f"/cards/{card}/statements/2026-10-14/minimum-due", {"amount": MINIMUM})
    _txn(db, world["me"], card, date(2026, 10, 15), amount=PURCHASE)
    refused = "\n".join(_run(card, 15, apply=False).lines())
    accepted = "\n".join(_run(card, 15, apply=False, accept=True).lines())
    assert f"entry {world['entry']}" in accepted and f"txn {world['paid'][0]}" in accepted
    for lines in (refused, accepted):
        for amount in (PLAN, PURCHASE, MINIMUM):
            whole = amount.split(".")[0]
            assert whole not in lines and f"{whole[0]},{whole[1:]}" not in lines, lines

    from sqlalchemy.engine.url import make_url

    parsed = make_url(os.environ["DATABASE_URL"])
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    script = str(BACKEND_DIR / "scripts" / "change_card_close_day.py")
    args = [sys.executable, script, "--card-id", str(card), "--close-day", "15",
            "--expect-host", parsed.host]
    out = subprocess.run(args + ["--expect-db", parsed.database, "--accept-history-shift"],
                         env=env, capture_output=True, text=True, timeout=300)
    # The script reads the real clock, not the pinned one: either outcome is a report.
    assert out.returncode in (0, 3), out.stdout + out.stderr
    assert out.stdout.startswith(f"target: host={parsed.host} db={parsed.database}\n")
    assert "mode: dry run" in out.stdout and "result: " in out.stdout
    for amount in (PLAN, PURCHASE, MINIMUM):
        assert amount.split(".")[0] not in out.stdout
    assert "password" not in out.stdout
    db.rollback()
    assert db.execute(text("SELECT billing_cycle_start FROM accounts WHERE id = :c"),
                      {"c": card}).scalar() == 14
    wrong = subprocess.run(args + ["--expect-db", "other_db"], env=env, capture_output=True,
                           text=True, timeout=300)
    assert wrong.returncode == 2 and wrong.stdout.startswith("refused:")

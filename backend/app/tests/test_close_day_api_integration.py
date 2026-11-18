"""``POST /cards/{account_id}/closing-day`` (STU-747).

The route over ``services/close_day_change`` (STU-744, docs/close-day-change.md):
a dry run reports and writes nothing, an apply changes the card whole or not at
all, and only an owner or admin of the card may ask. Reference day, cards and
fixtures are those of ``test_close_day_change``. Skips without a database.
"""
import json
import threading
import uuid
from datetime import date

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_share
from app.tests import test_close_day_change as base
from app.tests import test_installment_close_integration as race
from app.tests.test_close_day_change import (
    GAP_PLAN, MINIMUM, PLAN, PURCHASE, _entry_state, _materialise, _put, _snapshot)
from app.tests.test_installment_redate import _card, _txn

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

JOIN_TIMEOUT = 60

# The fixtures of the service's tests and of the install-close race tests, bound by name.
world = base.world
gap = base.gap
engine = race.engine
holder = race.holder


def _post(w, body, *, who=None, card=None, key=None):
    headers = dict((who or w["me"])["headers"])
    if key is not None:
        headers["Idempotency-Key"] = key
    return w["client"].post(f"{API}/cards/{card or w['card']}/closing-day", json=body,
                            headers=headers)


def _apply(day=15, **extra):
    return {"close_day": day, "dry_run": False, **extra}


def _day(db, card):
    db.rollback()
    return db.execute(text("SELECT billing_cycle_start FROM accounts WHERE id = :c"),
                      {"c": card}).scalar()


def _no_amounts(r):
    """No amount in the answer: no amount key, and no distinctive amount in its text."""
    def keys(node):
        if isinstance(node, dict):
            for k, v in node.items():
                yield k
                yield from keys(v)
        elif isinstance(node, list):
            for v in node:
                yield from keys(v)

    assert not [k for k in keys(r.json()) if "amount" in k or "balance" in k], r.text
    for amount in (PLAN, PURCHASE, MINIMUM, GAP_PLAN):
        assert amount not in r.text and amount.split(".")[0] not in r.text, r.text


# --- AC1: a dry run reports and writes nothing ------------------------------------------------

def test_dry_run_returns_the_report_and_writes_nothing(world):
    """AC1. The default body is a dry run; with a key it still stores nothing."""
    db, card, entry = world["db"], world["card"], world["entry"]
    _materialise(world)
    _put(world, f"/cards/{card}/statements/2026-10-14/due-date", {"due_date": "2026-11-06"})
    _put(world, f"/cards/{card}/statements/2026-10-14/minimum-due", {"amount": MINIMUM})
    before = _snapshot(db, card)
    keys = db.execute(text("SELECT count(*) FROM idempotency_keys")).scalar()
    db.rollback()

    for body, key in (({"close_day": 15}, None),
                      ({"close_day": 15, "dry_run": True}, str(uuid.uuid4()))):
        r = _post(world, body, key=key)
        assert r.status_code == 200, r.text
        report = r.json()
        assert (report["dry_run"], report["changed"], report["refused"], report["reasons"]) == (
            True, False, False, [])
        assert (report["old_close_day"], report["new_close_day"]) == (14, 15)
        assert report["history_shift_accepted"] is False and report["past_statements"] == []
        (moved,) = report["entries"]
        assert moved["entry_id"] == entry
        assert (moved["old_next_occurrence"], moved["new_next_occurrence"]) == (
            "2026-12-14", "2026-12-15")
        assert (moved["old_anchor_day"], moved["new_anchor_day"]) == (14, 15)
        assert [(x["transaction_id"], x["date_kept"], x["old_date"], x["new_date"],
                 x["old_occurrence"], x["new_occurrence"]) for x in moved["rows"]] == [
            (t, False, d, n, d, n) for t, d, n in zip(
                world["paid"], ("2026-10-14", "2026-11-14"), ("2026-10-15", "2026-11-15"))]
        assert [(d["old_close"], d["new_close"]) for d in report["printed_dues"]] == [
            ("2026-10-14", "2026-10-15")]
        assert [(d["old_close"], d["new_close"]) for d in report["minimum_dues"]] == [
            ("2026-10-14", "2026-10-15")]
        _no_amounts(r)
        assert _snapshot(db, card) == before
    assert db.execute(text("SELECT count(*) FROM idempotency_keys")).scalar() == keys
    db.rollback()


# --- AC2: an apply changes the card whole -----------------------------------------------------

def test_apply_changes_the_day_installments_and_dues(world):
    db, card, entry = world["db"], world["card"], world["entry"]
    _materialise(world)
    _put(world, f"/cards/{card}/statements/2026-10-14/due-date", {"due_date": "2026-11-06"})
    _put(world, f"/cards/{card}/statements/2026-10-14/minimum-due", {"amount": MINIMUM})
    before = _entry_state(db, entry)

    r = _post(world, _apply())

    assert r.status_code == 200, r.text
    report = r.json()
    assert (report["changed"], report["refused"], report["dry_run"]) == (True, False, False)
    _no_amounts(r)
    assert _day(db, card) == 15
    after = _entry_state(db, entry)
    sep, oct_ = world["paid"]
    assert after["normalised"] and after["next"] == date(2026, 12, 15) and after["anchor"] == 15
    assert after["rows"] == [(sep, date(2026, 10, 15), date(2026, 10, 15)),
                             (oct_, date(2026, 11, 15), date(2026, 11, 15))]
    assert after["counts"] == before["counts"]
    db.rollback()
    assert db.execute(text("SELECT statement_close FROM card_statement_due_overrides "
                           "WHERE account_id = :c"), {"c": card}).scalars().all() == [
        date(2026, 10, 15)]
    assert db.execute(text("SELECT statement_close FROM card_statement_minimums "
                           "WHERE account_id = :c"), {"c": card}).scalars().all() == [
        date(2026, 10, 15)]
    # The same day again is a service refusal.
    again = _post(world, _apply())
    assert again.status_code == 409 and again.json()["refused"] is True
    assert any("already closes on day 15" in x for x in again.json()["reasons"])


def test_apply_with_the_gap_shape_keeps_dates_and_moves_the_schedule(gap):
    """Charges dated the day after the old close: dates kept, the occurrence and the
    next charge move."""
    db, card, rows = gap["db"], gap["card"], gap["rows"]
    snapshot = _snapshot(db, card)

    r = _post(gap, _apply())
    assert r.status_code == 409 and r.json()["refused"] is True  # the history shift
    assert _snapshot(db, card) == snapshot

    r = _post(gap, _apply(accept_history_shift=True))
    assert r.status_code == 200, r.text
    report = r.json()
    assert report["changed"] is True and report["history_shift_accepted"] is True
    assert {e["entry_id"] for e in report["entries"]} == set(rows)
    for e in report["entries"]:
        assert (e["old_next_occurrence"], e["new_next_occurrence"]) == (
            "2027-01-14", "2026-12-15")
        (row,) = e["rows"]
        assert (row["transaction_id"], row["date_kept"]) == (rows[e["entry_id"]], True)
        assert (row["old_date"], row["new_date"]) == ("2026-11-15", "2026-11-15")
        assert (row["old_occurrence"], row["new_occurrence"]) == ("2026-12-14", "2026-11-15")
    assert [(s["old_close"], s["new_close"], s["moved_in"], s["moved_out"])
            for s in report["past_statements"]] == [
        ("2026-11-14", "2026-11-15", sorted(rows.values()), [])]
    _no_amounts(r)
    assert _day(db, card) == 15
    for entry, txn in rows.items():
        after = _entry_state(db, entry)
        assert after["normalised"] and after["next"] == date(2026, 12, 15)
        assert after["rows"] == [(txn, date(2026, 11, 15), date(2026, 11, 15))]


# --- AC3: who may ask --------------------------------------------------------------------------

def test_only_an_owner_or_admin_of_the_card_may_change_it(world):
    db, card, people, me = world["db"], world["card"], world["people"], world["me"]
    viewer, editor, stranger = (people(n, r) for n, r in (("Vic", "Viewer"), ("Eddy", "Editor"),
                                                          ("Sam", "Stranger")))
    admin = people("Ada", "Admin")
    sw_share(db, card, viewer["id"], "viewer", me["id"])
    sw_share(db, card, editor["id"], "editor", me["id"])
    sw_share(db, card, admin["id"], "admin", me["id"])
    before = _snapshot(db, card)

    for who in (viewer, editor, stranger):
        for body in (_apply(), {"close_day": 15}):
            r = _post(world, body, who=who)
            assert r.status_code == 404, (who["id"], r.status_code, r.text)
            assert r.json() == {"detail": "Account not found"}
    assert _snapshot(db, card) == before
    other = world["client"].get(f"{API}/cards/{card}/credit", headers=viewer["headers"])
    assert other.status_code == 404  # as the other card-management routes

    checking = world["client"].post(f"{API}/accounts/", json={
        "name": "Bank", "account_type": "checking", "balance": 10}, headers=me["headers"]).json()
    r = _post(world, _apply(), card=checking["id"])
    assert r.status_code == 400

    r = _post(world, _apply(), who=admin)
    assert r.status_code == 200 and r.json()["changed"] is True, r.text
    assert _day(db, card) == 15


@pytest.mark.parametrize("body", [{"close_day": 0}, {"close_day": 32}, {"close_day": "x"},
                                  {}, {"close_day": 15, "extra": 1}])
def test_an_invalid_body_is_422(world, body):
    before = _snapshot(world["db"], world["card"])
    assert _post(world, body).status_code == 422
    assert _snapshot(world["db"], world["card"]) == before


# --- AC4: a history shift is refused unless accepted ------------------------------------------

def test_apply_without_accept_history_shift_is_refused_with_the_report(world):
    """A purchase on Oct 15 is on the Nov 14 statement; on the 15th it is on Oct 15's."""
    db, card = world["db"], world["card"]
    _materialise(world)
    moved = _txn(db, world["me"], card, date(2026, 10, 15), amount=PURCHASE)
    before = _snapshot(db, card)

    for body in (_apply(), {"close_day": 15}):
        r = _post(world, body)
        assert r.status_code == 409, r.text
        report = r.json()
        assert report["refused"] is True and report["changed"] is False
        assert any(x.startswith("past statements would change") for x in report["reasons"])
        assert [(s["old_close"], s["new_close"], s["moved_in"], s["moved_out"])
                for s in report["past_statements"]] == [
            ("2026-10-14", "2026-10-15", [moved], []),
            ("2026-11-14", "2026-11-15", [], [moved])]
        assert report["history_shift_accepted"] is False
        assert report["entries"], "the report still lists what would move"
        _no_amounts(r)
        assert _snapshot(db, card) == before
    assert _day(db, card) == 14

    r = _post(world, _apply(accept_history_shift=True))
    assert r.status_code == 200 and r.json()["history_shift_accepted"] is True, r.text
    assert _day(db, card) == 15


# --- Idempotency-Key --------------------------------------------------------------------------

def test_an_apply_replays_its_answer_for_the_same_key(world):
    db, card = world["db"], world["card"]
    key = str(uuid.uuid4())
    first = _post(world, _apply(), key=key)
    assert first.status_code == 200, first.text
    again = _post(world, _apply(), key=key)
    assert again.status_code == 200 and again.content == first.content
    assert _day(db, card) == 15
    other = _post(world, _apply(16), key=key)
    assert other.status_code == 422  # the same key for another body


def test_a_refused_apply_keeps_its_key_free(world):
    db, card = world["db"], world["card"]
    _materialise(world)
    _txn(db, world["me"], card, date(2026, 10, 15), amount=PURCHASE)
    key = str(uuid.uuid4())
    assert _post(world, _apply(), key=key).status_code == 409
    db.rollback()
    assert db.execute(text("SELECT count(*) FROM idempotency_keys WHERE key = :k"),
                      {"k": key}).scalar() == 0
    # Nothing was stored, so the key is free for the retry that is accepted.
    r = _post(world, _apply(accept_history_shift=True), key=key)
    assert r.status_code == 200, r.text
    assert _post(world, _apply(accept_history_shift=True), key=key).content == r.content


# --- AC5: concurrency -------------------------------------------------------------------------

def _together(*fns):
    results = [None] * len(fns)
    barrier = threading.Barrier(len(fns))

    def run(i, fn):
        barrier.wait(10)
        results[i] = fn()

    threads = [threading.Thread(target=run, args=(i, fn), daemon=True)
               for i, fn in enumerate(fns)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(JOIN_TIMEOUT)
    assert not any(t.is_alive() for t in threads), "a request did not finish"
    return results


def test_two_applies_on_one_card_serialise(world):
    db, card, entry = world["db"], world["card"], world["entry"]
    a, b = _together(lambda: _post(world, _apply()), lambda: _post(world, _apply()))
    assert sorted((a.status_code, b.status_code)) == [200, 409], (a.text, b.text)
    loser = a if a.status_code == 409 else b
    assert any("already closes on day 15" in x for x in loser.json()["reasons"]), loser.text
    assert _day(db, card) == 15
    state = _entry_state(db, entry)
    assert state["normalised"] and state["next"] == date(2026, 12, 15)
    assert [r[1] for r in state["rows"]] == [date(2026, 10, 15), date(2026, 11, 15)]


def test_two_applies_to_different_days_leave_one_consistent_day(world):
    db, card, entry = world["db"], world["card"], world["entry"]
    a, b = _together(lambda: _post(world, _apply(15)), lambda: _post(world, _apply(16)))
    codes = sorted((a.status_code, b.status_code))
    assert codes[0] == 200, (a.text, b.text)  # the second may be refused or follow the first
    day = _day(db, card)
    assert day in (15, 16)
    state = _entry_state(db, entry)
    assert state["normalised"] and state["anchor"] == day
    assert state["next"] == date(2026, 12, day)
    assert [r[1] for r in state["rows"]] == [date(2026, 10, day), date(2026, 11, day)]


def test_create_and_apply_take_turns_without_a_deadlock(world):
    """A create of a card installment and an apply, started together on two
    connections, both finish. Either the create is read by the apply (it moves
    both) or the create reads the new day, or the apply, which found no installment
    to lock, sees the create's and is told to run again (409, nothing written); a
    second ask then succeeds. The entry ends on the card's close."""
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services.recurring_kinds import is_normalised_installment

    client, db, me = world["client"], world["db"], world["me"]
    for day in (15, 16, 17, 18, 19, 20):
        card = _card(client, me, 14, 21, f"Race card {day}")

        def create():
            return client.post(f"{API}/budget-entries/", json={
                "name": "Raced plan", "entry_type": "expense", "amount": 1_000,
                "cadence": "monthly", "next_occurrence": "2026-12-14T00:00:00",
                "account_id": card, "end_mode": "after_occurrences", "max_occurrences": 3},
                headers=me["headers"])

        made, changed = _together(create, lambda: _post(world, _apply(day), card=card))
        assert made.status_code == 201, made.text
        if changed.status_code == 409:
            assert any("changed while they were locked" in x
                       for x in changed.json()["reasons"]), changed.text
            assert _day(db, card) == 14
            changed = _post(world, _apply(day), card=card)
        assert changed.status_code == 200, changed.text
        assert _day(db, card) == day
        db.expire_all()
        (entry,) = db.query(BudgetEntry).filter(BudgetEntry.account_id == card).all()
        assert is_normalised_installment(entry, db.get(Account, card)), (day, entry.anchor_day)
        assert entry.anchor_day == day
        db.rollback()


def test_an_apply_waits_for_a_create_holding_the_card_then_runs_again(world, engine, holder):
    """The create holds the card with an installment the apply did not see: the
    apply, which waited, notices the set changed and refuses (409, nothing written);
    asked again it moves both."""
    from app.core import locking
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency
    from datetime import datetime

    db, me, card = world["db"], world["me"], world["card"]
    locking.lock_accounts(holder, [card])
    holder.add(BudgetEntry(
        user_id=me["id"], name="Held plan", entry_type=BudgetEntryType.EXPENSE, amount=1_000,
        cadence=RecurrenceFrequency.MONTHLY, next_occurrence=datetime(2026, 12, 14),
        anchor_day=14, account_id=card, end_mode="after_occurrences", max_occurrences=3))
    holder.flush()
    before = _snapshot(db, card)
    r = race._race(engine, holder, lambda: _post(world, _apply()))
    assert r.status_code == 409, r.text
    assert any("changed while they were locked" in x for x in r.json()["reasons"]), r.text
    assert _day(db, card) == 14 and len(_snapshot(db, card)["entries"]) == len(
        before["entries"]) + 1
    again = _post(world, _apply())
    assert again.status_code == 200 and len(again.json()["entries"]) == 2, again.text
    assert json.loads(again.text)["changed"] is True

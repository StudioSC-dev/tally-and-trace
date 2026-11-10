"""Overlap: a forced date on the next payment's day (``mode: "overlap"``).

Without ``mode`` the neighbour rule is strict, as ever. With ``overlap`` a forced
date may equal the next occurrence's effective date, never the previous one's;
every other refusal stands. Skips without a database.

Reference: Sunday 2026-10-18, 02:00 UTC (10:00 in Manila). A monthly "Rent" on
the 10th has Oct 10 missed and Nov 10 upcoming.
"""
from datetime import date, datetime

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_card_forced_dates_integration import (
    NOV, OCT, _card, _closes, _section, _subscription,
)
from app.tests.test_payment_date_overrides_integration import (
    _checking, _clear, _entry, _force, _get, _listed, _missed, _overrides, _txn,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)


def _overlap(client, who, entry, day, to, expect=200, mode="overlap"):
    body = {"effective_date": to} if mode is None else {"effective_date": to, "mode": mode}
    r = client.put(f"{API}/budget-entries/{entry}/occurrences/{day}/date", json=body,
                   headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    return {"client": sw_client, "db": sw_db, "me": me, "bank": _checking(sw_client, me),
            "monkeypatch": monkeypatch}


def test_strict_default_refuses_next_day(world):
    """AC 1: no mode, and a null mode, keep the strict rule."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")

    for mode in (None, "null"):
        body = {"effective_date": "2026-11-10"}
        if mode == "null":
            body["mode"] = None
        r = client.put(f"{API}/budget-entries/{entry}/occurrences/2026-10-10/date", json=body,
                       headers=me["headers"])
        assert r.status_code == 422, r.text
        assert "between" in r.json()["detail"]

    assert _overrides(db, budget_entry_id=entry) == []
    assert _missed(client, me, entry)[0]["count"] == 1


def test_an_unknown_mode_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")

    _overlap(client, me, entry, "2026-10-10", "2026-11-10", expect=422, mode="delay")
    _overlap(client, me, entry, "2026-10-10", "2026-11-10", expect=422, mode="strict")


def test_overlap_onto_next_day(world):
    """AC 2: the missed Oct 10 joins the upcoming Nov 10."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    assert _missed(client, me, entry)[0]["oldest"] == "2026-10-10"

    r = _overlap(client, me, entry, "2026-10-10", "2026-11-10")

    assert r.json() == {"occurrence_date": "2026-10-10", "effective_date": "2026-11-10"}
    assert _overrides(db, budget_entry_id=entry) == [("2026-10-10", "2026-11-10")]
    assert _missed(client, me, entry) == []
    assert _listed(client, me, entry)[:2] == [("2026-10-10", "2026-11-10"),
                                              ("2026-11-10", "2026-11-10")]


def test_overlap_refusals(world):
    """AC 3: every other refusal stands, with nothing written."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")

    # Past the next occurrence (a weekly one, so it is within the reach).
    weekly = _entry(client, me, bank, "2026-10-04", cadence="weekly", name="Weekly")
    r = _overlap(client, me, weekly, "2026-10-04", "2026-10-12", expect=422)
    assert "between" in r.json()["detail"]
    # The previous occurrence's day: the next one may not go back onto it.
    r = _overlap(client, me, entry, "2026-11-10", "2026-10-10", expect=422)
    assert "between" in r.json()["detail"]
    # Nor onto the day the previous one has itself moved to.
    _overlap(client, me, entry, "2026-10-10", "2026-11-10")
    _overlap(client, me, entry, "2026-11-10", "2026-12-10")
    _overlap(client, me, entry, "2026-12-10", "2026-11-10", expect=422)
    assert _overrides(db, budget_entry_id=entry) == [
        ("2026-10-10", "2026-11-10"), ("2026-11-10", "2026-12-10")]
    assert _overrides(db, budget_entry_id=weekly) == []

    # Over 31 days from the scheduled day: the next quarterly payment is 92 days on.
    quarterly = _entry(client, me, bank, "2026-10-10", cadence="quarterly", name="Dues")
    r = _overlap(client, me, quarterly, "2026-10-10", "2027-01-10", expect=422)
    assert "31 days" in r.json()["detail"]
    assert _overrides(db, budget_entry_id=quarterly) == []

    # A linked row: 409.
    linked = _entry(client, me, bank, "2026-10-10", name="Linked")
    sw_post(client, me, "/transactions/", {
        "account_id": bank, "transaction_type": "debit", "amount": 20_000, "description": "Linked",
        "transaction_date": "2026-10-10T00:00:00", "is_posted": False,
        "budget_entry_id": linked})
    _overlap(client, me, linked, "2026-10-10", "2026-11-10", expect=409)
    assert _overrides(db, budget_entry_id=linked) == []

    # Outside the record dates. The next occurrence is always later and inside the
    # range, so the lower bound is the one a refused overlap can still meet.
    early = _entry(client, me, bank, "2000-01-05", name="Early")
    _overlap(client, me, early, "2000-01-05", "1999-12-30", expect=422)
    assert _overrides(db, budget_entry_id=early) == []


def test_overlap_refuses_a_closed_statement(world):
    """AC 3: a card charge may not move onto a closed statement."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank)
    # Aug 20 and Sep 20 both sit on statements closed before Oct 18.
    entry = _subscription(client, me, card, "2026-08-20")

    r = _overlap(client, me, entry, "2026-08-20", "2026-09-20", expect=422)

    assert "closed" in r.json()["detail"]
    assert _overrides(world["db"], budget_entry_id=entry) == []


def test_overlap_readers(world):
    """AC 4: two occurrences on one day are listed, counted and projected separately."""
    client, me, bank = world["client"], world["me"], world["bank"]

    # Both before today: one missed row counting both.
    past = _entry(client, me, bank, "2026-09-10", name="Past")
    _overlap(client, me, past, "2026-09-10", "2026-10-10")
    (row,) = _missed(client, me, past)
    assert (row["count"], row["oldest"], row["oldest_effective"]) == (2, "2026-09-10", "2026-10-10")

    # A card subscription's missed charges do the same.
    card = _card(client, me, bank, name="Card X")
    weekly = _entry(client, me, card, "2026-10-04", cadence="weekly", name="Weekly",
                    billing_kind="subscription")
    _overlap(client, me, weekly, "2026-10-04", "2026-10-11")
    missed = [m for m in _section(client, me, card)["missed"] if m["entry_id"] == weekly]
    assert [(m["count"], m["oldest_effective"]) for m in missed] == [(2, "2026-10-11")]

    # Moved onto an upcoming day: two outflows that day, summing to twice the amount.
    future = _entry(client, me, bank, "2026-10-10", name="Future", amount=700)
    _overlap(client, me, future, "2026-10-10", "2026-11-10")
    body = _get(client, me, "/forecast/timeline?days=60")
    (cash,) = [r for r in body["by_currency"] if r["currency"] == "PHP"]
    nov10 = [e for e in cash["events"] if e["name"] == "Future" and e["date"].startswith("2026-11-10")]
    assert len(nov10) == 2
    assert sum(e["amount"] for e in nov10) == -1_400


def test_overlap_mark_paid_each(world):
    """AC 5: each is recorded on its own, dated that day; nothing is skipped."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _overlap(client, me, entry, "2026-10-10", "2026-11-10")

    rows = []
    for _ in range(2):
        r = client.post(f"{API}/budget-entries/{entry}/materialize", json={},
                        headers=me["headers"])
        assert r.status_code in (200, 201), r.text
        assert "X-Occurrences-Skipped" not in r.headers
        rows.append(_txn(db, r.json()["id"]))

    assert [t.transaction_date.date() for t in rows] == [date(2026, 11, 10)] * 2
    assert [t.occurrence_date.date() for t in rows] == [date(2026, 10, 10), date(2026, 11, 10)]
    assert _get(client, me, f"/budget-entries/{entry}")["next_occurrence"].startswith("2026-12-10")


def test_overlap_post_n_due_records_both(world):
    """AC 5: Post N due takes both once that day is due."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _overlap(client, me, entry, "2026-10-10", "2026-11-10")
    pin_clock(world["monkeypatch"], datetime(2026, 11, 12, 2, 0))

    r = client.post(f"{API}/budget-entries/{entry}/materialize-due", headers=me["headers"])

    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert [i["occurrence_date"] for i in results] == ["2026-10-10", "2026-11-10"]
    assert [_txn(db, i["transaction"]["id"]).transaction_date.date() for i in results] == [
        date(2026, 11, 10)] * 2
    assert r.json()["next_occurrence"].startswith("2026-12-10")


def test_overlap_card_statement(world):
    """AC 6: the charge bills on the statement holding the next charge's day."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank)
    entry = _subscription(client, me, card, "2026-10-20")
    assert _closes(client, me, card)[OCT] == 500

    r = _overlap(client, me, entry, "2026-10-20", "2026-11-20")

    assert r.json() == {"occurrence_date": "2026-10-20", "effective_date": "2026-11-20",
                        "statement_close": NOV, "statement_due": "2026-12-15"}
    closes = _closes(client, me, card)
    assert OCT not in closes
    assert closes[NOV] == 1_000  # both charges on the one statement


def test_overlap_clear(world):
    """AC 7: Clear restores the stacked payment; the next one may not cross it."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _overlap(client, me, entry, "2026-10-10", "2026-11-10")
    _clear(client, me, entry, "2026-10-10")
    assert _overrides(db, budget_entry_id=entry) == []
    assert _missed(client, me, entry)[0]["count"] == 1

    weekly = _entry(client, me, bank, "2026-10-04", cadence="weekly", name="Weekly")
    _force(client, me, weekly, "2026-10-11", "2026-10-14")
    _overlap(client, me, weekly, "2026-10-04", "2026-10-14")
    # Putting Oct 11 back on its own day would cross the payment stacked on Oct 14.
    r = client.delete(f"{API}/budget-entries/{weekly}/occurrences/2026-10-11/date",
                      headers=me["headers"])
    assert r.status_code == 409, r.text
    assert _overrides(db, budget_entry_id=weekly) == [
        ("2026-10-04", "2026-10-14"), ("2026-10-11", "2026-10-14")]
    _clear(client, me, weekly, "2026-10-04")
    _clear(client, me, weekly, "2026-10-11")
    assert _overrides(db, budget_entry_id=weekly) == []


def test_overlap_refuses_the_last_occurrence_of_a_capped_schedule(world):
    """There is no next payment to join: the strict rule applies."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10", end_mode="after_occurrences",
                   max_occurrences=2)

    _overlap(client, me, entry, "2026-11-10", "2026-12-10", expect=422)  # the last, onto the step past it
    assert _overrides(db, budget_entry_id=entry) == []
    _overlap(client, me, entry, "2026-10-10", "2026-11-10")  # the first still joins the last
    assert _overrides(db, budget_entry_id=entry) == [("2026-10-10", "2026-11-10")]


def test_overlap_refuses_the_last_occurrence_of_an_end_dated_schedule(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10", end_mode="on_date",
                   end_date="2026-11-15T00:00:00")

    _overlap(client, me, entry, "2026-11-10", "2026-12-10", expect=422)
    assert _overrides(db, budget_entry_id=entry) == []
    _overlap(client, me, entry, "2026-10-10", "2026-11-10")

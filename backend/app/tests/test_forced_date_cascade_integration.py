"""Delay all: a payment and every later one (``mode: "cascade"``, STU-581 PR 2).

A cascade moves the schedule itself: ``next_occurrence`` becomes the chosen
date and every later occurrence follows the schedule's own rule from there.
Nothing is forced. Undo (``POST /budget-entries/{id}/cascade-undo``) puts back
the schedule columns, the review and auto-post flags and the forced dates.
Skips without a database.

Reference: Tuesday 2026-11-10, 02:00 UTC (10:00 in Manila). A monthly "Rent" on
the 10th has Sep 10 and Oct 10 missed. "Card" closes on the 24th, due 21 days
later: the statements of Sep 24 and Oct 24 are closed.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_card_forced_dates_integration import (
    _card, _charges, _closes, _installment, _subscription,
)
from app.tests.test_payment_date_overrides_integration import (
    _checking, _entry, _force, _get, _missed, _overrides,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 10, 2, 0)
TODAY = date(2026, 11, 10)


# --- helpers ----------------------------------------------------------------------------------

def _cascade(client, who, entry, day, to, expect=200):
    r = client.put(f"{API}/budget-entries/{entry}/occurrences/{day}/date",
                   json={"effective_date": to, "mode": "cascade"}, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _undo(client, who, entry, token, expect=200):
    r = client.post(f"{API}/budget-entries/{entry}/cascade-undo", json={"undo_token": token},
                    headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _row(db, entry):
    """The entry's stored schedule, flags and version."""
    db.rollback()
    return dict(db.execute(text(
        "SELECT next_occurrence, anchor_day, day_rule, end_mode, end_date, max_occurrences, "
        "auto_post_enabled, installment_reviewed_at, updated_at, is_active "
        "FROM budget_entries WHERE id = :id"), {"id": entry}).mappings().one())


def _walk(db, entry, n):
    """The entry's next ``n`` occurrence days, walked from the stored row."""
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import capped_distinct_days

    db.rollback()
    row = db.get(BudgetEntry, entry)
    db.refresh(row)
    start = row.next_occurrence
    return [occ.date().isoformat()
            for occ in capped_distinct_days(row, start, datetime.max, max_steps=n)]


def _all(db, entry):
    """Every occurrence day the stored row walks (a bounded schedule)."""
    return _walk(db, entry, 500)


def _txn_count(db, entry):
    db.rollback()
    return db.execute(text("SELECT count(*) FROM transactions WHERE budget_entry_id = :id"),
                      {"id": entry}).scalar()


def _link(client, who, account, entry, day, posted):
    """A row linked to the entry's occurrence on ``day`` by hand."""
    sw_post(client, who, "/transactions/", {
        "account_id": account, "transaction_type": "debit", "amount": 20_000,
        "description": "Linked", "transaction_date": f"{day}T00:00:00", "is_posted": posted,
        "budget_entry_id": entry})


def _unchanged(db, entry):
    """A refusal's guard: the entry and its overrides as they are now."""
    before = (_row(db, entry), _overrides(db, budget_entry_id=entry), _txn_count(db, entry))

    def check():
        assert (_row(db, entry), _overrides(db, budget_entry_id=entry),
                _txn_count(db, entry)) == before
    return check


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    return {"client": sw_client, "db": sw_db, "me": me, "bank": _checking(sw_client, me),
            "people": sw_people, "monkeypatch": monkeypatch}


# --- AC 1: the owner's shape -------------------------------------------------------------------

def test_cascade_owner_shape(world):
    """Sep 10 and Oct 10 missed; Sep 10 delayed to Nov 12 moves the whole schedule."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    (missed,) = _missed(client, me, entry)
    assert (missed["count"], missed["oldest"]) == (2, "2026-09-10")

    r = _cascade(client, me, entry, "2026-09-10", "2026-11-12")

    body = r.json()
    assert body["occurrence_date"] == body["effective_date"] == "2026-11-12"
    cascade = body["cascade"]
    assert cascade["from"] == "2026-09-10"
    assert (cascade["rule"], cascade["remaining"]) == ("day_of_month", None)
    assert cascade["previous"] == {"next_occurrence": "2026-09-10T00:00:00", "anchor_day": 10,
                                   "day_rule": None, "end_date": None, "max_occurrences": None}
    assert cascade["undo_token"]
    row = _row(db, entry)
    assert row["next_occurrence"] == datetime(2026, 11, 12, tzinfo=timezone.utc)
    assert (row["anchor_day"], row["day_rule"]) == (12, None)
    assert _walk(db, entry, 3) == ["2026-11-12", "2026-12-12", "2027-01-12"]
    assert _missed(client, me, entry) == []
    assert _txn_count(db, entry) == 0
    assert _overrides(db, budget_entry_id=entry) == []


def test_cascade_replaces_the_moved_payments_own_forced_date(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    _force(client, me, entry, "2026-09-10", "2026-09-15")

    _cascade(client, me, entry, "2026-09-10", "2026-11-12")

    assert _overrides(db, budget_entry_id=entry) == []
    assert _walk(db, entry, 2) == ["2026-11-12", "2026-12-12"]


def test_cascade_starts_after_a_first_date_already_recorded(world):
    """Audit W2: the oldest occurrence no posted row stands for is the one that moves."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    _link(client, me, bank, entry, "2026-09-10", posted=True)
    (missed,) = _missed(client, me, entry)
    assert (missed["count"], missed["oldest"]) == (1, "2026-10-10")

    check = _unchanged(db, entry)
    r = _cascade(client, me, entry, "2026-09-10", "2026-11-12", expect=422)
    assert r.json()["detail"] == (
        "Only the oldest unpaid payment (Oct 10) can delay the ones after it")
    check()

    _cascade(client, me, entry, "2026-10-10", "2026-11-12")
    assert _walk(db, entry, 2) == ["2026-11-12", "2026-12-12"]
    assert _missed(client, me, entry) == []
    assert _txn_count(db, entry) == 1


# --- AC 2: month end ---------------------------------------------------------------------------

@pytest.mark.parametrize("first,chosen,expected", [
    ("2027-01-10", "2027-01-31", ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]),
    ("2027-01-10", "2027-01-29", ["2027-01-29", "2027-02-28", "2027-03-29"]),
    ("2028-01-10", "2028-01-31", ["2028-01-31", "2028-02-29", "2028-03-31"]),
])
def test_cascade_month_end(world, first, chosen, expected):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, first)

    _cascade(client, me, entry, first, chosen)

    assert _walk(db, entry, len(expected)) == expected
    assert _row(db, entry)["anchor_day"] == int(chosen[-2:])


# --- AC 3: weekly and bi-weekly ----------------------------------------------------------------

@pytest.mark.parametrize("cadence,step", [("weekly", 7), ("biweekly", 14)])
def test_cascade_fixed_days(world, cadence, step):
    """From a Monday (Nov 2) to a Thursday (Nov 12): every later one a Thursday, ``step`` apart."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-11-02", cadence=cadence)
    assert date(2026, 11, 2).weekday() == 0

    r = _cascade(client, me, entry, "2026-11-02", "2026-11-12")

    assert (r.json()["cascade"]["rule"], r.json()["cascade"]["remaining"]) == ("days", None)
    days = [date.fromisoformat(d) for d in _walk(db, entry, 6)]
    assert days[0] == date(2026, 11, 12)
    assert {d.weekday() for d in days} == {3}
    assert [(b - a).days for a, b in zip(days, days[1:])] == [step] * 5
    row = _row(db, entry)
    assert (row["anchor_day"], row["day_rule"]) == (None, None)
    assert _missed(client, me, entry) == []


# --- AC 4: a bounded schedule keeps its count --------------------------------------------------

def test_cascade_keeps_count(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]

    # On a date: Sep 10 through Feb 10 is 6 payments; after, Nov 12 through Apr 12.
    dated = _entry(client, me, bank, "2026-09-10", end_mode="on_date",
                   end_date="2027-02-10T00:00:00")
    assert len(_all(db, dated)) == 6
    r = _cascade(client, me, dated, "2026-09-10", "2026-11-12")
    assert r.json()["cascade"]["remaining"] == 6
    assert r.json()["cascade"]["previous"]["end_date"] == "2027-02-10T00:00:00"
    assert _all(db, dated) == ["2026-11-12", "2026-12-12", "2027-01-12", "2027-02-12",
                               "2027-03-12", "2027-04-12"]
    assert _row(db, dated)["end_date"] == datetime(2027, 4, 12, tzinfo=timezone.utc)

    # After N payments: max_occurrences stays.
    capped = _entry(client, me, bank, "2026-09-10", name="Sofa", end_mode="after_occurrences",
                    max_occurrences=4)
    r = _cascade(client, me, capped, "2026-09-10", "2026-11-12")
    assert r.json()["cascade"]["remaining"] == 4
    assert _row(db, capped)["max_occurrences"] == 4
    assert _all(db, capped) == ["2026-11-12", "2026-12-12", "2027-01-12", "2027-02-12"]

    # A capped schedule whose first month is already recorded by a posted row: the
    # three left move, not four.
    linked = _entry(client, me, bank, "2026-09-10", name="Desk", end_mode="after_occurrences",
                    max_occurrences=4)
    _link(client, me, bank, linked, "2026-09-10", posted=True)
    r = _cascade(client, me, linked, "2026-10-10", "2026-11-12")
    assert r.json()["cascade"]["remaining"] == 3
    assert _all(db, linked) == ["2026-11-12", "2026-12-12", "2027-01-12"]


@pytest.mark.parametrize("cadence,end,expected", [
    ("weekly", "2026-11-30", ["2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03",
                              "2026-12-10"]),
    ("biweekly", "2026-12-31", ["2026-11-11", "2026-11-25", "2026-12-09", "2026-12-23",
                                "2027-01-06"]),
])
def test_cascade_fixed_days_keeps_count(world, cadence, end, expected):
    """An end date on a weekly (Nov 2..30) or bi-weekly (Nov 2..Dec 28) schedule: 5 left, 5 after."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-11-02", cadence=cadence, end_mode="on_date",
                   end_date=f"{end}T00:00:00")
    assert len(_all(db, entry)) == 5

    r = _cascade(client, me, entry, "2026-11-02", expected[0])

    assert r.json()["cascade"]["remaining"] == 5
    assert _all(db, entry) == expected
    assert _row(db, entry)["end_date"].date().isoformat() == expected[-1]


# --- AC 5: refusals ----------------------------------------------------------------------------

def test_cascade_refusals(world):
    """Each refusal writes nothing: the entry, its overrides and its rows are as they were."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]

    def refused(entry, day, to, expect, detail):
        check = _unchanged(db, entry)
        r = _cascade(client, me, entry, day, to, expect=expect)
        assert detail in r.json()["detail"], r.text
        check()

    rent = _entry(client, me, bank, "2026-09-10")
    # Not the oldest unrecorded occurrence.
    refused(rent, "2026-10-10", "2026-11-12", 422,
            "Only the oldest unpaid payment (Sep 10) can delay the ones after it")
    # The same day, or earlier.
    refused(rent, "2026-09-10", "2026-09-10", 422, "A delay moves payments later")
    refused(rent, "2026-09-10", "2026-09-05", 422, "A delay moves payments later")
    # Not after its own forced date.
    forced = _entry(client, me, bank, "2026-09-10", name="Forced")
    _force(client, me, forced, "2026-09-10", "2026-09-20")
    refused(forced, "2026-09-10", "2026-09-15", 422, "A delay moves payments later")
    # More than two years ahead.
    refused(rent, "2026-09-10", (TODAY + timedelta(days=731)).isoformat(), 422,
            "no more than two years")

    # Twice a month.
    semi = _entry(client, me, bank, "2026-10-01", name="Semi", cadence="semi_monthly",
                  semi_monthly_day_1=1, semi_monthly_day_2=15)
    refused(semi, "2026-10-01", "2026-10-03", 422, "twice-a-month")
    # The last weekday of the month (Oct 30 2026 is a Friday).
    last = _entry(client, me, bank, "2026-10-30", name="Payroll", day_rule="last_weekday")
    refused(last, "2026-10-30", "2026-11-03", 422, "last-weekday")

    # A later pending or posted row.
    pending = _entry(client, me, bank, "2026-09-10", name="Pending")
    _link(client, me, bank, pending, "2026-10-10", posted=False)
    refused(pending, "2026-09-10", "2026-11-12", 409, "Oct 10 is already recorded")
    posted = _entry(client, me, bank, "2026-09-10", name="Posted")
    _link(client, me, bank, posted, "2026-10-10", posted=True)
    refused(posted, "2026-09-10", "2026-11-12", 409, "Oct 10 is already recorded")
    # The moved payment's own linked (pending) row.
    own = _entry(client, me, bank, "2026-09-10", name="Own")
    _link(client, me, bank, own, "2026-09-10", posted=False)
    refused(own, "2026-09-10", "2026-11-12", 409, "already recorded")

    # A later forced date.
    later = _entry(client, me, bank, "2026-09-10", name="Later")
    _force(client, me, later, "2026-10-10", "2026-10-12")
    refused(later, "2026-09-10", "2026-11-12", 422, "Oct 10 has its own date; clear it first")

    # Outside the record dates (a legacy schedule from before 2000).
    early = _entry(client, me, bank, "2000-01-05", name="Early")
    db.execute(text("UPDATE budget_entries SET next_occurrence = '1999-12-01' WHERE id = :id"),
               {"id": early})
    db.commit()
    refused(early, "1999-12-01", "1999-12-20", 422, "Choose a date from 2000-01-01")

    # Not an occurrence at all.
    refused(rent, "2026-09-11", "2026-11-12", 422, "Not an occurrence of this schedule")


def test_cascade_refusals_on_a_card(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    card = _card(client, me, bank)

    # A card installment keeps its months on the statement close.
    tablet = _installment(client, me, card, "2026-11-24")
    check = _unchanged(db, tablet)
    r = _cascade(client, me, tablet, "2026-11-24", "2026-12-01", expect=422)
    assert "card installment" in r.json()["detail"]
    check()

    # Sep 30 is inside the statement that closed on Oct 24.
    video = _subscription(client, me, card, "2026-08-20")
    check = _unchanged(db, video)
    r = _cascade(client, me, video, "2026-08-20", "2026-09-30", expect=422)
    assert "closed" in r.json()["detail"]
    check()


# --- AC 6: card statements ---------------------------------------------------------------------

def test_cascade_card_statements(world):
    """Nov 20 delayed to Nov 26, past the Nov 24 close: each charge bills on its new date's statement."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank)
    entry = _subscription(client, me, card, "2026-11-20")
    assert _closes(client, me, card, days=120) == {
        "2026-11-24": 500, "2026-12-24": 500, "2027-01-24": 500}

    r = _cascade(client, me, entry, "2026-11-20", "2026-11-26")

    assert (r.json()["statement_close"], r.json()["statement_due"]) == ("2026-12-24", "2027-01-14")
    assert _closes(client, me, card, days=120) == {"2026-12-24": 500, "2027-01-24": 500}
    # The charges panel lists the open cycle's charges: only the moved one is in it.
    assert _charges(client, me, card, entry) == [("2026-11-26", "2026-11-26")]


# --- AC 7: Undo --------------------------------------------------------------------------------

def test_cascade_undo_restores_walk(world):
    """Undo puts back the walk, the missed list, the flags and the forced date."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    _force(client, me, entry, "2026-09-10", "2026-09-12")
    db.execute(text("UPDATE budget_entries SET auto_post_enabled = true, "
                    "installment_reviewed_at = now() WHERE id = :id"), {"id": entry})
    db.commit()
    before = _row(db, entry)
    walk = _walk(db, entry, 12)
    missed = _missed(client, me, entry)
    assert missed[0]["count"] == 2
    overrides = _overrides(db, budget_entry_id=entry)
    assert overrides == [("2026-09-10", "2026-09-12")]

    token = _cascade(client, me, entry, "2026-09-10", "2026-11-12").json()["cascade"]["undo_token"]
    assert _walk(db, entry, 12) != walk
    assert _overrides(db, budget_entry_id=entry) == []
    # The cascade itself leaves the flags alone.
    assert _row(db, entry)["auto_post_enabled"] is True

    r = _undo(client, me, entry, token)

    assert r.json()["next_occurrence"].startswith("2026-09-10")
    assert _walk(db, entry, 12) == walk
    assert _missed(client, me, entry) == missed
    assert _overrides(db, budget_entry_id=entry) == overrides
    after = _row(db, entry)
    for field in ("next_occurrence", "anchor_day", "day_rule", "end_mode", "end_date",
                  "max_occurrences", "auto_post_enabled", "installment_reviewed_at",
                  "is_active"):
        assert after[field] == before[field], field
    assert after["updated_at"] is not None and after["updated_at"] != before["updated_at"]

    # Once applied it is spent: a second Undo is a 409 and writes nothing.
    check = _unchanged(db, entry)
    _undo(client, me, entry, token, expect=409)
    check()


@pytest.mark.parametrize("cadence", ["weekly", "biweekly"])
def test_cascade_undo_restores_a_fixed_day_schedule(world, cadence):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-11-02", cadence=cadence, end_mode="on_date",
                   end_date="2026-12-31T00:00:00")
    before, walk = _row(db, entry), _all(db, entry)

    token = _cascade(client, me, entry, "2026-11-02", "2026-11-12").json()["cascade"]["undo_token"]
    _undo(client, me, entry, token)

    assert _all(db, entry) == walk
    after = _row(db, entry)
    assert (after["next_occurrence"], after["end_date"]) == (
        before["next_occurrence"], before["end_date"])


def test_cascade_undo_refusals(world):
    """A changed entry, a tampered token or another entry's token: nothing is written."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    other = _entry(client, me, bank, "2026-09-10", name="Other")
    token = _cascade(client, me, entry, "2026-09-10", "2026-11-12").json()["cascade"]["undo_token"]
    _cascade(client, me, other, "2026-09-10", "2026-11-12")

    check = _unchanged(db, other)
    _undo(client, me, other, token, expect=422)
    check()
    body, _, sig = token.partition(".")
    check = _unchanged(db, entry)
    _undo(client, me, entry, f"{body}.{'0' * len(sig)}", expect=422)
    _undo(client, me, entry, "not-a-token", expect=422)
    check()

    # A forced date set after the cascade: Undo would drop it, so it is refused.
    _force(client, me, entry, "2026-12-12", "2026-12-14")
    check = _unchanged(db, entry)
    _undo(client, me, entry, token, expect=409)
    check()

    # A payment recorded after the cascade.
    paid = _entry(client, me, bank, "2026-09-10", name="Paid")
    token = _cascade(client, me, paid, "2026-09-10", "2026-11-12").json()["cascade"]["undo_token"]
    r = client.post(f"{API}/budget-entries/{paid}/materialize", json={}, headers=me["headers"])
    assert r.status_code in (200, 201), r.text
    check = _unchanged(db, paid)
    _undo(client, me, paid, token, expect=409)
    check()


# --- AC 8: access and a stale day --------------------------------------------------------------

def test_cascade_access_and_stale_day(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    viewer, stranger = world["people"](), world["people"]()
    sw_share(db, bank, viewer["id"], "viewer", me["id"])
    assert _get(client, viewer, f"/budget-entries/{entry}")["id"] == entry

    check = _unchanged(db, entry)
    for who in (viewer, stranger):
        r = _cascade(client, who, entry, "2026-09-10", "2026-11-12", expect=404)
        assert r.json()["detail"] == "Budget entry not found"
    check()

    token = _cascade(client, me, entry, "2026-09-10", "2026-11-12").json()["cascade"]["undo_token"]
    check = _unchanged(db, entry)
    # Repeating it: Sep 10 is no longer the oldest unrecorded payment.
    r = _cascade(client, me, entry, "2026-09-10", "2026-11-12", expect=422)
    assert r.json()["detail"] == (
        "Only the oldest unpaid payment (Nov 12) can delay the ones after it")
    for who in (viewer, stranger):
        _undo(client, who, entry, token, expect=404)
    check()

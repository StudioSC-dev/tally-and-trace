"""The choices for a refused date: ``GET .../occurrences/{day}/date-options`` (STU-581 PR 3).

Read-only. For the date the user asked for it says whether the occurrence can
join the next payment (``overlap``) or delay itself and every later one
(``cascade``), what each would do, and, when it cannot, the exact text the PUT
refuses with. Skips without a database.

Reference: Tuesday 2026-11-10, 02:00 UTC (10:00 in Manila). A monthly "Rent" on
the 10th has Sep 10 and Oct 10 missed. "Card" closes on the 24th, due 21 days
later: the statements of Sep 24 and Oct 24 are closed.
"""
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_card_forced_dates_integration import (
    NOV, _card, _closes, _installment, _subscription,
)
from app.tests.test_forced_date_cascade_integration import (
    _cascade, _link, _row, _txn_count, _unchanged, _walk,
)
from app.tests.test_forced_date_overlap_integration import _overlap
from app.tests.test_payment_date_overrides_integration import (
    _checking, _entry, _force, _get, _listed, _overrides,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 10, 2, 0)
TODAY = date(2026, 11, 10)


# --- helpers ----------------------------------------------------------------------------------

def _options(client, who, entry, day, to, expect=200):
    r = client.get(f"{API}/budget-entries/{entry}/occurrences/{day}/date-options",
                   params={"effective_date": to}, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _put(client, who, entry, day, to, mode):
    return client.put(f"{API}/budget-entries/{entry}/occurrences/{day}/date",
                      json={"effective_date": to, "mode": mode}, headers=who["headers"])


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    return {"client": sw_client, "db": sw_db, "me": me, "bank": _checking(sw_client, me),
            "people": sw_people, "monkeypatch": monkeypatch}


# --- AC 1: the chosen date is the next payment's day -------------------------------------------

def test_options_on_next_day(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")

    body = _options(client, me, entry, "2026-10-10", "2026-11-10")

    overlap = body["overlap"]
    assert (overlap["available"], overlap["reason"], overlap["date"]) == (
        True, None, "2026-11-10")
    assert [(p["occurrence_date"], p["effective_date"], float(p["amount"]))
            for p in overlap["payments"]] == [("2026-10-10", "2026-11-10", 20_000),
                                              ("2026-11-10", "2026-11-10", 20_000)]
    assert (float(overlap["total"]), overlap["currency"], overlap["statement_close"]) == (
        40_000, "PHP", None)
    cascade = body["cascade"]
    assert (cascade["available"], cascade["reason"], cascade["rule"], cascade["remaining"]) == (
        True, None, "day_of_month", None)
    assert cascade["moves"] == [
        {"occurrence_date": "2026-10-10", "from": "2026-10-10", "to": "2026-11-10",
         "statement_close": None},
        {"occurrence_date": "2026-11-10", "from": "2026-11-10", "to": "2026-12-10",
         "statement_close": None},
        {"occurrence_date": "2026-12-10", "from": "2026-12-10", "to": "2027-01-10",
         "statement_close": None}]


# --- AC 2: the chosen date is past the next payment --------------------------------------------

def test_options_past_next(world):
    client, me, bank = world["client"], world["me"], world["bank"]

    # Sep 10's next payment is Oct 10, 30 days on: Oct 20 is past it, so overlap offers Oct 10.
    rent = _entry(client, me, bank, "2026-09-10")
    body = _options(client, me, rent, "2026-09-10", "2026-10-20")
    assert (body["overlap"]["available"], body["overlap"]["date"]) == (True, "2026-10-10")
    assert [p["occurrence_date"] for p in body["overlap"]["payments"]] == [
        "2026-09-10", "2026-10-10"]
    assert body["cascade"]["available"] is True
    assert [m["to"] for m in body["cascade"]["moves"]] == ["2026-10-20", "2026-11-20", "2026-12-20"]

    # The next quarterly payment is 91 days on: the reach reason, and Delay all still offered.
    dues = _entry(client, me, bank, "2026-09-10", cadence="quarterly", name="Dues")
    body = _options(client, me, dues, "2026-09-10", "2026-12-20")
    assert body["overlap"]["available"] is False
    assert body["overlap"]["reason"] == "A forced date must stay within 31 days of the scheduled date"
    assert (body["overlap"]["date"], body["overlap"]["payments"], body["overlap"]["total"]) == (
        "2026-12-10", [], None)
    assert body["cascade"]["available"] is True
    assert [m["to"] for m in body["cascade"]["moves"]] == ["2026-12-20", "2027-03-20", "2027-06-20"]


# --- AC 3: a refusal is the PUT's text ---------------------------------------------------------

def _cases(world):
    """``(label, entry, day, chosen)``: every refusal of the overlap and cascade PUTs."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    card = _card(client, me, bank)
    cases = []

    def add(label, entry, day, to):
        cases.append((label, entry, day, to))

    add("reach", _entry(client, me, bank, "2026-09-10", cadence="quarterly", name="Dues"),
        "2026-09-10", "2026-12-20")
    own = _entry(client, me, bank, "2026-09-10", name="Own")
    _link(client, me, bank, own, "2026-09-10", posted=False)
    add("own row", own, "2026-09-10", "2026-10-20")
    rent = _entry(client, me, bank, "2026-09-10")
    add("not the oldest", rent, "2026-10-10", "2026-11-12")
    add("not later", rent, "2026-09-10", "2026-09-10")
    add("earlier", rent, "2026-09-10", "2026-09-05")
    add("too far", rent, "2026-09-10", (TODAY + timedelta(days=731)).isoformat())
    add("not an occurrence", rent, "2026-09-11", "2026-11-12")
    forced = _entry(client, me, bank, "2026-09-10", name="Forced")
    _force(client, me, forced, "2026-10-10", "2026-10-12")
    add("later forced", forced, "2026-09-10", "2026-11-12")
    pending = _entry(client, me, bank, "2026-09-10", name="Pending")
    _link(client, me, bank, pending, "2026-10-10", posted=False)
    add("later row", pending, "2026-09-10", "2026-11-12")
    semi = _entry(client, me, bank, "2026-10-01", name="Semi", cadence="semi_monthly",
                  semi_monthly_day_1=1, semi_monthly_day_2=15)
    add("semi-monthly", semi, "2026-10-01", "2026-10-03")
    last = _entry(client, me, bank, "2026-10-30", name="Payroll", day_rule="last_weekday")
    add("last weekday", last, "2026-10-30", "2026-11-03")
    capped = _entry(client, me, bank, "2026-10-10", name="Capped", end_mode="after_occurrences",
                    max_occurrences=2)
    add("last of a cap", capped, "2026-11-10", "2026-12-10")
    video = _subscription(client, me, card, "2026-08-20")
    add("closed statement", video, "2026-08-20", "2026-09-30")
    add("installment", _installment(client, me, card, "2026-11-24"), "2026-11-24", "2026-12-01")
    early = _entry(client, me, bank, "2000-01-05", name="Early")
    db.execute(text(
        "UPDATE budget_entries SET next_occurrence = '1999-12-01' WHERE id = :id"), {"id": early})
    db.commit()
    add("record dates", early, "1999-12-01", "1999-12-20")
    return cases


def test_options_reasons_match_put(world):
    """Every unavailable choice carries the text its PUT refuses with; at least one of each."""
    client, me, db = world["client"], world["me"], world["db"]
    refusals = {"overlap": 0, "cascade": 0}
    for label, entry, day, to in _cases(world):
        check = _unchanged(db, entry)
        if label == "not an occurrence":
            r = client.get(f"{API}/budget-entries/{entry}/occurrences/{day}/date-options",
                           params={"effective_date": to}, headers=me["headers"])
            put = _put(client, me, entry, day, to, "cascade")
            assert (r.status_code, r.json()["detail"]) == (put.status_code, put.json()["detail"]) \
                == (422, "Not an occurrence of this schedule")
            continue
        body = _options(client, me, entry, day, to)
        for mode in ("overlap", "cascade"):
            choice = body[mode]
            if choice["available"]:
                assert choice["reason"] is None, label
                continue
            refusals[mode] += 1
            put = _put(client, me, entry, day, choice["date"] if mode == "overlap" else to, mode)
            assert put.status_code in (409, 422), (label, mode, put.text)
            assert choice["reason"] == put.json()["detail"], (label, mode)
            assert choice["moves"] == [] if mode == "cascade" else choice["payments"] == []
        check()
    assert refusals["cascade"] >= 12 and refusals["overlap"] >= 4, refusals


def test_options_reason_texts(world):
    """The literal texts, so a changed constant is noticed."""
    client, me, bank = world["client"], world["me"], world["bank"]
    rent = _entry(client, me, bank, "2026-09-10")
    assert _options(client, me, rent, "2026-10-10", "2026-11-12")["cascade"]["reason"] == (
        "Only the oldest unpaid payment (Sep 10) can delay the ones after it")
    assert _options(client, me, rent, "2026-09-10", "2026-09-10")["cascade"]["reason"] == (
        "A delay moves payments later")
    pending = _entry(client, me, bank, "2026-09-10", name="Pending")
    _link(client, me, bank, pending, "2026-10-10", posted=False)
    assert _options(client, me, pending, "2026-09-10", "2026-11-12")["cascade"]["reason"] == (
        "Oct 10 is already recorded")
    forced = _entry(client, me, bank, "2026-09-10", name="Forced")
    _force(client, me, forced, "2026-10-10", "2026-10-12")
    assert _options(client, me, forced, "2026-09-10", "2026-11-12")["cascade"]["reason"] == (
        "Oct 10 has its own date; clear it first")
    semi = _entry(client, me, bank, "2026-10-01", name="Semi", cadence="semi_monthly",
                  semi_monthly_day_1=1, semi_monthly_day_2=15)
    assert "twice-a-month" in _options(client, me, semi, "2026-10-01", "2026-10-03")["cascade"]["reason"]


# --- AC 4: a preview is the outcome ------------------------------------------------------------

def test_options_match_outcome(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    pin_clock(world["monkeypatch"], datetime(2026, 10, 18, 2, 0))

    # Overlap: the previewed payments are what the upcoming list shows on that day.
    joined = _entry(client, me, bank, "2026-10-10")
    preview = _options(client, me, joined, "2026-10-10", "2026-11-10")["overlap"]
    _overlap(client, me, joined, "2026-10-10", preview["date"])
    on_day = [(o, e) for o, e in _listed(client, me, joined) if e == preview["date"]]
    assert on_day == [(p["occurrence_date"], p["effective_date"]) for p in preview["payments"]]
    assert _overrides(db, budget_entry_id=joined) == [("2026-10-10", "2026-11-10")]

    # Cascade: the previewed days are the schedule's walk and the list's, with the reply's rule
    # and remaining, for a month schedule, a bounded one and a weekly one.
    for kwargs, first, to in [
            ({}, "2026-09-10", "2026-11-12"),
            ({"end_mode": "on_date", "end_date": "2027-02-10T00:00:00"}, "2026-09-10", "2026-11-12"),
            ({"end_mode": "after_occurrences", "max_occurrences": 5}, "2026-09-10", "2026-11-12"),
            ({"cadence": "weekly"}, "2026-10-04", "2026-10-20")]:
        entry = _entry(client, me, bank, first, name=f"E{len(first)}{to}", **kwargs)
        preview = _options(client, me, entry, first, to)["cascade"]
        assert preview["available"], preview
        reply = _cascade(client, me, entry, first, to).json()["cascade"]
        assert (preview["rule"], preview["remaining"]) == (reply["rule"], reply["remaining"])
        days = [m["to"] for m in preview["moves"]]
        assert days == _walk(db, entry, 3)[:len(days)]
        assert len(days) == min(3, preview["remaining"] or 3)
        listed = [e for _, e in _listed(client, me, entry)][:len(days)]
        assert listed == days
        assert [o for o, _ in _listed(client, me, entry)][:len(days)] == days


# --- AC 5: a card's statements -----------------------------------------------------------------

def test_options_card_statements(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank)

    # Overlap: Oct 20 joins Nov 20, billed on the statement closing Nov 24.
    pin_clock(world["monkeypatch"], datetime(2026, 10, 18, 2, 0))
    joined = _subscription(client, me, card, "2026-10-20")
    overlap = _options(client, me, joined, "2026-10-20", "2026-11-20")["overlap"]
    assert (overlap["available"], overlap["statement_close"]) == (True, NOV)
    put = _overlap(client, me, joined, "2026-10-20", overlap["date"]).json()
    assert put["statement_close"] == overlap["statement_close"]

    # Cascade: each move names the statement that holds its new date (past the 24th: next month's).
    pin_clock(world["monkeypatch"], REF)
    moved = _subscription(client, me, card, "2026-11-20")
    cascade = _options(client, me, moved, "2026-11-20", "2026-11-26")["cascade"]
    assert [(m["to"], m["statement_close"]) for m in cascade["moves"]] == [
        ("2026-11-26", "2026-12-24"), ("2026-12-26", "2027-01-24"), ("2027-01-26", "2027-02-24")]
    put = _cascade(client, me, moved, "2026-11-20", "2026-11-26").json()
    assert put["statement_close"] == cascade["moves"][0]["statement_close"]
    assert {m["statement_close"] for m in cascade["moves"]} <= set(_closes(client, me, card, 180))


# --- AC 6: read-only, and who may ask ----------------------------------------------------------

def test_options_read_only_and_access(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-09-10")
    _force(client, me, entry, "2026-10-10", "2026-10-12")
    viewer, stranger = world["people"](), world["people"]()
    sw_share(db, bank, viewer["id"], "viewer", me["id"])
    assert _get(client, viewer, f"/budget-entries/{entry}")["id"] == entry

    check = _unchanged(db, entry)
    before = _row(db, entry)["updated_at"]
    for day, to in [("2026-09-10", "2026-11-12"), ("2026-09-10", "2026-10-10"),
                    ("2026-10-10", "2026-11-12")]:
        _options(client, me, entry, day, to)
    check()
    assert _row(db, entry)["updated_at"] == before
    assert _overrides(db, budget_entry_id=entry) == [("2026-10-10", "2026-10-12")]
    assert _txn_count(db, entry) == 0

    for who in (viewer, stranger):
        body = _options(client, who, entry, "2026-09-10", "2026-11-12", expect=404)
        assert body["detail"] == "Budget entry not found"
    check()

    # An entry with no account is a 400, as for the PUT.
    db.execute(text("UPDATE budget_entries SET account_id = NULL WHERE id = :id"), {"id": entry})
    db.commit()
    assert _options(client, me, entry, "2026-09-10", "2026-11-12", expect=400)["detail"]

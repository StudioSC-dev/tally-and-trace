"""Weekly and every-two-weeks schedules through every reader of cadence (STU-584 PR 5).

A proof suite: nothing in the backend changes for these cadences, so each case is
a regression gate. Every case that applies to both cadences runs for ``weekly``
(step 7) and ``biweekly`` (step 14). The cascade file already covers the cascade
on a fixed-day schedule; ``test_biweekly_cascade`` adds the Monday-to-Wednesday
walk with an end date. Skips without a database.

Reference: Tuesday 2026-11-10, 02:00 UTC (10:00 in Manila). "Card" closes on the
24th, due 21 days later.
"""
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_card_forced_dates_integration import _card, _closes
from app.tests.test_forced_date_cascade_integration import _all, _cascade, _row, _undo
from app.tests.test_payment_date_overrides_integration import (
    _checking, _entry, _get, _missed, _overrides, _snapshot,
)
from app.tests.test_settlement_autopay_integration import _job, _rows, _turn_on

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 10, 2, 0)
TODAY = date(2026, 11, 10)
TOKEN = "test-job-token"
CADENCES = pytest.mark.parametrize("cadence,step", [("weekly", 7), ("biweekly", 14)])


# --- helpers ----------------------------------------------------------------------------------

def _day(offset: int) -> str:
    return (TODAY + timedelta(days=offset)).isoformat()


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    pin_clock(monkeypatch, REF)
    me = sw_people()
    return {"client": sw_client, "db": sw_db, "me": me, "bank": _checking(sw_client, me),
            "monkeypatch": monkeypatch}


def _create(client, who, account, cadence, first=None, expect=(200, 201), **extra):
    r = client.post(f"{API}/budget-entries/", headers=who["headers"], json={
        "name": "Gym", "entry_type": "expense", "amount": 100, "cadence": cadence,
        "next_occurrence": f"{first or _day(0)}T00:00:00", "account_id": account, **extra})
    assert r.status_code in expect, r.text
    return r


def _event_days(client, who, entry, days=365):
    body = _get(client, who, f"/forecast/timeline?days={days}")
    return [e["date"][:10] for e in body["events"]
            if e["source"] == "budget_entry" and e["source_id"] == entry]


# --- AC 1: create ------------------------------------------------------------------------------

@CADENCES
def test_weekly_create_and_day_fields(world, cadence, step):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]

    # An anchor day belongs to the month family; a weekly schedule refuses it.
    for extra in ({"anchor_day": 10}, {"anchor_day": 10, "day_rule": None}):
        r = _create(client, me, bank, cadence, expect=(422,), **extra)
        assert "anchor_day" in r.text or "day" in r.text
    assert _create(client, me, bank, cadence, expect=(422,), day_rule="last_weekday")

    body = _create(client, me, bank, cadence).json()

    assert body["cadence"] == cadence
    assert (body["anchor_day"], body["day_rule"]) == (None, None)
    row = _row(db, body["id"])
    assert (row["anchor_day"], row["day_rule"]) == (None, None)
    # None of the refusals stored a row.
    db.rollback()
    assert db.execute(text("SELECT count(*) FROM budget_entries WHERE user_id = :u"),
                      {"u": me["id"]}).scalar() == 1


# --- AC 2: forecast and monthly figures ---------------------------------------------------------

@pytest.mark.parametrize("cadence,events,monthly", [("weekly", 52, 433.33),
                                                    ("biweekly", 26, 216.67)])
def test_weekly_forecast(world, cadence, events, monthly):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _create(client, me, bank, cadence, first=_day(1)).json()["id"]

    days = _event_days(client, me, entry, days=364)

    # 364 days from tomorrow: the first day plus 51 (or 25) steps.
    assert len(days) == events
    step = 7 if cadence == "weekly" else 14
    parsed = [date.fromisoformat(d) for d in days]
    assert parsed[0] == TODAY + timedelta(days=1)
    assert [(b - a).days for a, b in zip(parsed, parsed[1:])] == [step] * (events - 1)
    assert _snapshot(client, me)["monthly_summary"]["monthly_expenses"] == pytest.approx(
        monthly, abs=0.005)
    assert _get(client, me, "/forecast/disposable")["monthly_expenses"] == pytest.approx(
        monthly, abs=0.005)


# --- AC 3: missed and Mark paid -----------------------------------------------------------------

@CADENCES
def test_weekly_missed_and_mark_paid(world, cadence, step):
    client, me, bank = world["client"], world["me"], world["bank"]
    oldest = TODAY - timedelta(days=3 * step)
    days = [oldest + timedelta(days=i * step) for i in range(3)]
    entry = _entry(client, me, bank, oldest.isoformat(), cadence=cadence)

    (missed,) = _missed(client, me, entry)
    assert (missed["count"], missed["oldest"]) == (3, days[0].isoformat())

    # Mark paid on the newest: the two before it are skipped, not recorded.
    r = client.post(f"{API}/budget-entries/{entry}/materialize",
                    json={"occurrence_date": days[-1].isoformat()}, headers=me["headers"])
    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrences-Skipped-Count"] == "2"
    assert r.headers["X-Occurrences-Skipped"] == ",".join(d.isoformat() for d in days[:2])
    assert r.json()["transaction_date"].startswith(days[-1].isoformat())
    # Nothing is left to miss: the skipped days move on with the schedule.
    assert _missed(client, me, entry) == []


# --- AC 4: autopay and Post N due ---------------------------------------------------------------

@pytest.mark.parametrize("how", ["job", "post_n_due"])
@CADENCES
def test_weekly_post_due(world, cadence, step, how):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    if how == "job":
        # Turned on while nothing is due (turning on catches up), then the clock reaches
        # the third day: the job posts each of the three on its own date.
        first = TODAY + timedelta(days=1)
        today = first + timedelta(days=2 * step)
    else:
        first = TODAY - timedelta(days=2 * step)
        today = TODAY
    due = [first + timedelta(days=i * step) for i in range(3)]  # the third is today
    entry = _entry(client, me, bank, first.isoformat(), cadence=cadence, amount=100)
    before = db.execute(text("SELECT balance FROM accounts WHERE id = :a"), {"a": bank}).scalar()

    if how == "job":
        _turn_on(world | {"o": me, "checking": bank}, entry, expected_due=0)
        assert _rows(db, entry) == []
        pin_clock(world["monkeypatch"], datetime.combine(today, datetime.min.time()).replace(hour=2))
        assert _job(client)["posted"] >= 3
    else:
        r = client.post(f"{API}/budget-entries/{entry}/materialize-due", headers=me["headers"])
        assert r.status_code == 200, r.text

    assert _rows(db, entry) == [(d, d, 100.0, True) for d in due]
    db.rollback()
    assert db.execute(text("SELECT balance FROM accounts WHERE id = :a"),
                      {"a": bank}).scalar() == before - 300
    assert db.execute(text("SELECT next_occurrence FROM budget_entries WHERE id = :e"),
                      {"e": entry}).scalar().date() == today + timedelta(days=step)
    # Running again finds nothing due.
    if how == "job":
        assert _job(client)["posted"] == 0
        assert len(_rows(db, entry)) == 3


# --- AC 5: forced dates -------------------------------------------------------------------------

@pytest.mark.parametrize("cadence,step", [("weekly", 7), ("biweekly", 14)])
def test_weekly_forced_dates(world, cadence, step):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, _day(0), cadence=cadence)
    nominal = _day(0)

    def put(to, expect, **body):
        r = client.put(f"{API}/budget-entries/{entry}/occurrences/{nominal}/date",
                       json={"effective_date": to, **body}, headers=me["headers"])
        assert r.status_code == expect, r.text
        return r

    # One day short of the next payment: allowed.
    put(_day(step - 1), 200)
    assert _overrides(db, budget_entry_id=entry) == [(nominal, _day(step - 1))]
    # The next payment's own day: refused strict (also with an explicit null mode),
    # allowed with overlap.
    assert "between" in put(_day(step), 422).json()["detail"]
    put(_day(step), 422, mode=None)
    assert _overrides(db, budget_entry_id=entry) == [(nominal, _day(step - 1))]
    put(_day(step), 200, mode="overlap")
    assert _overrides(db, budget_entry_id=entry) == [(nominal, _day(step))]
    # Past the next payment's day: refused either way.
    put(_day(step + 1), 422, mode="overlap")
    assert _overrides(db, budget_entry_id=entry) == [(nominal, _day(step))]


# --- AC 6: bi-weekly cascade --------------------------------------------------------------------

def test_biweekly_cascade(world):
    """Monday Nov 2 (missed) to Wednesday Nov 11: Wednesdays 14 days apart, same count, Undo."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-11-02", cadence="biweekly", end_mode="on_date",
                   end_date="2027-01-15T00:00:00")
    assert date(2026, 11, 2).weekday() == 0
    walk = _all(db, entry)
    assert (len(walk), walk[0], walk[-1]) == (6, "2026-11-02", "2027-01-11")
    before = _row(db, entry)

    r = _cascade(client, me, entry, "2026-11-02", "2026-11-11")

    assert (r.json()["cascade"]["rule"], r.json()["cascade"]["remaining"]) == ("days", 6)
    moved = _all(db, entry)
    assert moved == ["2026-11-11", "2026-11-25", "2026-12-09", "2026-12-23", "2027-01-06",
                     "2027-01-20"]
    days = [date.fromisoformat(d) for d in moved]
    assert {d.weekday() for d in days} == {2}
    assert [(b - a).days for a, b in zip(days, days[1:])] == [14] * 5
    row = _row(db, entry)
    assert (row["anchor_day"], row["day_rule"]) == (None, None)
    assert row["end_date"].date() == date(2027, 1, 20)
    assert _missed(client, me, entry) == []

    _undo(client, me, entry, r.json()["cascade"]["undo_token"])

    assert _all(db, entry) == walk
    after = _row(db, entry)
    assert (after["next_occurrence"], after["end_date"]) == (
        before["next_occurrence"], before["end_date"])
    assert _missed(client, me, entry)[0]["count"] == 1


# --- AC 7: card ---------------------------------------------------------------------------------

@pytest.mark.parametrize("cadence,per_cycle", [("weekly", (5, 4)), ("biweekly", (3, 2))])
def test_weekly_card(world, cadence, per_cycle):
    """From Wed Nov 25: the Dec 24 statement holds 5 (3) charges, the Jan 24 one 4 (2)."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank)

    sub = _create(client, me, card, cadence, first="2026-11-25", billing_kind="subscription")
    assert sub.json()["kind"] == "subscription"

    closes = _closes(client, me, card, days=120)
    assert closes["2026-12-24"] == 100 * per_cycle[0]
    assert closes["2027-01-24"] == 100 * per_cycle[1]
    # A charge is billed once, on the statement holding its date.
    assert sum(a for close, a in closes.items() if close <= "2027-01-24") == 100 * sum(per_cycle)

    # A capped weekly card installment is refused; a capped weekly bill is accepted.
    for extra in ({"end_mode": "after_occurrences", "max_occurrences": 6},
                  {"end_mode": "after_occurrences", "max_occurrences": 6,
                   "billing_kind": "subscription"}):
        r = _create(client, me, card, cadence, first="2026-11-25", expect=(422,), **extra)
        assert r.json()["detail"] == "A card installment is charged monthly on the statement close"
    bill = _create(client, me, card, cadence, first="2026-11-25", billing_kind="bill",
                   end_mode="after_occurrences", max_occurrences=6)
    assert (bill.json()["kind"], bill.json()["cadence"]) == ("bill", cadence)


# --- AC 8: final payment on edit ---------------------------------------------------------------

@CADENCES
def test_weekly_final_payment(world, cadence, step):
    """A capped schedule moved forward keeps its last payment day and recounts to it."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, _day(0), cadence=cadence, end_mode="after_occurrences",
                   max_occurrences=6)
    walk = _all(db, entry)
    final = TODAY + timedelta(days=5 * step)
    assert (len(walk), walk[-1]) == (6, final.isoformat())

    def edit(**body):
        r = client.put(f"{API}/budget-entries/{entry}", json=body, headers=me["headers"])
        assert r.status_code == 200, r.text
        return r.json()

    # One step forward: five payments left, the same last one.
    body = edit(next_occurrence=f"{_day(step)}T00:00:00")
    assert (body["max_occurrences"], body["occurrences_paid_offset"]) == (5, 1)
    assert _all(db, entry) == walk[1:]

    # Off the step: the schedule restarts from the new date and stops on or before the
    # old final day, so the last payment never moves later.
    body = edit(next_occurrence=f"{_day(step + 1)}T00:00:00")
    redone = _all(db, entry)
    assert redone[0] == _day(step + 1)
    assert date.fromisoformat(redone[-1]) <= final
    assert date.fromisoformat(redone[-1]) + timedelta(days=step) > final
    assert body["max_occurrences"] == len(redone)

    # Past the last payment: refused, nothing written.
    r = client.put(f"{API}/budget-entries/{entry}", headers=me["headers"],
                   json={"next_occurrence": f"{(final + timedelta(days=1)).isoformat()}T00:00:00"})
    assert r.status_code == 422, r.text
    assert "after the plan's last payment" in r.json()["detail"]
    assert _all(db, entry) == redone


# --- AC 9: export -------------------------------------------------------------------------------

def test_weekly_export(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    ids = {c: _create(client, me, bank, c).json()["id"] for c in ("weekly", "biweekly")}

    body = client.get(f"{API}/data/export.json", headers=me["headers"])
    assert body.status_code == 200, body.text
    cadences = {row["id"]: row["cadence"] for row in body.json()["budget_entries"]}
    assert {cadences[i] for i in ids.values()} == {"weekly", "biweekly"}
    assert (cadences[ids["weekly"]], cadences[ids["biweekly"]]) == ("weekly", "biweekly")

    csv = client.get(f"{API}/data/export.csv", params={"table": "budget_entries"},
                     headers=me["headers"])
    assert csv.status_code == 200, csv.text
    lines = csv.text.splitlines()
    header = lines[0].split(",")
    assert "cadence" in header
    col = header.index("cadence")
    rows = {r.split(",")[0]: r for r in lines[1:]}
    assert rows[str(ids["weekly"])].split(",")[col] == "weekly"
    assert rows[str(ids["biweekly"])].split(",")[col] == "biweekly"

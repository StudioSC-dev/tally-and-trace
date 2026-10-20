"""Paused and ended recurring entries (STU-384, Ruling 5).

An inactive entry is ended when its cap is used up or its end date is before
Manila's today, and paused otherwise. Mark paid and Post N due refuse both
(409 "This entry has ended" / "This entry is paused") and write nothing.
Resuming a paused entry skips its paused months: ``next_occurrence`` moves to
the schedule's first date on or after Manila's today when the request leaves it
as stored. An ended schedule cannot be resumed. Skips without a database.
"""
import os
import sys
from datetime import datetime

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
ENDED = "This entry has ended"
PAUSED = "This entry is paused"


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def me(sw_client, sw_people, monkeypatch):
    who = sw_people()
    checking = sw_post(sw_client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    pin_clock(monkeypatch, REF)
    return {"client": sw_client, "who": who, "checking": checking}


def _entry(me, next_occ, name="Rent", account_id=None, **extra):
    if "T" not in next_occ:
        next_occ = f"{next_occ}T00:00:00"
    return sw_post(me["client"], me["who"], "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": 1_000, "cadence": "monthly",
        "next_occurrence": next_occ, "account_id": account_id or me["checking"],
        **extra})["id"]


def _put(me, entry_id, body):
    return me["client"].put(f"{API}/budget-entries/{entry_id}", json=body,
                            headers=me["who"]["headers"])


def _get(me, entry_id) -> dict:
    r = me["client"].get(f"{API}/budget-entries/{entry_id}", headers=me["who"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _next(me, entry_id) -> str:
    return _get(me, entry_id)["next_occurrence"][:19]


def _materialize(me, entry_id, body=None):
    return me["client"].post(f"{API}/budget-entries/{entry_id}/materialize", json=body or {},
                             headers=me["who"]["headers"])


def _due(me, entry_id):
    return me["client"].post(f"{API}/budget-entries/{entry_id}/materialize-due",
                             headers=me["who"]["headers"])


def _linked(engine, entry_id) -> int:
    with engine.connect() as c:
        return c.execute(text("SELECT count(*) FROM transactions WHERE budget_entry_id = :e"),
                         {"e": entry_id}).scalar()


def _refused(r, detail):
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == detail


# --- Posting refused while paused or ended ---------------------------------------------------

def test_a_paused_entry_refuses_mark_paid_and_post_due(me, engine):
    rent = _entry(me, "2026-09-05", is_active=False)
    installment = _entry(me, "2026-09-05", "Laptop", end_mode="after_occurrences",
                         max_occurrences=3, is_active=False)
    before = {e: _get(me, e) for e in (rent, installment)}

    for entry in (rent, installment):
        _refused(_materialize(me, entry), PAUSED)
        _refused(_due(me, entry), PAUSED)
        assert _linked(engine, entry) == 0
        assert _get(me, entry) == before[entry]


def test_an_ended_entry_refuses_mark_paid_and_post_due(me, engine):
    finished = _entry(me, "2026-09-05", "Laptop", end_mode="after_occurrences",
                      max_occurrences=0, is_active=False)
    past_end = _entry(me, "2026-09-05", end_mode="on_date",
                      end_date="2026-10-01T00:00:00", is_active=False)
    before = {e: _get(me, e) for e in (finished, past_end)}

    for entry in (finished, past_end):
        _refused(_materialize(me, entry), ENDED)
        _refused(_due(me, entry), ENDED)
        assert _linked(engine, entry) == 0
        assert _get(me, entry) == before[entry]


def test_an_active_entry_past_its_end_date_still_records_what_is_left(me, engine):
    entry = _entry(me, "2026-09-20", end_mode="on_date", end_date="2026-09-30T00:00:00")

    r = _materialize(me, entry)

    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrence-Recorded"] == "2026-09-20"
    assert _linked(engine, entry) == 1


# --- Resume -----------------------------------------------------------------------------------

def test_resume_skips_paused_months_when_the_date_is_left_as_stored(me):
    sent_back = _entry(me, "2026-08-05", is_active=False)
    omitted = _entry(me, "2026-08-05", is_active=False)
    explicit = _entry(me, "2026-08-05", is_active=False)

    # The form sends the stored date back unchanged.
    r = _put(me, sent_back, {"is_active": True, "next_occurrence": "2026-08-05T00:00:00"})
    assert r.status_code == 200, r.text
    assert r.json()["next_occurrence"][:19] == "2026-11-05T00:00:00"
    assert r.json()["is_active"] is True

    assert _put(me, omitted, {"is_active": True}).status_code == 200
    assert _next(me, omitted) == "2026-11-05T00:00:00"

    # A different date is used as sent.
    assert _put(me, explicit, {"is_active": True,
                               "next_occurrence": "2026-09-05T00:00:00"}).status_code == 200
    assert _next(me, explicit) == "2026-09-05T00:00:00"


def test_resume_leaves_a_current_date_and_other_updates_leave_the_date(me):
    upcoming = _entry(me, "2026-10-25", is_active=False)
    today = _entry(me, "2026-10-18", "Today", is_active=False)
    stale_active = _entry(me, "2026-08-05", "Stale")
    to_pause = _entry(me, "2026-08-05", "Pausing")

    assert _put(me, upcoming, {"is_active": True}).status_code == 200
    assert _next(me, upcoming) == "2026-10-25T00:00:00"
    assert _put(me, today, {"is_active": True}).status_code == 200
    assert _next(me, today) == "2026-10-18T00:00:00"

    assert _put(me, stale_active, {"name": "Stale rent"}).status_code == 200
    assert _next(me, stale_active) == "2026-08-05T00:00:00"
    assert _put(me, stale_active, {"is_active": True}).status_code == 200
    assert _next(me, stale_active) == "2026-08-05T00:00:00"

    r = _put(me, to_pause, {"is_active": False})
    assert r.status_code == 200, r.text
    assert r.json()["is_active"] is False
    assert _next(me, to_pause) == "2026-08-05T00:00:00"


def test_resume_walks_semi_monthly_days(me, monkeypatch):
    pin_clock(monkeypatch, datetime(2026, 10, 10, 2, 0))  # 10:00 on the 10th in Manila
    entry = _entry(me, "2026-08-01", cadence="semi_monthly", semi_monthly_day_1=1,
                   semi_monthly_day_2=15, is_active=False)

    assert _put(me, entry, {"is_active": True}).status_code == 200
    assert _next(me, entry) == "2026-10-15T00:00:00"


def test_resume_compares_on_the_manila_day(me, monkeypatch):
    # 16:30 UTC on the 17th is 00:30 on the 18th in Manila.
    pin_clock(monkeypatch, datetime(2026, 10, 17, 16, 30))
    yesterday = _entry(me, "2026-10-17T23:00:00", "Yesterday", is_active=False)
    today = _entry(me, "2026-10-18T00:00:00", "Today", is_active=False)
    assert _next(me, yesterday) == "2026-10-17T23:00:00"

    assert _put(me, yesterday, {"is_active": True}).status_code == 200
    assert _put(me, today, {"is_active": True}).status_code == 200

    assert _next(me, yesterday) == "2026-11-17T23:00:00"
    assert _next(me, today) == "2026-10-18T00:00:00"


def test_resume_does_not_count_skipped_months_against_the_cap(me):
    entry = _entry(me, "2026-07-05", "Laptop", end_mode="after_occurrences",
                   max_occurrences=5, is_active=False)
    before = _get(me, entry)

    r = _put(me, entry, {"is_active": True})

    assert r.status_code == 200, r.text
    after = r.json()
    assert after["next_occurrence"][:19] == "2026-11-05T00:00:00"
    assert after["max_occurrences"] == 5
    assert after["occurrences_paid"] == before["occurrences_paid"]
    assert after["occurrences_paid_offset"] == before["occurrences_paid_offset"]


def test_an_ended_schedule_cannot_be_resumed(me):
    past_end = _entry(me, "2026-08-05", end_mode="on_date",
                      end_date="2026-10-01T00:00:00", is_active=False)
    finished = _entry(me, "2026-08-05", "Laptop", end_mode="after_occurrences",
                      max_occurrences=0, is_active=False)
    # Next scheduled date (10-25) is after the end date (10-20), which is still ahead.
    ran_out = _entry(me, "2026-09-25", "Ran out", end_mode="on_date",
                     end_date="2026-10-20T00:00:00", is_active=False)

    for entry in (past_end, finished, ran_out):
        before = _get(me, entry)
        _refused(_put(me, entry, {"is_active": True}), ENDED)
        _refused(_put(me, entry, {"is_active": True,
                                  "next_occurrence": before["next_occurrence"]}), ENDED)
        assert _get(me, entry) == before


def test_resume_is_allowed_when_the_same_request_extends_the_schedule(me):
    finished = _entry(me, "2026-08-05", "Laptop", end_mode="after_occurrences",
                      max_occurrences=0, is_active=False)
    past_end = _entry(me, "2026-08-05", end_mode="on_date",
                      end_date="2026-10-01T00:00:00", is_active=False)

    r = _put(me, finished, {"is_active": True, "max_occurrences": 2})
    assert r.status_code == 200, r.text
    assert (r.json()["next_occurrence"][:19], r.json()["max_occurrences"]) == (
        "2026-11-05T00:00:00", 2)

    r = _put(me, past_end, {"is_active": True, "end_date": "2026-12-31T00:00:00"})
    assert r.status_code == 200, r.text
    assert r.json()["next_occurrence"][:19] == "2026-11-05T00:00:00"


def test_a_resumed_card_entry_shows_nothing_missed(me):
    client, who = me["client"], me["who"]
    card = sw_post(client, who, "/accounts/", {
        "name": "Card C", "account_type": "credit", "balance": 0, "billing_cycle_start": 24,
        "days_until_due_date": 21, "payment_account_id": me["checking"]})["id"]
    netflix = _entry(me, "2026-08-10", "Netflix", account_id=card, is_active=False)

    assert _put(me, netflix, {"is_active": True}).status_code == 200

    r = client.get(f"{API}/budget-entries/{netflix}/occurrences", headers=who["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["due_unposted"] == 0
    assert body["oldest_due"] is None
    assert all(o["occurrence_date"] >= "2026-10-18" for o in body["occurrences"])
    assert body["occurrences"][0]["occurrence_date"] == "2026-11-10"

    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    section = next(c for c in r.json()["card_charges"] if c["account_id"] == card)
    assert section["missed"] == []

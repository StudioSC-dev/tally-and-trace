"""The step cap on a whole-schedule walk (STU-427, AC6).

Pure, but for the last test (the API's answer). Both entry points, ``posting.schedule_walk`` and
``card_credit._stream``, walk through ``walk_limit.walk_capped``: at most
``WALK_STEP_LIMIT`` steps per entry per walk, and a walk the cap stops before
its end raises ``WalkLimitReached`` instead of returning what it walked.
"""
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.transaction import RecurrenceFrequency as F
from app.services import card_credit, forecast as fc, walk_limit
from app.services.posting import schedule_walk
from app.services.walk_limit import WALK_LIMIT_MESSAGE, WALK_STEP_LIMIT, WalkLimitReached
from app.tests.conftest import API, sw_db_reachable, sw_post

TODAY = date(2026, 10, 18)
END = datetime(2026, 10, 19)


def _entry(cadence, next_occurrence, **kw):
    defaults = dict(id=7, cadence=cadence, next_occurrence=next_occurrence,
                    end_mode="indefinite", end_date=None, max_occurrences=None,
                    semi_monthly_day_1=1, semi_monthly_day_2=15, anchor_day=None,
                    day_rule=None)
    defaults.update(kw)
    return SimpleNamespace(**defaults)


def _uncapped(entry, end):
    """The schedule as the walk saw it before the cap: one step per day of distance."""
    start = fc._naive(entry.next_occurrence)
    bound = max((end - start).days, 0) + 2
    return fc.capped_distinct_days(entry, start, end, max_steps=bound)


def _weeks_before_today(weeks: int) -> datetime:
    return datetime.combine(TODAY - timedelta(weeks=weeks), datetime.min.time())


WALKS = {
    "schedule_walk": lambda e: schedule_walk(e, TODAY),
    "_stream": lambda e: card_credit._stream(e, END, whole=False),
}


def test_walk_step_cap_configured_limit():
    """The documented limit: a finite, configured step count above any in-range walk."""
    assert WALK_STEP_LIMIT == 10_000
    weekly_from_2000_to_30_years_out = (date(2056, 10, 18) - date(2000, 1, 1)).days // 7 + 1
    assert weekly_from_2000_to_30_years_out < WALK_STEP_LIMIT


@pytest.mark.parametrize("walk", sorted(WALKS))
def test_walk_step_cap(walk, monkeypatch):
    """At the configured limit the walk stops and says so: never a partial schedule."""
    monkeypatch.setattr(walk_limit, "WALK_STEP_LIMIT", 50)
    weekly = _entry(F.WEEKLY, datetime(2025, 1, 5))  # about 93 weeks to TODAY
    semi = _entry(F.SEMI_MONTHLY, datetime(2020, 1, 1))  # about 82 months

    for entry in (weekly, semi):
        with pytest.raises(WalkLimitReached) as caught:
            WALKS[walk](entry)
        assert caught.value.limit == 50
        assert caught.value.entry_id == 7
        assert isinstance(caught.value, HTTPException)
        assert (caught.value.status_code, caught.value.detail) == (409, WALK_LIMIT_MESSAGE)


@pytest.mark.parametrize("walk", sorted(WALKS))
def test_walk_step_cap_returns_a_walk_complete_within_the_limit(walk, monkeypatch):
    """Past the bound but complete within the limit: returned, whole."""
    monkeypatch.setattr(walk_limit, "WALK_STEP_LIMIT", 50)
    capped = _entry(F.WEEKLY, datetime(2020, 1, 5), end_mode="after_occurrences",
                    max_occurrences=3)
    ended = _entry(F.WEEKLY, datetime(2020, 1, 5), end_mode="on_date",
                   end_date=datetime(2020, 6, 1))  # 22 weeks
    exactly = _entry(F.WEEKLY, _weeks_before_today(49))  # 50 occurrences, the 50th today

    assert [d.date() for d in WALKS[walk](capped)] == [
        date(2020, 1, 5), date(2020, 1, 12), date(2020, 1, 19)]
    assert len(WALKS[walk](ended)) == 22
    assert len(WALKS[walk](exactly)) == 50


def test_walk_step_cap_installment_stream_walks_to_its_cap(monkeypatch):
    """``_stream``'s whole walk (a card installment) to ``datetime.max``: its cap ends it."""
    monkeypatch.setattr(walk_limit, "WALK_STEP_LIMIT", 50)
    plan = _entry(F.MONTHLY, datetime(1970, 1, 5), end_mode="after_occurrences",
                  max_occurrences=12, anchor_day=5)
    days = card_credit._stream(plan, END, whole=True)
    assert (len(days), days[-1].date()) == (12, date(1970, 12, 5))


STALE = [
    _entry(F.WEEKLY, datetime(1985, 1, 6)),
    _entry(F.SEMI_MONTHLY, datetime(1970, 1, 1)),
    _entry(F.MONTHLY, datetime(2000, 1, 31), anchor_day=31),
    _entry(F.BIWEEKLY, datetime(2026, 9, 1), end_mode="after_occurrences", max_occurrences=4),
    _entry(F.QUARTERLY, datetime(2001, 3, 1), end_mode="on_date", end_date=datetime(2020, 1, 1)),
    _entry(F.ANNUAL, datetime(9999, 11, 30)),
]


@pytest.mark.parametrize("entry", STALE, ids=lambda e: f"{e.cadence.value}-{e.next_occurrence:%Y}")
def test_walk_below_cap_unchanged(entry):
    """Below the cap both walks return exactly what they returned before it."""
    end = datetime.combine(TODAY + timedelta(days=1), datetime.min.time())
    assert schedule_walk(entry, TODAY) == _uncapped(entry, end)
    assert card_credit._stream(entry, END, whole=False) == _uncapped(entry, END)
    if entry.end_mode == "after_occurrences":
        start = fc._naive(entry.next_occurrence)
        bound = max(max((END - start).days, 0) + 2, entry.max_occurrences + 2)
        assert card_credit._stream(entry, END, whole=True) == fc.capped_distinct_days(
            entry, start, datetime.max, max_steps=bound)


@pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")
def test_walk_step_cap_reaches_the_request(sw_client, sw_people, monkeypatch):
    """Through the API: a walk past the limit is a 409 naming it, and nothing is recorded."""
    client, me = sw_client, sw_people()
    checking = sw_post(client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    start = date.today() - timedelta(weeks=60)
    weekly = sw_post(client, me, "/budget-entries/", {
        "name": "Laundry", "entry_type": "expense", "amount": 100, "cadence": "weekly",
        "next_occurrence": f"{start.isoformat()}T00:00:00", "account_id": checking})["id"]
    monkeypatch.setattr(walk_limit, "WALK_STEP_LIMIT", 20)

    r = client.post(f"{API}/budget-entries/{weekly}/materialize-due", headers=me["headers"])

    assert (r.status_code, r.json()["detail"]) == (409, WALK_LIMIT_MESSAGE), r.text
    r = client.get(f"{API}/budget-entries/{weekly}", headers=me["headers"])
    assert r.json()["next_occurrence"].startswith(start.isoformat())

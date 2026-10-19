"""Posting walks a recurring schedule to the date, however stale (STU-343).

Pure: no database. ``iter_occurrences`` keeps the projection's step guard
(2000 fixed steps, 600 semi-monthly months) by default; ``schedule_walk``
(services/posting.py) walks the whole schedule through the requested day.
"""
from datetime import date, datetime
from types import SimpleNamespace

from app.models.transaction import RecurrenceFrequency as F
from app.services.forecast import iter_occurrences
from app.services.posting import schedule_walk

TODAY = date(2026, 10, 18)
END = datetime(2026, 10, 19)


def _entry(cadence, next_occurrence, **kw):
    defaults = dict(cadence=cadence, next_occurrence=next_occurrence, end_mode="indefinite",
                    end_date=None, max_occurrences=None, semi_monthly_day_1=1,
                    semi_monthly_day_2=15, anchor_day=None, day_rule=None)
    defaults.update(kw)
    return SimpleNamespace(**defaults)


def test_weekly_schedule_decades_stale_is_walked_to_the_date():
    e = _entry(F.WEEKLY, datetime(1985, 1, 6))

    walk = schedule_walk(e, TODAY)

    assert len(walk) == 2181
    assert (walk[0].date(), walk[-1].date()) == (date(1985, 1, 6), TODAY)
    # The projection's walk is unchanged: it still stops after 2000 steps.
    projected = list(iter_occurrences(e, e.next_occurrence, END))
    assert len(projected) == 2000
    assert projected == walk[:2000]


def test_semi_monthly_schedule_past_600_months_is_walked_to_the_date():
    e = _entry(F.SEMI_MONTHLY, datetime(1970, 1, 1))

    walk = schedule_walk(e, TODAY)

    assert len(walk) == 2 * (56 * 12 + 10)  # every 1st and 15th, 1970-01 .. 2026-10
    assert (walk[0].date(), walk[-1].date()) == (date(1970, 1, 1), date(2026, 10, 15))
    projected = list(iter_occurrences(e, e.next_occurrence, END))
    assert len(projected) == 1200
    assert projected[-1].date() == date(2019, 12, 15)
    assert projected == walk[:1200]


def test_walk_still_respects_the_cap_and_end_date():
    capped = _entry(F.WEEKLY, datetime(1985, 1, 6), end_mode="after_occurrences",
                    max_occurrences=3)
    assert [o.date() for o in schedule_walk(capped, TODAY)] == [
        date(1985, 1, 6), date(1985, 1, 13), date(1985, 1, 20)]
    ended = _entry(F.WEEKLY, datetime(1985, 1, 6), end_mode="on_date",
                   end_date=datetime(1985, 1, 14))
    assert len(schedule_walk(ended, TODAY)) == 2


def test_walk_from_a_future_next_occurrence_is_empty_before_it():
    e = _entry(F.MONTHLY, datetime(2026, 11, 1))
    assert schedule_walk(e, TODAY) == []
    assert [o.date() for o in schedule_walk(e, date(2027, 1, 1))] == [
        date(2026, 11, 1), date(2026, 12, 1), date(2027, 1, 1)]

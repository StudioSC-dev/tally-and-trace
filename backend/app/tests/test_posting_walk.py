"""Posting walks a recurring schedule to the date, however stale (STU-343).

Pure: no database. ``iter_occurrences`` keeps the projection's step guard
(2000 fixed steps, 600 semi-monthly months) by default; ``schedule_walk``
(services/posting.py) walks the whole schedule through the requested day.
"""
from datetime import date, datetime
from types import SimpleNamespace

import pytest

from app.models.transaction import RecurrenceFrequency as F
from app.services import forecast as fc
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


@pytest.mark.schedule_date_guards
def test_weekly_schedule_decades_stale_is_walked_to_the_date():
    e = _entry(F.WEEKLY, datetime(1985, 1, 6))

    walk = schedule_walk(e, TODAY)

    assert len(walk) == 2181
    assert (walk[0].date(), walk[-1].date()) == (date(1985, 1, 6), TODAY)
    # The projection's walk is unchanged: it still stops after 2000 steps.
    projected = list(iter_occurrences(e, e.next_occurrence, END))
    assert len(projected) == 2000
    assert projected == walk[:2000]


@pytest.mark.schedule_date_guards
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


def test_walk_lists_a_clamped_semi_monthly_day_once():
    """Days 30 and 31 both clamp onto Feb 28: one occurrence to record, and the
    projection's own walk lists it once too (STU-648)."""
    e = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 30), semi_monthly_day_1=30,
               semi_monthly_day_2=31)

    assert [o.date() for o in schedule_walk(e, date(2027, 3, 31))] == [
        date(2027, 1, 30), date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 30),
        date(2027, 3, 31)]
    assert [o.date() for o in iter_occurrences(e, e.next_occurrence, datetime(2027, 3, 1))] == [
        date(2027, 1, 30), date(2027, 1, 31), date(2027, 2, 28)]


def test_capped_walk_counts_a_clamped_semi_monthly_day_once(monkeypatch):
    """Days 30/31, four left: the cap applies after Feb 28's two clamped days
    merge, so the walk is the four occurrences four Mark paids record. The
    projection's own walk merges and caps the same way (STU-364)."""
    e = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 30), semi_monthly_day_1=30,
               semi_monthly_day_2=31, end_mode="after_occurrences", max_occurrences=4)
    four = [date(2027, 1, 30), date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 30)]

    assert [o.date() for o in schedule_walk(e, date(2027, 3, 31))] == four
    assert [o.date() for o in schedule_walk(e, date(2027, 12, 31))] == four
    assert [o.date() for o in iter_occurrences(e, e.next_occurrence, datetime(2028, 1, 1))] == four

    # ``unrecorded_occurrences`` (card missed items) caps the same way.
    monkeypatch.setattr(fc, "_linked_rows", lambda *a, **k: [])
    monkeypatch.setattr(fc, "load_entry_overrides", lambda *a: {})
    e.id = 1
    assert [o.date() for o in fc.unrecorded_occurrences(None, [e], date(2027, 12, 31))[1]] == four


def test_capped_walk_without_clamped_days_still_stops_at_its_cap():
    semi = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 1), end_mode="after_occurrences",
                  max_occurrences=3)
    assert [o.date() for o in schedule_walk(semi, date(2027, 12, 31))] == [
        date(2027, 1, 1), date(2027, 1, 15), date(2027, 2, 1)]
    monthly = _entry(F.MONTHLY, datetime(2027, 1, 31), end_mode="after_occurrences",
                     max_occurrences=2)
    assert [o.date() for o in schedule_walk(monthly, date(2027, 12, 31))] == [
        date(2027, 1, 31), date(2027, 2, 28)]
    done = _entry(F.MONTHLY, datetime(2027, 1, 31), end_mode="after_occurrences",
                  max_occurrences=0)
    assert schedule_walk(done, date(2027, 12, 31)) == []


def test_unrecorded_occurrences_count_pending_rows_only_when_asked(monkeypatch):
    """A posted linked row stands for its day's occurrence either way; a pending
    one only with ``pending_records`` (STU-465), each row for one occurrence."""
    e = _entry(F.MONTHLY, datetime(2026, 11, 5))
    e.id = 7
    rows = [(7, datetime(2026, 11, 5), 1, True), (7, datetime(2026, 12, 5), 2, False),
            (7, datetime(2027, 1, 5), 3, False), (7, datetime(2027, 1, 5), 4, False)]
    monkeypatch.setattr(fc, "_linked_rows", lambda *a, **k: rows)
    monkeypatch.setattr(fc, "load_entry_overrides", lambda *a: {})
    through = date(2027, 2, 5)

    assert [o.date() for o in fc.unrecorded_occurrences(None, [e], through)[7]] == [
        date(2026, 12, 5), date(2027, 1, 5), date(2027, 2, 5)]
    assert [o.date() for o in fc.unrecorded_occurrences(
        None, [e], through, pending_records=True)[7]] == [date(2027, 2, 5)]


# --- The projection walks a capped semi-monthly schedule as posting does (STU-364) ----------

def _window(entry, start, end):
    return [(when.date(), original.date() if original else None)
            for when, original in fc.iter_window_occurrences(entry, start, end)]


def test_projection_matches_distinct_day_walk():
    """Days 30/31, five left: the forecast lists Feb 28 once and, with the cap
    applied after the merge, keeps Mar 31 as the fifth occurrence (capping
    first would have spent it on a second Feb 28). Every projection walk
    matches posting's ``schedule_walk``."""
    e = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 30), semi_monthly_day_1=30,
               semi_monthly_day_2=31, end_mode="after_occurrences", max_occurrences=5)
    five = [date(2027, 1, 30), date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 30),
            date(2027, 3, 31)]
    end = datetime(2028, 1, 1)

    assert [o.date() for o in schedule_walk(e, date(2027, 12, 31))] == five
    assert [o.date() for o in iter_occurrences(e, e.next_occurrence, end)] == five
    # The window from the schedule's start: every occurrence on its own day.
    assert _window(e, datetime(2027, 1, 30), end) == [(d, None) for d in five]
    # A window starting after Jan 31: January's two are still owed, overdue on
    # the window start; Feb 28 is listed once.
    assert _window(e, datetime(2027, 2, 15), end) == [
        (date(2027, 2, 15), date(2027, 1, 30)), (date(2027, 2, 15), date(2027, 1, 31)),
        (date(2027, 2, 28), None), (date(2027, 3, 30), None), (date(2027, 3, 31), None)]
    # With a forced date (an unrelated one), the effective walk agrees.
    moved = {date(2027, 3, 30): date(2027, 3, 29)}
    assert [(w.date(), n.date()) for w, _, n in fc.effective_window_occurrences(
        e, datetime(2027, 1, 30), end, moved)] == [
        (date(2027, 1, 30), date(2027, 1, 30)), (date(2027, 1, 31), date(2027, 1, 31)),
        (date(2027, 2, 28), date(2027, 2, 28)), (date(2027, 3, 29), date(2027, 3, 30)),
        (date(2027, 3, 31), date(2027, 3, 31))]
    # Days 29/30/31 clamp in a 30-day month too: Apr 30 is one occurrence.
    april = _entry(F.SEMI_MONTHLY, datetime(2027, 4, 1), semi_monthly_day_1=30,
                   semi_monthly_day_2=31, end_mode="after_occurrences", max_occurrences=3)
    assert [o.date() for o in iter_occurrences(april, april.next_occurrence, end)] == [
        date(2027, 4, 30), date(2027, 5, 30), date(2027, 5, 31)]
    assert [o.date() for o in schedule_walk(april, date(2027, 12, 31))] == [
        date(2027, 4, 30), date(2027, 5, 30), date(2027, 5, 31)]


def test_non_semi_monthly_projection_unchanged():
    """Fixed-step cadences, capped or not, project as before: no two of their
    occurrences share a day, so merging changes nothing."""
    end = datetime(2027, 7, 1)
    monthly = _entry(F.MONTHLY, datetime(2027, 1, 31), anchor_day=31)
    assert [o for o, _ in _window(monthly, datetime(2027, 1, 1), end)] == [
        date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 31), date(2027, 4, 30),
        date(2027, 5, 31), date(2027, 6, 30)]
    capped_monthly = _entry(F.MONTHLY, datetime(2027, 1, 31), anchor_day=31,
                            end_mode="after_occurrences", max_occurrences=3)
    assert _window(capped_monthly, datetime(2027, 2, 15), end) == [
        (date(2027, 2, 15), date(2027, 1, 31)), (date(2027, 2, 28), None),
        (date(2027, 3, 31), None)]
    weekly = _entry(F.WEEKLY, datetime(2027, 1, 4), end_mode="after_occurrences",
                    max_occurrences=4)
    assert [o for o, _ in _window(weekly, datetime(2027, 1, 1), end)] == [
        date(2027, 1, 4), date(2027, 1, 11), date(2027, 1, 18), date(2027, 1, 25)]
    quarterly = _entry(F.QUARTERLY, datetime(2027, 1, 15), end_mode="on_date",
                       end_date=datetime(2027, 6, 30))
    assert [o for o, _ in _window(quarterly, datetime(2027, 1, 1), end)] == [
        date(2027, 1, 15), date(2027, 4, 15)]


def test_non_colliding_semi_monthly_unchanged():
    """Semi-monthly days that never clamp onto each other (1/15, and 15/30, where
    30 clamps to Feb 28 but 15 does not) project every day, as before."""
    end = datetime(2027, 4, 1)
    plain = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 1))
    assert [o for o, _ in _window(plain, datetime(2027, 1, 1), end)] == [
        date(2027, 1, 1), date(2027, 1, 15), date(2027, 2, 1), date(2027, 2, 15),
        date(2027, 3, 1), date(2027, 3, 15)]
    fifteen_thirty = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 15), semi_monthly_day_1=15,
                            semi_monthly_day_2=30)
    assert [o for o, _ in _window(fifteen_thirty, datetime(2027, 1, 1), end)] == [
        date(2027, 1, 15), date(2027, 1, 30), date(2027, 2, 15), date(2027, 2, 28),
        date(2027, 3, 15), date(2027, 3, 30)]
    same_day = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 10), semi_monthly_day_1=10,
                      semi_monthly_day_2=10)
    assert [o for o, _ in _window(same_day, datetime(2027, 1, 1), end)] == [
        date(2027, 1, 10), date(2027, 2, 10), date(2027, 3, 10)]


# --- An uncapped entry's projection merges a clamped day too (STU-648) --------------------

def test_uncapped_projection_merges_clamped_day():
    """Days 30/31, no cap: Feb 28 once in a common year, Feb 29 once in a leap
    year, over January to April. The end_date variant merges too."""
    for year, feb_last in ((2027, 28), (2028, 29)):
        e = _entry(F.SEMI_MONTHLY, datetime(year, 1, 30), semi_monthly_day_1=30,
                   semi_monthly_day_2=31)
        got = [o for o, _ in _window(e, datetime(year, 1, 1), datetime(year, 5, 1))]
        assert got == [date(year, 1, 30), date(year, 1, 31), date(year, 2, feb_last),
                       date(year, 3, 30), date(year, 3, 31), date(year, 4, 30)]
        assert got.count(date(year, 2, feb_last)) == 1
    ended = _entry(F.SEMI_MONTHLY, datetime(2027, 1, 30), semi_monthly_day_1=30,
                   semi_monthly_day_2=31, end_mode="on_date", end_date=datetime(2027, 3, 30))
    assert [o for o, _ in _window(ended, datetime(2027, 1, 1), datetime(2027, 4, 1))] == [
        date(2027, 1, 30), date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 30)]


def test_uncapped_projection_matches_posting_days():
    """The forecast's days equal the days posting would record over the window."""
    for year in (2027, 2028):
        e = _entry(F.SEMI_MONTHLY, datetime(year, 1, 30), semi_monthly_day_1=30,
                   semi_monthly_day_2=31)
        forecast = [o for o, _ in _window(e, datetime(year, 1, 1), datetime(year, 5, 1))]
        posting = [o.date() for o in schedule_walk(e, date(year, 4, 30))]
        assert forecast == posting

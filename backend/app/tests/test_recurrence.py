"""Anchored-day and last-weekday schedules (STU-315, plan sections 2.2 and 3.1-3.3).

Pure: no database. Month-family entries (monthly, quarterly, semi-annual,
annual) with an ``anchor_day`` land on that day, clamped to short months and
back again afterwards; with ``day_rule`` "last_weekday" on the month's last
Monday-Friday. Both null keeps the legacy schedule, which steps from the
current date's day and so sticks on a clamped day. Every walk goes through
``iter_occurrences``, which every projection uses.
"""
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

from app.models.transaction import RecurrenceFrequency as F
from app.services.forecast import iter_occurrences, iter_window_occurrences

END = datetime.max


def _entry(cadence, next_occurrence, **kw):
    defaults = dict(cadence=cadence, next_occurrence=next_occurrence, end_mode="indefinite",
                    end_date=None, max_occurrences=None, semi_monthly_day_1=1,
                    semi_monthly_day_2=15, anchor_day=None, day_rule=None)
    defaults.update(kw)
    return SimpleNamespace(**defaults)


def _walk(entry, n, start=None):
    out = []
    for occ in iter_occurrences(entry, start or entry.next_occurrence, END):
        out.append(occ)
        if len(out) == n:
            break
    return out


def _days(entry, n):
    return [o.date() for o in _walk(entry, n)]


# --- 3.1: anchored days ------------------------------------------------------------------

def test_anchor_31_returns_to_the_31st_after_short_months():
    e = _entry(F.MONTHLY, datetime(2026, 10, 31), anchor_day=31)
    assert _days(e, 6) == [date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 31),
                           date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 31)]


def test_legacy_schedule_keeps_clamping_from_the_current_day():
    """Both fields null: today's behaviour, locked."""
    e = _entry(F.MONTHLY, datetime(2026, 10, 31))
    assert _days(e, 6) == [date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 30),
                           date(2027, 1, 30), date(2027, 2, 28), date(2027, 3, 28)]


def test_leap_february_then_back_to_each_anchor():
    for anchor in (29, 30, 31):
        e = _entry(F.MONTHLY, datetime(2028, 1, anchor), anchor_day=anchor)
        assert _days(e, 3) == [date(2028, 1, anchor), date(2028, 2, 29),
                               date(2028, 3, anchor)], anchor


def test_quarterly_anchor_31():
    e = _entry(F.QUARTERLY, datetime(2026, 8, 31), anchor_day=31)
    assert _days(e, 5) == [date(2026, 8, 31), date(2026, 11, 30), date(2027, 2, 28),
                           date(2027, 5, 31), date(2027, 8, 31)]


def test_semi_annual_anchor_31():
    e = _entry(F.SEMI_ANNUAL, datetime(2026, 8, 31), anchor_day=31)
    assert _days(e, 3) == [date(2026, 8, 31), date(2027, 2, 28), date(2027, 8, 31)]


def test_annual_anchor_29_returns_on_the_next_leap_year():
    e = _entry(F.ANNUAL, datetime(2028, 2, 29), anchor_day=29)
    assert _days(e, 5) == [date(2028, 2, 29), date(2029, 2, 28), date(2030, 2, 28),
                           date(2031, 2, 28), date(2032, 2, 29)]


def test_walks_near_maxyear_end_cleanly():
    for kw, december in (({"anchor_day": 30}, date(9999, 12, 30)),
                         ({"day_rule": "last_weekday"}, date(9999, 12, 31))):
        e = _entry(F.MONTHLY, datetime(9999, 11, 30), **kw)
        assert [o.date() for o in iter_occurrences(e, e.next_occurrence, END)] == [
            date(9999, 11, 30), december], kw


def test_anchored_days_up_to_28_agree_with_the_legacy_schedule():
    for day in (1, 15, 28):
        legacy = _entry(F.MONTHLY, datetime(2026, 10, day))
        anchored = _entry(F.MONTHLY, datetime(2026, 10, day), anchor_day=day)
        assert _days(legacy, 14) == _days(anchored, 14), day


def test_step_keeps_time_of_day_and_tzinfo():
    from app.services.recurrence import step_occurrence

    manila = timezone(timedelta(hours=8))
    e = _entry(F.MONTHLY, None, anchor_day=31)
    stepped = step_occurrence(e, datetime(2027, 1, 31, 9, 30, tzinfo=timezone.utc))
    assert stepped == datetime(2027, 2, 28, 9, 30, tzinfo=timezone.utc)
    assert stepped.tzinfo is timezone.utc
    ruled = _entry(F.MONTHLY, None, day_rule="last_weekday")
    stepped = step_occurrence(ruled, datetime(2026, 10, 30, 7, 15, tzinfo=manila))
    assert stepped == datetime(2026, 11, 30, 7, 15, tzinfo=manila)
    assert stepped.tzinfo is manila


# --- 3.2: last weekday -------------------------------------------------------------------

def test_last_weekday_skips_weekend_month_ends():
    e = _entry(F.MONTHLY, datetime(2026, 10, 30), day_rule="last_weekday")
    days = _days(e, 17)
    assert days[:5] == [date(2026, 10, 30), date(2026, 11, 30), date(2026, 12, 31),
                        date(2027, 1, 29), date(2027, 2, 26)]
    assert days[16] == date(2028, 2, 29)
    assert all(d.weekday() < 5 for d in days)


def test_last_weekday_of_month():
    from app.services.recurrence import last_weekday

    assert last_weekday(2027, 1) == date(2027, 1, 29)   # 31st is a Sunday
    assert last_weekday(2026, 10) == date(2026, 10, 30)  # 31st is a Saturday
    assert last_weekday(2026, 11) == date(2026, 11, 30)  # a Monday
    assert last_weekday(2028, 2) == date(2028, 2, 29)


def test_a_rule_wins_over_a_stored_anchor():
    e = _entry(F.MONTHLY, datetime(2026, 10, 30), day_rule="last_weekday", anchor_day=15)
    assert _days(e, 2) == [date(2026, 10, 30), date(2026, 11, 30)]


# --- 3.3: other cadences, time of day, capped installments ----------------------------------

def test_non_month_cadences_ignore_the_day_fields():
    for cadence in (F.WEEKLY, F.BIWEEKLY, F.SEMI_MONTHLY):
        plain = _entry(cadence, datetime(2026, 10, 31, 8, 0))
        for kw in ({"anchor_day": 5}, {"day_rule": "last_weekday"}):
            assert _walk(_entry(cadence, datetime(2026, 10, 31, 8, 0), **kw), 8) == \
                _walk(plain, 8), (cadence, kw)


def test_time_of_day_is_kept_on_rule_dates():
    e = _entry(F.MONTHLY, datetime(2026, 10, 31, 20, 45), anchor_day=31)
    assert _walk(e, 3) == [datetime(2026, 10, 31, 20, 45), datetime(2026, 11, 30, 20, 45),
                           datetime(2026, 12, 31, 20, 45)]


def test_capped_installment_overdue_from_the_window_start_follows_the_anchor():
    """Three left from 31 Oct, the window opening 15 Jan: the anchored walk is
    31 Oct, 30 Nov, 31 Dec (not 30 Dec), all before the window, so all three are
    owed on its start and the cap is used up."""
    e = _entry(F.MONTHLY, datetime(2026, 10, 31), anchor_day=31,
               end_mode="after_occurrences", max_occurrences=3)
    start = datetime(2027, 1, 15)
    assert list(iter_window_occurrences(e, start, datetime(2027, 6, 1))) == [
        (start, datetime(2026, 10, 31)), (start, datetime(2026, 11, 30)),
        (start, datetime(2026, 12, 31))]


def test_capped_installment_in_window_uses_rule_dates():
    e = _entry(F.MONTHLY, datetime(2026, 11, 30), anchor_day=31,
               end_mode="after_occurrences", max_occurrences=4)
    start = datetime(2026, 12, 15)
    assert list(iter_window_occurrences(e, start, datetime(2027, 12, 1))) == [
        (start, datetime(2026, 11, 30)), (datetime(2026, 12, 31), None),
        (datetime(2027, 1, 31), None), (datetime(2027, 2, 28), None)]


def test_end_date_is_inclusive_on_rule_dates():
    e = _entry(F.MONTHLY, datetime(2026, 10, 31), anchor_day=31, end_mode="on_date",
               end_date=datetime(2026, 12, 31))
    assert _days(e, 10) == [date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 31)]

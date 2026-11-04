"""Unit tests for PH banking days (pure, no database).

These pin the calendar facts the statement due roll relies on at the pinned
``holidays`` version, so a version bump that changes one of them fails here.
"""
from datetime import date, timedelta

import holidays

from app.services.banking_days import is_banking_day, next_banking_day


def _ph_public(year):
    return holidays.country_holidays("PH", years=year, categories=(holidays.PUBLIC,))


def test_bonifacio_day_2026_is_listed():
    assert date(2026, 11, 30) in _ph_public(2026)
    assert not is_banking_day(date(2026, 11, 30))


def test_special_non_working_days_are_not_banking_days():
    for day in (
        date(2026, 11, 2),   # All Souls' Day
        date(2026, 12, 24),  # Christmas Eve
        date(2026, 12, 31),  # Last day of the year
        date(2026, 8, 21),   # Ninoy Aquino Day
    ):
        assert not is_banking_day(day), day


def test_special_working_day_is_a_banking_day():
    inc_founding = date(2026, 7, 27)  # a Monday in the WORKDAY category
    assert inc_founding.weekday() == 0
    assert is_banking_day(inc_founding)


def test_weekends_are_not_banking_days():
    assert not is_banking_day(date(2026, 11, 28))  # Saturday
    assert not is_banking_day(date(2026, 11, 29))  # Sunday


def test_sunday_before_bonifacio_rolls_to_tuesday():
    assert next_banking_day(date(2026, 11, 29)) == date(2026, 12, 1)


def test_banking_day_is_unchanged():
    assert next_banking_day(date(2026, 11, 23)) == date(2026, 11, 23)


def test_christmas_cluster_rolls_to_monday():
    assert next_banking_day(date(2026, 12, 24)) == date(2026, 12, 28)


def test_year_end_cluster_crosses_into_january():
    assert next_banking_day(date(2026, 12, 30)) == date(2027, 1, 4)


def test_holy_week_rolls_past_black_saturday():
    maundy_thursday = next(
        day for day, name in _ph_public(2026).items() if name == "Maundy Thursday"
    )
    assert maundy_thursday.weekday() == 3
    assert next_banking_day(maundy_thursday) == maundy_thursday + timedelta(days=4)

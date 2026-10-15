"""The day a month-family recurring entry falls on (STU-315).

Month-family cadences (monthly, quarterly, semi-annual, annual) step by whole
months. An entry with ``day_rule`` "last_weekday" lands on the month's last
Monday-Friday; one with an ``anchor_day`` lands on that day, clamped to the
month's length. Both step from the current (year, month), never from the
current day, so a clamped 28 February goes back to the 31st in March. An entry
with neither keeps the legacy step (``forecast._next_occurrence``), which
clamps from the current day and so sticks on a clamped one.
"""

from calendar import monthrange
from datetime import MAXYEAR, date, datetime, timedelta
from typing import Optional, Tuple

from app.models.transaction import RecurrenceFrequency

LAST_WEEKDAY = "last_weekday"

MONTH_STEP = {
    RecurrenceFrequency.MONTHLY: 1,
    RecurrenceFrequency.QUARTERLY: 3,
    RecurrenceFrequency.SEMI_ANNUAL: 6,
    RecurrenceFrequency.ANNUAL: 12,
}
MONTH_FAMILY = frozenset(MONTH_STEP)


def shift_month(year: int, month: int, months: int) -> Tuple[int, int]:
    """(year, month) ``months`` later; ``ValueError`` past the last year a date holds."""
    index = month - 1 + months
    year, month = year + index // 12, index % 12 + 1
    if year > MAXYEAR:
        raise ValueError("past the last year a date can hold")
    return year, month


def last_weekday(year: int, month: int) -> date:
    """The month's last Monday-Friday (a Saturday or Sunday month end moves to Friday)."""
    d = date(year, month, monthrange(year, month)[1])
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def rule_date(entry, year: int, month: int) -> Optional[date]:
    """The entry's day in that month, or None for the legacy schedule."""
    if getattr(entry, "day_rule", None) == LAST_WEEKDAY:
        return last_weekday(year, month)
    anchor = getattr(entry, "anchor_day", None)
    if anchor:
        return date(year, month, min(anchor, monthrange(year, month)[1]))
    return None


def step_occurrence(entry, current: datetime) -> datetime:
    """The occurrence after ``current`` for a fixed-step cadence.

    Keeps ``current``'s time of day and tzinfo: materialize passes the aware
    value read from the ``timestamptz`` column and compares the result with
    ``end_date``. Semi-monthly entries are walked by their callers.
    """
    from app.services.forecast import _next_occurrence

    months = MONTH_STEP.get(entry.cadence)
    if months:
        year, month = shift_month(current.year, current.month, months)
        day = rule_date(entry, year, month)
        if day is not None:
            return current.replace(year=day.year, month=day.month, day=day.day)
    return _next_occurrence(current, entry.cadence)

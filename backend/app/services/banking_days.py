"""Philippine banking days, for rolling a card statement's due date.

A bank posts a payment due on a day it is closed on the next day it opens, and
prints that day on the statement. A day is **not** a banking day when it is:

- a Saturday or a Sunday, or
- in ``holidays.country_holidays("PH", categories=(holidays.PUBLIC,))``.

The ``PUBLIC`` category holds both the regular holidays and the special
non-working days (All Saints', All Souls', Christmas Eve, Black Saturday, ...).
The ``WORKDAY`` category holds the special *working* days, on which banks open,
so it is deliberately left out.

The calendar comes from the ``holidays`` package pinned in
``backend/requirements.txt`` (0.108). A proclamation newer than that release is
not known here: picking it up needs a version bump.
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache
from typing import FrozenSet

import holidays

# A weekend plus the longest PH holiday run (Holy Week, the year-end cluster) is
# well under two weeks; past this the calendar data is wrong, not the date.
_MAX_ROLL_DAYS = 14


@lru_cache(maxsize=None)
def _non_banking_holidays(year: int) -> FrozenSet[date]:
    """The PH ``PUBLIC`` holidays in ``year``.

    A fresh calendar per year, frozen, so the library's lazy year expansion never
    mutates an object shared across threads.
    """
    calendar = holidays.country_holidays("PH", years=year, categories=(holidays.PUBLIC,))
    return frozenset(calendar.keys())


def is_banking_day(d: date) -> bool:
    """False on a Saturday, a Sunday, or a PH public holiday or special non-working day."""
    if d.weekday() >= 5:
        return False
    return d not in _non_banking_holidays(d.year)


def next_banking_day(d: date) -> date:
    """``d`` itself when it is a banking day, otherwise the next banking day after it."""
    for step in range(_MAX_ROLL_DAYS + 1):
        candidate = d + timedelta(days=step)
        if is_banking_day(candidate):
            return candidate
    raise RuntimeError(f"no PH banking day within {_MAX_ROLL_DAYS} days of {d.isoformat()}")

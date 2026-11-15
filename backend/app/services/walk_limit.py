"""The step cap on a whole-schedule walk (STU-427).

``posting.schedule_walk`` and ``card_credit._stream`` walk a recurring entry's
schedule from its stored ``next_occurrence``, bounded by the distance in days
to where they stop (one step per day, which a complete walk never reaches). A
stale ``next_occurrence``, as on a row stored before entry dates were bounded,
makes that bound, and the walk, long. ``walk_capped`` caps it:

- A step is one advance of ``forecast.iter_occurrences``: one cadence step (a
  week, two weeks, a month, a quarter, ...), or one month of a semi-monthly
  schedule.
- The cap is per entry, per walk: each call walks one entry's schedule and has
  ``WALK_STEP_LIMIT`` steps of its own. A calculation over many entries (a
  card's credit, a batch post) is not capped as a whole.
- A walk the cap stops before its end raises ``WalkLimitReached``: what it
  walked is never returned, neither as the schedule nor as part of it. It is
  an ``HTTPException`` (409), so a request it reaches is refused with
  ``WALK_LIMIT_MESSAGE``, and a caller may catch it by its type.

``WALK_STEP_LIMIT`` is far above any in-range entry's walk (app/core/
record_dates.py): a weekly schedule from 2000-01-01 to an end date 30 years
after today is about 3,000 steps; a weekly row stored as early as 1835 still
walks to today.
"""
from datetime import datetime
from typing import List

from fastapi import HTTPException

from app.services import forecast as fc

WALK_STEP_LIMIT = 10_000
WALK_LIMIT_MESSAGE = ("This entry's schedule is too long to work out from its next date. "
                      "Move the next date later, then try again.")


class WalkLimitReached(HTTPException):
    """A schedule walk reached ``limit`` steps before its end."""

    def __init__(self, entry_id, limit: int):
        super().__init__(status_code=409, detail=WALK_LIMIT_MESSAGE)
        self.entry_id = entry_id
        self.limit = limit


def _ended_within(entry, start: datetime, end: datetime, limit: int) -> bool:
    """Whether the uncapped walk ends on its own within ``limit`` steps: one
    more step yields nothing. From ``start`` = ``next_occurrence`` every step
    that does not end the walk yields (a semi-monthly month past the first
    yields a day, or is past ``end``, where the walk ends anyway)."""
    def count(steps: int) -> int:
        return sum(1 for _ in fc.iter_occurrences(entry, start, end, max_steps=steps,
                                                  apply_cap=False))
    return count(limit + 1) == count(limit)


def walk_capped(entry, start: datetime, end: datetime, bound: int) -> List[datetime]:
    """``forecast.capped_distinct_days(entry, start, end, max_steps=bound)``,
    walked at most ``WALK_STEP_LIMIT`` steps. ``start`` is ``next_occurrence``
    and ``bound`` the caller's complete-walk bound, so a bound within the limit
    is walked as before. Past it, the walk stops at the limit and is returned
    only when it was complete there (its cap reached, or it ended on its own);
    otherwise ``WalkLimitReached``."""
    limit = WALK_STEP_LIMIT
    if bound <= limit:
        return fc.capped_distinct_days(entry, start, end, max_steps=bound)
    days = fc.capped_distinct_days(entry, start, end, max_steps=limit)
    cap = (entry.max_occurrences
           if getattr(entry, "end_mode", None) == "after_occurrences" else None)
    if (cap is not None and len(days) >= cap) or _ended_within(entry, start, end, limit):
        return days
    raise WalkLimitReached(getattr(entry, "id", None), limit)

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

from app.models.transaction import RecurrenceFrequency
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


def _step_of(entry, anchor: datetime, index: int, occ: datetime) -> int:
    """The step (1-based) of the walk from ``anchor`` that yielded ``occ``, the
    ``index``-th occurrence yielded. A fixed-step walk from ``next_occurrence``
    yields once a step; a semi-monthly one walks a month a step."""
    if entry.cadence == RecurrenceFrequency.SEMI_MONTHLY:
        return (occ.year - anchor.year) * 12 + occ.month - anchor.month + 1
    return index + 1


def walk_capped(entry, start: datetime, end: datetime, bound: int) -> List[datetime]:
    """``forecast.capped_distinct_days(entry, start, end, max_steps=bound)``,
    walked at most ``WALK_STEP_LIMIT`` steps, plus one sentinel step. ``start``
    is ``next_occurrence`` and ``bound`` the caller's complete-walk bound, so a
    bound within the limit is walked as before. Past it, one walk of
    ``WALK_STEP_LIMIT + 1`` steps: an occurrence the sentinel step yields (one
    inside ``[start, end)`` and the end date) means the schedule runs on past
    the limit, so ``WalkLimitReached``, unless the cap was reached first.
    Otherwise the walk ended on its own within the limit and is returned. One
    call never advances the schedule more than ``WALK_STEP_LIMIT + 1`` times."""
    limit = WALK_STEP_LIMIT
    if bound <= limit:
        return fc.capped_distinct_days(entry, start, end, max_steps=bound)
    cap = (entry.max_occurrences
           if getattr(entry, "end_mode", None) == "after_occurrences" else None)
    if cap is not None and cap <= 0:
        return []
    anchor = fc._naive(start)
    seen: set = set()
    days: List[datetime] = []
    occurrences = fc.iter_occurrences(entry, start, end, max_steps=limit + 1, apply_cap=False)
    for index, occ in enumerate(occurrences):
        if _step_of(entry, anchor, index, occ) > limit:
            raise WalkLimitReached(getattr(entry, "id", None), limit)
        if occ.date() not in seen:
            seen.add(occ.date())
            days.append(occ)
            if cap is not None and len(days) >= cap:
                break
    return days

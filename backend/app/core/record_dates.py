"""The dates a transaction may be saved with (STU-404).

A date runs from ``RECORD_DATE_MIN`` to Manila's today plus ``RECORD_YEARS_AHEAD``
calendar years, both inclusive. The day compared is the UTC calendar day of the
value (an aware value is converted to UTC first, a naive one is taken as UTC).
The bounds apply only to dates being saved: they are enforced on request bodies
and on dates the server derives, never on stored rows or response models, so an
older row stays readable and editable.

A recurring entry's dates (STU-427) take the same rule with their own reach:
``next_occurrence`` ``ENTRY_NEXT_YEARS_AHEAD`` years, ``end_date``
``ENTRY_END_YEARS_AHEAD`` (an installment may end decades out). Each helper
takes ``years``, the reach, defaulting to a transaction's.
"""
from datetime import date, datetime, timezone
from typing import Optional, Union

from fastapi import HTTPException
from pydantic_core import PydanticCustomError

from app.core.time import manila_today

RECORD_DATE_MIN = date(2000, 1, 1)
RECORD_YEARS_AHEAD = 5
ENTRY_NEXT_YEARS_AHEAD = 5
ENTRY_END_YEARS_AHEAD = 30


def record_date_max(today: date, years: int = RECORD_YEARS_AHEAD) -> date:
    """``today`` plus ``years`` calendar years; Feb 29 becomes Feb 28."""
    year = today.year + years
    try:
        return today.replace(year=year)
    except ValueError:
        return today.replace(year=year, day=28)


def record_day(value: Union[date, datetime]) -> Optional[date]:
    """The UTC calendar day of ``value``; ``None`` when the UTC conversion overflows."""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            try:
                value = value.astimezone(timezone.utc)
            except (OverflowError, ValueError):
                return None
        return value.date()
    return value


def _bounds(years: int = RECORD_YEARS_AHEAD) -> tuple[date, date]:
    return RECORD_DATE_MIN, record_date_max(manila_today(), years)


def _in_range(value: Union[date, datetime], years: int = RECORD_YEARS_AHEAD) -> bool:
    day = record_day(value)
    lo, hi = _bounds(years)
    return day is not None and lo <= day <= hi


def record_date_message(years: int = RECORD_YEARS_AHEAD) -> str:
    """The refusal text, read from Manila's today at call time."""
    lo, hi = _bounds(years)
    return f"Choose a date from {lo.isoformat()} to {hi.isoformat()}"


def check_record_date(value, years: int = RECORD_YEARS_AHEAD):
    """A Pydantic field validator body: the value, or a 422 ``record_date_range``.

    ``None`` passes (an optional date left out).
    """
    if value is None or _in_range(value, years):
        return value
    lo, hi = _bounds(years)
    raise PydanticCustomError(
        "record_date_range", "Choose a date from {lo} to {hi}",
        {"lo": lo.isoformat(), "hi": hi.isoformat()})


def refuse_record_date(value: Union[date, datetime], years: int = RECORD_YEARS_AHEAD) -> None:
    """The same rule as a 422, for a date the server derives itself (or, on a
    recurring-entry edit, a date the edit changes)."""
    if not _in_range(value, years):
        raise HTTPException(status_code=422, detail=record_date_message(years))

"""``POST /cards/{account_id}/closing-day`` (STU-747): the request and the STU-744 report.

The report lists ids, dates, day numbers and reasons only: no amount appears in it.
"""
from datetime import date
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class CloseDayChange(BaseModel):
    """The new closing day. ``dry_run`` (the default) makes and checks the whole
    change, then writes nothing; ``accept_history_shift`` lets it go ahead when
    past statements would hold other rows."""
    model_config = ConfigDict(extra="forbid")

    close_day: int = Field(..., ge=1, le=31)
    dry_run: bool = True
    accept_history_shift: bool = False


class CloseDayRow(BaseModel):
    """One linked transaction of a moved installment. ``date_kept`` is a gap row,
    billed between the old and the new close: it keeps its date and only its
    occurrence moves."""
    transaction_id: int
    date_kept: bool
    old_date: date
    new_date: date
    old_occurrence: Optional[date] = None
    new_occurrence: Optional[date] = None


class CloseDayEntry(BaseModel):
    entry_id: int
    old_next_occurrence: Optional[date] = None
    new_next_occurrence: Optional[date] = None
    old_anchor_day: Optional[int] = None
    new_anchor_day: Optional[int] = None
    rows: List[CloseDayRow] = []


class CloseDayDue(BaseModel):
    """A printed due or a minimum due, moved from ``old_close`` to ``new_close``."""
    id: int
    old_close: date
    new_close: date


class CloseDayStatement(BaseModel):
    """A closed statement whose rows would differ: row ids moved in and out."""
    old_close: date
    new_close: date
    moved_in: List[int]
    moved_out: List[int]


class CloseDayReport(BaseModel):
    """What the change does, or why it is refused. ``changed`` is true only when
    it was applied (never for a dry run); ``refused`` when nothing can be written."""
    card_id: int
    dry_run: bool
    changed: bool
    refused: bool
    reasons: List[str]
    old_close_day: Optional[int] = None
    new_close_day: int
    entries: List[CloseDayEntry]
    printed_dues: List[CloseDayDue]
    minimum_dues: List[CloseDayDue]
    past_statements: List[CloseDayStatement]
    history_shift_accepted: bool

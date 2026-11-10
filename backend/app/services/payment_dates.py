"""Forced payment dates (``payment_date_overrides``).

The schedule's date (the nominal date) is an occurrence's identity and never
moves: every link, the schedule's advance and every loan settlement read it. A
forced date is the occurrence's effective date, which alone decides when it is
due, shown, overdue and posted.

A forced date stays within ``OVERRIDE_REACH`` of the nominal date and strictly
between the effective dates of the neighbouring occurrences, so the due
occurrences of a schedule are always a prefix of it and "oldest first" holds.
A walker extends by the reach, on records that have overrides only, and then
filters on the effective date, so an occurrence forced into a window is found.

Nothing here imports the forecast: the forecast and the loans service read it.
"""
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, Optional

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.record_dates import refuse_record_date
from app.models.payment_date_override import PaymentDateOverride

OVERRIDE_REACH = timedelta(days=31)

OUTSIDE_REACH = "A forced date must stay within 31 days of the scheduled date"
OUT_OF_ORDER = "A forced date must fall between the dates of the payments before and after it"
CLEAR_OUT_OF_ORDER = ("Clearing it would put this payment on or past a neighbouring payment's "
                      "forced date; change that one first")

Moved = Dict[date, date]  # nominal date -> effective date, for one entry or loan


def _load(db: Session, column, ids: Iterable[Optional[int]]) -> Dict[int, Moved]:
    ids = {i for i in ids if i is not None}
    out: Dict[int, Moved] = defaultdict(dict)
    if not ids:
        return out
    rows = db.query(column, PaymentDateOverride.occurrence_date,
                    PaymentDateOverride.effective_date).filter(column.in_(ids)).all()
    for owner, nominal, forced in rows:
        out[owner][nominal] = forced
    return out


def load_entry_overrides(db: Session, entry_ids: Iterable[int]) -> Dict[int, Moved]:
    """``{entry id: {nominal: effective}}``; an entry with none is missing or empty."""
    return _load(db, PaymentDateOverride.budget_entry_id, entry_ids)


def load_loan_overrides(db: Session, loan_ids: Iterable[int]) -> Dict[int, Moved]:
    """``{loan id: {nominal due date: effective}}``; a loan with none is missing or empty."""
    return _load(db, PaymentDateOverride.loan_account_id, loan_ids)


def effective(moved: Optional[Moved], day: date) -> date:
    """The effective date of the occurrence on the nominal ``day``."""
    return moved.get(day, day) if moved else day


def effective_at(moved: Optional[Moved], when: datetime) -> datetime:
    """``effective`` of a datetime occurrence, keeping its time of day."""
    return datetime.combine(effective(moved, when.date()), when.time())


def extend(end: datetime) -> datetime:
    """``end`` plus the reach, clamped so ``datetime.max`` cannot overflow."""
    try:
        return end + OVERRIDE_REACH
    except OverflowError:
        return datetime.max


def in_order(previous: Optional[date], day: date, following: Optional[date],
             overlap: bool = False) -> bool:
    """Whether ``day`` falls strictly between its neighbours (None: no neighbour).
    With ``overlap`` it may also equal the following one's date, never the previous."""
    return ((previous is None or previous < day)
            and (following is None or day < following or (overlap and day == following)))


def refuse_forced_date(nominal: date, forced: date, previous: Optional[date],
                       following: Optional[date], overlap: bool = False) -> None:
    """422 for a forced date past the reach, out of order or outside the record dates.
    ``overlap`` lets it land on the following occurrence's date."""
    if abs(forced - nominal) > OVERRIDE_REACH:
        raise HTTPException(status_code=422, detail=OUTSIDE_REACH)
    if not in_order(previous, forced, following, overlap):
        raise HTTPException(status_code=422, detail=OUT_OF_ORDER)
    refuse_record_date(forced)


def _owner_filter(budget_entry_id: Optional[int], loan_account_id: Optional[int]):
    if budget_entry_id is not None:
        return PaymentDateOverride.budget_entry_id == budget_entry_id
    return PaymentDateOverride.loan_account_id == loan_account_id


def set_override(db: Session, actor_id: int, nominal: date, forced: date, *,
                 budget_entry_id: Optional[int] = None,
                 loan_account_id: Optional[int] = None) -> None:
    """Insert or replace one override, without committing. The caller holds the record's lock."""
    statement = pg_insert(PaymentDateOverride).values(
        budget_entry_id=budget_entry_id, loan_account_id=loan_account_id,
        occurrence_date=nominal, effective_date=forced, created_by_actor=actor_id)
    db.execute(statement.on_conflict_do_update(
        constraint=("uq_payment_date_overrides_entry_occurrence" if budget_entry_id is not None
                    else "uq_payment_date_overrides_loan_occurrence"),
        set_={"effective_date": statement.excluded.effective_date,
              "created_by_actor": statement.excluded.created_by_actor,
              "updated_at": func.now()}))


def clear_override(db: Session, nominal: date, *, budget_entry_id: Optional[int] = None,
                   loan_account_id: Optional[int] = None) -> None:
    """Delete one override if it exists, without committing."""
    db.query(PaymentDateOverride).filter(
        _owner_filter(budget_entry_id, loan_account_id),
        PaymentDateOverride.occurrence_date == nominal,
    ).delete(synchronize_session=False)


def clear_all(db: Session, *, budget_entry_id: Optional[int] = None,
              loan_account_id: Optional[int] = None) -> None:
    """Delete a record's overrides, without committing: its schedule changed, so
    the dates they were validated against are gone."""
    db.query(PaymentDateOverride).filter(
        _owner_filter(budget_entry_id, loan_account_id),
    ).delete(synchronize_session=False)

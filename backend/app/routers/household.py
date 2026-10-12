"""Household views (STU-233, plan §3): one sharer's Household at a time.

A view is opened by ``sharer_id``: a user whose Household tag share the
caller holds, or the caller themselves (their own Household view). Any other
id answers 404, as an unknown one does. The view's scope is the sharer's
active Household-tagged accounts the caller sees (``tag_viewer`` or a direct
role); the caller's own private accounts are outside it. Read-only: there are
no write routes here, and a tag share grants none elsewhere.

- ``GET /household/``: the views the caller can open.
- ``GET /household/{sharer_id}/dashboard``: the scope accounts (as
  ``/accounts/`` serializes them), the current month's totals and the next
  30 days of upcoming items.
- ``GET /household/{sharer_id}/transactions``: the scope's transactions the
  caller may read, plus the sharer's Household occurrences outside the scope,
  newest first, in the ``/transactions/`` shape.
- ``GET /household/{sharer_id}/upcoming?days=``: the view's projection, in
  the ``/forecast/upcoming`` shape, each full item with its ``currency``.
- ``GET /household/{sharer_id}/monthly?from=YYYY-MM&to=YYYY-MM``: monthly
  totals per currency (``services/household.household_monthly``); each bound
  defaults to the current month, the range is at most 36 months, and each
  bound lies in 1900-01 through 2999-12 (422 otherwise).
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.access import household_grants
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.redaction import display_name, serialize_accounts, serialize_transactions
from app.core.time import naive_utc_now
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.household import HouseholdMonthlyResponse, HouseholdViewOut
from app.schemas.transaction import TransactionListResponse
from app.services import household as household_svc
from app.services.forecast import _upcoming_window

router = APIRouter()

MONTH = r"^\d{4}-(0[1-9]|1[0-2])$"
MAX_MONTHS = 36
MIN_YEAR, MAX_YEAR = 1900, 2999


def _grant(db: Session, user: User, sharer_id: int):
    grant = household_svc.household_view(db, user, sharer_id)
    if grant is None:
        raise HTTPException(status_code=404, detail="Household not found")
    return grant


def _sharer(db: Session, sharer_id: int) -> dict:
    return {"id": sharer_id, "name": display_name(db.get(User, sharer_id)) or ""}


def _month(value: str) -> datetime:
    """A ``YYYY-MM`` bound as its first day; 422 outside the supported years.

    The bounds keep every date the service derives from the range (the month
    after ``to``, statement cycles and loan dues past it) inside the years
    ``datetime`` can hold.
    """
    year, month = (int(part) for part in value.split("-"))
    if not MIN_YEAR <= year <= MAX_YEAR:
        raise HTTPException(status_code=422,
                            detail=f"Months must be between {MIN_YEAR}-01 and {MAX_YEAR}-12")
    return datetime(year, month, 1)


@router.get("/", response_model=List[HouseholdViewOut])
def list_households(db: Session = Depends(get_db),
                    current_user: User = Depends(get_current_active_user)):
    """The caller's own Household view first, then each sharer's, by sharer id."""
    views = [{"sharer_id": current_user.id, "sharer_name": display_name(current_user) or "",
              "is_self": True}]
    for grant in household_grants(db, current_user):
        views.append({"sharer_id": grant.sharer_id, "is_self": False,
                      "sharer_name": _sharer(db, grant.sharer_id)["name"]})
    return views


@router.get("/{sharer_id}/transactions", response_model=TransactionListResponse)
def household_transactions(
    sharer_id: int,
    start_date: Optional[datetime] = Query(None),
    end_date: Optional[datetime] = Query(None),
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    grant = _grant(db, current_user, sharer_id)
    scope_ids = [a.id for a in household_svc.household_accounts(db, current_user, grant)]
    query = db.query(Transaction).filter(household_svc.household_transactions_criterion(
        db, current_user, grant, scope_ids))
    if start_date:
        query = query.filter(Transaction.transaction_date >= start_date)
    if end_date:
        query = query.filter(Transaction.transaction_date <= end_date)
    total = query.count()
    rows = (query.order_by(Transaction.transaction_date.desc(), Transaction.id.desc())
            .offset(offset).limit(limit).all())
    return {"items": serialize_transactions(db, current_user, rows), "total": total,
            "has_more": offset + len(rows) < total}


@router.get("/{sharer_id}/upcoming")
def household_upcoming(
    sharer_id: int,
    days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    grant = _grant(db, current_user, sharer_id)
    start, end = _upcoming_window(days, None)
    items = household_svc.household_upcoming(db, current_user, grant, start, end)
    return {"sharer": _sharer(db, sharer_id), "items": items, "days": days}


@router.get("/{sharer_id}/monthly", response_model=HouseholdMonthlyResponse)
def household_monthly(
    sharer_id: int,
    from_: Optional[str] = Query(None, alias="from", pattern=MONTH,
                                 description="First month, YYYY-MM (default: this month)"),
    to: Optional[str] = Query(None, pattern=MONTH,
                              description="Last month, YYYY-MM (default: this month)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    grant = _grant(db, current_user, sharer_id)
    this_month = naive_utc_now().strftime("%Y-%m")
    from_, to = from_ or this_month, to or this_month
    first, last = _month(from_), _month(to)
    span = (last.year - first.year) * 12 + last.month - first.month + 1
    if span < 1 or span > MAX_MONTHS:
        raise HTTPException(status_code=422,
                            detail=f"'from' must not be after 'to', at most {MAX_MONTHS} months")
    months = household_svc.household_monthly(db, current_user, grant, first, last)
    return {"sharer": _sharer(db, sharer_id), "from": from_, "to": to, "months": months}


@router.get("/{sharer_id}/dashboard")
def household_dashboard(
    sharer_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    grant = _grant(db, current_user, sharer_id)
    accounts = household_svc.household_accounts(db, current_user, grant)
    month = naive_utc_now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    [current] = household_svc.household_monthly(db, current_user, grant, month, month)
    start, end = _upcoming_window(30, None)
    return {
        "sharer": _sharer(db, sharer_id),
        "accounts": serialize_accounts(db, current_user, accounts),
        "month": current,
        "upcoming": household_svc.household_upcoming(db, current_user, grant, start, end),
    }

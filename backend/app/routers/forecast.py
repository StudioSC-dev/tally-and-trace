"""Projection views. Each takes ``?tag=`` (``app/core/tags.py``).

With a tag, the projection is built as usual and only the events whose source
carries the tag effectively are kept: a transaction or recurring entry by its
own tags plus its owner's tags on the accounts it is booked on, a card
statement or loan due by the card's or loan's own tags. The scope is the same
(the same accounts and opening balances), so the per-account closings are
today's balances moved by the tagged events alone. A tag the caller can't use
gives the result of a tag with no records, as an unknown id does.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.tags import TAG_FILTER_HELP, filter_tag_id
from app.models.user import User
from app.services import forecast as forecast_svc

router = APIRouter()


@router.get("/cashflow")
def get_cashflow(
    months: int = Query(6, ge=1, le=24, description="Number of months to project"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
):
    """
    Forward-looking cash-flow projection.
    Returns per-period breakdown: income, expenses, unposted debits, net, running balance.
    """
    timeline = forecast_svc.project_cashflow(
        db=db,
        user_id=current_user.id,
        months=months,
        tag_id=filter_tag_id(db, current_user, tag),
    )
    return {"periods": timeline, "months": months}


@router.get("/upcoming")
def get_upcoming(
    days: int = Query(30, ge=1, le=365, description="Look-ahead window in days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
):
    """
    Chronological list of upcoming bills/income from BudgetEntry.next_occurrence
    + unposted transactions within the next N days.
    """
    items = forecast_svc.get_upcoming_items(
        db=db,
        user_id=current_user.id,
        days=days,
        tag_id=filter_tag_id(db, current_user, tag),
    )
    return {"items": items, "days": days}


@router.get("/timeline")
def get_timeline(
    days: int = Query(60, ge=1, le=365, description="Look-ahead window in days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
):
    """
    Dated running-balance timeline (pre-due-date solvency).

    Unlike /cashflow (which nets whole months), this walks every income/payable in
    date order and reports the running balance after each, the trough (lowest point
    + date), and any shortfall — i.e. whether bills due before payday can be covered
    with funds on hand. Available cash excludes credit-card balances.
    """
    result = forecast_svc.project_running_balance(
        db=db,
        user_id=current_user.id,
        days=days,
        tag_id=filter_tag_id(db, current_user, tag),
    )
    return forecast_svc.serialize_timeline(result)


@router.get("/disposable")
def get_disposable(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
):
    """
    Monthly net disposable income =
    total recurring monthly income − total recurring monthly expenses
    (each cadence is normalized to a monthly equivalent).
    """
    result = forecast_svc.get_disposable_income(
        db=db,
        user_id=current_user.id,
        tag_id=filter_tag_id(db, current_user, tag),
    )
    return result

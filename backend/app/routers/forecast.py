"""Projection views. Each takes ``?tag=`` (``app/core/tags.py``).

With a tag, the projection is built as usual and only the events whose source
carries the tag effectively are kept: a transaction or recurring entry by its
own tags plus its owner's tags on the accounts it is booked on, a card
statement or loan due by the card's or loan's own tags. The scope is the same
(the same accounts and opening balances), so the per-account closings are
today's balances moved by the tagged events alone. A tag the caller can't use
gives the result of a tag with no records, as an unknown id does.

Every projection is split by account currency (STU-236): the scalars are the
user's default currency, ``by_currency`` carries one row per currency (default
first), full listed rows carry their ``currency`` and, when estimated at a
stored rate, the estimate labels, and ``currencies`` and ``fx`` describe the
response. ``/upcoming`` has no totals, so no ``by_currency``.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.tags import TAG_FILTER_HELP, filter_tag_id
from app.models.user import User
from app.services import forecast as forecast_svc
from app.services.fx import FxRates, get_fx

router = APIRouter()


@router.get("/cashflow")
def get_cashflow(
    months: int = Query(6, ge=1, le=24, description="Number of months to project"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
    fx: FxRates = Depends(get_fx),
):
    """
    Forward-looking cash-flow projection.
    Returns per-period breakdown: income, expenses, unposted debits, net, running balance.
    """
    result = forecast_svc.cashflow_by_currency(
        db=db,
        user_id=current_user.id,
        months=months,
        tag_id=filter_tag_id(db, current_user, tag),
        fx=fx,
    )
    return {"periods": result["periods"], "months": months,
            "currencies": result["currencies"], "fx": result["fx"]}


@router.get("/upcoming")
def get_upcoming(
    days: int = Query(30, ge=1, le=365, description="Look-ahead window in days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
    fx: FxRates = Depends(get_fx),
):
    """
    Chronological list of upcoming bills/income from BudgetEntry.next_occurrence
    + unposted transactions within the next N days.
    """
    result = forecast_svc.upcoming_by_currency(
        db=db,
        user_id=current_user.id,
        days=days,
        tag_id=filter_tag_id(db, current_user, tag),
        fx=fx,
    )
    return {"items": result["items"], "days": days, "currencies": result["currencies"],
            "fx": result["fx"]}


@router.get("/timeline")
def get_timeline(
    days: int = Query(60, ge=1, le=365, description="Look-ahead window in days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
    fx: FxRates = Depends(get_fx),
):
    """
    Dated running-balance timeline (pre-due-date solvency).

    Unlike /cashflow (which nets whole months), this walks every income/payable in
    date order and reports the running balance after each, the trough (lowest point
    + date), and any shortfall — i.e. whether bills due before payday can be covered
    with funds on hand. Available cash excludes credit-card balances.
    """
    return forecast_svc.timeline_by_currency(
        db=db,
        user_id=current_user.id,
        days=days,
        tag_id=filter_tag_id(db, current_user, tag),
        fx=fx,
    )


@router.get("/disposable")
def get_disposable(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
    fx: FxRates = Depends(get_fx),
):
    """
    Monthly net disposable income =
    total recurring monthly income − total recurring monthly expenses
    (each cadence is normalized to a monthly equivalent), plus money moved in
    minus money moved out across currencies, per currency.
    """
    return forecast_svc.disposable_by_currency(
        db=db,
        user_id=current_user.id,
        tag_id=filter_tag_id(db, current_user, tag),
        fx=fx,
    )

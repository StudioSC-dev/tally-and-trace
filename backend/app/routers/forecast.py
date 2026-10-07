from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.entity_context import get_active_entity
from app.models.entity import Entity
from app.models.user import User
from app.services import forecast as forecast_svc

router = APIRouter()


@router.get("/cashflow")
def get_cashflow(
    months: int = Query(6, ge=1, le=24, description="Number of months to project"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """
    Forward-looking cash-flow projection.
    Returns per-period breakdown: income, expenses, unposted debits, net, running balance.
    """
    entity_id = active_entity.id if active_entity else None
    timeline = forecast_svc.project_cashflow(
        db=db,
        user_id=current_user.id,
        entity_id=entity_id,
        months=months,
    )
    return {"periods": timeline, "months": months}


@router.get("/upcoming")
def get_upcoming(
    days: int = Query(30, ge=1, le=365, description="Look-ahead window in days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """
    Chronological list of upcoming bills/income from BudgetEntry.next_occurrence
    + unposted transactions within the next N days.
    """
    entity_id = active_entity.id if active_entity else None
    items = forecast_svc.get_upcoming_items(
        db=db,
        user_id=current_user.id,
        entity_id=entity_id,
        days=days,
    )
    return {"items": items, "days": days}


@router.get("/timeline")
def get_timeline(
    days: int = Query(60, ge=1, le=365, description="Look-ahead window in days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """
    Dated running-balance timeline (pre-due-date solvency).

    Unlike /cashflow (which nets whole months), this walks every income/payable in
    date order and reports the running balance after each, the trough (lowest point
    + date), and any shortfall — i.e. whether bills due before payday can be covered
    with funds on hand. Available cash excludes credit-card balances.
    """
    entity_id = active_entity.id if active_entity else None
    result = forecast_svc.project_running_balance(
        db=db,
        user_id=current_user.id,
        entity_id=entity_id,
        days=days,
    )
    return forecast_svc.serialize_timeline(result)


@router.get("/disposable")
def get_disposable(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """
    Monthly net disposable income =
    total recurring monthly income − total recurring monthly expenses
    (each cadence is normalized to a monthly equivalent).
    """
    entity_id = active_entity.id if active_entity else None
    result = forecast_svc.get_disposable_income(
        db=db,
        user_id=current_user.id,
        entity_id=entity_id,
    )
    return result

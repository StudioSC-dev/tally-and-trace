from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.models.user import User
from app.services import forecast as forecast_svc

router = APIRouter()


@router.get("/cashflow")
def get_cashflow(
    months: int = Query(6, ge=1, le=24, description="Number of months to project"),
    entity_id: Optional[int] = Query(None, description="Entity context"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Forward-looking cash-flow projection.
    Returns per-period breakdown: income, expenses, unposted debits, net, running balance.
    """
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
    entity_id: Optional[int] = Query(None, description="Entity context"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Chronological list of upcoming bills/income from BudgetEntry.next_occurrence
    + unposted transactions within the next N days.
    """
    items = forecast_svc.get_upcoming_items(
        db=db,
        user_id=current_user.id,
        entity_id=entity_id,
        days=days,
    )
    return {"items": items, "days": days}


@router.get("/disposable")
def get_disposable(
    entity_id: Optional[int] = Query(None, description="Entity context"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Monthly net disposable income =
    total recurring monthly income − total recurring monthly expenses
    (each cadence is normalized to a monthly equivalent).
    """
    result = forecast_svc.get_disposable_income(
        db=db,
        user_id=current_user.id,
        entity_id=entity_id,
    )
    return result

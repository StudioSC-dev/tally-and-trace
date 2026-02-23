"""
Unified dashboard snapshot endpoint for Tally & Trace.
Returns everything the front-end needs in a single call.
"""
import math
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.models.account import Account
from app.models.allocation import Allocation, AllocationType
from app.models.user import User
from app.models.wishlist_item import WishlistItem
from app.services import forecast as forecast_svc

router = APIRouter()

SAVINGS_RATE_FACTOR = 0.5


@router.get("/snapshot")
def get_snapshot(
    entity_id: Optional[int] = Query(None, description="Entity context"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Single-call snapshot returning:
    - Account balances
    - Upcoming items this month
    - Monthly income/expense summary
    - 3-month cash-flow forecast
    - Goal progress
    - Top 3 wishlist items with readiness advisory
    """
    # -----------------------------------------------------------------------
    # 1. Account balances
    # -----------------------------------------------------------------------
    accounts = forecast_svc.get_account_balances(db, current_user.id, entity_id)
    total_balance = sum(a.balance for a in accounts)
    by_account = [
        {"id": a.id, "name": a.name, "balance": a.balance, "currency": a.currency.value}
        for a in accounts
    ]

    # -----------------------------------------------------------------------
    # 2. Upcoming this month (next 30 days)
    # -----------------------------------------------------------------------
    upcoming = forecast_svc.get_upcoming_items(db, current_user.id, entity_id, days=30)

    # -----------------------------------------------------------------------
    # 3. Monthly income/expense summary (disposable income)
    # -----------------------------------------------------------------------
    disposable_data = forecast_svc.get_disposable_income(db, current_user.id, entity_id)

    # -----------------------------------------------------------------------
    # 4. 3-month cash-flow forecast
    # -----------------------------------------------------------------------
    forecast_3m = forecast_svc.project_cashflow(db, current_user.id, entity_id, months=3)

    # -----------------------------------------------------------------------
    # 5. Goals progress
    # -----------------------------------------------------------------------
    goals_query = db.query(Allocation).filter(
        Allocation.user_id == current_user.id,
        Allocation.allocation_type == AllocationType.GOAL,
        Allocation.is_active == True,
    )
    if entity_id is not None:
        goals_query = goals_query.filter(Allocation.entity_id == entity_id)

    goals_progress = []
    for goal in goals_query.all():
        if goal.target_amount and goal.target_amount > 0:
            progress_pct = round((goal.current_amount / goal.target_amount) * 100, 1)
            remaining = round(max(goal.target_amount - goal.current_amount, 0), 2)
        else:
            progress_pct = 0.0
            remaining = 0.0
        goals_progress.append({
            "id": goal.id,
            "name": goal.name,
            "target_amount": goal.target_amount,
            "current_amount": goal.current_amount,
            "progress_pct": progress_pct,
            "remaining": remaining,
        })

    # -----------------------------------------------------------------------
    # 6. Top 3 wishlist items (unpurchased) with affordability
    # -----------------------------------------------------------------------
    monthly_disposable = disposable_data["monthly_disposable"]
    savings_rate = max(monthly_disposable * SAVINGS_RATE_FACTOR, 0.01)

    from sqlalchemy import case
    priority_order = case(
        {"critical": 0, "high": 1, "medium": 2, "low": 3},
        value=WishlistItem.priority,
    )
    wishlist_items = (
        db.query(WishlistItem)
        .filter(
            WishlistItem.user_id == current_user.id,
            WishlistItem.is_purchased == False,
        )
        .order_by(priority_order, WishlistItem.created_at)
        .limit(3)
        .all()
    )

    from datetime import timedelta
    wishlist_next_up = []
    for item in wishlist_items:
        months_needed = math.ceil(item.estimated_cost / savings_rate)
        affordable_by = (datetime.utcnow() + timedelta(days=months_needed * 30)).date().isoformat()
        wishlist_next_up.append({
            "id": item.id,
            "name": item.name,
            "cost": item.estimated_cost,
            "priority": item.priority.value,
            "affordable_by": affordable_by,
        })

    return {
        "balances": {
            "total": round(total_balance, 2),
            "by_account": by_account,
        },
        "upcoming_this_month": upcoming,
        "monthly_summary": disposable_data,
        "forecast_next_3_months": forecast_3m,
        "goals_progress": goals_progress,
        "wishlist_next_up": wishlist_next_up,
    }

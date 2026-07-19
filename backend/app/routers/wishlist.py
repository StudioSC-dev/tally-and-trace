import math
from datetime import timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.entity_context import (
    get_accessible_or_404,
    get_active_entity,
    scope_criterion,
    validate_entity_ownership,
)
from app.models.entity import Entity
from app.models.user import User
from app.models.wishlist_item import WishlistItem
from app.schemas.wishlist import (
    WishlistItemCreate,
    WishlistItemResponse,
    WishlistItemUpdate,
    WishlistPlanItem,
    WishlistPlanResponse,
    WishlistReadiness,
)
from app.services import forecast as forecast_svc
from app.core.time import utc_now

router = APIRouter()

SAVINGS_RATE_FACTOR = 0.5  # Assume 50% of disposable income goes to wishlist savings


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[WishlistItemResponse])
def list_wishlist(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    is_purchased: Optional[bool] = Query(None),
):
    """List wishlist items, sorted by priority then created_at."""
    from sqlalchemy import case
    priority_order = case(
        {"critical": 0, "high": 1, "medium": 2, "low": 3},
        value=WishlistItem.priority,
    )
    # Was an UNVALIDATED entity_id query param (Session 13 missed this router); now
    # goes through get_active_entity, which verifies membership before scoping.
    query = db.query(WishlistItem).filter(
        scope_criterion(WishlistItem, current_user.id, active_entity.id if active_entity else None)
    )
    if is_purchased is not None:
        query = query.filter(WishlistItem.is_purchased == is_purchased)
    return query.order_by(priority_order, WishlistItem.created_at).all()


@router.post("/", response_model=WishlistItemResponse, status_code=status.HTTP_201_CREATED)
def create_wishlist_item(
    payload: WishlistItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    item_data = payload.dict()
    if item_data.get("entity_id") is None and active_entity is not None:
        item_data["entity_id"] = active_entity.id
    else:
        validate_entity_ownership(db, current_user, item_data.get("entity_id"))

    item = WishlistItem(**item_data, user_id=current_user.id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/plan", response_model=WishlistPlanResponse)
def get_wishlist_plan(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """
    Sequential purchase timeline for all unpurchased items ordered by priority.
    Each item is scheduled after the previous one has been saved up for.
    """
    entity_id = active_entity.id if active_entity else None
    disposable_data = forecast_svc.get_disposable_income(db, current_user.id, entity_id)
    monthly_disposable = disposable_data["monthly_disposable"]
    savings_rate = max(monthly_disposable * SAVINGS_RATE_FACTOR, 0.01)

    from sqlalchemy import case
    priority_order = case(
        {"critical": 0, "high": 1, "medium": 2, "low": 3},
        value=WishlistItem.priority,
    )
    items = (
        db.query(WishlistItem)
        .filter(
            scope_criterion(WishlistItem, current_user.id, entity_id),
            WishlistItem.is_purchased.is_(False),
        )
        .order_by(priority_order, WishlistItem.created_at)
        .all()
    )

    now = utc_now()
    cumulative_months = 0
    plan: List[WishlistPlanItem] = []

    for item in items:
        months_needed = math.ceil(float(item.estimated_cost) / savings_rate)
        cumulative_months += months_needed
        purchase_date = now + timedelta(days=cumulative_months * 30)
        plan.append(
            WishlistPlanItem(
                item_id=item.id,
                name=item.name,
                estimated_cost=item.estimated_cost,
                estimated_purchase_date=purchase_date.date().isoformat(),
                cumulative_months=cumulative_months,
            )
        )

    return WishlistPlanResponse(
        monthly_disposable=monthly_disposable,
        savings_rate=savings_rate,
        items=plan,
    )


@router.get("/{item_id}", response_model=WishlistItemResponse)
def get_wishlist_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    return get_accessible_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")


@router.put("/{item_id}", response_model=WishlistItemResponse)
def update_wishlist_item(
    item_id: int,
    payload: WishlistItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    item = get_accessible_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")

    update_data = payload.dict(exclude_unset=True)
    if update_data.get("is_purchased") and not item.is_purchased:
        update_data.setdefault("purchased_at", utc_now())
    for field, value in update_data.items():
        setattr(item, field, value)
    item.updated_at = utc_now()
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_wishlist_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    item = get_accessible_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")
    db.delete(item)
    db.commit()


@router.get("/{item_id}/readiness", response_model=WishlistReadiness)
def get_readiness(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """
    Advisory: Given disposable income, calculate when the user can afford this item.
    """
    item = get_accessible_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")

    entity_id = active_entity.id if active_entity else None
    disposable_data = forecast_svc.get_disposable_income(db, current_user.id, entity_id)
    monthly_disposable = disposable_data["monthly_disposable"]
    savings_rate = monthly_disposable * SAVINGS_RATE_FACTOR

    if savings_rate <= 0:
        months_needed = 9999
        affordable_now = False
    else:
        months_needed = math.ceil(float(item.estimated_cost) / savings_rate)
        affordable_now = float(item.estimated_cost) <= monthly_disposable

    estimated_date = (utc_now() + timedelta(days=months_needed * 30)).date().isoformat()

    return WishlistReadiness(
        item_id=item.id,
        name=item.name,
        estimated_cost=item.estimated_cost,
        monthly_disposable=monthly_disposable,
        savings_rate=savings_rate,
        months_needed=months_needed,
        estimated_purchase_date=estimated_date,
        affordable_now=affordable_now,
    )

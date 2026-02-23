from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.account import Account
from app.models.category import Category
from app.models.allocation import Allocation
from app.models.user import User
from app.schemas.budget_entry import (
    BudgetEntryCreate,
    BudgetEntryUpdate,
    BudgetEntryResponse,
    BudgetEntryListResponse,
)

router = APIRouter()


def _ensure_related_resources(
    *,
    db: Session,
    user_id: int,
    account_id: Optional[int],
    category_id: Optional[int],
    allocation_id: Optional[int],
):
    if account_id:
        account = (
            db.query(Account)
            .filter(Account.id == account_id, Account.user_id == user_id)
            .first()
        )
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
    if category_id:
        category = (
            db.query(Category)
            .filter(Category.id == category_id, Category.user_id == user_id)
            .first()
        )
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
    if allocation_id:
        allocation = (
            db.query(Allocation)
            .filter(Allocation.id == allocation_id, Allocation.user_id == user_id)
            .first()
        )
        if not allocation:
            raise HTTPException(status_code=404, detail="Allocation not found")


@router.get("/", response_model=BudgetEntryListResponse)
def list_budget_entries(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    entry_type: Optional[BudgetEntryType] = Query(
        None, description="Filter by entry type (income or expense)"
    ),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    entity_id: Optional[int] = Query(None, description="Filter by entity ID"),
    before: Optional[datetime] = Query(
        None, description="Filter entries occurring before this datetime"
    ),
    after: Optional[datetime] = Query(
        None, description="Filter entries occurring after this datetime"
    ),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    query = db.query(BudgetEntry).filter(BudgetEntry.user_id == current_user.id)

    if entity_id is not None:
        query = query.filter(BudgetEntry.entity_id == entity_id)
    if entry_type:
        query = query.filter(BudgetEntry.entry_type == entry_type)
    if is_active is not None:
        query = query.filter(BudgetEntry.is_active == is_active)
    if before is not None:
        query = query.filter(BudgetEntry.next_occurrence <= before)
    if after is not None:
        query = query.filter(BudgetEntry.next_occurrence >= after)

    total = query.count()
    entries = (
        query.order_by(BudgetEntry.next_occurrence.asc(), BudgetEntry.id.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    return BudgetEntryListResponse(
        items=entries,
        total=total,
        has_more=(offset + len(entries)) < total,
    )


@router.get("/{entry_id}", response_model=BudgetEntryResponse)
def get_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = (
        db.query(BudgetEntry)
        .filter(BudgetEntry.id == entry_id, BudgetEntry.user_id == current_user.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    return entry


@router.post("/", response_model=BudgetEntryResponse, status_code=201)
def create_budget_entry(
    entry_in: BudgetEntryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    _ensure_related_resources(
        db=db,
        user_id=current_user.id,
        account_id=entry_in.account_id,
        category_id=entry_in.category_id,
        allocation_id=entry_in.allocation_id,
    )

    entry_data = entry_in.dict()
    entry_data["user_id"] = current_user.id
    entry_data["end_mode"] = entry_data.get("end_mode", "indefinite").lower()
    entry = BudgetEntry(**entry_data)

    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.put("/{entry_id}", response_model=BudgetEntryResponse)
def update_budget_entry(
    entry_id: int,
    entry_update: BudgetEntryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = (
        db.query(BudgetEntry)
        .filter(BudgetEntry.id == entry_id, BudgetEntry.user_id == current_user.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Budget entry not found")

    prospective_data = entry_update.dict(exclude_unset=True)
    _ensure_related_resources(
        db=db,
        user_id=current_user.id,
        account_id=prospective_data.get("account_id", entry.account_id),
        category_id=prospective_data.get("category_id", entry.category_id),
        allocation_id=prospective_data.get("allocation_id", entry.allocation_id),
    )
    if "end_mode" in prospective_data and prospective_data["end_mode"] is not None:
        prospective_data["end_mode"] = prospective_data["end_mode"].lower()

    for field, value in prospective_data.items():
        setattr(entry, field, value)

    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = (
        db.query(BudgetEntry)
        .filter(BudgetEntry.id == entry_id, BudgetEntry.user_id == current_user.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Budget entry not found")

    db.delete(entry)
    db.commit()


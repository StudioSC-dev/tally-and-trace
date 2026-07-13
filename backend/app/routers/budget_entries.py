from calendar import monthrange
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
from app.models.transaction import RecurrenceFrequency, TransactionType
from app.models.user import User
from app.schemas.budget_entry import (
    BudgetEntryCreate,
    BudgetEntryUpdate,
    BudgetEntryResponse,
    BudgetEntryListResponse,
    BudgetEntryMaterialize,
)
from app.schemas.transaction import TransactionResponse

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


def _advance_occurrence(entry: BudgetEntry, current: datetime) -> datetime:
    """Return the occurrence following ``current`` for this entry's cadence."""
    from app.services.forecast import _next_occurrence

    if entry.cadence == RecurrenceFrequency.SEMI_MONTHLY:
        d1 = entry.semi_monthly_day_1 or 1
        d2 = entry.semi_monthly_day_2 or 15
        days = sorted({d1, d2})
        months = [(current.year, current.month)]
        months.append((current.year + 1, 1) if current.month == 12 else (current.year, current.month + 1))
        candidates = []
        for (y, m) in months:
            last = monthrange(y, m)[1]
            for d in days:
                candidates.append(current.replace(year=y, month=m, day=min(d, last)))
        future = sorted(c for c in candidates if c > current)
        return future[0] if future else _next_occurrence(current, RecurrenceFrequency.MONTHLY)

    return _next_occurrence(current, entry.cadence)


@router.post("/{entry_id}/materialize", response_model=TransactionResponse, status_code=201)
def materialize_budget_entry(
    entry_id: int,
    payload: BudgetEntryMaterialize = BudgetEntryMaterialize(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Post a due recurring entry as an actual transaction and advance its schedule.

    Reuses the transaction-create path (so account balances and budget-allocation
    deltas stay consistent), then moves ``next_occurrence`` to the following one —
    deactivating the entry when it passes its end date or exhausts its occurrences.
    """
    from app.routers.transactions import create_transaction
    from app.schemas.transaction import TransactionCreate

    entry = (
        db.query(BudgetEntry)
        .filter(BudgetEntry.id == entry_id, BudgetEntry.user_id == current_user.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    if not entry.account_id:
        raise HTTPException(status_code=400, detail="This entry has no account to post to")

    occurrence_date = payload.transaction_date or entry.next_occurrence
    amount = payload.amount if payload.amount is not None else entry.amount
    txn_type = (
        TransactionType.CREDIT if entry.entry_type == BudgetEntryType.INCOME else TransactionType.DEBIT
    )

    txn_create = TransactionCreate(
        account_id=entry.account_id,
        amount=amount,
        currency=entry.currency,
        transaction_type=txn_type,
        transaction_date=occurrence_date,
        category_id=entry.category_id,
        allocation_id=entry.allocation_id,
        entity_id=entry.entity_id,
        budget_entry_id=entry.id,
        description=entry.name,
        is_posted=True,
    )
    db_txn = create_transaction(transaction=txn_create, db=db, current_user=current_user)

    if payload.advance:
        next_occ = _advance_occurrence(entry, entry.next_occurrence)
        deactivate = False
        if entry.end_mode == "on_date" and entry.end_date and next_occ > entry.end_date:
            deactivate = True
        if entry.end_mode == "after_occurrences" and entry.max_occurrences is not None:
            entry.max_occurrences = max(entry.max_occurrences - 1, 0)
            if entry.max_occurrences <= 0:
                deactivate = True
        if deactivate:
            entry.is_active = False
        else:
            entry.next_occurrence = next_occ
        entry.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(db_txn)

    return db_txn


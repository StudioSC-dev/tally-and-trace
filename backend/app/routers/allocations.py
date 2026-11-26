from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Iterable, List, Optional
from app.core import locking
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.access import (
    OWNER_ROLES, get_account_or_404, get_owned_or_404, owned_criterion, require_owned_ref,
)
from app.models.category import Category
from app.models.allocation import Allocation, AllocationType
from app.schemas.allocation import (
    MULTI_ACCOUNT, TRANSACTION_TOTAL, AllocationCreate, AllocationResponse, AllocationUpdate, AllocationListResponse,
    AllocationRankedResponse, AllocationRankOrder, account_rule_error, goal_mode,
)
from app.models.user import CurrencyType, User
from app.core.time import utc_now
from app.routers.transactions import _lock_allocations, _recompute_budget_total
from app.services import allocation_rank
from app.services.fx import FxRates, get_fx
from app.services.savings_progress import progress_for

router = APIRouter()


def _ids(value, detail: str) -> list:
    """Configuration ids as ints; anything else is a 400."""
    try:
        return [int(v) for v in value]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=detail)


def _validate_configuration(db: Session, user: User, configuration) -> None:
    """Same-owner rule for the ids in an allocation's configuration.

    ``category_ids``, ``account_ids`` and ``savings_category_id`` must all be
    the caller's own (allocations are never shared, so the caller is the owner).
    """
    if not configuration:
        return
    for category_id in _ids(configuration.get("category_ids") or [],
                            "configuration.category_ids must be a list of ids"):
        require_owned_ref(db, Category, category_id, "Category not found", user)
    for account_id in _ids(configuration.get("account_ids") or [],
                           "configuration.account_ids must be a list of ids"):
        get_account_or_404(db, user, account_id, roles=OWNER_ROLES)
    savings = configuration.get("savings_category_id")
    if savings is not None:
        (savings_id,) = _ids([savings], "configuration.savings_category_id must be an id")
        require_owned_ref(db, Category, savings_id, "Category not found", user)

def _first_aggregated_account(allocation_type, configuration) -> Optional[int]:
    """A ``multi_account`` savings allocation's stored account: its first aggregated one."""
    if allocation_type != AllocationType.SAVINGS or goal_mode(configuration) != MULTI_ACCOUNT:
        return None
    (first,) = _ids(configuration["account_ids"][:1],
                    "configuration.account_ids must be a list of ids")
    return first

def _responses(db: Session, allocations: Iterable[Allocation],
               fx: FxRates) -> List[AllocationResponse]:
    """The allocations as responses: savings ones with their calculated progress."""
    allocations = list(allocations)
    progress = progress_for(db, allocations, fx)
    bodies = []
    for allocation in allocations:
        body = AllocationResponse.model_validate(allocation)
        if allocation.id in progress:
            body = body.model_copy(update=progress[allocation.id].as_fields())
        bodies.append(body)
    return bodies

@router.get("/", response_model=AllocationListResponse)
def get_allocations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    allocation_type: Optional[str] = Query(None, description="Filter by allocation type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    ranked: Optional[bool] = Query(None, description="Only ranked goals (true) or only the others (false)"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    fx: FxRates = Depends(get_fx),
):
    """Get all allocations with optional filtering"""
    # Allocations are never shared: the caller's own only.
    query = db.query(Allocation).filter(owned_criterion(Allocation, current_user))

    if account_id:
        query = query.filter(Allocation.account_id == account_id)
    if allocation_type:
        # Convert string to enum
        try:
            allocation_type_enum = AllocationType(allocation_type.lower())
            query = query.filter(Allocation.allocation_type == allocation_type_enum)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid allocation type: {allocation_type}")
    if is_active is not None:
        query = query.filter(Allocation.is_active == is_active)
    if ranked is not None:
        # Ranked rows are the ones holding a rank (STU-786); totals and pages follow.
        query = query.filter(Allocation.rank.is_not(None) if ranked else Allocation.rank.is_(None))

    total = query.count()
    allocations = (
        query.order_by(Allocation.created_at.desc(), Allocation.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(allocations) < total
    return {"items": _responses(db, allocations, fx), "total": total, "has_more": has_more}

@router.get("/ranked", response_model=AllocationRankedResponse)
def get_ranked_allocations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """All of the caller's ranked goals, top first. Never paged (STU-786)."""
    allocations = allocation_rank.ranked_for(db, current_user.id)
    return {"items": _responses(db, allocations, fx)}

@router.put("/ranked", response_model=AllocationRankedResponse)
def reorder_ranked_allocations(
    order: AllocationRankOrder,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Set the caller's ranked goals to the given complete order (STU-786)."""
    allocations = allocation_rank.reorder(db, current_user.id, order.ids)
    db.commit()
    return {"items": _responses(db, allocations, fx)}

@router.post("/", response_model=AllocationResponse)
def create_allocation(
    allocation: AllocationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Create a new allocation"""
    # Allocations are never shared: the caller is the owner (STU-222).
    locking.lock_owner_budgets(db, current_user.id)
    _validate_configuration(db, current_user, allocation.configuration)
    allocation_data = allocation.dict()
    first = _first_aggregated_account(allocation.allocation_type, allocation.configuration)
    if first is not None:
        allocation_data["account_id"] = first
    if allocation.allocation_type == AllocationType.SAVINGS:
        # A savings figure is calculated on read (STU-777): a sent one is ignored.
        allocation_data["current_amount"] = 0
    # An allocation is the owner's: its account must be the caller's own.
    account = None
    if allocation_data["account_id"] is not None:
        account = get_account_or_404(db, current_user, allocation_data["account_id"],
                                     roles=OWNER_ROLES)
    if allocation_data["currency"] is None:
        # Unsent: a savings allocation tracking its account(s) takes the (first)
        # account's currency, anything else the owner's default currency, or PHP
        # without one (STU-777). The caller is always the owner.
        tracks_account = (allocation.allocation_type == AllocationType.SAVINGS
                          and goal_mode(allocation.configuration) != TRANSACTION_TOTAL)
        allocation_data["currency"] = (account.currency if tracks_account and account
                                       else current_user.default_currency or CurrencyType.PHP)

    db_allocation = Allocation(**allocation_data, user_id=current_user.id)
    db.add(db_allocation)
    db.flush()
    allocation_rank.sync_membership(db, db_allocation, was_ranked=False)
    if db_allocation.allocation_type == AllocationType.BUDGET:
        # A budget's total is derived from its rows (STU-222): a sent one is ignored.
        _recompute_budget_total(db, db_allocation, [None])
    db.commit()
    db.refresh(db_allocation)
    return _responses(db, [db_allocation], fx)[0]

@router.get("/{allocation_id}", response_model=AllocationResponse)
def get_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Get a specific allocation by ID"""
    allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    return _responses(db, [allocation], fx)[0]

@router.put("/{allocation_id}", response_model=AllocationResponse)
def update_allocation(
    allocation_id: int,
    allocation_update: AllocationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Update an existing allocation"""
    db_allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    db_allocation = apply_allocation_update(
        db, current_user, db_allocation, allocation_update.dict(exclude_unset=True))
    db.commit()
    db.refresh(db_allocation)
    return _responses(db, [db_allocation], fx)[0]

def apply_allocation_update(db: Session, user: User, allocation: Allocation,
                            update_data: dict) -> Allocation:
    """Apply an allocation edit, uncommitted, and return the allocation.

    The owner's budget lock is taken first (allocations are never shared, so the
    caller is the owner), then the allocation row, refreshed, so a membership
    change never races a transaction write discovering that owner's budgets
    (STU-222). A budget's total is derived from its rows: a sent one is ignored
    and the total is recomputed.
    """
    locking.lock_owner_budgets(db, user.id)
    locked = _lock_allocations(db, [allocation])
    if not locked:
        # Deleted between the caller's ownership check and the lock.
        raise HTTPException(status_code=404, detail="Allocation not found")
    (allocation,) = locked
    was_ranked = allocation_rank.is_ranked(allocation.allocation_type, allocation.is_active)
    update_data = dict(update_data)
    if "currency" in update_data and update_data["currency"] is None:
        update_data.pop("currency")  # a null currency is no change, never a null column
    if {"allocation_type", "configuration", "account_id"} & update_data.keys():
        # The account each mode needs (STU-777), judged on the allocation as edited.
        allocation_type = update_data.get("allocation_type", allocation.allocation_type)
        configuration = update_data.get("configuration", allocation.configuration)
        problem = account_rule_error(allocation_type, configuration,
                                     update_data.get("account_id", allocation.account_id))
        if problem:
            raise HTTPException(status_code=422, detail=problem)
        if "configuration" in update_data:
            _validate_configuration(db, user, configuration)
        first = _first_aggregated_account(allocation_type, configuration)
        if first is not None:
            update_data["account_id"] = first
    if "account_id" in update_data and update_data["account_id"] is not None:
        get_account_or_404(db, user, update_data["account_id"], roles=OWNER_ROLES)
    if update_data.get("allocation_type", allocation.allocation_type) in (
            AllocationType.BUDGET, AllocationType.SAVINGS):
        # Budgets' and savings' figures are derived (STU-222, STU-777): a sent one is ignored.
        update_data.pop("current_amount", None)
    for field, value in update_data.items():
        setattr(allocation, field, value)

    allocation.updated_at = utc_now()
    db.flush()
    allocation_rank.sync_membership(db, allocation, was_ranked)
    if allocation.allocation_type == AllocationType.BUDGET:
        _recompute_budget_total(db, allocation, [None])
    return allocation

@router.delete("/{allocation_id}")
def delete_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Soft delete an allocation (mark as inactive)"""
    # The owner's lock first, then the read, so the rank gap closes on current ranks (STU-786).
    locking.lock_owner_budgets(db, current_user.id)
    db_allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    db_allocation.is_active = False
    db_allocation.updated_at = utc_now()
    allocation_rank.clear_and_close_gap(db, db_allocation)
    db.commit()
    return {"message": "Allocation deleted successfully"}

@router.get("/{allocation_id}/progress")
def get_allocation_progress(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Get progress details for an allocation"""
    allocation = get_owned_or_404(db, Allocation, allocation_id, current_user, "Allocation not found")
    # A savings allocation's figure is calculated from its mode (STU-777).
    savings = progress_for(db, [allocation], fx).get(allocation.id)
    current_amount = savings.current_amount if savings else allocation.current_amount
    # Calculate progress percentage
    progress_percentage = 0
    if allocation.target_amount and allocation.target_amount > 0:
        progress_percentage = (current_amount / allocation.target_amount) * 100
    
    # Calculate monthly progress
    monthly_progress = 0
    if allocation.monthly_target:
        from app.models.transaction import Transaction, TransactionType
        # The allocation owner's transactions for it in the current month. Another
        # user's row naming it is a stale reference and never counts.
        start_of_month = datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_of_month = (start_of_month + timedelta(days=32)).replace(day=1) - timedelta(seconds=1)
        
        transactions = db.query(Transaction).filter(
            Transaction.allocation_id == allocation_id,
            Transaction.user_id == allocation.user_id,
            Transaction.transaction_date >= start_of_month,
            Transaction.transaction_date <= end_of_month,
            Transaction.transaction_type == TransactionType.CREDIT
        ).all()
        
        monthly_progress = sum(t.amount for t in transactions)
    
    body = {
        "allocation_id": allocation_id,
        "current_amount": current_amount,
        "target_amount": allocation.target_amount,
        "progress_percentage": round(progress_percentage, 2),
        "monthly_target": allocation.monthly_target,
        "monthly_progress": monthly_progress,
        "remaining_amount": allocation.target_amount - current_amount if allocation.target_amount else 0,
        "target_date": allocation.target_date,
        "days_remaining": (allocation.target_date - datetime.now()).days if allocation.target_date else None
    }
    if savings:
        body.update(savings.as_fields())
    return body

@router.get("/summary/goals")
def get_goals_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get summary of all active goals"""
    goals = (
        db.query(Allocation)
        .filter(
            owned_criterion(Allocation, current_user),
            Allocation.allocation_type == AllocationType.GOAL,
            Allocation.is_active.is_(True),
        )
        .all()
    )
    
    total_target = sum(goal.target_amount or 0 for goal in goals)
    total_current = sum(goal.current_amount for goal in goals)
    total_progress = (total_current / total_target * 100) if total_target > 0 else 0
    
    return {
        "total_goals": len(goals),
        "total_target_amount": total_target,
        "total_current_amount": total_current,
        "total_progress_percentage": round(total_progress, 2),
        "goals": [
            {
                "id": goal.id,
                "name": goal.name,
                "target_amount": goal.target_amount,
                "current_amount": goal.current_amount,
                "progress_percentage": round((goal.current_amount / goal.target_amount * 100) if goal.target_amount else 0, 2),
                "target_date": goal.target_date
            }
            for goal in goals
        ]
    }

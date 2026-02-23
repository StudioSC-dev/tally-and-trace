from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.models.allocation import Allocation, AllocationType
from app.schemas.allocation import AllocationCreate, AllocationResponse, AllocationUpdate, AllocationListResponse
from app.models.account import Account
from app.models.user import User
from datetime import datetime

router = APIRouter()

@router.get("/", response_model=AllocationListResponse)
def get_allocations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    account_id: Optional[int] = Query(None, description="Filter by account ID"),
    allocation_type: Optional[str] = Query(None, description="Filter by allocation type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    entity_id: Optional[int] = Query(None, description="Filter by entity ID"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all allocations with optional filtering"""
    query = db.query(Allocation).filter(Allocation.user_id == current_user.id)

    if entity_id is not None:
        query = query.filter(Allocation.entity_id == entity_id)
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
    
    total = query.count()
    allocations = (
        query.order_by(Allocation.created_at.desc(), Allocation.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(allocations) < total
    return {"items": allocations, "total": total, "has_more": has_more}

@router.post("/", response_model=AllocationResponse)
def create_allocation(
    allocation: AllocationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Create a new allocation"""
    # Verify account exists
    account = (
        db.query(Account)
        .filter(Account.id == allocation.account_id, Account.user_id == current_user.id)
        .first()
    )
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    
    db_allocation = Allocation(**allocation.dict(), user_id=current_user.id)
    db.add(db_allocation)
    db.commit()
    db.refresh(db_allocation)
    return db_allocation

@router.get("/{allocation_id}", response_model=AllocationResponse)
def get_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get a specific allocation by ID"""
    allocation = (
        db.query(Allocation)
        .filter(Allocation.id == allocation_id, Allocation.user_id == current_user.id)
        .first()
    )
    if not allocation:
        raise HTTPException(status_code=404, detail="Allocation not found")
    return allocation

@router.put("/{allocation_id}", response_model=AllocationResponse)
def update_allocation(
    allocation_id: int,
    allocation_update: AllocationUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update an existing allocation"""
    db_allocation = (
        db.query(Allocation)
        .filter(Allocation.id == allocation_id, Allocation.user_id == current_user.id)
        .first()
    )
    if not db_allocation:
        raise HTTPException(status_code=404, detail="Allocation not found")
    
    update_data = allocation_update.dict(exclude_unset=True)
    if "account_id" in update_data and update_data["account_id"] is not None:
        account = (
            db.query(Account)
            .filter(Account.id == update_data["account_id"], Account.user_id == current_user.id)
            .first()
        )
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")
    for field, value in update_data.items():
        setattr(db_allocation, field, value)
    
    db_allocation.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(db_allocation)
    return db_allocation

@router.delete("/{allocation_id}")
def delete_allocation(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Soft delete an allocation (mark as inactive)"""
    db_allocation = (
        db.query(Allocation)
        .filter(Allocation.id == allocation_id, Allocation.user_id == current_user.id)
        .first()
    )
    if not db_allocation:
        raise HTTPException(status_code=404, detail="Allocation not found")
    
    db_allocation.is_active = False
    db_allocation.updated_at = datetime.utcnow()
    db.commit()
    return {"message": "Allocation deleted successfully"}

@router.get("/{allocation_id}/progress")
def get_allocation_progress(
    allocation_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get progress details for an allocation"""
    allocation = (
        db.query(Allocation)
        .filter(Allocation.id == allocation_id, Allocation.user_id == current_user.id)
        .first()
    )
    if not allocation:
        raise HTTPException(status_code=404, detail="Allocation not found")
    
    # Calculate progress percentage
    progress_percentage = 0
    if allocation.target_amount and allocation.target_amount > 0:
        progress_percentage = (allocation.current_amount / allocation.target_amount) * 100
    
    # Calculate monthly progress
    monthly_progress = 0
    if allocation.monthly_target:
        from app.models.transaction import Transaction, TransactionType
        from datetime import datetime, timedelta
        
        # Get transactions for this allocation in the current month
        start_of_month = datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_of_month = (start_of_month + timedelta(days=32)).replace(day=1) - timedelta(seconds=1)
        
        transactions = db.query(Transaction).filter(
            Transaction.allocation_id == allocation_id,
            Transaction.transaction_date >= start_of_month,
            Transaction.transaction_date <= end_of_month,
            Transaction.transaction_type == TransactionType.CREDIT
        ).all()
        
        monthly_progress = sum(t.amount for t in transactions)
    
    return {
        "allocation_id": allocation_id,
        "current_amount": allocation.current_amount,
        "target_amount": allocation.target_amount,
        "progress_percentage": round(progress_percentage, 2),
        "monthly_target": allocation.monthly_target,
        "monthly_progress": monthly_progress,
        "remaining_amount": allocation.target_amount - allocation.current_amount if allocation.target_amount else 0,
        "target_date": allocation.target_date,
        "days_remaining": (allocation.target_date - datetime.now()).days if allocation.target_date else None
    }

@router.get("/summary/goals")
def get_goals_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get summary of all active goals"""
    goals = (
        db.query(Allocation)
        .filter(
            Allocation.user_id == current_user.id,
            Allocation.allocation_type == AllocationType.GOAL,
            Allocation.is_active == True,
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

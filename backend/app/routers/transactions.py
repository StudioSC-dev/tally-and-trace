from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import List, Optional, Set
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.models.transaction import Transaction, TransactionType
from app.schemas.transaction import TransactionCreate, TransactionResponse, TransactionUpdate, TransactionListResponse
from app.models.transaction import RecurrenceFrequency
from app.models.account import Account
from app.models.category import Category
from app.models.user import User
from app.models.budget_entry import BudgetEntry
from app.models.allocation import Allocation, AllocationType
from app.models.allocation import BudgetPeriodFrequency
from datetime import datetime, timedelta
from calendar import monthrange
import os
from app.core.config import settings

router = APIRouter()


def _normalize_reference(reference: Optional[datetime]) -> datetime:
    value = reference or datetime.utcnow()
    return value.replace(tzinfo=None) if value.tzinfo else value


def _start_of_period(reference: datetime, frequency: BudgetPeriodFrequency) -> datetime:
    freq = frequency or BudgetPeriodFrequency.MONTHLY
    base = reference.replace(hour=0, minute=0, second=0, microsecond=0)
    if freq == BudgetPeriodFrequency.DAILY:
        return base
    if freq == BudgetPeriodFrequency.WEEKLY:
        return base - timedelta(days=base.weekday())
    if freq == BudgetPeriodFrequency.MONTHLY:
        return base.replace(day=1)
    if freq == BudgetPeriodFrequency.QUARTERLY:
        quarter = (base.month - 1) // 3
        month = quarter * 3 + 1
        return base.replace(month=month, day=1)
    return base


def _add_months(start: datetime, months: int) -> datetime:
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    day = min(start.day, monthrange(year, month)[1])
    return start.replace(year=year, month=month, day=day)


def _compute_period_end(start: datetime, frequency: BudgetPeriodFrequency) -> datetime:
    freq = frequency or BudgetPeriodFrequency.MONTHLY
    if freq == BudgetPeriodFrequency.DAILY:
        return start + timedelta(days=1)
    if freq == BudgetPeriodFrequency.WEEKLY:
        return start + timedelta(weeks=1)
    if freq == BudgetPeriodFrequency.MONTHLY:
        return _add_months(start, 1)
    if freq == BudgetPeriodFrequency.QUARTERLY:
        return _add_months(start, 3)
    return start


def _compute_previous_start(start: datetime, frequency: BudgetPeriodFrequency) -> datetime:
    freq = frequency or BudgetPeriodFrequency.MONTHLY
    if freq == BudgetPeriodFrequency.DAILY:
        return start - timedelta(days=1)
    if freq == BudgetPeriodFrequency.WEEKLY:
        return start - timedelta(weeks=1)
    if freq == BudgetPeriodFrequency.MONTHLY:
        return _add_months(start, -1)
    if freq == BudgetPeriodFrequency.QUARTERLY:
        return _add_months(start, -3)
    return start


def _ensure_budget_period(allocation: Allocation, reference: Optional[datetime]) -> None:
    frequency = allocation.period_frequency or BudgetPeriodFrequency.MONTHLY
    normalized_reference = _normalize_reference(reference)

    period_start = allocation.period_start
    period_end = allocation.period_end
    if period_start:
        period_start = _normalize_reference(period_start)
    if period_end:
        period_end = _normalize_reference(period_end)

    period_changed = False

    if period_start is None or period_end is None:
        period_start = _start_of_period(normalized_reference, frequency)
        period_end = _compute_period_end(period_start, frequency)
        period_changed = True

    while normalized_reference >= period_end:
        period_start = period_end
        period_end = _compute_period_end(period_start, frequency)
        period_changed = True

    while normalized_reference < period_start:
        previous_start = _compute_previous_start(period_start, frequency)
        period_end = period_start
        period_start = previous_start
        period_changed = True

    if period_changed:
        allocation.current_amount = 0.0

    allocation.period_start = period_start
    allocation.period_end = period_end


def _budget_delta_for_transaction(transaction_type: TransactionType, amount: float) -> float:
    if transaction_type == TransactionType.DEBIT:
        return amount
    if transaction_type == TransactionType.CREDIT:
        return -amount
    return 0.0


def _get_budget_allocations_for_transaction(
    db: Session,
    *,
    user_id: int,
    allocation_id: Optional[int],
    category_id: Optional[int],
) -> List[Allocation]:
    allocations: List[Allocation] = []
    seen: Set[int] = set()

    if allocation_id:
        allocation = (
            db.query(Allocation)
            .filter(
                Allocation.id == allocation_id,
                Allocation.user_id == user_id,
                Allocation.allocation_type == AllocationType.BUDGET,
            )
            .first()
        )
        if allocation:
            allocations.append(allocation)
            seen.add(allocation.id)

    if category_id is not None:
        candidate_budgets = (
            db.query(Allocation)
            .filter(
                Allocation.user_id == user_id,
                Allocation.allocation_type == AllocationType.BUDGET,
            )
            .all()
        )
        for allocation in candidate_budgets:
            if allocation.id in seen:
                continue
            config = allocation.configuration or {}
            raw_category_ids = config.get("category_ids") or []
            normalized_ids: Set[int] = set()
            for value in raw_category_ids:
                try:
                    normalized_ids.add(int(value))
                except (TypeError, ValueError):
                    continue
            if category_id in normalized_ids:
                allocations.append(allocation)
                seen.add(allocation.id)

    return allocations


def _apply_budget_delta(
    allocations: List[Allocation],
    delta: float,
    reference_date: Optional[datetime],
) -> None:
    if not allocations or not delta:
        return

    normalized_reference = _normalize_reference(reference_date)
    now = datetime.utcnow()

    for allocation in allocations:
        if allocation.allocation_type != AllocationType.BUDGET:
            continue
        _ensure_budget_period(allocation, normalized_reference)
        current = allocation.current_amount or 0.0
        allocation.current_amount = current + delta
        allocation.updated_at = now

@router.get("/", response_model=TransactionListResponse)
def get_transactions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    account_ids: Optional[List[int]] = Query(None, alias="account_ids", description="Filter by account IDs"),
    category_ids: Optional[List[int]] = Query(None, alias="category_ids", description="Filter by category IDs"),
    allocation_id: Optional[int] = Query(None, description="Filter by allocation ID"),
    transaction_types: Optional[List[str]] = Query(None, alias="transaction_types", description="Filter by transaction types"),
    start_date: Optional[datetime] = Query(None, description="Start date for filtering"),
    end_date: Optional[datetime] = Query(None, description="End date for filtering"),
    is_reconciled: Optional[bool] = Query(None, description="Filter by reconciliation status"),
    search: Optional[str] = Query(None, description="Search by description"),
    entity_id: Optional[int] = Query(None, description="Filter by entity ID"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all transactions with optional filtering"""
    # First get user's accounts to filter transactions
    user_accounts = db.query(Account).filter(Account.user_id == current_user.id).all()
    user_account_ids = [account.id for account in user_accounts]
    
    query = db.query(Transaction).filter(
        or_(
            Transaction.account_id.in_(user_account_ids),
            Transaction.transfer_from_account_id.in_(user_account_ids),
            Transaction.transfer_to_account_id.in_(user_account_ids)
        )
    )
    
    if entity_id is not None:
        query = query.filter(Transaction.entity_id == entity_id)
    if account_ids:
        query = query.filter(
            or_(
                Transaction.account_id.in_(account_ids),
                Transaction.transfer_from_account_id.in_(account_ids),
                Transaction.transfer_to_account_id.in_(account_ids)
            )
        )
    if category_ids:
        query = query.filter(Transaction.category_id.in_(category_ids))
    if allocation_id:
        query = query.filter(Transaction.allocation_id == allocation_id)
    if transaction_types:
        try:
            allowed_types = [TransactionType(item.lower()) for item in transaction_types]
            query = query.filter(Transaction.transaction_type.in_(allowed_types))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid transaction type provided: {exc}") from exc
    if start_date:
        query = query.filter(Transaction.transaction_date >= start_date)
    if end_date:
        query = query.filter(Transaction.transaction_date <= end_date)
    if is_reconciled is not None:
        query = query.filter(Transaction.is_reconciled == is_reconciled)
    if search:
        query = query.filter(Transaction.description.ilike(f"%{search}%"))

    total = query.count()
    transactions = (
        query.order_by(Transaction.transaction_date.desc(), Transaction.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(transactions) < total
    return {"items": transactions, "total": total, "has_more": has_more}

@router.post("/", response_model=TransactionResponse)
def create_transaction(transaction: TransactionCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Create a new transaction and update account balance"""
    transaction_data = transaction.dict()
    transaction_data["user_id"] = current_user.id
    transaction_data["transfer_fee"] = transaction.transfer_fee or 0.0
    budget_entry: Optional[BudgetEntry] = None

    if transaction.budget_entry_id:
        budget_entry = (
            db.query(BudgetEntry)
            .filter(
                BudgetEntry.id == transaction.budget_entry_id,
                BudgetEntry.user_id == current_user.id,
            )
            .first()
        )
        if not budget_entry:
            raise HTTPException(status_code=404, detail="Budget entry not found")
        transaction_data["budget_entry_id"] = budget_entry.id
    
    if budget_entry:
        transaction_data["is_recurring"] = True
        transaction_data["recurrence_frequency"] = budget_entry.cadence
    else:
        transaction_data["is_recurring"] = False
        transaction_data["recurrence_frequency"] = None
    
    primary_account: Optional[Account] = None
    destination_account: Optional[Account] = None
    
    if transaction.transaction_type == TransactionType.TRANSFER:
        if transaction.transfer_from_account_id is None or transaction.transfer_to_account_id is None:
            raise HTTPException(status_code=400, detail="Transfer transactions require source and destination accounts")
        if transaction.transfer_from_account_id == transaction.transfer_to_account_id:
            raise HTTPException(status_code=400, detail="Transfer accounts must be different")
        if transaction.account_id != transaction.transfer_from_account_id:
            raise HTTPException(status_code=400, detail="For transfers, account_id must match transfer_from_account_id")
        
        primary_account = db.query(Account).filter(
            Account.id == transaction.transfer_from_account_id,
            Account.user_id == current_user.id
        ).first()
        if not primary_account:
            raise HTTPException(status_code=404, detail="Source account not found")
        
        destination_account = db.query(Account).filter(
            Account.id == transaction.transfer_to_account_id,
            Account.user_id == current_user.id
        ).first()
        if not destination_account:
            raise HTTPException(status_code=404, detail="Destination account not found")
        
        if transaction_data.get("currency") is None:
            transaction_data["currency"] = destination_account.currency
        if transaction_data.get("projected_currency") is None and transaction.projected_amount is not None:
            transaction_data["projected_currency"] = destination_account.currency
        if transaction_data.get("original_currency") is None and transaction.original_amount is not None:
            transaction_data["original_currency"] = destination_account.currency
    else:
        primary_account = db.query(Account).filter(
            Account.id == transaction.account_id,
            Account.user_id == current_user.id
        ).first()
        if not primary_account:
            raise HTTPException(status_code=404, detail="Account not found")
        if transaction_data.get("currency") is None:
            transaction_data["currency"] = primary_account.currency
        if transaction_data.get("projected_currency") is None and transaction.projected_amount is not None:
            transaction_data["projected_currency"] = primary_account.currency
        if transaction_data.get("original_currency") is None and transaction.original_amount is not None:
            transaction_data["original_currency"] = transaction_data["currency"]
    
    db_transaction = Transaction(**transaction_data)
    db.add(db_transaction)
    
    if transaction.transaction_type == TransactionType.CREDIT and transaction.is_posted:
        primary_account.balance += transaction.amount
    elif transaction.transaction_type == TransactionType.DEBIT and transaction.is_posted:
        primary_account.balance -= transaction.amount
    elif transaction.transaction_type == TransactionType.TRANSFER and transaction.is_posted:
        transfer_fee = transaction.transfer_fee or 0.0
        primary_account.balance -= (transaction.amount + transfer_fee)
        if destination_account:
            destination_account.balance += transaction.amount

    if transaction.is_posted:
        delta = _budget_delta_for_transaction(transaction.transaction_type, transaction.amount)
        if delta:
            budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=transaction.allocation_id,
                category_id=transaction.category_id,
            )
            _apply_budget_delta(budget_allocations, delta, transaction.transaction_date)
    
    db.commit()
    db.refresh(db_transaction)
    return db_transaction

@router.get("/{transaction_id}", response_model=TransactionResponse)
def get_transaction(transaction_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get a specific transaction by ID"""
    # First get user's accounts to filter transactions
    user_accounts = db.query(Account).filter(Account.user_id == current_user.id).all()
    user_account_ids = [account.id for account in user_accounts]
    
    transaction = db.query(Transaction).filter(
        Transaction.id == transaction_id,
        or_(
            Transaction.account_id.in_(user_account_ids),
            Transaction.transfer_from_account_id.in_(user_account_ids),
            Transaction.transfer_to_account_id.in_(user_account_ids)
        )
    ).first()
    if not transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return transaction

@router.put("/{transaction_id}", response_model=TransactionResponse)
def update_transaction(transaction_id: int, transaction_update: TransactionUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Update an existing transaction and recalculate account balance"""
    # First get user's accounts to filter transactions
    user_accounts = db.query(Account).filter(Account.user_id == current_user.id).all()
    user_account_ids = [account.id for account in user_accounts]
    
    db_transaction = db.query(Transaction).filter(
        Transaction.id == transaction_id,
        or_(
            Transaction.account_id.in_(user_account_ids),
            Transaction.transfer_from_account_id.in_(user_account_ids),
            Transaction.transfer_to_account_id.in_(user_account_ids)
        )
    ).first()
    if not db_transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    
    # Store old values for balance recalculation
    old_amount = db_transaction.amount
    old_type = db_transaction.transaction_type
    old_account_id = db_transaction.account_id
    old_is_posted = db_transaction.is_posted
    old_transfer_fee = db_transaction.transfer_fee or 0.0
    old_transfer_from = db_transaction.transfer_from_account_id
    old_transfer_to = db_transaction.transfer_to_account_id
    old_category_id = db_transaction.category_id
    old_allocation_id = db_transaction.allocation_id
    old_transaction_date = db_transaction.transaction_date
    
    # Reverse previous balance effects if posted
    if old_is_posted:
        if old_type == TransactionType.CREDIT:
            old_account = db.query(Account).filter(Account.id == old_account_id).first()
            if old_account:
                old_account.balance -= old_amount
        elif old_type == TransactionType.DEBIT:
            old_account = db.query(Account).filter(Account.id == old_account_id).first()
            if old_account:
                old_account.balance += old_amount
        elif old_type == TransactionType.TRANSFER:
            if old_transfer_from:
                from_account = db.query(Account).filter(Account.id == old_transfer_from).first()
                if from_account:
                    from_account.balance += old_amount + old_transfer_fee
            if old_transfer_to:
                to_account = db.query(Account).filter(Account.id == old_transfer_to).first()
                if to_account:
                    to_account.balance -= old_amount
        old_budget_delta = _budget_delta_for_transaction(old_type, old_amount)
        if old_budget_delta:
            previous_budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=old_allocation_id,
                category_id=old_category_id,
            )
            _apply_budget_delta(previous_budget_allocations, -old_budget_delta, old_transaction_date)
    
    # Update transaction
    update_data = transaction_update.dict(exclude_unset=True)
    if "budget_entry_id" in update_data:
        new_budget_entry_id = update_data.get("budget_entry_id")
        budget_entry = None
        if new_budget_entry_id:
            budget_entry = (
                db.query(BudgetEntry)
                .filter(
                    BudgetEntry.id == new_budget_entry_id,
                    BudgetEntry.user_id == current_user.id,
                )
                .first()
            )
            if not budget_entry:
                raise HTTPException(status_code=404, detail="Budget entry not found")
        setattr(db_transaction, "budget_entry_id", new_budget_entry_id)
        db_transaction.is_recurring = bool(budget_entry)
        db_transaction.recurrence_frequency = budget_entry.cadence if budget_entry else None
        update_data.pop("budget_entry_id", None)

    update_data.pop("is_recurring", None)
    update_data.pop("recurrence_frequency", None)

    for field, value in update_data.items():
        setattr(db_transaction, field, value)
    
    db_transaction.updated_at = datetime.utcnow()
    db_transaction.transfer_fee = db_transaction.transfer_fee or 0.0
    
    primary_account: Optional[Account] = None
    destination_account: Optional[Account] = None
    
    try:
        if db_transaction.transaction_type == TransactionType.TRANSFER:
            if db_transaction.transfer_from_account_id is None or db_transaction.transfer_to_account_id is None:
                raise HTTPException(status_code=400, detail="Transfer transactions require source and destination accounts")
            if db_transaction.transfer_from_account_id == db_transaction.transfer_to_account_id:
                raise HTTPException(status_code=400, detail="Transfer accounts must be different")
            
            primary_account = db.query(Account).filter(
                Account.id == db_transaction.transfer_from_account_id,
                Account.user_id == current_user.id
            ).first()
            if not primary_account:
                raise HTTPException(status_code=404, detail="Source account not found")
            
            destination_account = db.query(Account).filter(
                Account.id == db_transaction.transfer_to_account_id,
                Account.user_id == current_user.id
            ).first()
            if not destination_account:
                raise HTTPException(status_code=404, detail="Destination account not found")
            
            db_transaction.account_id = db_transaction.transfer_from_account_id
            if db_transaction.currency is None:
                db_transaction.currency = destination_account.currency
            if db_transaction.projected_amount is not None and db_transaction.projected_currency is None:
                db_transaction.projected_currency = destination_account.currency
            if db_transaction.original_amount is not None and db_transaction.original_currency is None:
                db_transaction.original_currency = destination_account.currency
        else:
            primary_account = db.query(Account).filter(
                Account.id == db_transaction.account_id,
                Account.user_id == current_user.id
            ).first()
            if not primary_account:
                raise HTTPException(status_code=404, detail="Account not found")
            if db_transaction.currency is None:
                db_transaction.currency = primary_account.currency
            if db_transaction.projected_amount is not None and db_transaction.projected_currency is None:
                db_transaction.projected_currency = primary_account.currency
            if db_transaction.original_amount is not None and db_transaction.original_currency is None:
                db_transaction.original_currency = db_transaction.currency
    except HTTPException:
        db.rollback()
        raise
    
    # Apply new balance effects if posted
    if db_transaction.is_posted:
        if db_transaction.transaction_type == TransactionType.CREDIT and primary_account:
            primary_account.balance += db_transaction.amount
        elif db_transaction.transaction_type == TransactionType.DEBIT and primary_account:
            primary_account.balance -= db_transaction.amount
        elif db_transaction.transaction_type == TransactionType.TRANSFER and primary_account and destination_account:
            primary_account.balance -= db_transaction.amount + db_transaction.transfer_fee
            destination_account.balance += db_transaction.amount
        new_budget_delta = _budget_delta_for_transaction(db_transaction.transaction_type, db_transaction.amount)
        if new_budget_delta:
            new_budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=db_transaction.allocation_id,
                category_id=db_transaction.category_id,
            )
            _apply_budget_delta(new_budget_allocations, new_budget_delta, db_transaction.transaction_date)
    
    db.commit()
    db.refresh(db_transaction)
    return db_transaction

@router.delete("/{transaction_id}")
def delete_transaction(transaction_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Delete a transaction and update account balance"""
    # First get user's accounts to filter transactions
    user_accounts = db.query(Account).filter(Account.user_id == current_user.id).all()
    user_account_ids = [account.id for account in user_accounts]
    
    db_transaction = db.query(Transaction).filter(
        Transaction.id == transaction_id,
        or_(
            Transaction.account_id.in_(user_account_ids),
            Transaction.transfer_from_account_id.in_(user_account_ids),
            Transaction.transfer_to_account_id.in_(user_account_ids)
        )
    ).first()
    if not db_transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    
    # Update account balances if posted
    if db_transaction.is_posted:
        if db_transaction.transaction_type == TransactionType.CREDIT:
            account = db.query(Account).filter(Account.id == db_transaction.account_id).first()
            if account: account.balance -= db_transaction.amount
        elif db_transaction.transaction_type == TransactionType.DEBIT:
            account = db.query(Account).filter(Account.id == db_transaction.account_id).first()
            if account: account.balance += db_transaction.amount
        elif db_transaction.transaction_type == TransactionType.TRANSFER:
            if db_transaction.transfer_from_account_id:
                from_account = db.query(Account).filter(Account.id == db_transaction.transfer_from_account_id).first()
                if from_account:
                    from_account.balance += db_transaction.amount + (db_transaction.transfer_fee or 0.0)
            if db_transaction.transfer_to_account_id:
                to_account = db.query(Account).filter(Account.id == db_transaction.transfer_to_account_id).first()
                if to_account:
                    to_account.balance -= db_transaction.amount
        budget_delta = _budget_delta_for_transaction(db_transaction.transaction_type, db_transaction.amount)
        if budget_delta:
            budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=db_transaction.allocation_id,
                category_id=db_transaction.category_id,
            )
            _apply_budget_delta(budget_allocations, -budget_delta, db_transaction.transaction_date)
    
    db.delete(db_transaction)
    db.commit()
    return {"message": "Transaction deleted successfully"}

@router.post("/{transaction_id}/upload-receipt")
async def upload_receipt(
    transaction_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Upload a receipt for a transaction"""
    # First get user's accounts to filter transactions
    user_accounts = db.query(Account).filter(Account.user_id == current_user.id).all()
    user_account_ids = [account.id for account in user_accounts]
    
    db_transaction = db.query(Transaction).filter(
        Transaction.id == transaction_id,
        or_(
            Transaction.account_id.in_(user_account_ids),
            Transaction.transfer_from_account_id.in_(user_account_ids),
            Transaction.transfer_to_account_id.in_(user_account_ids)
        )
    ).first()
    if not db_transaction:
        raise HTTPException(status_code=404, detail="Transaction not found")
    
    # Validate file type
    file_extension = file.filename.split(".")[-1].lower()
    if file_extension not in settings.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400, 
            detail=f"File type not allowed. Allowed types: {', '.join(settings.ALLOWED_EXTENSIONS)}"
        )
    
    # Create upload directory if it doesn't exist
    upload_dir = os.path.join(settings.UPLOAD_DIR, "receipts")
    os.makedirs(upload_dir, exist_ok=True)
    
    # Save file
    filename = f"receipt_{transaction_id}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.{file_extension}"
    file_path = os.path.join(upload_dir, filename)
    
    with open(file_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)
    
    # Update transaction with receipt URL
    db_transaction.receipt_url = f"/uploads/receipts/{filename}"
    db.commit()
    
    return {"message": "Receipt uploaded successfully", "file_url": db_transaction.receipt_url}

@router.get("/summary/period")
def get_transaction_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    start_date: datetime = Query(..., description="Start date for summary"),
    end_date: datetime = Query(..., description="End date for summary"),
    account_id: Optional[int] = Query(None, description="Filter by account ID")
):
    """Get transaction summary for a specific period"""
    # First get user's accounts to filter transactions
    user_accounts = db.query(Account).filter(Account.user_id == current_user.id).all()
    user_account_ids = [account.id for account in user_accounts]
    
    query = db.query(Transaction).filter(
        Transaction.transaction_date >= start_date,
        Transaction.transaction_date <= end_date,
        or_(
            Transaction.account_id.in_(user_account_ids),
            Transaction.transfer_from_account_id.in_(user_account_ids),
            Transaction.transfer_to_account_id.in_(user_account_ids)
        )
    )
    
    if account_id:
        query = query.filter(Transaction.account_id == account_id)
    
    transactions = [t for t in query.all() if t.is_posted]
    
    total_income = sum(t.amount for t in transactions if t.transaction_type == TransactionType.CREDIT)
    total_expenses = sum(t.amount for t in transactions if t.transaction_type == TransactionType.DEBIT)
    net_flow = total_income - total_expenses
    
    # Group by category
    category_summary = {}
    for transaction in transactions:
        if transaction.transaction_type == TransactionType.TRANSFER:
            continue
        if transaction.category_id:
            category = db.query(Category).filter(Category.id == transaction.category_id).first()
            category_name = category.name if category else "Uncategorized"
            if category_name not in category_summary:
                category_summary[category_name] = {"income": 0, "expenses": 0}
            
            if transaction.transaction_type == TransactionType.CREDIT:
                category_summary[category_name]["income"] += transaction.amount
            else:
                category_summary[category_name]["expenses"] += transaction.amount
    
    return {
        "period": {
            "start_date": start_date,
            "end_date": end_date
        },
        "summary": {
            "total_income": total_income,
            "total_expenses": total_expenses,
            "net_flow": net_flow,
            "transaction_count": len(transactions)
        },
        "category_breakdown": category_summary
    }

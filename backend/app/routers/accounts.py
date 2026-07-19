from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.entity_context import (
    can_access_record,
    get_accessible_or_404,
    get_active_entity,
    scope_criterion,
    validate_entity_ownership,
)
from app.models.account import Account, AccountType
from app.models.entity import Entity
from app.models.user import User
from app.schemas.account import AccountCreate, AccountResponse, AccountUpdate, AccountListResponse
from app.core.time import utc_now

router = APIRouter()


def _validate_payment_routing(db: Session, current_user: User, data: dict, account_id: Optional[int] = None) -> None:
    """Reject statement-payment routing that points at accounts the caller can't use.

    Without this, a caller could route a card's statement at an arbitrary account id
    and read that account's name back out of the timeline's ``account_shortfalls``.
    Also rejects self-routing, which would make a card fund its own payment.
    """
    for field in ("payment_account_id", "payment_overflow_account_id"):
        target_id = data.get(field)
        if target_id is None:
            continue

        if account_id is not None and target_id == account_id:
            raise HTTPException(status_code=400, detail=f"{field} cannot be the card itself")

        target = db.query(Account).filter(Account.id == target_id).first()
        if not target or not can_access_record(db, current_user, target):
            raise HTTPException(status_code=404, detail=f"{field} account not found")
        if target.account_type == AccountType.CREDIT:
            raise HTTPException(
                status_code=400,
                detail=f"{field} must be a funding account, not a credit card",
            )


@router.get("/", response_model=AccountListResponse)
def get_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    account_type: Optional[str] = Query(None, description="Filter by account type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all accounts with optional filtering"""
    query = db.query(Account).filter(
        scope_criterion(Account, current_user.id, active_entity.id if active_entity else None)
    )

    if account_type:
        # Convert string to enum
        try:
            account_type_enum = AccountType(account_type.lower())
            query = query.filter(Account.account_type == account_type_enum)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid account type: {account_type}")
    
    if is_active is not None:
        query = query.filter(Account.is_active == is_active)
    
    total = query.count()
    accounts = (
        query.order_by(Account.created_at.desc(), Account.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(accounts) < total
    return {"items": accounts, "total": total, "has_more": has_more}

@router.post("/", response_model=AccountResponse)
def create_account(
    account: AccountCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """Create a new account"""
    account_data = account.dict()
    if account_data.get("entity_id") is None and active_entity is not None:
        account_data["entity_id"] = active_entity.id
    else:
        validate_entity_ownership(db, current_user, account_data.get("entity_id"))

    _validate_payment_routing(db, current_user, account_data)

    db_account = Account(**account_data, user_id=current_user.id)
    db.add(db_account)
    db.commit()
    db.refresh(db_account)
    return db_account

@router.get("/{account_id}", response_model=AccountResponse)
def get_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get a specific account by ID"""
    return get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

@router.put("/{account_id}", response_model=AccountResponse)
def update_account(account_id: int, account_update: AccountUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Update an existing account"""
    db_account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

    update_data = account_update.dict(exclude_unset=True)
    _validate_payment_routing(db, current_user, update_data, account_id=account_id)
    for field, value in update_data.items():
        setattr(db_account, field, value)

    db_account.updated_at = utc_now()
    db.commit()
    db.refresh(db_account)
    return db_account

@router.delete("/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Soft delete an account (mark as inactive)"""
    db_account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

    db_account.is_active = False
    db_account.updated_at = utc_now()
    db.commit()
    return {"message": "Account deleted successfully"}

@router.get("/{account_id}/balance")
def get_account_balance(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get current balance and balance history for an account"""
    account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

    # Calculate running balance from transactions
    from app.models.transaction import Transaction, TransactionType
    
    
    transactions = db.query(Transaction).filter(
        or_(
            Transaction.account_id == account_id,
            Transaction.transfer_from_account_id == account_id,
            Transaction.transfer_to_account_id == account_id
        )
    ).order_by(Transaction.transaction_date).all()
    
    balance_history = []
    running_balance = 0.0
    
    for transaction in transactions:
        if not transaction.is_posted:
            continue

        if transaction.transaction_type == TransactionType.CREDIT and transaction.account_id == account_id:
            running_balance += float(transaction.amount)
        elif transaction.transaction_type == TransactionType.DEBIT and transaction.account_id == account_id:
            running_balance -= float(transaction.amount)
        elif transaction.transaction_type == TransactionType.TRANSFER:
            if transaction.transfer_from_account_id == account_id:
                running_balance -= float(transaction.amount) + float(transaction.transfer_fee or 0.0)
            elif transaction.transfer_to_account_id == account_id:
                running_balance += float(transaction.amount)
            else:
                continue
        else:
            continue
        
        balance_history.append({
            "date": transaction.transaction_date,
            "balance": running_balance,
            "transaction_id": transaction.id
        })
    
    return {
        "account_id": account_id,
        "current_balance": account.balance,
        "calculated_balance": running_balance,
        "balance_history": balance_history
    }

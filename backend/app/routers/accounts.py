from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.models.account import Account, AccountType
from app.models.user import User
from app.schemas.account import AccountCreate, AccountResponse, AccountUpdate, AccountListResponse
from datetime import datetime

router = APIRouter()

@router.get("/", response_model=AccountListResponse)
def get_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    account_type: Optional[str] = Query(None, description="Filter by account type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    entity_id: Optional[int] = Query(None, description="Filter by entity ID"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all accounts with optional filtering"""
    query = db.query(Account).filter(Account.user_id == current_user.id)

    if entity_id is not None:
        query = query.filter(Account.entity_id == entity_id)
    
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
def create_account(account: AccountCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Create a new account"""
    db_account = Account(**account.dict(), user_id=current_user.id)
    db.add(db_account)
    db.commit()
    db.refresh(db_account)
    return db_account

@router.get("/{account_id}", response_model=AccountResponse)
def get_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get a specific account by ID"""
    account = db.query(Account).filter(Account.id == account_id, Account.user_id == current_user.id).first()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return account

@router.put("/{account_id}", response_model=AccountResponse)
def update_account(account_id: int, account_update: AccountUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Update an existing account"""
    db_account = db.query(Account).filter(Account.id == account_id, Account.user_id == current_user.id).first()
    if not db_account:
        raise HTTPException(status_code=404, detail="Account not found")
    
    update_data = account_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(db_account, field, value)
    
    db_account.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(db_account)
    return db_account

@router.delete("/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Soft delete an account (mark as inactive)"""
    db_account = db.query(Account).filter(Account.id == account_id, Account.user_id == current_user.id).first()
    if not db_account:
        raise HTTPException(status_code=404, detail="Account not found")
    
    db_account.is_active = False
    db_account.updated_at = datetime.utcnow()
    db.commit()
    return {"message": "Account deleted successfully"}

@router.get("/{account_id}/balance")
def get_account_balance(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get current balance and balance history for an account"""
    account = db.query(Account).filter(Account.id == account_id, Account.user_id == current_user.id).first()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    
    # Calculate running balance from transactions
    from app.models.transaction import Transaction, TransactionType
    
    from sqlalchemy import or_
    
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
            running_balance += transaction.amount
        elif transaction.transaction_type == TransactionType.DEBIT and transaction.account_id == account_id:
            running_balance -= transaction.amount
        elif transaction.transaction_type == TransactionType.TRANSFER:
            if transaction.transfer_from_account_id == account_id:
                running_balance -= transaction.amount + (transaction.transfer_fee or 0.0)
            elif transaction.transfer_to_account_id == account_id:
                running_balance += transaction.amount
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

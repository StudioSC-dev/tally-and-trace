from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from app.models.account import AccountType
from app.models.user import CurrencyType

class AccountBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    account_type: AccountType
    entity_id: Optional[int] = Field(None, gt=0)
    balance: float = Field(default=0.0)  # Allow negative balances for credit cards
    description: Optional[str] = None
    currency: CurrencyType = CurrencyType.PHP
    
    # Credit card specific fields
    credit_limit: Optional[float] = Field(None, ge=0)
    due_date: Optional[int] = Field(None, ge=1, le=31)  # Day of month (legacy support)
    billing_cycle_start: Optional[int] = Field(None, ge=1, le=31)  # Day of month / statement day
    days_until_due_date: Optional[int] = Field(21, ge=1, le=90)

class AccountCreate(AccountBase):
    is_active: bool = True

class AccountUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    account_type: Optional[AccountType] = None
    entity_id: Optional[int] = Field(None, gt=0)
    balance: Optional[float] = Field(None)  # Allow negative balances for credit cards
    description: Optional[str] = None
    currency: Optional[CurrencyType] = None
    credit_limit: Optional[float] = Field(None, ge=0)
    due_date: Optional[int] = Field(None, ge=1, le=31)
    billing_cycle_start: Optional[int] = Field(None, ge=1, le=31)
    days_until_due_date: Optional[int] = Field(None, ge=1, le=90)
    is_active: Optional[bool] = None

class AccountResponse(AccountBase):
    id: int
    is_active: bool
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class AccountListResponse(BaseModel):
    items: List[AccountResponse]
    total: int
    has_more: bool

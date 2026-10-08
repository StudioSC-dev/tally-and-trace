from pydantic import BaseModel, Field, field_validator
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
    billing_cycle_start: Optional[int] = Field(None, ge=1, le=31)  # Day of month the statement closes
    days_until_due_date: Optional[int] = Field(21, ge=1, le=90)
    # Where the statement payment is funded from (primary -> overflow, as on budget entries).
    payment_account_id: Optional[int] = Field(None, gt=0)
    payment_overflow_account_id: Optional[int] = Field(None, gt=0)
    # Spending wallet (cash on hand, e-wallet): balance shown, not projection cash.
    is_spending_wallet: bool = False

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
    payment_account_id: Optional[int] = Field(None, gt=0)
    payment_overflow_account_id: Optional[int] = Field(None, gt=0)
    is_spending_wallet: Optional[bool] = None
    is_active: Optional[bool] = None

    @field_validator("is_spending_wallet")
    @classmethod
    def _wallet_flag_not_null(cls, v):
        # Omit the field to leave it unchanged; an explicit null would violate NOT NULL.
        if v is None:
            raise ValueError("is_spending_wallet cannot be null")
        return v

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

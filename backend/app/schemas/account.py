from pydantic import BaseModel, Field, field_validator
from typing import Literal, Optional, List
from datetime import date, datetime
from app.models.account import AccountType
from app.models.user import CurrencyType
from app.schemas.tag import (
    TagIds, TagSummaries, tag_ids_create_field, tag_ids_not_null, tag_ids_update_field,
    tags_response_field,
)

LoanKind = Literal["personal", "auto", "home"]
LoanAmortization = Literal["fixed", "reduce_term"]


LOAN_PAYMENTS_MADE_OFFSET_DESCRIPTION = (
    "Scheduled payments made before the loan was tracked here. The due dates "
    "after them are settled by the combined amount (principal + interest) of the "
    "posted transactions with loan_payment_kind 'scheduled', oldest first. Legacy "
    "transfers (loan_payment_kind null) never count: their payments belong in this "
    "offset. Back-filled history recorded as scheduled payments, or a legacy "
    "transfer moved out of the loan and back in (which stamps it), is counted "
    "again, so this offset must be lowered for it."
)


class AccountBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    account_type: AccountType
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
    # Loan accounts only (balance negative while owed). payment_account_id above
    # is where the loan's payments are funded from by default.
    loan_kind: Optional[LoanKind] = None
    loan_annual_rate: Optional[float] = Field(None, ge=0, le=100)  # percent
    loan_term_months: Optional[int] = Field(None, ge=1, le=600)
    loan_payment_amount: Optional[float] = Field(None, gt=0)
    loan_first_payment_date: Optional[date] = None
    # Defaults by kind when omitted: home -> reduce_term, auto/personal -> fixed.
    loan_amortization: Optional[LoanAmortization] = None
    loan_payments_made_offset: Optional[int] = Field(
        None, ge=0, description=LOAN_PAYMENTS_MADE_OFFSET_DESCRIPTION)

class AccountCreate(AccountBase):
    is_active: bool = True
    tag_ids: TagIds = tag_ids_create_field()

class AccountUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    account_type: Optional[AccountType] = None
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
    loan_kind: Optional[LoanKind] = None
    loan_annual_rate: Optional[float] = Field(None, ge=0, le=100)
    loan_term_months: Optional[int] = Field(None, ge=1, le=600)
    loan_payment_amount: Optional[float] = Field(None, gt=0)
    loan_first_payment_date: Optional[date] = None
    loan_amortization: Optional[LoanAmortization] = None
    loan_payments_made_offset: Optional[int] = Field(
        None, ge=0, description=LOAN_PAYMENTS_MADE_OFFSET_DESCRIPTION)
    is_active: Optional[bool] = None
    tag_ids: Optional[TagIds] = tag_ids_update_field()

    @field_validator("tag_ids")
    @classmethod
    def _tag_ids_not_null(cls, v):
        return tag_ids_not_null(v)

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
    tags: TagSummaries = tags_response_field()

    class Config:
        from_attributes = True


class AccountListResponse(BaseModel):
    items: List[AccountResponse]
    total: int
    has_more: bool

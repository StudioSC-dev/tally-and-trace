from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
from datetime import datetime
from app.models.transaction import TransactionType, RecurrenceFrequency
from app.models.user import CurrencyType
from app.schemas.tag import (
    TagIds, TagSummaries, tag_ids_create_field, tag_ids_not_null, tag_ids_update_field,
    tags_response_field,
)

class TransactionBase(BaseModel):
    account_id: int = Field(..., gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    budget_entry_id: Optional[int] = Field(None, gt=0)
    amount: float = Field(..., ge=0)
    currency: CurrencyType = CurrencyType.PHP
    projected_amount: Optional[float] = Field(None, gt=0)
    projected_currency: Optional[CurrencyType] = None
    original_amount: Optional[float] = Field(None, gt=0)
    original_currency: Optional[CurrencyType] = None
    exchange_rate: Optional[float] = Field(None, gt=0)
    transfer_fee: float = Field(0, ge=0)
    description: Optional[str] = None
    transaction_type: TransactionType
    is_posted: bool = True
    transfer_from_account_id: Optional[int] = Field(None, gt=0)
    transfer_to_account_id: Optional[int] = Field(None, gt=0)
    transaction_date: datetime
    posting_date: Optional[datetime] = None
    
    # File attachments
    receipt_url: Optional[str] = None
    invoice_url: Optional[str] = None
    
    # Transaction status
    is_reconciled: bool = False
    is_recurring: bool = False
    recurrence_frequency: Optional[RecurrenceFrequency] = None

class TransactionCreate(TransactionBase):
    tag_ids: TagIds = tag_ids_create_field()

class TransactionUpdate(BaseModel):
    account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    budget_entry_id: Optional[int] = Field(None, gt=0)
    amount: Optional[float] = Field(None, ge=0)
    currency: Optional[CurrencyType] = None
    projected_amount: Optional[float] = Field(None, gt=0)
    projected_currency: Optional[CurrencyType] = None
    original_amount: Optional[float] = Field(None, gt=0)
    original_currency: Optional[CurrencyType] = None
    exchange_rate: Optional[float] = Field(None, gt=0)
    transfer_fee: Optional[float] = Field(None, ge=0)
    description: Optional[str] = None
    transaction_type: Optional[TransactionType] = None
    is_posted: Optional[bool] = None
    transfer_from_account_id: Optional[int] = Field(None, gt=0)
    transfer_to_account_id: Optional[int] = Field(None, gt=0)
    transaction_date: Optional[datetime] = None
    posting_date: Optional[datetime] = None
    receipt_url: Optional[str] = None
    invoice_url: Optional[str] = None
    is_reconciled: Optional[bool] = None
    is_recurring: Optional[bool] = None
    recurrence_frequency: Optional[RecurrenceFrequency] = None
    tag_ids: Optional[TagIds] = tag_ids_update_field()

    @field_validator("tag_ids")
    @classmethod
    def _tag_ids_not_null(cls, v):
        return tag_ids_not_null(v)

class TransactionResponse(TransactionBase):
    id: int
    # Read-only (scheduled / prepayment): set on every transfer into a loan
    # recorded through the API (the loan endpoints, a generic create, a
    # materialised recurring entry, an edit that retargets a row into a loan,
    # posting a legacy planned row); null on other rows and on legacy rows.
    loan_payment_kind: Optional[str] = None
    tags: TagSummaries = tags_response_field()
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class TransactionListResponse(BaseModel):
    items: List[TransactionResponse]
    total: int
    has_more: bool

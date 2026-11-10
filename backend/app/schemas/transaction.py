from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from typing import Annotated, Literal, Optional, List, Union
from datetime import datetime
from app.core.record_dates import check_record_date
from app.schemas.access import AccountRef, RecordPermissions
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
    # Transfers only: what the destination received, in its own currency (null:
    # the same as ``amount``). Required to post a cross-currency transfer.
    received_amount: Optional[float] = Field(None, ge=0)
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

    # Here, not on ``TransactionBase``: ``TransactionFields`` (the response
    # model) inherits that, and a stored row outside the range must stay readable.
    @field_validator("transaction_date", "posting_date")
    @classmethod
    def _date_in_range(cls, v):
        return check_record_date(v)

class RepeatingTransaction(TransactionCreate):
    """The transaction ``POST /transactions/repeating`` records as its entry's first
    occurrence. Its description is the entry's name, so it is required; the entry
    is created by the request, so no ``budget_entry_id`` may be sent."""
    description: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                                  max_length=150)]
    # The entry's amount when no ``projected_amount`` is sent: an entry needs more than 0.
    amount: float = Field(..., gt=0)

    @field_validator("budget_entry_id")
    @classmethod
    def _no_entry(cls, v):
        if v is not None:
            raise ValueError("budget_entry_id must be absent: this request creates the entry")
        return v


class RepeatSchedule(BaseModel):
    """The schedule of the entry a repeating transaction starts (services/repeat.py).

    The day fields, ends, ``billing_kind`` and their rules are
    ``POST /budget-entries/``'s. ``settlement`` "autopay" turns autopay on in the
    same commit. A semi-monthly cadence is not offered: its two days are not
    the transaction's date."""
    model_config = ConfigDict(extra="forbid")

    cadence: RecurrenceFrequency
    anchor_day: Optional[int] = Field(None, ge=1, le=31)
    day_rule: Optional[Literal["last_weekday"]] = None
    end_mode: Literal["indefinite", "on_date", "after_occurrences"]
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=1, le=360)
    billing_kind: Optional[Literal["subscription", "bill"]] = None
    settlement: Literal["manual", "autopay"] = "manual"

    @field_validator("cadence")
    @classmethod
    def _not_semi_monthly(cls, v):
        if v == RecurrenceFrequency.SEMI_MONTHLY:
            raise ValueError("A repeating transaction can't be semi-monthly")
        return v


class RepeatingCreate(BaseModel):
    transaction: RepeatingTransaction
    repeat: RepeatSchedule


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
    received_amount: Optional[float] = Field(None, ge=0)
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

    @field_validator("transaction_date", "posting_date")
    @classmethod
    def _date_in_range(cls, v):
        return check_record_date(v)

class TransactionFields(TransactionBase):
    """A transaction's stored fields as its creator sees them (no access fields)."""
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


class TransactionResponse(TransactionFields):
    """``view`` "full": the creator's view of their own record."""
    view: Literal["full"] = "full"
    permissions: RecordPermissions
    created_by: Optional[str] = None


class SharedFullTransaction(BaseModel):
    """``view`` "shared_full": an editor's or admin's view of someone else's record.

    The owner schema without the creator's private references (category,
    allocation, recurring entry, receipt and invoice), plus ``category_name``.
    """
    view: Literal["shared_full"]
    id: int
    permissions: RecordPermissions
    created_by: Optional[str] = None
    account_id: int
    amount: float
    currency: CurrencyType
    projected_amount: Optional[float] = None
    projected_currency: Optional[CurrencyType] = None
    original_amount: Optional[float] = None
    original_currency: Optional[CurrencyType] = None
    exchange_rate: Optional[float] = None
    transfer_fee: float = 0
    received_amount: Optional[float] = None
    description: Optional[str] = None
    transaction_type: TransactionType
    is_posted: bool
    transfer_from_account_id: Optional[int] = None
    transfer_to_account_id: Optional[int] = None
    transaction_date: datetime
    posting_date: Optional[datetime] = None
    is_reconciled: bool = False
    is_recurring: bool = False
    recurrence_frequency: Optional[RecurrenceFrequency] = None
    loan_payment_kind: Optional[str] = None
    category_name: Optional[str] = None
    tags: TagSummaries = tags_response_field()
    created_at: datetime
    updated_at: Optional[datetime] = None


class LimitedTransaction(BaseModel):
    """``view`` "limited": the allowlist for everyone else (see app/core/redaction.py).

    A payment into a loan or card the caller can't view has ``transfer_fee`` null
    and ``amount`` the whole payment; a transfer drawn from one has ``transfer_fee``
    null and ``amount`` what the other side received.
    """
    view: Literal["limited"]
    id: int
    permissions: RecordPermissions
    created_by: Optional[str] = None
    date: datetime
    display_description: Optional[str] = None
    amount: float
    transfer_fee: Optional[float] = None
    currency: CurrencyType
    transaction_type: TransactionType
    is_posted: bool
    category_name: Optional[str] = None
    account: Optional[AccountRef] = None
    counterpart: Optional[AccountRef] = None
    tags: TagSummaries = tags_response_field()


TransactionOut = Annotated[
    Union[TransactionResponse, SharedFullTransaction, LimitedTransaction],
    Field(discriminator="view"),
]


class TransactionListResponse(BaseModel):
    items: List[TransactionOut]
    total: int
    has_more: bool

from datetime import datetime
from typing import Optional, List, Literal
from pydantic import BaseModel, Field, field_validator, model_validator
from app.models.budget_entry import BudgetEntryType
from app.models.transaction import RecurrenceFrequency
from app.models.user import CurrencyType


class BudgetEntryBase(BaseModel):
    entity_id: Optional[int] = Field(None, gt=0)
    name: str = Field(..., min_length=1, max_length=150)
    entry_type: BudgetEntryType
    amount: float = Field(..., gt=0)
    currency: CurrencyType = CurrencyType.PHP
    cadence: RecurrenceFrequency = RecurrenceFrequency.MONTHLY
    next_occurrence: datetime
    lead_time_days: int = Field(0, ge=0, le=365)
    # Only meaningful when cadence == SEMI_MONTHLY. Days clamp to month length at projection time.
    semi_monthly_day_1: int = Field(1, ge=1, le=31)
    semi_monthly_day_2: int = Field(15, ge=1, le=31)
    end_mode: Literal["indefinite", "on_date", "after_occurrences"] = "indefinite"
    account_id: Optional[int] = Field(None, gt=0)
    overflow_account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    is_autopay: bool = False
    is_active: bool = True
    description: Optional[str] = Field(None, max_length=500)
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=0, le=360)
    # Installments paid before import with no linked transaction; counts toward "n of m".
    occurrences_paid_offset: int = Field(0, ge=0, le=360)


ZERO_REMAINING_MESSAGE = (
    "max_occurrences of 0 is only allowed for inactive 'after_occurrences' entries"
)


def zero_remaining_allowed(end_mode: str, max_occurrences: Optional[int], is_active: bool) -> bool:
    """0 remaining means a completed installment: only valid when inactive."""
    if max_occurrences != 0:
        return True
    return end_mode == "after_occurrences" and not is_active


class BudgetEntryCreate(BudgetEntryBase):
    @model_validator(mode="after")
    def _zero_remaining_only_when_completed(self):
        if not zero_remaining_allowed(self.end_mode, self.max_occurrences, self.is_active):
            raise ValueError(ZERO_REMAINING_MESSAGE)
        return self


class BudgetEntryUpdate(BaseModel):
    entity_id: Optional[int] = Field(None, gt=0)
    name: Optional[str] = Field(None, min_length=1, max_length=150)
    entry_type: Optional[BudgetEntryType] = None
    amount: Optional[float] = Field(None, gt=0)
    currency: Optional[CurrencyType] = None
    cadence: Optional[RecurrenceFrequency] = None
    next_occurrence: Optional[datetime] = None
    lead_time_days: Optional[int] = Field(None, ge=0, le=365)
    semi_monthly_day_1: Optional[int] = Field(None, ge=1, le=31)
    semi_monthly_day_2: Optional[int] = Field(None, ge=1, le=31)
    account_id: Optional[int] = Field(None, gt=0)
    overflow_account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    is_autopay: Optional[bool] = None
    is_active: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=500)
    end_mode: Optional[Literal["indefinite", "on_date", "after_occurrences"]] = None
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=0, le=360)
    occurrences_paid_offset: Optional[int] = Field(None, ge=0, le=360)

    @field_validator("occurrences_paid_offset")
    @classmethod
    def _offset_not_null(cls, v):
        # Omit the field to leave it unchanged; an explicit null would violate NOT NULL.
        if v is None:
            raise ValueError("occurrences_paid_offset cannot be null")
        return v


class BudgetEntryResponse(BudgetEntryBase):
    id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Installments only ("n of m"): occurrences materialised so far, counted from the
    # linked transactions. None for open-ended entries, where the notion doesn't apply.
    occurrences_paid: Optional[int] = None

    class Config:
        from_attributes = True


class BudgetEntryListResponse(BaseModel):
    items: List[BudgetEntryResponse]
    total: int
    has_more: bool


class BudgetEntryMaterialize(BaseModel):
    """Post a due recurring entry as an actual transaction."""
    transaction_date: Optional[datetime] = None  # defaults to the entry's next_occurrence
    amount: Optional[float] = Field(None, gt=0)   # defaults to the entry's amount
    advance: bool = True                          # advance next_occurrence to the following one


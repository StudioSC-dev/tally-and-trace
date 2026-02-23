from datetime import datetime
from typing import Optional, List, Literal
from pydantic import BaseModel, Field
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
    end_mode: Literal["indefinite", "on_date", "after_occurrences"] = "indefinite"
    account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    is_autopay: bool = False
    is_active: bool = True
    description: Optional[str] = Field(None, max_length=500)
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=1, le=360)


class BudgetEntryCreate(BudgetEntryBase):
    pass


class BudgetEntryUpdate(BaseModel):
    entity_id: Optional[int] = Field(None, gt=0)
    name: Optional[str] = Field(None, min_length=1, max_length=150)
    entry_type: Optional[BudgetEntryType] = None
    amount: Optional[float] = Field(None, gt=0)
    currency: Optional[CurrencyType] = None
    cadence: Optional[RecurrenceFrequency] = None
    next_occurrence: Optional[datetime] = None
    lead_time_days: Optional[int] = Field(None, ge=0, le=365)
    account_id: Optional[int] = Field(None, gt=0)
    category_id: Optional[int] = Field(None, gt=0)
    allocation_id: Optional[int] = Field(None, gt=0)
    is_autopay: Optional[bool] = None
    is_active: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=500)
    end_mode: Optional[Literal["indefinite", "on_date", "after_occurrences"]] = None
    end_date: Optional[datetime] = None
    max_occurrences: Optional[int] = Field(None, ge=1, le=360)


class BudgetEntryResponse(BudgetEntryBase):
    id: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class BudgetEntryListResponse(BaseModel):
    items: List[BudgetEntryResponse]
    total: int
    has_more: bool


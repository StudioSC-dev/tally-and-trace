from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime
from app.models.allocation import AllocationType, BudgetPeriodFrequency


class AllocationBase(BaseModel):
    account_id: int = Field(..., gt=0)
    entity_id: Optional[int] = Field(None, gt=0)
    name: str = Field(..., min_length=1, max_length=100)
    allocation_type: AllocationType
    description: Optional[str] = None

    # Financial details
    target_amount: Optional[float] = Field(None, ge=0)
    current_amount: float = Field(default=0.0, ge=0)
    monthly_target: Optional[float] = Field(None, ge=0)
    target_date: Optional[datetime] = None
    period_frequency: Optional[BudgetPeriodFrequency] = None
    period_start: Optional[datetime] = None
    period_end: Optional[datetime] = None
    is_active: bool = True
    configuration: Optional[Dict[str, Any]] = None


class AllocationCreate(AllocationBase):
    pass


class AllocationUpdate(BaseModel):
    account_id: Optional[int] = Field(None, gt=0)
    entity_id: Optional[int] = Field(None, gt=0)
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    allocation_type: Optional[AllocationType] = None
    description: Optional[str] = None
    target_amount: Optional[float] = Field(None, ge=0)
    current_amount: Optional[float] = Field(None, ge=0)
    monthly_target: Optional[float] = Field(None, ge=0)
    target_date: Optional[datetime] = None
    period_frequency: Optional[BudgetPeriodFrequency] = None
    period_start: Optional[datetime] = None
    period_end: Optional[datetime] = None
    is_active: Optional[bool] = None
    configuration: Optional[Dict[str, Any]] = None


class AllocationResponse(AllocationBase):
    id: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class AllocationListResponse(BaseModel):
    items: List[AllocationResponse]
    total: int
    has_more: bool

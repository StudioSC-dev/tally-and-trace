from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

from app.models.category import CategoryKind


class CategoryBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = None
    entity_id: Optional[int] = Field(None, gt=0)
    color: Optional[str] = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')  # Hex color validation
    is_expense: bool = True
    # Directional role. When omitted on create it is derived from is_expense
    # (expense/income); is_expense is kept in sync from kind by the router.
    kind: Optional[CategoryKind] = None
    is_active: bool = True

class CategoryCreate(CategoryBase):
    pass

class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    entity_id: Optional[int] = Field(None, gt=0)
    color: Optional[str] = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')
    is_expense: Optional[bool] = None
    kind: Optional[CategoryKind] = None
    is_active: Optional[bool] = None

class CategoryResponse(CategoryBase):
    id: int
    kind: CategoryKind
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

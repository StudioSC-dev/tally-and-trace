from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from app.models.wishlist_item import WishlistPriority
from app.models.user import CurrencyType


class WishlistItemCreate(BaseModel):
    entity_id: Optional[int] = Field(None, gt=0)
    name: str = Field(..., min_length=1, max_length=200)
    estimated_cost: float = Field(..., gt=0)
    currency: CurrencyType = CurrencyType.PHP
    priority: WishlistPriority = WishlistPriority.MEDIUM
    category_id: Optional[int] = Field(None, gt=0)
    url: Optional[str] = Field(None, max_length=500)
    notes: Optional[str] = None
    target_date: Optional[datetime] = None


class WishlistItemUpdate(BaseModel):
    entity_id: Optional[int] = Field(None, gt=0)
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    estimated_cost: Optional[float] = Field(None, gt=0)
    currency: Optional[CurrencyType] = None
    priority: Optional[WishlistPriority] = None
    category_id: Optional[int] = Field(None, gt=0)
    url: Optional[str] = Field(None, max_length=500)
    notes: Optional[str] = None
    target_date: Optional[datetime] = None
    is_purchased: Optional[bool] = None
    purchased_at: Optional[datetime] = None


class WishlistItemResponse(BaseModel):
    id: int
    user_id: int
    entity_id: Optional[int] = None
    name: str
    estimated_cost: float
    currency: CurrencyType
    priority: WishlistPriority
    category_id: Optional[int] = None
    url: Optional[str] = None
    notes: Optional[str] = None
    target_date: Optional[datetime] = None
    is_purchased: bool
    purchased_at: Optional[datetime] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class WishlistReadiness(BaseModel):
    item_id: int
    name: str
    estimated_cost: float
    monthly_disposable: float
    savings_rate: float
    months_needed: int
    estimated_purchase_date: str
    affordable_now: bool


class WishlistPlanItem(BaseModel):
    item_id: int
    name: str
    estimated_cost: float
    estimated_purchase_date: str
    cumulative_months: int


class WishlistPlanResponse(BaseModel):
    monthly_disposable: float
    savings_rate: float
    items: List[WishlistPlanItem]

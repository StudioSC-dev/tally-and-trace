from pydantic import BaseModel, Field, model_validator
from typing import Optional, List
from datetime import datetime
from app.models.wishlist_item import (
    INSTALLMENT_MAX_MONTHS, INSTALLMENT_MIN_MONTHS, WishlistPaymentPlan, WishlistPriority,
)
from app.models.user import CurrencyType


class WishlistItemCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    estimated_cost: float = Field(..., gt=0)
    currency: CurrencyType = CurrencyType.PHP
    priority: WishlistPriority = WishlistPriority.MEDIUM
    category_id: Optional[int] = Field(None, gt=0)
    url: Optional[str] = Field(None, max_length=500)
    notes: Optional[str] = None
    target_date: Optional[datetime] = None
    # STU-779: the account the purchase is paid from, and how. An installment needs a
    # credit card account and ``installment_months``; a full payment takes none.
    account_id: Optional[int] = Field(None, gt=0)
    payment_plan: WishlistPaymentPlan = WishlistPaymentPlan.FULL
    installment_months: Optional[int] = Field(
        None, ge=INSTALLMENT_MIN_MONTHS, le=INSTALLMENT_MAX_MONTHS)

    @model_validator(mode="after")
    def _months_match_the_plan(self):
        months_rule(self.payment_plan, self.installment_months)
        return self


INSTALLMENT_MONTHS_MESSAGE = "An installment needs installment_months (2 to 60)"
FULL_MONTHS_MESSAGE = "installment_months is only allowed on an installment"


def months_rule(payment_plan, installment_months) -> None:
    """ValueError unless ``installment_months`` is set exactly on an installment."""
    if payment_plan == WishlistPaymentPlan.INSTALLMENT and installment_months is None:
        raise ValueError(INSTALLMENT_MONTHS_MESSAGE)
    if payment_plan == WishlistPaymentPlan.FULL and installment_months is not None:
        raise ValueError(FULL_MONTHS_MESSAGE)


class WishlistItemUpdate(BaseModel):
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
    # Null clears the account. Sending ``payment_plan`` "full" clears
    # ``installment_months`` unless it is sent too (then it is refused).
    account_id: Optional[int] = Field(None, gt=0)
    payment_plan: Optional[WishlistPaymentPlan] = None
    installment_months: Optional[int] = Field(
        None, ge=INSTALLMENT_MIN_MONTHS, le=INSTALLMENT_MAX_MONTHS)


class WishlistItemResponse(BaseModel):
    id: int
    user_id: int
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
    account_id: Optional[int] = None
    payment_plan: WishlistPaymentPlan = WishlistPaymentPlan.FULL
    installment_months: Optional[int] = None
    # The card installment entry marking the item purchased created (STU-779).
    installment_entry_id: Optional[int] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    # What a write did besides saving the item, for the client to show; null otherwise.
    notice: Optional[str] = None

    class Config:
        from_attributes = True


class WishlistReadiness(BaseModel):
    item_id: int
    name: str
    estimated_cost: float
    currency: str
    monthly_disposable: float
    savings_rate: float
    months_needed: int
    estimated_purchase_date: str
    affordable_now: bool
    note: Optional[str] = None


class WishlistPlanItem(BaseModel):
    item_id: int
    name: str
    estimated_cost: float
    estimated_purchase_date: Optional[str] = None
    cumulative_months: int
    note: Optional[str] = None


class WishlistPlanResponse(BaseModel):
    monthly_disposable: float
    savings_rate: float
    items: List[WishlistPlanItem]

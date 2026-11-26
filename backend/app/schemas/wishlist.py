from pydantic import BaseModel, Field, model_validator
from typing import Literal, Optional, List
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


# An item's projection status (STU-789, ``services/wishlist_projection.py``), first match.
ProjectionStatus = Literal["paid_from_savings", "not_estimated", "incomplete", "no_projection",
                           "no_room", "beyond_horizon", "dated"]
# Which free-flow figure an item's rate is: a critical item's net flow, a want's free flow.
RateBasis = Literal["net_flow", "free_flow"]


class WishlistReadiness(BaseModel):
    item_id: int
    name: str
    estimated_cost: float
    currency: str
    monthly_disposable: float
    # The item's rate (its basis's figure), 0 when it has none.
    savings_rate: float
    months_needed: int = Field(
        ..., deprecated="Read estimated_date: 9999 unless the item is dated")
    estimated_purchase_date: str = Field(
        ..., deprecated="Read estimated_date: a placeholder date unless the item is dated")
    affordable_now: bool
    note: Optional[str] = None
    # STU-789: set only when ``projection_status`` is ``dated``.
    estimated_date: Optional[str] = None
    basis: Optional[RateBasis] = None
    projection_status: Optional[ProjectionStatus] = None
    projection_note: Optional[str] = None


class WishlistPlanItem(BaseModel):
    item_id: int
    name: str
    estimated_cost: float
    estimated_purchase_date: Optional[str] = None
    # Months until the item is bought behind every earlier queued item in its
    # currency; 0 for an item outside the queue, and for a queued item with no rate.
    cumulative_months: int
    # Why there is no date, when there isn't one.
    note: Optional[str] = None
    # STU-789: the item on its own, then what the queue says.
    currency: Optional[str] = None
    priority: Optional[WishlistPriority] = None
    basis: Optional[RateBasis] = None
    projection_status: Optional[ProjectionStatus] = None
    projection_note: Optional[str] = None
    queue_note: Optional[str] = None
    # A critical item whose currency row is ``ok`` only.
    net_flow_after: Optional[float] = None
    from_saving: Optional[float] = None


class WishlistPlanInstallment(BaseModel):
    """An installment item, left out of the save-up queue (STU-779): it is paid
    monthly on its card, not saved up for."""
    item_id: int
    name: str
    estimated_cost: float
    currency: str
    account_id: Optional[int] = None
    installment_months: int
    monthly_amount: float
    final_amount: float


FreeFlowStatus = Literal["not_estimated", "incomplete", "no_projection", "ok"]


class WishlistFreeFlowRow(BaseModel):
    """One currency's monthly free flow (STU-788). A figure the status leaves out is null."""
    currency: str
    status: FreeFlowStatus
    sample_months: int
    income: Optional[float] = None
    spending: Optional[float] = None
    debt_paid: Optional[float] = None
    net_flow: Optional[float] = None
    saved: Optional[float] = None
    goal_top_up: Optional[float] = None
    reserved: Optional[float] = None
    free_flow: Optional[float] = None
    shortfall: Optional[float] = None


class WishlistFreeFlowGoal(BaseModel):
    """One of the caller's goals that can reserve, in rank order (STU-788). The
    figures are null when the caller is not estimated or crosses currencies;
    ``underfunded`` is set only in a currency whose row is ``ok``."""
    allocation_id: int
    rank: Optional[int] = None
    currency: str
    pace: Optional[float] = None
    fed: Optional[float] = None
    top_up: Optional[float] = None
    underfunded: Optional[float] = None
    unreserved: bool = False
    overdue: bool = False


class WishlistFreeFlow(BaseModel):
    """``GET /wishlist/free-flow``: per-currency rows, the goals, and the known
    limitations the "based on your last N full months" note lists."""
    rows: List[WishlistFreeFlowRow]
    goals: List[WishlistFreeFlowGoal]
    limitations: List[str] = []


class WishlistPlanResponse(BaseModel):
    monthly_disposable: float
    # The default currency's free flow when that row is ``ok``, else 0 (STU-789).
    savings_rate: float
    items: List[WishlistPlanItem]
    installments: List[WishlistPlanInstallment] = []
    # STU-789: the free-flow rows the items are dated from, per currency.
    net_flow: List[WishlistFreeFlowRow] = []


CheckStatus = Literal["fits", "over", "unknown"]


class WishlistOutlookMonth(BaseModel):
    """One month of the outlook, in the item's currency. ``existing_installments``
    (and so ``total``) is null when a card installment that month has no stored
    rate into the item's currency."""
    month: str  # YYYY-MM
    existing_installments: Optional[float] = None
    # Null only for a purchased item whose installment has no stored rate into
    # the item's currency.
    this_item: Optional[float] = None
    total: Optional[float] = None


class WishlistDisposableCheck(BaseModel):
    """This item alone (its monthly amount, or the full price) against its rate
    (STU-789): ``available``, the item's net flow (critical) or free flow (a want)
    in its currency. ``unknown`` when the item has no rate. ``monthly_disposable``
    is the recurring-entry figure, kept for compatibility."""
    status: CheckStatus
    currency: str
    amount: float
    monthly_disposable: Optional[float] = None
    after_purchase: Optional[float] = None
    reason: Optional[str] = None
    basis: Optional[RateBasis] = None
    available: Optional[float] = None


class WishlistCreditCheck(BaseModel):
    """The full price against the card's available credit now, in the card's
    currency (an installment holds the whole price on the limit)."""
    status: CheckStatus
    currency: Optional[str] = None
    amount: Optional[float] = None
    available: Optional[float] = None
    limit: Optional[float] = None
    reason: Optional[str] = None


class WishlistOutlook(BaseModel):
    item_id: int
    currency: str
    payment_plan: WishlistPaymentPlan
    estimated_cost: float
    installment_months: Optional[int] = None
    monthly_amount: Optional[float] = None
    final_amount: Optional[float] = None
    months: List[WishlistOutlookMonth]
    note: Optional[str] = None
    disposable_check: WishlistDisposableCheck
    credit_check: Optional[WishlistCreditCheck] = None
    # STU-789: the item on its own (``services/wishlist_projection.py``).
    projection_status: Optional[ProjectionStatus] = None
    projection_note: Optional[str] = None

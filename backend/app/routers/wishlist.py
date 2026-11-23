import math
from datetime import datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core import locking
from app.core.auth import get_current_active_user
from app.core.context import RequestContext, request_context
from app.core.database import get_db
from app.core.access import get_owned_or_404, owned_criterion, require_account, require_owned_ref
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.category import Category
from app.models.transaction import RecurrenceFrequency
from app.models.user import User
from app.models.wishlist_item import WishlistItem, WishlistPaymentPlan
from app.schemas.wishlist import (
    months_rule,
    WishlistItemCreate,
    WishlistItemResponse,
    WishlistItemUpdate,
    WishlistOutlook,
    WishlistPlanInstallment,
    WishlistPlanItem,
    WishlistPlanResponse,
    WishlistReadiness,
)
from app.routers.budget_entries import add_budget_entry
from app.schemas.budget_entry import BudgetEntryCreate
from app.services import forecast as forecast_svc
from app.services import wishlist_outlook
from app.services.installment_split import TOO_SMALL_MESSAGE, try_installment_split
from app.services.fx import FxRates, convert
from app.core.time import manila_day, utc_now

router = APIRouter()

SAVINGS_RATE_FACTOR = 0.5  # Assume 50% of disposable income goes to wishlist savings


def no_projection_note(currency: str) -> str:
    """What an item in a currency with no disposable row says (STU-304)."""
    return f"No projected income or expenses in {currency}, so this can't be judged yet."


def item_currency_row(ctx: RequestContext, item, rows: Optional[List[dict]] = None) -> Optional[dict]:
    """The ``by_currency`` disposable row of the item's own currency, or None
    when the projection has none (STU-304: never the default-currency scalars).
    Pass ``rows`` (the projection's ``by_currency``) to avoid recomputing it."""
    code = getattr(item.currency, "value", item.currency)
    if rows is None:
        rows = forecast_svc.disposable_by_currency(ctx)["by_currency"]
    return next((r for r in rows if r["currency"] == code), None)


def price_of(cost) -> Decimal:
    """An item's price as money: two places, half up (as ``Numeric(15, 2)`` stores it)."""
    return Decimal(str(cost)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


INSTALLMENT_CARD_MESSAGE = "An installment is paid from a credit card account"
LOAN_ACCOUNT_MESSAGE = "A wishlist item cannot be paid from a loan"
INSTALLMENT_LINKED_MESSAGE = (
    "This item's card installment was already created; change it in Recurring instead")


def validate_payment(db: Session, user: User, owner: User, *, account_id: Optional[int],
                     payment_plan, installment_months: Optional[int], cost,
                     check_account: bool = True) -> Optional[Account]:
    """The item's payment account, after the payment rules (STU-779).

    The account passes the check recurring entries use (``require_account``):
    the caller and the item's owner both hold an edit role on it, so a
    household admin or editor may plan on a shared account and a viewer may
    not (404). It is never a loan, as a recurring entry is never paid from one.
    An installment is a card installment: it needs a credit card account and
    ``installment_months``, and a price that gives every payment at least 0.01
    (``installment_split``). ``check_account`` False skips the account's
    access check (an edit that leaves the payment fields alone).
    """
    try:
        months_rule(payment_plan, installment_months)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    account = None
    if account_id is not None:
        account = (require_account(db, user, account_id, "Account not found", owner=owner)
                   if check_account else db.get(Account, account_id))
    if check_account and account is not None and account.account_type == AccountType.LOAN:
        raise HTTPException(status_code=400, detail=LOAN_ACCOUNT_MESSAGE)
    if payment_plan == WishlistPaymentPlan.INSTALLMENT:
        if check_account and (account is None or account.account_type != AccountType.CREDIT):
            raise HTTPException(status_code=400, detail=INSTALLMENT_CARD_MESSAGE)
        if try_installment_split(price_of(cost), installment_months) is None:
            raise HTTPException(status_code=422,
                                detail=TOO_SMALL_MESSAGE.format(months=installment_months))
    return account


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@router.get("/", response_model=List[WishlistItemResponse])
def list_wishlist(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    is_purchased: Optional[bool] = Query(None),
):
    """List wishlist items, sorted by priority then created_at."""
    from sqlalchemy import case
    priority_order = case(
        {"critical": 0, "high": 1, "medium": 2, "low": 3},
        value=WishlistItem.priority,
    )
    # Wishlist items are never shared: the caller's own only.
    query = db.query(WishlistItem).filter(owned_criterion(WishlistItem, current_user))
    if is_purchased is not None:
        query = query.filter(WishlistItem.is_purchased == is_purchased)
    return query.order_by(priority_order, WishlistItem.created_at).all()


@router.post("/", response_model=WishlistItemResponse, status_code=status.HTTP_201_CREATED)
def create_wishlist_item(
    payload: WishlistItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    item_data = payload.dict()
    # Same-owner rule: the category is the caller's own.
    require_owned_ref(db, Category, item_data.get("category_id"), "Category not found",
                      current_user)
    validate_payment(db, current_user, current_user, account_id=payload.account_id,
                     payment_plan=payload.payment_plan,
                     installment_months=payload.installment_months,
                     cost=payload.estimated_cost)

    item = WishlistItem(**item_data, user_id=current_user.id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/plan", response_model=WishlistPlanResponse)
def get_wishlist_plan(
    ctx: RequestContext = Depends(request_context),
):
    """
    Purchase timeline for all unpurchased items ordered by priority. Each item
    is timed against the disposable income of its own currency (STU-649), and
    queues only behind earlier items in that same currency. An item whose
    currency has no disposable row gets no date and says so in ``note``.
    The top-level figures stay the default-currency ones.

    An installment item (STU-779) is paid monthly on its card, not saved up
    for: it is left out of the queue (and of every later item's wait) and
    listed in ``installments`` with its monthly and final amounts.
    """
    db, current_user = ctx.db, ctx.user
    disposable_data = forecast_svc.get_disposable_income(db, current_user.id)
    monthly_disposable = disposable_data["monthly_disposable"]
    savings_rate = max(monthly_disposable * SAVINGS_RATE_FACTOR, 0.01)

    from sqlalchemy import case
    priority_order = case(
        {"critical": 0, "high": 1, "medium": 2, "low": 3},
        value=WishlistItem.priority,
    )
    items = (
        db.query(WishlistItem)
        .filter(
            owned_criterion(WishlistItem, current_user),
            WishlistItem.is_purchased.is_(False),
        )
        .order_by(priority_order, WishlistItem.created_at)
        .all()
    )

    installments: List[WishlistPlanInstallment] = []
    queued = []
    for item in items:
        if item.payment_plan != WishlistPaymentPlan.INSTALLMENT:
            queued.append(item)
            continue
        payments = wishlist_outlook.this_item_payments(item, price_of(item.estimated_cost))
        installments.append(WishlistPlanInstallment(
            item_id=item.id,
            name=item.name,
            estimated_cost=item.estimated_cost,
            currency=getattr(item.currency, "value", item.currency),
            account_id=item.account_id,
            installment_months=item.installment_months,
            monthly_amount=payments[0],
            final_amount=payments[-1],
        ))

    now = utc_now()
    cumulative_by_currency: Dict[str, int] = {}
    currency_rows = forecast_svc.disposable_by_currency(ctx)["by_currency"] if queued else []
    plan: List[WishlistPlanItem] = []

    for item in queued:
        code = getattr(item.currency, "value", item.currency)
        row = item_currency_row(ctx, item, currency_rows)
        if row is None:
            plan.append(
                WishlistPlanItem(
                    item_id=item.id,
                    name=item.name,
                    estimated_cost=item.estimated_cost,
                    estimated_purchase_date=None,
                    cumulative_months=cumulative_by_currency.get(code, 0),
                    note=no_projection_note(code),
                )
            )
            continue
        item_rate = max(row["monthly_disposable"] * SAVINGS_RATE_FACTOR, 0.01)
        months_needed = math.ceil(float(item.estimated_cost) / item_rate)
        cumulative_months = cumulative_by_currency.get(code, 0) + months_needed
        cumulative_by_currency[code] = cumulative_months
        purchase_date = now + timedelta(days=cumulative_months * 30)
        plan.append(
            WishlistPlanItem(
                item_id=item.id,
                name=item.name,
                estimated_cost=item.estimated_cost,
                estimated_purchase_date=purchase_date.date().isoformat(),
                cumulative_months=cumulative_months,
            )
        )

    return WishlistPlanResponse(
        monthly_disposable=monthly_disposable,
        savings_rate=savings_rate,
        items=plan,
        installments=installments,
    )


@router.get("/{item_id}", response_model=WishlistItemResponse)
def get_wishlist_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    return get_owned_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")


@router.put("/{item_id}", response_model=WishlistItemResponse)
def update_wishlist_item(
    item_id: int,
    payload: WishlistItemUpdate,
    ctx: RequestContext = Depends(request_context),
):
    """Edit an item. Marking an installment item purchased creates its card
    installment in the same change (``_create_installment``, STU-779), once:
    the item row is locked first (``locking.lock_wishlist_item``), so a repeated
    or concurrent request reads the link the first one stored and creates
    nothing. Un-marking it leaves the installment running and says so in
    ``notice``."""
    db, current_user = ctx.db, ctx.user
    item = locking.lock_wishlist_item(db, item_id)
    if item is None or item.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="Wishlist item not found")

    update_data = payload.dict(exclude_unset=True)
    if "category_id" in update_data:
        require_owned_ref(db, Category, update_data["category_id"], "Category not found",
                          current_user)
    _validate_payment_update(db, current_user, item, update_data)
    purchasing = bool(update_data.get("is_purchased")) and not item.is_purchased
    unpurchasing = update_data.get("is_purchased") is False and item.is_purchased
    if purchasing and update_data.get("purchased_at") is None:
        # Absent or an explicit null: the purchase is now.
        update_data["purchased_at"] = utc_now()
    for field, value in update_data.items():
        setattr(item, field, value)
    notice = None
    if (purchasing and item.payment_plan == WishlistPaymentPlan.INSTALLMENT
            and item.installment_entry_id is None):
        entry = _create_installment(ctx, item)
        item.installment_entry_id = entry.id
        notice = INSTALLMENT_CREATED_NOTICE.format(
            count=entry.max_occurrences, currency=getattr(entry.currency, "value", entry.currency))
    elif unpurchasing and item.installment_entry_id is not None:
        notice = INSTALLMENT_KEPT_NOTICE
    item.updated_at = utc_now()
    db.commit()
    db.refresh(item)
    item.notice = notice
    return item


INSTALLMENT_CREATED_NOTICE = (
    "Created a card installment of {count} monthly payments in {currency}; "
    "it is in Recurring and the forecast")
INSTALLMENT_KEPT_NOTICE = (
    "The card installment keeps running in Recurring and the forecast; "
    "delete it there if this purchase did not happen")
PURCHASE_NO_RATE_MESSAGE = (
    "No exchange rate from {base} to {quote} is stored yet, so the installment "
    "can't be created; try again later")


def _create_installment(ctx: RequestContext, item: WishlistItem) -> BudgetEntry:
    """The card installment an installment item's purchase creates (STU-779),
    added through the recurring form's own path (``budget_entries.add_budget_entry``),
    flushed and uncommitted.

    An expense on the item's card, monthly, ``after_occurrences`` with the
    item's months, in the card's currency: the price is converted at the stored
    rate when the item's currency differs (409, nothing written, when there is
    none). Each payment but the last is the split's amount and the last its
    ``final_amount`` (``installment_split``, the shared rounding). The first
    date is the purchase's Manila day, which the create path moves to the
    card's statement close like any card installment's.
    """
    db = ctx.db
    card = db.get(Account, item.account_id) if item.account_id else None
    if card is None or card.account_type != AccountType.CREDIT:
        raise HTTPException(status_code=400, detail=INSTALLMENT_CARD_MESSAGE)
    price = price_of(item.estimated_cost)
    if card.currency != item.currency:
        fx = ctx.fx if ctx.fx is not None else FxRates.offline(db)
        rate = fx.rate(item.currency, card.currency)
        if rate is None:
            raise HTTPException(status_code=409, detail=PURCHASE_NO_RATE_MESSAGE.format(
                base=getattr(item.currency, "value", item.currency),
                quote=getattr(card.currency, "value", card.currency)))
        price = convert(price, rate.rate)
    split = try_installment_split(price, item.installment_months)
    if split is None:
        raise HTTPException(status_code=422, detail=TOO_SMALL_MESSAGE.format(
            months=item.installment_months))
    day = manila_day(item.purchased_at)
    try:
        entry_in = BudgetEntryCreate(
            name=item.name[:150],
            entry_type=BudgetEntryType.EXPENSE,
            amount=float(split.amount),
            final_amount=split.final_amount,
            currency=card.currency,
            cadence=RecurrenceFrequency.MONTHLY,
            next_occurrence=datetime.combine(day, time(), tzinfo=timezone.utc),
            end_mode="after_occurrences",
            max_occurrences=item.installment_months,
            account_id=card.id,
            category_id=item.category_id,
            billing_kind=None,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()[0]["msg"]) from None
    return add_budget_entry(db, ctx.user, entry_in)


PAYMENT_FIELDS = ("account_id", "payment_plan", "installment_months")
# What the linked card installment was built from besides the payment fields.
LINKED_TERMS = ("estimated_cost", "currency")


def _changes(item: WishlistItem, field: str, value) -> bool:
    """Whether ``value`` differs from the stored field (a price by its money value)."""
    stored = getattr(item, field)
    if field == "estimated_cost":
        return value is None or price_of(value) != price_of(stored)
    return value != stored


def _validate_payment_update(db: Session, user: User, item: WishlistItem,
                             update_data: dict) -> None:
    """The payment rules on the item as the update leaves it (``validate_payment``).

    Sending ``payment_plan`` "full" without ``installment_months`` clears the
    months. The account's access is checked only when a payment field is
    sent, so an edit of the name alone never fails on it. Once marking the
    item purchased created its card installment, the payment fields and the
    price and currency it was built from are fixed (409 on a change;
    resending the stored values passes).
    """
    sent = [f for f in PAYMENT_FIELDS if f in update_data]
    if "payment_plan" in update_data and update_data["payment_plan"] is None:
        raise HTTPException(status_code=422, detail="payment_plan cannot be null")
    if (update_data.get("payment_plan") == WishlistPaymentPlan.FULL
            and "installment_months" not in update_data):
        update_data["installment_months"] = None
        sent.append("installment_months")
    if item.installment_entry_id is not None and any(
            _changes(item, f, update_data[f]) for f in (*sent, *LINKED_TERMS)
            if f in update_data):
        raise HTTPException(status_code=409, detail=INSTALLMENT_LINKED_MESSAGE)
    if not sent and "estimated_cost" not in update_data:
        return
    merged = {f: update_data.get(f, getattr(item, f)) for f in PAYMENT_FIELDS}
    validate_payment(db, user, item.user, **merged,
                     cost=update_data.get("estimated_cost") or item.estimated_cost,
                     check_account=bool(sent))


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_wishlist_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    item = get_owned_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")
    db.delete(item)
    db.commit()


@router.get("/{item_id}/outlook", response_model=WishlistOutlook)
def get_outlook(
    item_id: int,
    ctx: RequestContext = Depends(request_context),
):
    """How the purchase sits with the caller's money (STU-779): the monthly and
    final payments, the months ahead with the card installments already
    running, and whether this item fits monthly disposable income and, on a
    card, its available credit (``services/wishlist_outlook.py``)."""
    item = get_owned_or_404(ctx.db, WishlistItem, item_id, ctx.user, "Wishlist item not found")
    code = getattr(item.currency, "value", item.currency)
    return wishlist_outlook.outlook(ctx, item, price_of(item.estimated_cost),
                                    item_currency_row(ctx, item), no_projection_note(code))


@router.get("/{item_id}/readiness", response_model=WishlistReadiness)
def get_readiness(
    item_id: int,
    ctx: RequestContext = Depends(request_context),
):
    """
    Advisory: Given disposable income in the item's own currency, calculate when
    the user can afford this item. An item in a currency with no disposable row
    is not affordable, and says so in ``note``.
    """
    item = get_owned_or_404(ctx.db, WishlistItem, item_id, ctx.user, "Wishlist item not found")
    currency = getattr(item.currency, "value", item.currency)

    row = item_currency_row(ctx, item)
    note = None
    if row is None:
        monthly_disposable = 0.0
        note = no_projection_note(currency)
    else:
        monthly_disposable = row["monthly_disposable"]
    savings_rate = monthly_disposable * SAVINGS_RATE_FACTOR

    if savings_rate <= 0:
        months_needed = 9999
        affordable_now = False
    else:
        months_needed = math.ceil(float(item.estimated_cost) / savings_rate)
        affordable_now = float(item.estimated_cost) <= monthly_disposable

    estimated_date = (utc_now() + timedelta(days=months_needed * 30)).date().isoformat()

    return WishlistReadiness(
        item_id=item.id,
        name=item.name,
        estimated_cost=item.estimated_cost,
        currency=currency,
        monthly_disposable=monthly_disposable,
        savings_rate=savings_rate,
        months_needed=months_needed,
        estimated_purchase_date=estimated_date,
        affordable_now=affordable_now,
        note=note,
    )

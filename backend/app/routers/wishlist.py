import math
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.context import RequestContext, request_context
from app.core.database import get_db
from app.core.access import get_owned_or_404, owned_criterion, require_account, require_owned_ref
from app.models.account import Account, AccountType
from app.models.category import Category
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
from app.services import forecast as forecast_svc
from app.services import wishlist_outlook
from app.services.installment_split import TOO_SMALL_MESSAGE, try_installment_split
from app.core.time import utc_now

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
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    item = get_owned_or_404(db, WishlistItem, item_id, current_user, "Wishlist item not found")

    update_data = payload.dict(exclude_unset=True)
    if "category_id" in update_data:
        require_owned_ref(db, Category, update_data["category_id"], "Category not found",
                          current_user)
    _validate_payment_update(db, current_user, item, update_data)
    if update_data.get("is_purchased") and not item.is_purchased:
        update_data.setdefault("purchased_at", utc_now())
    for field, value in update_data.items():
        setattr(item, field, value)
    item.updated_at = utc_now()
    db.commit()
    db.refresh(item)
    return item


PAYMENT_FIELDS = ("account_id", "payment_plan", "installment_months")


def _validate_payment_update(db: Session, user: User, item: WishlistItem,
                             update_data: dict) -> None:
    """The payment rules on the item as the update leaves it (``validate_payment``).

    Sending ``payment_plan`` "full" without ``installment_months`` clears the
    months. The account's access is checked only when a payment field is
    sent, so an edit of the name alone never fails on it. Once marking the
    item purchased created its card installment, the payment fields are
    fixed (409 on a change; resending the stored values passes).
    """
    sent = [f for f in PAYMENT_FIELDS if f in update_data]
    if "payment_plan" in update_data and update_data["payment_plan"] is None:
        raise HTTPException(status_code=422, detail="payment_plan cannot be null")
    if (update_data.get("payment_plan") == WishlistPaymentPlan.FULL
            and "installment_months" not in update_data):
        update_data["installment_months"] = None
        sent.append("installment_months")
    if not sent and "estimated_cost" not in update_data:
        return
    if item.installment_entry_id is not None and any(
            update_data[f] != getattr(item, f) for f in sent):
        raise HTTPException(status_code=409, detail=INSTALLMENT_LINKED_MESSAGE)
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

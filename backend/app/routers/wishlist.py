from dataclasses import asdict
from datetime import datetime, time, timezone
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
    WishlistFreeFlow,
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
from app.services import free_flow
from app.services import wishlist_outlook
from app.services import wishlist_projection as projection_svc
from app.services.installment_split import TOO_SMALL_MESSAGE, try_installment_split
from app.services.fx import FxRates, convert
from app.core.time import manila_day, utc_now

router = APIRouter()

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


QUEUE_BEYOND_NOTE = "More than 5 years away behind earlier items"
QUEUE_BEHIND_UNDATED_NOTE = "Waits behind an urgent need that has no date yet"
_WANT_ORDER = {"high": 0, "medium": 1, "low": 2}


def _queue(items: List[WishlistItem], projections: Dict[int, projection_svc.Projection],
           costs: Dict[int, Decimal]) -> Dict[int, dict]:
    """The plan's queue in one currency (STU-789, plan section 3): ``{item id:
    {cumulative_months, date, queue_note}}`` for the queued items, those whose
    currency row is ``ok`` and that are not paid from savings.

    Critical items first by ``created_at``, each at ``ceil(cumulative critical
    cost / net_flow)``; wants after them by priority then ``created_at``, each at
    the critical block (the last critical item's count, 0 with none) plus
    ``ceil(cumulative want cost / free_flow)``. A queued item with no rate (its
    rate is 0) has no count, so 0. Only an item that is ``dated`` on its own and
    whose count is at most 60 gets a date, and a want gets none while any queued
    critical item in its currency has none."""
    queued = [i for i in items if projections[i.id].row is not None]
    if not queued:
        return {}
    row = projections[queued[0].id].row
    critical = sorted((i for i in queued if projection_svc.is_critical(i)),
                      key=lambda i: (i.created_at, i.id))
    wants = sorted((i for i in queued if not projection_svc.is_critical(i)),
                   key=lambda i: (_WANT_ORDER[getattr(i.priority, "value", i.priority)],
                                  i.created_at, i.id))
    out: Dict[int, dict] = {}
    total, block, critical_undated = Decimal("0"), 0, False
    for item in critical:
        total += costs[item.id]
        months = projection_svc.months_for(total, row.net_flow) if row.net_flow > 0 else 0
        own_dated = projections[item.id].dated
        dated = own_dated and months <= projection_svc.HORIZON_MONTHS
        critical_undated = critical_undated or not dated
        block = months
        out[item.id] = {
            "cumulative_months": months,
            "date": projection_svc.due_date(months) if dated else None,
            "queue_note": QUEUE_BEYOND_NOTE if own_dated and not dated else None,
        }
    total = Decimal("0")
    for item in wants:
        total += costs[item.id]
        months = (block + projection_svc.months_for(total, row.free_flow)
                  if row.free_flow > 0 else 0)
        own_dated = projections[item.id].dated
        dated = own_dated and not critical_undated and months <= projection_svc.HORIZON_MONTHS
        if critical_undated:
            note = QUEUE_BEHIND_UNDATED_NOTE
        elif own_dated and not dated:
            note = QUEUE_BEYOND_NOTE
        else:
            note = None
        out[item.id] = {
            "cumulative_months": months,
            "date": projection_svc.due_date(months) if dated else None,
            "queue_note": note,
        }
    return out


def _critical_figures(item, p: projection_svc.Projection, cost: Decimal) -> dict:
    """``net_flow_after`` and ``from_saving`` for a critical item whose currency
    row is ``ok`` (and that is not paid from savings), on its own, dated or not;
    empty otherwise. The figures of several critical items do not add up."""
    if not projection_svc.is_critical(item) or p.row is None:
        return {}
    net, free = p.row.net_flow, p.row.free_flow
    from_saving = None
    if net > 0:
        from_saving = max(cost - projection_svc.months_for(cost, net) * free, Decimal("0"))
    return {"net_flow_after": float(net - cost),
            "from_saving": None if from_saving is None else float(from_saving)}


@router.get("/plan", response_model=WishlistPlanResponse)
def get_wishlist_plan(
    ctx: RequestContext = Depends(request_context),
):
    """
    Purchase timeline for all unpurchased items (STU-789, plan section 3). Each
    item carries its own ``projection_status`` from free flow
    (``services/wishlist_projection.py``); the queue in its currency then sets
    its date (``_queue``). An item that is not queued has no date and
    ``cumulative_months`` 0. ``monthly_disposable`` is the recurring-entry figure,
    kept for compatibility; ``savings_rate`` is the default currency's free flow
    when that row is ``ok``, else 0; ``net_flow`` lists the free-flow rows.

    An installment item (STU-779) is paid monthly on its card, not saved up
    for: it is left out of the queue (and of every later item's wait) and
    listed in ``installments`` with its monthly and final amounts.
    """
    db, current_user = ctx.db, ctx.user
    disposable_data = forecast_svc.get_disposable_income(db, current_user.id)
    monthly_disposable = disposable_data["monthly_disposable"]

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

    flow = free_flow.compute(ctx)
    costs = {item.id: price_of(item.estimated_cost) for item in queued}
    projections = {item.id: projection_svc.project(ctx, item, costs[item.id])
                   for item in queued}
    by_currency: Dict[str, List[WishlistItem]] = {}
    for item in queued:
        by_currency.setdefault(getattr(item.currency, "value", item.currency), []).append(item)
    queue: Dict[int, dict] = {}
    for group in by_currency.values():
        queue.update(_queue(group, projections, costs))

    plan: List[WishlistPlanItem] = []
    for item in queued:
        p = projections[item.id]
        q = queue.get(item.id, {"cumulative_months": 0, "date": None, "queue_note": None})
        plan.append(WishlistPlanItem(
            item_id=item.id,
            name=item.name,
            estimated_cost=item.estimated_cost,
            estimated_purchase_date=q["date"],
            cumulative_months=q["cumulative_months"],
            note=None if q["date"] is not None else (p.note or q["queue_note"]),
            currency=getattr(item.currency, "value", item.currency),
            priority=item.priority,
            basis=p.basis,
            projection_status=p.status,
            projection_note=p.note,
            queue_note=q["queue_note"],
            **_critical_figures(item, p, costs[item.id]),
        ))

    default = flow.row(ctx.default_currency)
    savings_rate = (float(default.free_flow)
                    if default is not None and default.status == free_flow.OK else 0.0)
    return WishlistPlanResponse(
        monthly_disposable=monthly_disposable,
        savings_rate=savings_rate,
        items=plan,
        installments=installments,
        net_flow=[asdict(r) for r in flow.rows],
    )


@router.get("/free-flow", response_model=WishlistFreeFlow)
def get_free_flow(
    ctx: RequestContext = Depends(request_context),
):
    """The caller's monthly free flow per currency, from their posted
    transactions and savings goals (STU-788, ``services/free_flow.py``).
    Registered before ``/{item_id}`` so the path is not read as an id."""
    result = free_flow.compute(ctx)
    return WishlistFreeFlow(
        rows=[asdict(r) for r in result.rows],
        goals=[asdict(g) for g in result.goals],
        limitations=list(result.limitations),
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
    """Edit an item. Marking an installment item purchased, or switching an
    already purchased item to the installment plan, creates its card
    installment in the same change (``_create_installment``, STU-779; the
    switch dates it from the item's ``purchased_at``), once:
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
    switching = "payment_plan" in update_data and item.is_purchased
    if ((purchasing or switching) and item.payment_plan == WishlistPaymentPlan.INSTALLMENT
            and item.installment_entry_id is None):
        if item.purchased_at is None:
            item.purchased_at = utc_now()
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
    running, and whether this item fits its rate from free flow (STU-789) and,
    on a card, its available credit (``services/wishlist_outlook.py``)."""
    item = get_owned_or_404(ctx.db, WishlistItem, item_id, ctx.user, "Wishlist item not found")
    price = price_of(item.estimated_cost)
    return wishlist_outlook.outlook(ctx, item, price, item_currency_row(ctx, item),
                                    projection_svc.project(ctx, item, price))


@router.get("/{item_id}/readiness", response_model=WishlistReadiness)
def get_readiness(
    item_id: int,
    ctx: RequestContext = Depends(request_context),
):
    """
    Advisory (STU-789): when the caller can afford this item, from its rate
    (``services/wishlist_projection.py``). ``savings_rate`` is the rate, 0 when
    there is none; ``affordable_now`` is ``cost <= rate`` when there is one.
    ``estimated_date`` is set only for a ``dated`` item. The legacy
    ``months_needed`` and ``estimated_purchase_date`` follow from the rate for a
    ``dated`` item and otherwise keep the zero-rate values (9999 and the date that
    follows); they are deprecated. ``monthly_disposable`` is the recurring-entry
    figure, kept for compatibility.
    """
    item = get_owned_or_404(ctx.db, WishlistItem, item_id, ctx.user, "Wishlist item not found")
    currency = getattr(item.currency, "value", item.currency)
    row = item_currency_row(ctx, item)
    monthly_disposable = 0.0 if row is None else row["monthly_disposable"]

    cost = price_of(item.estimated_cost)
    p = projection_svc.project(ctx, item, cost)
    months_needed = p.months if p.dated else 9999

    return WishlistReadiness(
        item_id=item.id,
        name=item.name,
        estimated_cost=item.estimated_cost,
        currency=currency,
        monthly_disposable=monthly_disposable,
        savings_rate=float(p.rate) if p.rate is not None else 0.0,
        months_needed=months_needed,
        estimated_purchase_date=projection_svc.due_date(months_needed),
        affordable_now=p.rate is not None and cost <= p.rate,
        note=p.note,
        estimated_date=p.date,
        basis=p.basis,
        projection_status=p.status,
        projection_note=p.note,
    )

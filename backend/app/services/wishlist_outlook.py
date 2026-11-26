"""A wishlist item's installment outlook (STU-779): ``GET /wishlist/{id}/outlook``.

Everything is read for the item's owner, who is the caller (wishlist items are
never shared), through the request's context, so household roles apply as in
the forecast: the card installments are the forecast's own events, and a card's
credit is shown only to its owner or an admin (``card_credit.can_see_credit``).

**Months.** One row per month from next month (Manila) through the later of the
item's term (its months, or one for a full payment) and 12 months: the card
installments already running that month (``existing_installments``: each active
card installment occurrence the forecast projects, ``recurring_kinds.is_card_installment``,
at its own amount converted into the item's currency), this item (its monthly
amount, the final payment in its last month; a full payment in the first month),
and their total. The rows are context only: nothing below subtracts them.

**Disposable check** (STU-789). This item alone, its monthly amount (an
installment, linked or not) or its full price, against its rate from free flow
(``wishlist_projection``): ``available`` is the item's net flow (critical) or
free flow (a want) in its currency, and ``basis`` says which. ``fits`` or ``over``
when the item has a rate (its currency row is ``ok`` and it is not paid from
savings), else ``unknown`` with the projection's note as ``reason``.
``after_purchase`` is ``available`` less this item. ``monthly_disposable`` keeps
the recurring-entry figure (``forecast.disposable_by_currency``, the item's
currency, null with no row or no income), for compatibility only.

**Credit check.** Card accounts only: the full price, converted into the card's
currency, against the card's available credit now (``card_credit.credit_for_cards``);
an installment holds the whole price on the limit. ``unknown`` when the card has
no limit or the caller may not see its credit.

A missing exchange rate gives ``unknown`` (or a null month figure) with a reason.
Once marking the item purchased created its installment, that entry is already in
the card's hold and the forecast: it is left out of ``existing_installments``,
``this_item`` is its own projected payments (on the statement closes, converted
into the item's currency; null with no stored rate), and the credit check
compares nothing more (``already_counted``).
"""
from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from app.core.context import RequestContext
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.wishlist_item import WishlistItem, WishlistPaymentPlan
from app.services import card_credit
from app.services import forecast as forecast_svc
from app.services.installment_split import installment_split
from app.services.recurring_kinds import is_card_installment
from app.services.wishlist_projection import Projection

OUTLOOK_MIN_MONTHS = 12
_ZERO = Decimal("0")

ALREADY_COUNTED = "This item's installment already counts in your plan"
NO_LIMIT = "This card has no credit limit set"
NO_CREDIT_ACCESS = "Only the card's owner or an admin can see its available credit"
NO_RATE = "No exchange rate from {base} to {quote} is stored yet"
UNCONVERTED_INSTALLMENTS = (
    "Some card installments have no exchange rate into {currency}, so those months "
    "show no total")


def _code(currency) -> str:
    return getattr(currency, "value", currency)


def _f(value) -> Optional[float]:
    return None if value is None else round(float(value), 2)


def _add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def this_item_payments(item: WishlistItem, price: Decimal) -> List[Decimal]:
    """The item's own payments, month by month: the installment split (each
    payment but the last, then the last), or the full price at once."""
    if item.payment_plan == WishlistPaymentPlan.INSTALLMENT:
        split = installment_split(price, item.installment_months)
        return [split.amount] * (item.installment_months - 1) + [split.final_amount]
    return [price]


def _installments_by_month(ctx: RequestContext, item: WishlistItem, start: date,
                           count: int) -> tuple:
    """``(existing, linked, any unconverted)``: per month, the card installments
    already running (``existing``) and the occurrences of the item's own linked
    entry (``linked``), each from the forecast's events and converted into the
    item's currency; a month holding a figure with no stored rate is None."""
    db = ctx.db
    begin = datetime.combine(start, datetime.min.time())
    end = datetime.combine(_add_months(start, count), datetime.min.time())
    events = forecast_svc.shared_events(ctx, begin, end, keep_origin=True, detail=True)
    entry_ids = {e["origin"][1] for e in events
                 if e.get("origin") and e["origin"][0] is BudgetEntry}
    entries = ({e.id: e for e in db.query(BudgetEntry).filter(BudgetEntry.id.in_(entry_ids))}
               if entry_ids else {})
    account_ids = {e.account_id for e in entries.values() if e.account_id}
    accounts = ({a.id: a for a in db.query(Account).filter(Account.id.in_(account_ids))}
                if account_ids else {})
    money = forecast_svc.Money(db, ctx.fx)
    existing: List[Optional[Decimal]] = [_ZERO] * count
    linked: List[Optional[Decimal]] = [_ZERO] * count
    unconverted = False
    for e in events:
        origin = e.get("origin")
        if not origin or origin[0] is not BudgetEntry:
            continue
        entry = entries.get(origin[1])
        if entry is None:
            continue
        own = entry.id == item.installment_entry_id
        if not own and not is_card_installment(entry, accounts.get(entry.account_id)):
            continue
        totals = linked if own else existing
        when = forecast_svc._naive(e["date"]).date()
        index = (when.year - start.year) * 12 + when.month - start.month
        if not 0 <= index < count:
            continue
        figure, _ = money.to(e["face_amount"], e.get("face_currency") or entry.currency,
                             item.currency)
        if figure is None:
            unconverted = True
            totals[index] = None
        elif totals[index] is not None:
            totals[index] += figure
    return existing, linked, unconverted


def _disposable_check(item: WishlistItem, row: Optional[dict], amount: Decimal,
                      projection: Projection) -> dict:
    currency = _code(item.currency)
    disposable = (Decimal(str(row["monthly_disposable"]))
                  if row is not None and row["monthly_income"] > 0 else None)
    out = {"currency": currency, "amount": _f(amount), "monthly_disposable": _f(disposable),
           "basis": projection.basis}
    if projection.rate is None:
        return {**out, "status": "unknown", "reason": projection.note}
    available = projection.rate
    return {
        **out,
        "status": "fits" if amount <= available else "over",
        "available": _f(available),
        "after_purchase": _f(available - amount),
        "reason": None,
    }


def _credit_check(ctx: RequestContext, item: WishlistItem, account: Optional[Account],
                  price: Decimal, already_counted: bool) -> Optional[dict]:
    if account is None or account.account_type != AccountType.CREDIT:
        return None
    if not card_credit.can_see_credit(ctx.user, account):
        return {"status": "unknown", "reason": NO_CREDIT_ACCESS}
    credit = card_credit.credit_for_cards(ctx, [account.id]).get(account.id)
    if credit is None or credit["limit"] is None:
        return {"status": "unknown", "reason": NO_LIMIT}
    quote = credit["currency"]
    base = _code(item.currency)
    figure, _ = forecast_svc.Money(ctx.db, ctx.fx).to(
        _ZERO if already_counted else price, base, quote)
    out = {"currency": quote, "available": credit["available_now"], "limit": credit["limit"]}
    if figure is None:
        return {**out, "status": "unknown", "reason": NO_RATE.format(base=base, quote=quote)}
    available = Decimal(str(credit["available_now"]))
    return {**out, "status": "fits" if figure <= available else "over", "amount": _f(figure),
            "reason": ALREADY_COUNTED if already_counted else None}


def outlook(ctx: RequestContext, item: WishlistItem, price: Decimal, row: Optional[dict],
            projection: Projection) -> dict:
    """The outlook (module docstring). ``price`` is the item's price as money,
    ``row`` the disposable row of its currency (None when there is none) and
    ``projection`` the item's own (``wishlist_projection.project``)."""
    payments = this_item_payments(item, price)
    count = max(len(payments), OUTLOOK_MIN_MONTHS)
    start = _add_months(ctx.today, 1)
    existing, linked, unconverted = _installments_by_month(ctx, item, start, count)
    already_counted = item.installment_entry_id is not None
    months = []
    for i in range(count):
        # Once purchased, this item's months are its entry's own projected payments
        # (charged on the statement close), not the plan's split from next month.
        if already_counted:
            mine = linked[i]
        else:
            mine = payments[i] if i < len(payments) else _ZERO
        months.append({
            "month": _add_months(start, i).strftime("%Y-%m"),
            "existing_installments": _f(existing[i]),
            "this_item": _f(mine),
            "total": _f(None if existing[i] is None or mine is None
                        else existing[i] + mine),
        })
    installment = item.payment_plan == WishlistPaymentPlan.INSTALLMENT
    account = ctx.db.get(Account, item.account_id) if item.account_id else None
    return {
        "item_id": item.id,
        "currency": _code(item.currency),
        "payment_plan": item.payment_plan,
        "estimated_cost": _f(price),
        "installment_months": item.installment_months,
        "monthly_amount": _f(payments[0]) if installment else None,
        "final_amount": _f(payments[-1]) if installment else None,
        "months": months,
        "note": UNCONVERTED_INSTALLMENTS.format(currency=_code(item.currency))
        if unconverted else None,
        "disposable_check": _disposable_check(
            item, row, payments[0] if installment else price, projection),
        "credit_check": _credit_check(ctx, item, account, price, already_counted),
        "projection_status": projection.status,
        "projection_note": projection.note,
    }

"""
Unified dashboard snapshot endpoint for Tally & Trace.
Returns everything the front-end needs in a single call.
"""
import math

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.conditional import conditional_get
from app.core.config import settings
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.access import TAG_VIEWER, owned_criterion
from app.core.context import RequestContext, request_context
from app.core.tags import TAG_FILTER_HELP, filter_tag_id
from app.models.allocation import Allocation, AllocationType
from app.models.user import User
from app.models.wishlist_item import WishlistItem
from app.services import card_charges as card_charges_svc
from app.services import card_credit as card_credit_svc
from app.services import forecast as forecast_svc
from app.services import missed as missed_svc
from app.services import quick_balances as quick_balances_svc
from app.services.fx import FxRates, get_fx
from app.core.time import utc_now

router = APIRouter()


class QuickBalancePins(BaseModel):
    """``PUT /dashboard/quick-balances``: the full ordered list of pinned account ids."""
    account_ids: List[int] = Field(max_length=quick_balances_svc.MAX_TILES)

    @field_validator("account_ids")
    @classmethod
    def _distinct(cls, ids: List[int]) -> List[int]:
        if len(set(ids)) != len(ids):
            raise ValueError("account_ids must be distinct")
        return ids

SAVINGS_RATE_FACTOR = 0.5


def _due_lists(ctx: RequestContext, upcoming: list, *, tag_id: Optional[int],
               collector: forecast_svc.FxCollector, ids: forecast_svc.PublicIds) -> dict:
    """The lists the Transactions page's Due card reads, after ``upcoming`` (the
    30-day ``upcoming_by_currency`` items, given with the same ``collector`` and
    ``ids``): ``payables``, ``card_charges``, ``card_statements_due``, ``missed``,
    ``installment_review``, ``installment_auto_post``, ``autopay_due`` and
    ``auto_post_scheduled``. The snapshot and ``/dashboard/due`` both build them
    here, so their rows cannot drift apart. Adds the entry and loan row fields to
    ``upcoming`` and ``payables`` in place."""
    payables = forecast_svc.payables_by_currency(ctx, days=30, tag_id=tag_id,
                                                 collector=collector, ids=ids)
    # After the other lists: its rows join the same ``fx`` and public ids.
    # Available credit on the cards the caller manages (owner or admin, with a
    # limit): no one else gets a credit key (services/card_credit.py).
    credit = card_credit_svc.credit_for_cards(ctx, card_credit_svc.managed_card_ids(ctx))
    card_charges = card_charges_svc.card_charges_by_card(
        ctx, collector=collector, ids=ids, credit=credit)
    statements_due = card_credit_svc.statements_due(ctx)
    missed = missed_svc.recurring_missed(ctx, tag_id=tag_id)
    installments = missed_svc.installment_snapshot(ctx)
    autopay_due = missed_svc.autopay_due(ctx)
    # Snapshot and due only: /forecast/payables and /forecast/upcoming stay as they are.
    missed_svc.entry_row_fields(ctx, upcoming)
    missed_svc.entry_row_fields(ctx, payables)
    missed_svc.loan_row_fields(ctx, upcoming)
    missed_svc.loan_row_fields(ctx, payables)
    return {
        "payables": payables,
        "card_charges": card_charges,
        "card_statements_due": statements_due,
        "missed": missed,
        "installment_review": installments["installment_review"],
        "installment_auto_post": installments["installment_auto_post"],
        "autopay_due": autopay_due,
        "auto_post_scheduled": settings.JOB_TOKEN is not None,
    }


@router.get("/snapshot", dependencies=[Depends(conditional_get)])
def get_snapshot(
    ctx: RequestContext = Depends(request_context),
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
):
    """
    Single-call snapshot returning:
    - Account balances
    - Upcoming items this month
    - Monthly income/expense summary
    - 3-month cash-flow forecast
    - Goal progress
    - Top 3 wishlist items with readiness advisory
    - Available cash (projection-cash accounts only; card balances are owed)
    - Per-account month-end closings over the forecast window
    - Payables (cash outflows) due in the next 30 days
    - Upcoming charges by card (``card_charges``, services/card_charges.py), each
      card the caller manages with a limit carrying its available ``credit``
      (services/card_credit.py)
    - Each managed card's owed closed statement (``card_statements_due``,
      ``card_credit.statements_due``): owner and admin, active credit cards,
      with or without a limit; the amount is what Pay suggests as Full
    - Missed recurring entries outside the cards' lists (``missed``,
      services/missed.py), a card installment's row carrying ``auto_post``,
      ``block_reason`` and ``can_review``
    - Card installments to review (``installment_review``, each row's
      ``clean_review`` the binding a batch review sends back when the review
      asks nothing, else null; services/missed.py) and those with
      months due (``installment_auto_post``, with the caller's ``postable_count``
      and ``due_today_count``), and whether the morning job is configured
      (``auto_post_scheduled``)
    - Autopay cash entries and loans with a payment due (``autopay_due``,
      services/missed.py), a held payment among them with its ``block_reason``
    - Full budget-entry rows in ``upcoming_this_month``
      and ``payables`` carry ``kind`` and ``can_mark_paid``, and full loan rows
      ``settlement``

    With ``?tag=`` the upcoming items, monthly summary, forecast, closings and
    payables keep only tagged records (see routers/forecast.py), and so does
    ``missed``; balances, available cash, goals, the wishlist, the card
    charges, ``card_statements_due``, ``installment_review``,
    ``installment_auto_post`` and ``autopay_due`` are not tagged and stay whole.

    Split by account currency (STU-236): every scalar is the user's default
    currency, ``by_currency`` rows carry each currency's (``balances``,
    ``monthly_summary``, each forecast period and each closing), full list
    rows carry their ``currency``, and ``currencies`` and ``fx`` describe the
    response.
    """
    # Stamped before any list is computed: a request crossing Manila midnight
    # reports the older day, so the client refetches rather than taking
    # yesterday's rows for today's.
    db, current_user, today = ctx.db, ctx.user, ctx.today
    tag_id = filter_tag_id(db, current_user, tag)
    default = ctx.default_currency
    collector = forecast_svc.FxCollector()
    # Limited public ids are numbered once per response: an occurrence keeps
    # one id in upcoming and payables, and distinct ones never share one.
    ids = forecast_svc.PublicIds()
    # -----------------------------------------------------------------------
    # 1. Account balances
    # -----------------------------------------------------------------------
    accounts = ctx.accounts
    total_balance = sum(a.balance for a in accounts if a.currency.value == default)
    balance_rows = [
        {
            "currency": c,
            "total": round(sum(a.balance for a in accounts if a.currency.value == c), 2),
            "available_cash": round(float(forecast_svc.get_available_cash(
                [a for a in accounts if a.currency.value == c])), 2),
        }
        for c in forecast_svc.ordered_currencies({a.currency.value for a in accounts}, default)
    ]
    # By the caller's role: an account seen through a tag share shows only
    # what every role sees (no settings, so no spending-wallet flag).
    held = ctx.access
    by_account = [
        {
            "id": a.id,
            "name": a.name,
            "balance": a.balance,
            "currency": a.currency.value,
            # Shown, but not counted in available cash or projections.
            **({} if held.of(a) == TAG_VIEWER
               else {"is_spending_wallet": forecast_svc.is_spending_wallet(a)}),
        }
        for a in accounts
    ]

    # -----------------------------------------------------------------------
    # 2. Upcoming this month (next 30 days)
    # -----------------------------------------------------------------------
    # One ``collect_events`` run serves every list below (STU-598): it reaches
    # the end of the cash-flow window, the furthest any of them reads.
    ctx.widen_events(forecast_svc.cashflow_window_end(3))
    upcoming = forecast_svc.upcoming_by_currency(ctx, days=30, tag_id=tag_id,
                                                 collector=collector, ids=ids)["items"]

    # -----------------------------------------------------------------------
    # 3. Monthly income/expense summary (disposable income)
    # -----------------------------------------------------------------------
    disposable = forecast_svc.disposable_by_currency(ctx, tag_id=tag_id)
    disposable_data = {k: v for k, v in disposable.items() if k not in ("currencies", "fx")}

    # -----------------------------------------------------------------------
    # 4. 3-month cash-flow forecast
    # -----------------------------------------------------------------------
    forecast_3m = forecast_svc.cashflow_by_currency(ctx, months=3, tag_id=tag_id,
                                                    collector=collector)["periods"]

    # -----------------------------------------------------------------------
    # 5. Goals progress
    # -----------------------------------------------------------------------
    goals_query = db.query(Allocation).filter(
        owned_criterion(Allocation, current_user),
        Allocation.allocation_type == AllocationType.GOAL,
        Allocation.is_active.is_(True),
    )

    goals_progress = []
    for goal in goals_query.all():
        if goal.target_amount and goal.target_amount > 0:
            progress_pct = round((goal.current_amount / goal.target_amount) * 100, 1)
            remaining = round(max(goal.target_amount - goal.current_amount, 0), 2)
        else:
            progress_pct = 0.0
            remaining = 0.0
        goals_progress.append({
            "id": goal.id,
            "name": goal.name,
            "target_amount": goal.target_amount,
            "current_amount": goal.current_amount,
            "progress_pct": progress_pct,
            "remaining": remaining,
        })

    # -----------------------------------------------------------------------
    # 6. Top 3 wishlist items (unpurchased) with affordability
    # -----------------------------------------------------------------------
    monthly_disposable = disposable_data["monthly_disposable"]
    savings_rate = max(monthly_disposable * SAVINGS_RATE_FACTOR, 0.01)

    from sqlalchemy import case
    priority_order = case(
        {"critical": 0, "high": 1, "medium": 2, "low": 3},
        value=WishlistItem.priority,
    )
    wishlist_items = (
        db.query(WishlistItem)
        .filter(
            owned_criterion(WishlistItem, current_user),
            WishlistItem.is_purchased.is_(False),
        )
        .order_by(priority_order, WishlistItem.created_at)
        .limit(3)
        .all()
    )

    from datetime import timedelta
    wishlist_next_up = []
    for item in wishlist_items:
        months_needed = math.ceil(float(item.estimated_cost) / savings_rate)
        affordable_by = (utc_now() + timedelta(days=months_needed * 30)).date().isoformat()
        wishlist_next_up.append({
            "id": item.id,
            "name": item.name,
            "cost": item.estimated_cost,
            "priority": item.priority.value,
            "affordable_by": affordable_by,
        })

    # -----------------------------------------------------------------------
    # 7. Available cash, per-account closings, payables
    # -----------------------------------------------------------------------
    available_cash = forecast_svc.get_available_cash(
        [a for a in accounts if a.currency.value == default])
    account_closings = [
        {
            "period_label": p["period_label"],
            "period_start": p["period_start"],
            "period_end": p["period_end"],
            "by_account": p["by_account"],
            "unassigned_closing": p["unassigned_closing"],
            "overflow_moves": p["overflow_moves"],
            "by_currency": [
                {k: row[k] for k in ("currency", "by_account", "unassigned_closing",
                                     "overflow_moves")}
                for row in p["by_currency"]
            ],
        }
        for p in forecast_3m
    ]
    due = _due_lists(ctx, upcoming, tag_id=tag_id, collector=collector, ids=ids)

    return {
        "balances": {
            "total": round(total_balance, 2),
            "by_account": by_account,
            "by_currency": balance_rows,
        },
        "upcoming_this_month": upcoming,
        "monthly_summary": disposable_data,
        "forecast_next_3_months": forecast_3m,
        "goals_progress": goals_progress,
        "wishlist_next_up": wishlist_next_up,
        "available_cash": round(float(available_cash), 2),
        "account_closings": account_closings,
        "payables": due["payables"],
        "card_charges": due["card_charges"],
        "card_statements_due": due["card_statements_due"],
        "missed": due["missed"],
        "installment_review": due["installment_review"],
        "installment_auto_post": due["installment_auto_post"],
        "autopay_due": due["autopay_due"],
        "auto_post_scheduled": due["auto_post_scheduled"],
        # The Manila day this snapshot was computed for (STU-511): a client
        # holding it across midnight can tell its rows are yesterday's.
        "today": today.isoformat(),
        # The monthly summary's currencies too (viewable accounts and entries'
        # buckets, no placeholder); ``fx.rates`` stays the full listed rows'.
        "currencies": forecast_svc.response_currencies(
            {a.currency.value for a in accounts} | set(disposable["currencies"]),
            collector, default),
        "fx": collector.as_dict(),
    }


@router.get("/quick-balances")
def get_quick_balances(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """``QuickBalances``: the dashboard's quick balance tiles (STU-578,
    services/quick_balances.py).

    ``{pinned, max_tiles, tiles}``. Each tile is ``{account_id, name,
    account_type, currency, balance, slot}`` in the account's own currency
    (no conversion, no tag filter), ``slot`` the default slot it fills
    (``debit``, ``credit`` or ``e_wallet``). A credit card the caller owns
    or administers adds ``card`` (``{amount_due, due_date, overdue,
    incomplete, unbilled}``, ``card_credit.amount_due``), and one whose
    group is served credit adds ``credit`` (``{limit, available_now,
    complete, shared_with}``, ``card_credit.credit_for_cards``).
    """
    return quick_balances_svc.quick_balances(db, current_user, fx)


@router.put("/quick-balances")
def put_quick_balances(
    body: QuickBalancePins,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    fx: FxRates = Depends(get_fx),
):
    """Store the caller's pinned quick balances (0 to 6 distinct ids, in order;
    ``[]`` clears them) and return ``QuickBalances`` as GET does. An account
    the caller may not pin is a 404 without its name."""
    quick_balances_svc.set_pins(db, current_user, body.account_ids)
    return quick_balances_svc.quick_balances(db, current_user, fx)

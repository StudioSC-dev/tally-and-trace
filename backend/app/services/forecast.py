"""
Cash-flow projection engine for Tally & Trace.

Given a set of accounts, budget entries (recurring income/expenses), and
unposted transactions, this service generates a forward-looking timeline.
"""

from __future__ import annotations

from calendar import monthrange
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from types import SimpleNamespace
from typing import Iterator, List, Optional, Sequence

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.entity_context import scope_criterion
from app.core.time import naive_utc_now
from app.services.statements import get_statement_payables
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType
from app.models.transaction import RecurrenceFrequency


# ---------------------------------------------------------------------------
# Period helpers
# ---------------------------------------------------------------------------

def _add_months(dt: datetime, months: int) -> datetime:
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    day = min(dt.day, monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _next_occurrence(current: datetime, cadence: RecurrenceFrequency) -> datetime:
    if cadence == RecurrenceFrequency.WEEKLY:
        return current + timedelta(days=7)
    if cadence == RecurrenceFrequency.BIWEEKLY:
        return current + timedelta(days=14)
    if cadence == RecurrenceFrequency.MONTHLY:
        return _add_months(current, 1)
    if cadence == RecurrenceFrequency.QUARTERLY:
        return _add_months(current, 3)
    if cadence == RecurrenceFrequency.SEMI_ANNUAL:
        return _add_months(current, 6)
    if cadence == RecurrenceFrequency.ANNUAL:
        return _add_months(current, 12)
    # SEMI_MONTHLY is not a fixed step (two days per month) — handled by iter_occurrences.
    return _add_months(current, 1)


def _monthly_equivalent(amount: float, cadence: RecurrenceFrequency) -> float:
    """Normalize any cadence to a monthly amount."""
    per_month = {
        RecurrenceFrequency.WEEKLY: 52 / 12,
        RecurrenceFrequency.BIWEEKLY: 26 / 12,
        RecurrenceFrequency.SEMI_MONTHLY: 2.0,
        RecurrenceFrequency.MONTHLY: 1.0,
        RecurrenceFrequency.QUARTERLY: 1 / 3,
        RecurrenceFrequency.SEMI_ANNUAL: 1 / 6,
        RecurrenceFrequency.ANNUAL: 1 / 12,
    }
    return float(amount) * per_month.get(cadence, 1.0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_projection_cash(account) -> bool:
    """True when an account's balance is money on hand for projection purposes.

    Credit-card balances are money owed, not cash: card spending reaches cash only
    when the statement is paid (modelled as dated statement payables).
    """
    return account.account_type != AccountType.CREDIT


def get_account_balances(db: Session, user_id: int, entity_id: Optional[int] = None):
    """Return all active accounts for the user (optionally scoped to entity)."""
    query = db.query(Account).filter(
        scope_criterion(Account, user_id, entity_id),
        Account.is_active.is_(True),
    )
    return query.all()


def project_cashflow(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    months: int = 6,
    reference: Optional[datetime] = None,
) -> List[dict]:
    """
    Generate a month-by-month cash-flow projection from the dated events
    (``collect_events``), so it agrees with the running-balance timeline.

    The window starts TODAY (the same ``start`` as the timeline: opening balances
    are as of now), so the first period runs from today to the 1st of next month
    and later periods are whole calendar months.

    Returns a list of dicts with keys:
      period_label, period_start, period_end,
      opening_balance, income, expenses, unposted_expenses, statement_payables,
      net, closing_balance, by_account, unassigned_closing, overflow_moves

    ``income`` / ``expenses`` are budget-entry occurrences; ``unposted_expenses`` is
    net unposted cash transactions (debits - credits + transfer fees, plus transfer
    amounts crossing the scope boundary), excluding card payments;
    ``statement_payables`` is cash paid to credit cards in the period: statement
    payables due (net of payments) plus planned card payments.
    ``by_account`` is each projection-cash account's month-end closing, excluding
    virtual overflow pulls (reported in ``overflow_moves``).
    """
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = start.replace(day=1)
    boundaries = [start] + [_add_months(month_start, i) for i in range(1, months + 1)]
    end = boundaries[-1]

    accounts, opening_by_account, account_names = _projection_accounts(db, user_id, entity_id)
    opening = sum(opening_by_account.values(), Decimal("0"))

    events = collect_events(db, start, end, user_id=user_id, entity_id=entity_id, accounts=accounts)
    cash_events = [e for e in events if e["counts_as_cash"]]
    routing = _route_legs(
        opening_by_account, cash_events, account_names,
        checkpoints=[b.date() for b in boundaries[1:]],
    )

    def f(x: Decimal) -> float:
        return round(float(x), 2)

    timeline = []
    for i in range(months):
        period_start, period_end = boundaries[i], boundaries[i + 1]
        in_period = [e for e in cash_events if period_start <= _naive(e["date"]) < period_end]

        def total(source: str, sign: int = 0) -> Decimal:
            amounts = (e["amount"] for e in in_period if e["source"] == source)
            if sign > 0:
                amounts = (a for a in amounts if a > 0)
            elif sign < 0:
                amounts = (a for a in amounts if a < 0)
            return sum(amounts, Decimal("0"))

        income = total("budget_entry", 1)
        expenses = -total("budget_entry", -1)
        card_payments = sum(
            (e["amount"] for e in in_period if e.get("card_payment")), Decimal("0"))
        unposted = -(total("transaction") - card_payments)
        statements = -(total("statement") + card_payments)
        net = sum((e["amount"] for e in in_period), Decimal("0"))
        closing = opening + net

        snapshot = routing["closings"][i]
        timeline.append({
            "period_label": period_start.strftime("%B %Y"),
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "opening_balance": f(opening),
            "income": f(income),
            "expenses": f(expenses),
            "unposted_expenses": f(unposted),
            "statement_payables": f(statements),
            "net": f(net),
            "closing_balance": f(closing),
            "by_account": [
                {
                    "account_id": a["account_id"],
                    "account_name": a["account_name"],
                    "closing_balance": f(a["closing_balance"]),
                }
                for a in account_closings(snapshot, opening_by_account, account_names)
            ],
            "unassigned_closing": f(snapshot["unassigned"]),
            "overflow_moves": serialize_overflow_moves([
                m for m in routing["overflow_moves"]
                if period_start.date() <= m["date"] < period_end.date()
            ]),
        })

        opening = closing

    return timeline


def _upcoming_window(days: int, reference: Optional[datetime]) -> tuple:
    """``[start of today, end of the day `days` from now)`` — the cutoff day is inclusive."""
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=days + 1)


def get_upcoming_items(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    days: int = 30,
    reference: Optional[datetime] = None,
) -> List[dict]:
    """
    Return every dated event from ``collect_events`` within the next N days
    (budget-entry occurrences, unposted transactions and credit-card statement
    payables), sorted by date. ``amount`` is the unsigned amount as entered.
    """
    start, end = _upcoming_window(days, reference)
    events = collect_events(db, start, end, user_id=user_id, entity_id=entity_id)

    items = [
        {
            "name": e["name"],
            "amount": e["face_amount"],
            "due_date": _naive(e["date"]).date().isoformat(),
            "entry_type": e["type"],
            "source": e["source"],
            "source_id": e["source_id"],
        }
        for e in events
    ]
    items.sort(key=lambda x: x["due_date"])
    return items


def get_available_cash(accounts) -> Decimal:
    """Pooled projection cash: the sum of projection-cash account balances."""
    return sum((_money(a.balance) for a in accounts if is_projection_cash(a)), Decimal("0"))


def get_payables(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    days: int = 30,
    reference: Optional[datetime] = None,
) -> List[dict]:
    """Cash outflows due within the next N days, with the account each draws on.

    Same window and events as ``get_upcoming_items``, restricted to events that
    take cash out of the pool (bills, unposted debits, card statements and planned
    card payments). Other transfers between your own accounts are not payables;
    card charges reach cash via their statement payable instead.
    """
    start, end = _upcoming_window(days, reference)
    accounts = get_account_balances(db, user_id, entity_id)
    names = {a.id: a.name for a in accounts}
    events = collect_events(db, start, end, user_id=user_id, entity_id=entity_id, accounts=accounts)

    payables = []
    for e in sorted(events, key=_event_sort_key):
        if not e["counts_as_cash"] or e["amount"] >= 0:
            continue
        if e["type"] == TransactionType.TRANSFER.value and not e.get("card_payment"):
            continue
        acc = e["funding_account_id"]
        ov = e["overflow_account_id"]
        payables.append({
            "due_date": _naive(e["date"]).date().isoformat(),
            "name": e["name"],
            "amount": round(float(-e["amount"]), 2),
            "source": e["source"],
            "source_id": e["source_id"],
            "account_id": acc,
            "account_name": names.get(acc),
            "overflow_account_id": ov,
            "overflow_account_name": names.get(ov),
        })
    return payables


def get_disposable_income(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
) -> dict:
    """
    Compute monthly net disposable income:
    total monthly income - total monthly expenses (normalised from each cadence).
    """
    be_query = db.query(BudgetEntry).filter(
        scope_criterion(BudgetEntry, user_id, entity_id),
        BudgetEntry.is_active.is_(True),
    )

    monthly_income: float = 0.0
    monthly_expenses: float = 0.0

    for entry in be_query.all():
        monthly = _monthly_equivalent(entry.amount, entry.cadence)
        if entry.entry_type == BudgetEntryType.INCOME:
            monthly_income += monthly
        else:
            monthly_expenses += monthly

    disposable = monthly_income - monthly_expenses
    return {
        "monthly_income": round(monthly_income, 2),
        "monthly_expenses": round(monthly_expenses, 2),
        "monthly_disposable": round(disposable, 2),
    }


# ---------------------------------------------------------------------------
# Dated running-balance timeline (pre-due-date solvency)
#
# The month-bucket projection above answers "does the month net out?". This
# section answers the question that actually keeps you solvent: "at any point
# WITHIN the window, does the running balance go negative before payday?".
# It walks every income/payable in date order, carries a running balance, and
# reports the trough (lowest point + date) and any shortfall.
# ---------------------------------------------------------------------------

_CENTS = Decimal("0.01")


def _money(x) -> Decimal:
    """Coerce a float/Decimal/int into a 2dp Decimal (money is stored as float today)."""
    return Decimal(str(x)).quantize(_CENTS, rounding=ROUND_HALF_UP)


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _clamp_day(year: int, month: int, day: int) -> int:
    """Clamp a day-of-month to the month's length (so e.g. day 31 -> 30/28)."""
    return min(day, monthrange(year, month)[1])


def iter_occurrences(entry, start: datetime, end: datetime) -> Iterator[datetime]:
    """Yield naive occurrence datetimes for a budget entry in ``[start, end)``.

    - Fixed-step cadences (weekly/biweekly/monthly/quarterly/semi-annual/annual)
      walk forward from ``next_occurrence``.
    - ``SEMI_MONTHLY`` fires on two configurable days each month (default 1 & 15),
      clamped to the month length.
    - Respects ``end_date`` (``end_mode == "on_date"``) and caps future occurrences
      at ``max_occurrences`` (``end_mode == "after_occurrences"``; counted from
      ``next_occurrence`` forward — best-effort, since elapsed count isn't stored).
    """
    start = _naive(start)
    end = _naive(end)
    anchor = _naive(entry.next_occurrence)
    end_date = _naive(entry.end_date) if getattr(entry, "end_date", None) else None
    cap = entry.max_occurrences if getattr(entry, "end_mode", None) == "after_occurrences" else None
    produced = 0

    if entry.cadence == RecurrenceFrequency.SEMI_MONTHLY:
        d1 = getattr(entry, "semi_monthly_day_1", None) or 1
        d2 = getattr(entry, "semi_monthly_day_2", None) or 15
        days = sorted({d1, d2})
        y, m = anchor.year, anchor.month
        guard = 0
        while guard < 600:
            guard += 1
            if datetime(y, m, 1) > end:
                break
            for day in days:
                occ = datetime(y, m, _clamp_day(y, m, day),
                               anchor.hour, anchor.minute, anchor.second)
                if occ < anchor:
                    continue
                if end_date is not None and occ > end_date:
                    return
                if cap is not None and produced >= cap:
                    return
                produced += 1
                if start <= occ < end:
                    yield occ
            m += 1
            if m > 12:
                m, y = 1, y + 1
        return

    # Fixed-step cadences
    occ = anchor
    guard = 0
    while occ < end and guard < 2000:
        guard += 1
        if end_date is not None and occ > end_date:
            break
        if cap is not None and produced >= cap:
            break
        produced += 1
        if occ >= start:
            yield occ
        occ = _next_occurrence(occ, entry.cadence)


def build_timeline(opening, events: List[dict]) -> dict:
    """Pure core: walk signed-amount events in date order over an opening balance.

    ``events`` items: ``{date, name, amount, type, source, source_id}`` where
    ``amount`` is signed (positive = inflow, negative = outflow). Same-day ties
    use ``_event_sort_key`` (transfers, then outflows, then inflows), the same
    order per-account routing uses, so the two views agree on shortfalls.

    Returns opening/closing balances, the per-event running balance, the trough
    (lowest balance + its date, ``None`` date meaning the opening is the low), and
    every point where the running balance goes negative (``shortfalls``).
    """
    opening = _money(opening)

    running = opening
    lowest = opening
    trough_date: Optional[date] = None
    out_events: List[dict] = []
    shortfalls: List[dict] = []

    for e in sorted(events, key=_event_sort_key):
        amt = _money(e["amount"])
        running = (running + amt).quantize(_CENTS)
        d = e["date"].date() if isinstance(e["date"], datetime) else e["date"]
        out_events.append({
            "date": d,
            "name": e.get("name"),
            "amount": amt,
            "type": e.get("type"),
            "source": e.get("source"),
            "source_id": e.get("source_id"),
            "running_balance": running,
        })
        if running < lowest:
            lowest = running
            trough_date = d
        if running < 0:
            shortfalls.append({"date": d, "name": e.get("name"), "balance_after": running})

    return {
        "opening_balance": opening,
        "events": out_events,
        "lowest_balance": lowest,
        "trough_date": trough_date,   # None => the opening balance is the lowest point
        "closing_balance": running,
        "shortfall": bool(shortfalls),
        "shortfalls": shortfalls,
    }


# ---------------------------------------------------------------------------
# Unified dated-event engine
#
# collect_events is the single source of dated events for every forward-looking
# view (running-balance timeline, monthly cash-flow, upcoming items). Each event
# carries per-account LEGS: the signed amount it moves on each account it touches.
#
#   leg = {"account_id", "amount", "overflow_account_id", "cash"}
#
# ``cash`` says whether the leg counts toward pooled projection cash. The event's
# ``amount`` is the sum of its cash legs (its effect on the pooled total), and
# ``counts_as_cash`` is False when it moves no projection cash at all (e.g. a
# charge on a credit card, which reaches cash via the statement payable instead).
# ``face_amount`` is the unsigned amount as entered, for listings.
#
# ``funding_account_id`` / ``overflow_account_id`` mirror the primary leg so older
# event consumers keep working.
# ---------------------------------------------------------------------------

def _leg(account_id, amount, overflow_account_id=None, cash: bool = True) -> dict:
    return {
        "account_id": account_id,
        "amount": _money(amount),
        "overflow_account_id": overflow_account_id,
        "cash": cash,
    }


def _event(*, date, name, type, source, source_id, face_amount, legs: List[dict],
           counts_as_cash: Optional[bool] = None, **extra) -> dict:
    cash_legs = [leg for leg in legs if leg["cash"]]
    primary = legs[0] if legs else {}
    if counts_as_cash is None:
        counts_as_cash = bool(cash_legs)
    ev = {
        "date": date,
        "name": name,
        "amount": sum((leg["amount"] for leg in cash_legs), Decimal("0")),
        "type": type,
        "source": source,
        "source_id": source_id,
        "face_amount": _money(face_amount),
        "legs": legs,
        "counts_as_cash": counts_as_cash,
        "funding_account_id": primary.get("account_id"),
        "overflow_account_id": primary.get("overflow_account_id"),
    }
    ev.update(extra)
    return ev


def _legs_of(e: dict) -> List[dict]:
    """An event's legs; events built without legs get one from funding_account_id."""
    legs = e.get("legs")
    if legs is not None:
        return legs
    return [{
        "account_id": e.get("funding_account_id"),
        "amount": e["amount"],
        "overflow_account_id": e.get("overflow_account_id"),
        "cash": True,
    }]


def _event_sort_key(e: dict):
    """Date order; same-day ties run transfers, then outflows, then inflows.

    Transfers go first so money moved between your own accounts funds that day's
    payables; outflows before inflows is the conservative solvency assumption.
    """
    d = e["date"]
    d = d.date() if isinstance(d, datetime) else d
    if e.get("type") == TransactionType.TRANSFER.value:
        rank = 0
    elif _money(e["amount"]) < 0:
        rank = 1
    else:
        rank = 2
    return (d, rank)


def _transfer_event(txn, cash_ids: set, card_ids: set,
                    date: Optional[datetime] = None, **extra) -> dict:
    """A transfer: -(amount + fee) on the source, +amount on the destination.

    Legs are kept only for accounts in the projection's scope (``cash_ids`` and
    ``card_ids``); an account outside it (another entity's, or an inactive one) is
    never exposed. A leg is cash when its account is a projection-cash account, so:

    - between two projection-cash accounts the pooled total moves only by the fee,
      while each account's balance moves by its own leg;
    - out of the pool to an outside account costs the pool amount + fee;
    - into the pool from an outside account adds the amount.

    A transfer INTO a credit card (a card payment) is cash on the paying account:
    statements net payments (services/statements.py), so the statement payable
    only carries what the payments leave unpaid, and the payment itself is where
    the rest of the cash leaves. The card's leg is never cash. Such an event is
    marked ``card_payment``.

    A transfer FROM a credit card (a cash advance) is cash coming in on the
    receiving account: statements bill the advance plus its fee as a charge on the
    card, so the statement payable repays it later.
    """
    src = txn.transfer_from_account_id or txn.account_id
    dst = txn.transfer_to_account_id
    amount = Decimal(str(txn.amount))
    fee = Decimal(str(txn.transfer_fee or 0))
    scoped = cash_ids | card_ids
    legs = []
    if src in scoped:
        legs.append(_leg(src, -(amount + fee), cash=src in cash_ids))
    if dst in scoped:
        legs.append(_leg(dst, amount, cash=dst in cash_ids))
    if dst in card_ids:
        extra = {**extra, "card_payment": True}
    return _event(
        date=date or _naive(txn.transaction_date),
        name=txn.description or "Unposted transfer",
        type=txn.transaction_type.value,
        source="transaction",
        source_id=txn.id,
        face_amount=amount,
        legs=legs,
        transfer_fee=_money(fee),
        **extra,
    )


def collect_events(
    db: Session,
    start: datetime,
    end: datetime,
    *,
    user_id: int,
    entity_id: Optional[int] = None,
    accounts: Optional[list] = None,
) -> List[dict]:
    """Every dated event in ``[start, end)``, each with per-account legs.

    Sources: active budget-entry occurrences, unposted transactions, and one dated
    payable per credit-card statement cycle due in the window. Occurrences of a
    budget entry scheduled on a credit card are charges on that card's statement,
    not cash events (see ``_card_entry_charges``). Events that move no
    projection cash are included (``counts_as_cash`` False) so listings can show
    them; cash views must filter on ``counts_as_cash``.

    A transaction leg is cash only when its account is one of the scoped
    projection-cash accounts. Unposted transfers into or out of any scoped account
    (projection-cash or credit card) are collected even when the transaction row
    belongs to another scope (a cross-entity transfer), but only their in-scope
    legs are kept; a card's own leg is never cash, while the other side of a card
    payment or cash advance is (see ``_transfer_event``).

    Balances change only when a transaction is posted, so an unposted transaction
    dated before ``start`` is a pending movement not yet in the opening balance: it
    is emitted dated at ``start`` with ``overdue`` True and its ``original_date``.
    Overdue charges on a credit card are skipped (they reach cash through their
    statements); a non-transfer row's card involvement comes from ``account_id``
    alone, never from leftover ``transfer_*`` fields. Overdue card transfers are
    handled like in-window ones: an overdue card payment is still cash leaving at
    ``start`` (its statement is netted by it, so the cash appears only here), and
    an overdue cash advance is cash arriving at ``start`` (its statement bills it).
    """
    start = _naive(start)
    end = _naive(end)
    if accounts is None:
        accounts = get_account_balances(db, user_id, entity_id)
    cash_ids = {a.id for a in accounts if is_projection_cash(a)}
    card_ids = {a.id for a in accounts if not is_projection_cash(a)}

    events: List[dict] = []

    be_query = db.query(BudgetEntry).filter(
        scope_criterion(BudgetEntry, user_id, entity_id),
        BudgetEntry.is_active.is_(True),
    )
    card_entries = []
    for entry in be_query.all():
        if entry.account_id in card_ids:
            card_entries.append(entry)
            continue
        sign = Decimal("1") if entry.entry_type == BudgetEntryType.INCOME else Decimal("-1")
        for occ in iter_occurrences(entry, start, end):
            events.append(_event(
                date=occ,
                name=entry.name,
                type=entry.entry_type.value,
                source="budget_entry",
                source_id=entry.id,
                face_amount=entry.amount,
                legs=[_leg(entry.account_id, sign * Decimal(str(entry.amount)),
                           entry.overflow_account_id)],
            ))

    in_scope = scope_criterion(Transaction, user_id, entity_id)
    scoped_ids = cash_ids | card_ids
    if scoped_ids:
        in_scope = or_(in_scope, and_(
            Transaction.transaction_type == TransactionType.TRANSFER,
            or_(
                Transaction.transfer_to_account_id.in_(scoped_ids),
                Transaction.transfer_from_account_id.in_(scoped_ids),
            ),
        ))
    txn_query = db.query(Transaction).filter(
        in_scope,
        Transaction.is_posted.is_(False),
        Transaction.transaction_date < end,
    )
    for txn in txn_query.all():
        when = _naive(txn.transaction_date)
        overdue: dict = {}
        if when < start:
            # Only a transfer's transfer_* fields are meaningful: a row edited from a
            # transfer into a debit/credit may still carry stale ones.
            if txn.transaction_type != TransactionType.TRANSFER and txn.account_id in card_ids:
                continue
            when, overdue = start, {"overdue": True, "original_date": when}
        if txn.transaction_type == TransactionType.TRANSFER:
            events.append(_transfer_event(txn, cash_ids, card_ids, date=when, **overdue))
            continue
        if txn.transaction_type == TransactionType.CREDIT:
            amt = Decimal(str(txn.amount))       # inflow
        elif txn.transaction_type == TransactionType.DEBIT:
            amt = -Decimal(str(txn.amount))      # outflow
        else:
            continue
        # A charge on a credit card is NOT a cash outflow on its purchase date — the
        # cash leaves when that card's statement is paid, which is modelled as a
        # dated statement payable below. Its leg is therefore non-cash.
        events.append(_event(
            date=when,
            name=txn.description or "Unposted transaction",
            type=txn.transaction_type.value,
            source="transaction",
            source_id=txn.id,
            face_amount=txn.amount,
            legs=[_leg(txn.account_id, amt, cash=txn.account_id in cash_ids)],
            **overdue,
        ))

    projected_charges = _card_entry_charges(db, card_entries, start, end, events)

    # Each credit card contributes one dated payable per billing cycle due in the
    # window, derived from its own transactions (see services/statements.py) and
    # the projected charges of budget entries scheduled on it.
    for p in get_statement_payables(db, user_id, entity_id, start, end,
                                    projected_charges=projected_charges):
        extra = {k: v for k, v in p.items() if k not in {
            "date", "name", "amount", "type", "source", "source_id",
            "funding_account_id", "overflow_account_id",
        }}
        events.append(_event(
            date=p["date"],
            name=p["name"],
            type=p["type"],
            source=p["source"],
            source_id=p["source_id"],
            face_amount=-p["amount"],
            legs=[_leg(p["funding_account_id"], p["amount"], p["overflow_account_id"])],
            **extra,
        ))

    return events


def _card_entry_charges(db: Session, entries: list, start: datetime, end: datetime,
                        events: List[dict]) -> dict:
    """Projected statement charges for budget entries scheduled on a credit card.

    A card-backed occurrence is not a cash event: it is a charge on the card, so it
    is billed on the statement cycle containing its date and reaches cash inside
    that statement's payable, funded from the card's ``payment_account_id``.
    Occurrences are taken from ``next_occurrence`` onward (not just from ``start``):
    one dated before the window is still an unbilled charge on its cycle.

    An occurrence whose linked transaction already exists is suppressed: a
    transaction with this ``budget_entry_id`` dated the same calendar day stands in
    for it (each transaction suppresses at most one occurrence), since that
    transaction is itself a line item on the card.

    In-window occurrences are appended to ``events`` as non-cash listings, like
    unposted card charges. Returns ``{card_id: [line items]}``.
    """
    if not entries:
        return {}
    linked = Counter(
        (entry_id, _naive(when).date())
        for entry_id, when in db.query(Transaction.budget_entry_id, Transaction.transaction_date)
        .filter(Transaction.budget_entry_id.in_([e.id for e in entries]))
    )
    charges: dict = {}
    for entry in entries:
        income = entry.entry_type == BudgetEntryType.INCOME
        amount = Decimal(str(entry.amount))
        for occ in iter_occurrences(entry, _naive(entry.next_occurrence), end):
            key = (entry.id, occ.date())
            if linked[key]:
                linked[key] -= 1
                continue
            charges.setdefault(entry.account_id, []).append(SimpleNamespace(
                transaction_date=occ,
                amount=amount,
                transaction_type=TransactionType.CREDIT if income else TransactionType.DEBIT,
            ))
            if occ >= start:
                events.append(_event(
                    date=occ,
                    name=entry.name,
                    type=entry.entry_type.value,
                    source="budget_entry",
                    source_id=entry.id,
                    face_amount=entry.amount,
                    legs=[_leg(entry.account_id, amount if income else -amount, cash=False)],
                ))
    return charges


def _route_legs(
    opening_by_account: dict,
    events: List[dict],
    account_names: dict,
    checkpoints: Sequence[date] = (),
) -> dict:
    """Walk events' cash legs per account with primary → overflow routing.

    Keeps two books:

    - the ROUTING book applies legs plus the virtual overflow pulls, and is what
      account shortfalls are judged against;
    - the SCHEDULED book applies legs only. Per-account closings come from it, so
      an overflow pull (a "would have to move money" signal, not a planned
      transfer) never shows up as a balance change. Overflow use is reported
      separately in ``overflow_moves``.

    ``checkpoints`` are dates (e.g. month starts); ``closings[i]`` is the scheduled
    book just before the first event on/after ``checkpoints[i]``, and
    ``final`` is the book after every event. Each closing reports the opening
    accounts in ``by_account``; cash legs on any other account (or none) land in
    ``unassigned``, so ``sum(by_account) + unassigned`` is always the pooled total.
    """
    routed = {aid: _money(bal) for aid, bal in opening_by_account.items()}
    scheduled = dict(routed)
    tracked = set(opening_by_account)
    unassigned = Decimal("0")
    shortfalls: List[dict] = []
    overflow_moves: List[dict] = []
    pending = sorted(checkpoints)
    closings: List[dict] = []

    def _snapshot() -> dict:
        extra = sum((v for k, v in scheduled.items() if k not in tracked), Decimal("0"))
        return {
            "by_account": {aid: scheduled[aid] for aid in opening_by_account},
            "unassigned": unassigned + extra,
        }

    for e in sorted(events, key=_event_sort_key):
        if not e.get("counts_as_cash", True):
            continue
        d = e["date"].date() if isinstance(e["date"], datetime) else e["date"]
        while pending and d >= pending[0]:
            closings.append(_snapshot())
            pending.pop(0)
        for leg in _legs_of(e):
            if not leg.get("cash", True):
                continue
            acc = leg.get("account_id")
            amt = _money(leg["amount"])
            if acc is None:
                unassigned += amt
                continue
            scheduled[acc] = scheduled.get(acc, Decimal("0")) + amt
            routed[acc] = routed.get(acc, Decimal("0")) + amt
            if amt >= 0:  # inflow into the account
                continue

            overflow_used = Decimal("0")
            ov = leg.get("overflow_account_id")
            if routed[acc] < 0 and ov is not None:
                need = -routed[acc]
                ov_avail = routed.get(ov, Decimal("0"))
                transfer = min(need, ov_avail) if ov_avail > 0 else Decimal("0")
                routed[acc] += transfer
                routed[ov] = ov_avail - transfer
                overflow_used = transfer
                if transfer > 0:
                    overflow_moves.append({
                        "date": d,
                        "name": e.get("name"),
                        "from_account_id": ov,
                        "from_account_name": account_names.get(ov),
                        "to_account_id": acc,
                        "to_account_name": account_names.get(acc),
                        "amount": transfer,
                    })
            if routed[acc] < 0:
                shortfalls.append({
                    "date": d,
                    "name": e.get("name"),
                    "account_id": acc,
                    "account_name": account_names.get(acc),
                    "short_amount": -routed[acc],
                    "overflow_used": overflow_used,
                })

    while pending:
        closings.append(_snapshot())
        pending.pop(0)

    return {
        "shortfalls": shortfalls,
        "overflow_moves": overflow_moves,
        "closings": closings,
        "final": _snapshot(),
    }


def account_closings(snapshot: dict, opening_by_account: dict, account_names: dict) -> List[dict]:
    """Shape a routing snapshot as ``[{account_id, account_name, opening_balance, closing_balance}]``."""
    return [
        {
            "account_id": aid,
            "account_name": account_names.get(aid),
            "opening_balance": _money(opening_by_account[aid]),
            "closing_balance": snapshot["by_account"][aid],
        }
        for aid in opening_by_account
    ]


def route_accounts(opening_by_account: dict, events: List[dict], account_names: dict) -> List[dict]:
    """Per-account funding projection with primary → overflow routing (UC1).

    Walks the same events as the aggregate timeline, but tracks each account's
    legs separately. An outflow leg draws down its account; if that would go
    negative, the shortfall is pulled from the leg's ``overflow_account_id`` when
    set. Anything still uncovered is reported as an **account shortfall** — the
    account you intended to pay from can't cover this bill (even with overflow),
    so you'd have to move money in. Returns the shortfalls, date-ordered.
    """
    return _route_legs(opening_by_account, events, account_names)["shortfalls"]


def _projection_accounts(db: Session, user_id: int, entity_id: Optional[int]):
    """Accounts in scope, plus the projection-cash opening balance per account."""
    accounts = get_account_balances(db, user_id, entity_id)
    opening_by_account = {
        a.id: Decimal(str(a.balance)) for a in accounts if is_projection_cash(a)
    }
    account_names = {a.id: a.name for a in accounts}
    return accounts, opening_by_account, account_names


def project_running_balance(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    days: int = 60,
    reference: Optional[datetime] = None,
) -> dict:
    """Build the dated running-balance timeline over the next ``days`` days."""
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)

    # Available cash is projection-cash accounts only (see is_projection_cash).
    accounts, opening_by_account, account_names = _projection_accounts(db, user_id, entity_id)
    opening = sum(opening_by_account.values(), Decimal("0"))

    events = collect_events(db, start, end, user_id=user_id, entity_id=entity_id, accounts=accounts)
    cash_events = [e for e in events if e["counts_as_cash"]]

    result = build_timeline(opening, cash_events)
    routing = _route_legs(opening_by_account, cash_events, account_names)
    result["account_shortfalls"] = routing["shortfalls"]
    # Per-account closings at window end exclude virtual overflow pulls; those
    # are reported separately so the closings stay a plain sum of scheduled legs.
    result["by_account"] = account_closings(routing["final"], opening_by_account, account_names)
    result["unassigned_closing"] = routing["final"]["unassigned"]
    result["overflow_moves"] = routing["overflow_moves"]
    result["window_start"] = start.date()
    result["window_end"] = end.date()
    return result


def serialize_overflow_moves(moves: List[dict]) -> List[dict]:
    return [
        {
            "date": m["date"].isoformat(),
            "name": m["name"],
            "from_account_id": m["from_account_id"],
            "from_account_name": m["from_account_name"],
            "to_account_id": m["to_account_id"],
            "to_account_name": m["to_account_name"],
            "amount": float(m["amount"]),
        }
        for m in moves
    ]


def serialize_timeline(result: dict) -> dict:
    """Convert a build_timeline/project_running_balance result to JSON-friendly types."""
    def f(x):
        return float(x) if isinstance(x, Decimal) else x

    def iso(d):
        return d.isoformat() if d is not None else None

    return {
        "window_start": iso(result.get("window_start")),
        "window_end": iso(result.get("window_end")),
        "opening_balance": f(result["opening_balance"]),
        "lowest_balance": f(result["lowest_balance"]),
        "trough_date": iso(result["trough_date"]),
        "closing_balance": f(result["closing_balance"]),
        "shortfall": result["shortfall"],
        "shortfalls": [
            {"date": iso(s["date"]), "name": s["name"], "balance_after": f(s["balance_after"])}
            for s in result["shortfalls"]
        ],
        "account_shortfalls": [
            {
                "date": iso(s["date"]),
                "name": s["name"],
                "account_id": s["account_id"],
                "account_name": s["account_name"],
                "short_amount": f(s["short_amount"]),
                "overflow_used": f(s["overflow_used"]),
            }
            for s in result.get("account_shortfalls", [])
        ],
        "by_account": [
            {
                "account_id": a["account_id"],
                "account_name": a["account_name"],
                "opening_balance": f(a["opening_balance"]),
                "closing_balance": f(a["closing_balance"]),
            }
            for a in result.get("by_account", [])
        ],
        "unassigned_closing": f(result.get("unassigned_closing", Decimal("0"))),
        "overflow_moves": serialize_overflow_moves(result.get("overflow_moves", [])),
        "events": [
            {
                "date": iso(e["date"]),
                "name": e["name"],
                "amount": f(e["amount"]),
                "type": e["type"],
                "source": e["source"],
                "source_id": e["source_id"],
                "running_balance": f(e["running_balance"]),
            }
            for e in result["events"]
        ],
    }

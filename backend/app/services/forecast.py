"""
Cash-flow projection engine for Tally & Trace.

Given a set of accounts, budget entries (recurring income/expenses), and
unposted transactions, this service generates a forward-looking timeline.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterator, List, Optional

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
    Generate a month-by-month cash-flow projection.

    Returns a list of dicts with keys:
      period_label, period_start, period_end,
      opening_balance, income, expenses, unposted_expenses,
      net, closing_balance
    """
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    # Start of current month
    period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    accounts = get_account_balances(db, user_id, entity_id)
    # Exclude credit-card accounts — their balance is money owed, not cash on hand.
    # (This is an advisory monthly projection, so float is fine here.)
    opening = sum(float(a.balance) for a in accounts if a.account_type != AccountType.CREDIT)

    # Active budget entries for the entity/user
    be_query = db.query(BudgetEntry).filter(
        scope_criterion(BudgetEntry, user_id, entity_id),
        BudgetEntry.is_active.is_(True),
    )
    budget_entries = be_query.all()

    # Unposted transactions (confirmed upcoming expenses)
    txn_query = db.query(Transaction).filter(
        scope_criterion(Transaction, user_id, entity_id),
        Transaction.is_posted.is_(False),
    )
    unposted_txns = txn_query.all()

    timeline = []
    for _ in range(months):
        period_end = _add_months(period_start, 1)

        income: float = 0.0
        expenses: float = 0.0

        for entry in budget_entries:
            # Walk occurrences within the period
            occ = entry.next_occurrence.replace(tzinfo=None) if entry.next_occurrence.tzinfo else entry.next_occurrence
            # If the first occurrence already passed use it as starting point
            while occ < period_start:
                occ = _next_occurrence(occ, entry.cadence)

            while period_start <= occ < period_end:
                if entry.entry_type == BudgetEntryType.INCOME:
                    income += float(entry.amount)
                else:
                    expenses += float(entry.amount)
                occ = _next_occurrence(occ, entry.cadence)

        # Unposted transactions within the period
        unposted_period: float = 0.0
        for txn in unposted_txns:
            txn_date = txn.transaction_date.replace(tzinfo=None) if txn.transaction_date.tzinfo else txn.transaction_date
            if period_start <= txn_date < period_end:
                from app.models.transaction import TransactionType
                if txn.transaction_type == TransactionType.DEBIT:
                    unposted_period += float(txn.amount)
                elif txn.transaction_type == TransactionType.CREDIT:
                    unposted_period -= float(txn.amount)

        net = income - expenses - unposted_period
        closing = opening + net

        timeline.append({
            "period_label": period_start.strftime("%B %Y"),
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "opening_balance": round(opening, 2),
            "income": round(income, 2),
            "expenses": round(expenses, 2),
            "unposted_expenses": round(unposted_period, 2),
            "net": round(net, 2),
            "closing_balance": round(closing, 2),
        })

        opening = closing
        period_start = period_end

    return timeline


def get_upcoming_items(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    days: int = 30,
    reference: Optional[datetime] = None,
) -> List[dict]:
    """
    Return all scheduled income/expense occurrences and unposted transactions
    within the next N days, sorted by date.
    """
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    cutoff = now + timedelta(days=days)

    items: List[dict] = []

    be_query = db.query(BudgetEntry).filter(
        scope_criterion(BudgetEntry, user_id, entity_id),
        BudgetEntry.is_active.is_(True),
    )

    for entry in be_query.all():
        occ = entry.next_occurrence.replace(tzinfo=None) if entry.next_occurrence.tzinfo else entry.next_occurrence
        # Walk forward occurrences within the window
        counter = 0
        while occ <= cutoff and counter < 100:
            if occ >= now:
                items.append({
                    "name": entry.name,
                    "amount": entry.amount,
                    "due_date": occ.date().isoformat(),
                    "entry_type": entry.entry_type.value,
                    "source": "budget_entry",
                    "source_id": entry.id,
                })
            occ = _next_occurrence(occ, entry.cadence)
            counter += 1

    txn_query = db.query(Transaction).filter(
        scope_criterion(Transaction, user_id, entity_id),
        Transaction.is_posted.is_(False),
        Transaction.transaction_date >= now,
        Transaction.transaction_date <= cutoff,
    )

    for txn in txn_query.all():
        items.append({
            "name": txn.description or "Unposted transaction",
            "amount": txn.amount,
            "due_date": txn.transaction_date.date().isoformat(),
            "entry_type": txn.transaction_type.value,
            "source": "transaction",
            "source_id": txn.id,
        })

    items.sort(key=lambda x: x["due_date"])
    return items


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
    put OUTFLOWS before inflows — the conservative assumption for solvency.

    Returns opening/closing balances, the per-event running balance, the trough
    (lowest balance + its date, ``None`` date meaning the opening is the low), and
    every point where the running balance goes negative (``shortfalls``).
    """
    opening = _money(opening)

    def _key(e):
        d = e["date"]
        d = d.date() if isinstance(d, datetime) else d
        return (d, 0 if _money(e["amount"]) < 0 else 1)

    running = opening
    lowest = opening
    trough_date: Optional[date] = None
    out_events: List[dict] = []
    shortfalls: List[dict] = []

    for e in sorted(events, key=_key):
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


def route_accounts(opening_by_account: dict, events: List[dict], account_names: dict) -> List[dict]:
    """Per-account funding projection with primary → overflow routing (UC1).

    Walks the same events as the aggregate timeline, but tracks each funding
    account separately. A payable draws down its ``funding_account_id``; if that
    would go negative, the shortfall is pulled from ``overflow_account_id`` when
    set. Anything still uncovered is reported as an **account shortfall** — the
    account you intended to pay from can't cover this bill (even with overflow),
    so you'd have to move money in. Returns the shortfalls, date-ordered.
    """
    balances = {aid: _money(bal) for aid, bal in opening_by_account.items()}
    shortfalls: List[dict] = []

    def _key(e):
        d = e["date"]
        d = d.date() if isinstance(d, datetime) else d
        return (d, 0 if _money(e["amount"]) < 0 else 1)

    for e in sorted(events, key=_key):
        acc = e.get("funding_account_id")
        if acc is None:
            continue
        amt = _money(e["amount"])
        d = e["date"].date() if isinstance(e["date"], datetime) else e["date"]
        if amt >= 0:  # inflow into the account
            balances[acc] = balances.get(acc, Decimal("0")) + amt
            continue

        balances[acc] = balances.get(acc, Decimal("0")) + amt  # amt is negative
        overflow_used = Decimal("0")
        ov = e.get("overflow_account_id")
        if balances[acc] < 0 and ov is not None:
            need = -balances[acc]
            ov_avail = balances.get(ov, Decimal("0"))
            transfer = min(need, ov_avail) if ov_avail > 0 else Decimal("0")
            balances[acc] += transfer
            balances[ov] = ov_avail - transfer
            overflow_used = transfer
        if balances[acc] < 0:
            shortfalls.append({
                "date": d,
                "name": e.get("name"),
                "account_id": acc,
                "account_name": account_names.get(acc),
                "short_amount": -balances[acc],
                "overflow_used": overflow_used,
            })

    return shortfalls


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

    accounts = get_account_balances(db, user_id, entity_id)
    # Available cash EXCLUDES credit-card accounts — those balances are money owed,
    # not money on hand. (Card payments show up as payable events instead.)
    asset_accounts = [a for a in accounts if a.account_type != AccountType.CREDIT]
    credit_account_ids = {a.id for a in accounts if a.account_type == AccountType.CREDIT}
    opening = sum((Decimal(str(a.balance)) for a in asset_accounts), Decimal("0"))
    opening_by_account = {a.id: Decimal(str(a.balance)) for a in asset_accounts}
    account_names = {a.id: a.name for a in accounts}

    events: List[dict] = []

    be_query = db.query(BudgetEntry).filter(
        scope_criterion(BudgetEntry, user_id, entity_id),
        BudgetEntry.is_active.is_(True),
    )
    for entry in be_query.all():
        sign = Decimal("1") if entry.entry_type == BudgetEntryType.INCOME else Decimal("-1")
        for occ in iter_occurrences(entry, start, end):
            events.append({
                "date": occ,
                "name": entry.name,
                "amount": sign * Decimal(str(entry.amount)),
                "type": entry.entry_type.value,
                "source": "budget_entry",
                "source_id": entry.id,
                "funding_account_id": entry.account_id,
                "overflow_account_id": entry.overflow_account_id,
            })

    txn_query = db.query(Transaction).filter(
        scope_criterion(Transaction, user_id, entity_id),
        Transaction.is_posted.is_(False),
        Transaction.transaction_date >= start,
        Transaction.transaction_date < end,
    )
    for txn in txn_query.all():
        # A charge on a credit card is NOT a cash outflow on its purchase date — the
        # cash leaves when that card's statement is paid. Those cards are modelled as
        # dated statement payables below; counting the charge here as well would both
        # double-count it and date it wrongly (pessimistic, weeks early).
        if txn.account_id in credit_account_ids:
            continue
        if txn.transaction_type == TransactionType.CREDIT:
            amt = Decimal(str(txn.amount))       # inflow
        elif txn.transaction_type == TransactionType.DEBIT:
            amt = -Decimal(str(txn.amount))      # outflow
        else:
            continue  # transfers don't change total available cash (account-aware routing is a follow-up)
        events.append({
            "date": _naive(txn.transaction_date),
            "name": txn.description or "Unposted transaction",
            "amount": amt,
            "type": txn.transaction_type.value,
            "source": "transaction",
            "source_id": txn.id,
            "funding_account_id": txn.account_id,
            "overflow_account_id": None,
        })

    # Each credit card contributes one dated payable per billing cycle due in the
    # window, derived from its own transactions (see services/statements.py).
    events.extend(get_statement_payables(db, user_id, entity_id, start, end))

    result = build_timeline(opening, events)
    result["account_shortfalls"] = route_accounts(opening_by_account, events, account_names)
    result["window_start"] = start.date()
    result["window_end"] = end.date()
    return result


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

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

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.access import (
    NONE, account_role, can_read_record, readable_criterion, viewable_account_ids,
    viewable_accounts,
)
from app.core.redaction import CARD_PAYMENT, LIMITED, LOAN_PAYMENT, Redactor
from app.core.tags import effective_tag_criterion, ids_with_effective_tag
from app.core.time import naive_utc_now
from app.services.loans import COVER_HORIZON, build_loan_payables
from app.services.statements import (
    get_statement_payables, resolve_cycle_fields, statement_due_date,
)
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

    Loan balances are money owed too (a liability): a payment into a loan is cash
    leaving the paying account (see ``_transfer_event``), and the loan's own
    balance never counts as cash.

    Spending wallets (cash on hand, e-wallets) are not projection cash either:
    their balance is shown, but topping one up is where the money leaves the
    projection (see ``_transfer_event``), and spending from it is not counted again.
    """
    if account.account_type in (AccountType.CREDIT, AccountType.LOAN):
        return False
    return not getattr(account, "is_spending_wallet", False)


def is_spending_wallet(account) -> bool:
    """A non-credit, non-loan account flagged as a spending wallet."""
    return account.account_type not in (AccountType.CREDIT, AccountType.LOAN) and bool(
        getattr(account, "is_spending_wallet", False)
    )


def wallet_ids_of(db: Session, account_ids) -> frozenset:
    """The spending wallets among ``account_ids``, judged from the accounts themselves.

    Scope and ``is_active`` decide which legs a projection keeps, never whether an
    account is a wallet: an entry funded from a wallet outside the caller's
    scope, or from an inactive one, is still wallet spending, not projection cash.
    """
    ids = {i for i in account_ids if i is not None}
    if not ids:
        return frozenset()
    return frozenset(
        a.id for a in db.query(Account).filter(Account.id.in_(ids)).all() if is_spending_wallet(a)
    )


def _loan_ids_of(db: Session, account_ids) -> frozenset:
    """The loans among ``account_ids``, judged from the accounts themselves (any scope)."""
    ids = {i for i in account_ids if i is not None}
    if not ids:
        return frozenset()
    return frozenset(
        a.id for a in db.query(Account.id).filter(
            Account.id.in_(ids), Account.account_type == AccountType.LOAN)
    )


def get_account_balances(db: Session, user_id: int):
    """The projection's scope: every active account the user holds a role on."""
    return viewable_accounts(db, user_id, active_only=True).all()


def project_cashflow(
    db: Session,
    user_id: int,
    months: int = 6,
    reference: Optional[datetime] = None,
    tag_id: Optional[int] = None,
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
    amounts crossing the scope boundary), excluding card payments. A card cash
    advance is cash coming in, so it shows here as a NEGATIVE amount, while its
    repayment (advance plus fee) lands later in ``statement_payables``;
    ``statement_payables`` is cash paid to credit cards in the period: statement
    payables due (net of payments) plus planned card payments, including those
    payments' transfer fees.
    Loan payables (``source`` "loan": a due date's payment not covered by a
    planned payment, see services/loans.py) are in ``net`` and the closing
    balances only, not in any of the columns above; a planned payment into a
    loan stays in its source's column (``unposted_expenses`` for a transaction,
    ``expenses`` for a recurring transfer entry).
    ``by_account`` is each projection-cash account's month-end closing, excluding
    virtual overflow pulls (reported in ``overflow_moves``).
    With ``tag_id`` only the tagged events count (see ``collect_events``).
    """
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = start.replace(day=1)
    boundaries = [start] + [_add_months(month_start, i) for i in range(1, months + 1)]
    end = boundaries[-1]

    accounts, opening_by_account, account_names = _projection_accounts(db, user_id)
    opening = sum(opening_by_account.values(), Decimal("0"))

    events = collect_events(db, start, end, user_id=user_id, accounts=accounts, tag_id=tag_id)
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
    days: int = 30,
    reference: Optional[datetime] = None,
    tag_id: Optional[int] = None,
) -> List[dict]:
    """
    Return every dated event from ``collect_events`` within the next N days
    (budget-entry occurrences, unposted transactions, credit-card statement
    payables and loan payables on due dates), sorted by date. ``amount`` is the unsigned amount as entered.
    """
    start, end = _upcoming_window(days, reference)
    events = collect_events(db, start, end, user_id=user_id, tag_id=tag_id)

    items = [
        {
            "name": e["name"],
            "amount": e["face_amount"],
            "due_date": _naive(e["date"]).date().isoformat(),
            "entry_type": e["type"],
            "source": e["source"],
            "source_id": e["source_id"],
        }
        for e in events if e.get("view") != LIMITED
    ]
    # A limited event (see collect_events) is listed in its public shape only.
    limited = [e for e in events if e.get("view") == LIMITED]
    items += [limited_event(e, f"e{i}") for i, e in enumerate(
        sorted(limited, key=_event_sort_key), start=1)]
    items.sort(key=lambda x: x.get("due_date") or x["date"])
    return items


def get_available_cash(accounts) -> Decimal:
    """Pooled projection cash: the sum of projection-cash account balances."""
    return sum((_money(a.balance) for a in accounts if is_projection_cash(a)), Decimal("0"))


def get_payables(
    db: Session,
    user_id: int,
    days: int = 30,
    reference: Optional[datetime] = None,
    tag_id: Optional[int] = None,
) -> List[dict]:
    """Cash outflows due within the next N days, with the account each draws on.

    Same window and events as ``get_upcoming_items``, restricted to events that
    take cash out of the pool (bills, unposted debits, card statements, planned
    card payments, loan payables on due dates, planned payments into a loan
    from cash (scheduled payments and prepayments, for principal + interest),
    and spending-wallet top-ups for their amount + fee: topping a wallet up is
    the spending). Other transfers between your own accounts are not payables;
    card charges reach cash via their statement payable instead.

    A planned payment into a loan dated up to ``PLANNED_LOOKBACK`` (31 days)
    after the window end can still cover a due date inside the window (see
    services/loans.py), so that due date is not listed, while the payment
    itself falls outside the window and is not listed either.
    """
    start, end = _upcoming_window(days, reference)
    accounts = get_account_balances(db, user_id)
    names = {a.id: a.name for a in accounts}
    events = collect_events(db, start, end, user_id=user_id, accounts=accounts, tag_id=tag_id)

    payables = []
    public = 0
    for e in sorted(events, key=_event_sort_key):
        if not e["counts_as_cash"] or e["amount"] >= 0:
            continue
        if (e["type"] == TransactionType.TRANSFER.value and not e.get("card_payment")
                and not e.get("top_up") and not e.get("loan_payment")):
            continue
        if e.get("view") == LIMITED:
            public += 1
            payables.append(limited_event(e, f"e{public}"))
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
    tag_id: Optional[int] = None,
) -> dict:
    """
    Compute monthly net disposable income:
    total monthly income - total monthly expenses (normalised from each cadence).

    Spending wallets are expensed when topped up, as in the period summary: a
    recurring transfer into a wallet from a non-wallet account is an expense, a
    recurring transfer out of a wallet into one of the caller's non-wallet
    accounts (money returned, unspent) offsets it, any other recurring transfer
    is not an expense (it moves your own money), and expense entries funded from
    a wallet are not counted again. As in the summary, a recurring transfer
    counts only when its source account is in the caller's scope, and money
    leaving a wallet for an account outside the scope stays wallet spend. A
    recurring income entry paid into a wallet is income and also an implicit
    top-up, so the same amount counts as expense: moving it on to a non-wallet
    account then nets it back out instead of counting it twice.

    With ``tag_id`` only entries carrying that tag effectively count
    (``app/core/tags.py``), each once.
    """
    # The accounts the caller holds a role on (inactive ones included), as in the
    # period summary: a top-up counts only when its source is one of them, and a
    # return only when both the wallet and the destination are.
    scope_ids = viewable_account_ids(db, user_id)
    # Every entry the caller may read: their own, plus any touching one of those
    # accounts, whoever created it.
    query = db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user_id, scope_ids),
        BudgetEntry.is_active.is_(True),
    )
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(BudgetEntry, tag_id))
    entries = query.all()
    referenced = {
        acc_id for e in entries
        for acc_id in (e.account_id, e.transfer_to_account_id) if acc_id is not None
    }
    wallet_ids = {
        a.id for a in db.query(Account).filter(Account.id.in_(referenced)).all()
        if is_spending_wallet(a)
    } if referenced else set()

    monthly_income: float = 0.0
    monthly_expenses: float = 0.0

    for entry in entries:
        monthly = _monthly_equivalent(entry.amount, entry.cadence)
        if entry.transfer_to_account_id is not None:
            to_wallet = entry.transfer_to_account_id in wallet_ids
            from_wallet = entry.account_id in wallet_ids
            if entry.account_id not in scope_ids:
                continue  # inbound from outside the caller's scope
            if to_wallet and not from_wallet:
                monthly_expenses += monthly
            elif from_wallet and not to_wallet and entry.transfer_to_account_id in scope_ids:
                monthly_expenses -= monthly
            continue
        if entry.user_id != user_id and entry.account_id not in scope_ids:
            continue  # another user's entry paid from outside the caller's accounts
        if entry.entry_type == BudgetEntryType.INCOME:
            monthly_income += monthly
            if entry.account_id in wallet_ids:
                monthly_expenses += monthly  # income into a wallet is a top-up
        elif entry.account_id not in wallet_ids:
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
        if e.get("view") == LIMITED:
            out_events[-1].update({k: e.get(k) for k in (
                "view", "face_amount", "currency", "account", "kind", "overdue",
                "original_date")})
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
                    date: Optional[datetime] = None, *,
                    billed_ids: Optional[set] = None,
                    wallet_ids: frozenset = frozenset(),
                    known_wallet_ids: frozenset = frozenset(),
                    loan_ids: frozenset = frozenset(),
                    known_loan_ids: frozenset = frozenset(),
                    hidden_loan_ids: frozenset = frozenset(),
                    unbilled_ids: frozenset = frozenset(),
                    source: str = "transaction",
                    overflow_account_id: Optional[int] = None, **extra) -> dict:
    """A transfer: -(amount + fee) on the source, +amount on the destination.

    Legs are kept only for accounts in the projection's scope (``cash_ids``,
    ``card_ids`` and ``wallet_ids``); an account outside it (one the caller holds
    no role on, or an inactive one) is never exposed. A leg is cash when its account is a
    projection-cash account, so:

    - between two projection-cash accounts the pooled total moves only by the fee,
      while each account's balance moves by its own leg;
    - out of the pool to an outside account costs the pool amount + fee;
    - into the pool from an outside account adds the amount.

    A spending wallet's leg is never cash, so a top-up (cash to wallet) costs the
    source amount + fee, and money moved from a wallet back to a cash account adds
    the amount to it; a transfer between two wallets moves no projection cash.
    ``known_wallet_ids`` are every wallet the caller has classified, in scope or
    not; a cash-funded transfer into one of them is marked ``top_up`` (spending,
    so a payable), even when the wallet itself has no leg here. Likewise a
    cash-funded transfer into a loan (``loan_ids`` in scope, ``known_loan_ids``
    any other the caller references) is marked ``loan_payment``. A transfer
    into a loan the caller cannot access (``hidden_loan_ids``) is a neutral
    "Loan payment": no description, ``source_id`` or ``transfer_fee`` (the
    interest), only its amounts, date and in-scope legs.

    ``unbilled_ids`` are cards outside the scope without cycle settings: a
    transfer touching one moves no cash, as for a scoped one.

    ``source`` and ``overflow_account_id`` let a recurring transfer budget entry
    reuse this: its occurrences are transfers whose source leg routes to the
    entry's overflow account like any other payment from that account.

    A transfer INTO a credit card (a card payment) is cash on the paying account:
    statements net payments (services/statements.py), so the statement payable
    only carries what the payments leave unpaid, and the payment itself is where
    the rest of the cash leaves. The card's leg is never cash. Such an event is
    marked ``card_payment``.

    A transfer FROM a credit card (a cash advance) is cash coming in on the
    receiving account: statements bill the advance plus its fee as a charge on the
    card, so the statement payable repays it later.

    Both rules need the card's statements to be modelled. ``billed_ids`` are the
    cards that have them (cycle settings; default: every card). A transfer
    touching a card without cycle settings moves no projection cash at all: no
    statement bills an advance from it or is netted by a payment into it, so
    counting either side would leave cash that nothing balances. A payment into
    a billed card from such a card outside the scope (one the caller holds no
    role on, or an inactive one) agrees: its source has no leg here, so it moves no cash, and
    statements decide "unbilled" from the source account itself, so it does not
    net the statement either; that debt is paid in cash on its due date.
    """
    if billed_ids is None:
        billed_ids = card_ids
    unbilled = (card_ids - billed_ids) | unbilled_ids
    src = txn.transfer_from_account_id or txn.account_id
    dst = txn.transfer_to_account_id
    amount = Decimal(str(txn.amount))
    fee = Decimal(str(txn.transfer_fee or 0))
    scoped = cash_ids | card_ids | wallet_ids
    via_unbilled = src in unbilled or dst in unbilled
    src_cash = src in cash_ids and not via_unbilled
    legs = []
    if src in scoped:
        legs.append(_leg(src, -(amount + fee), overflow_account_id, cash=src_cash))
    if dst in scoped:
        legs.append(_leg(dst, amount, cash=dst in cash_ids and not via_unbilled))
    if dst in billed_ids:
        extra = {**extra, "card_payment": True}
    if src_cash and dst in (known_wallet_ids | wallet_ids):
        extra = {**extra, "top_up": True}
    if src_cash and dst in (known_loan_ids | loan_ids):
        # Paying a loan from cash is spending (principal and interest), so a payable.
        extra = {**extra, "loan_payment": True}
    hidden = dst in hidden_loan_ids
    if not hidden:
        extra = {**extra, "transfer_fee": _money(fee)}
    return _event(
        date=date or _naive(txn.transaction_date),
        name="Loan payment" if hidden else txn.description or "Unposted transfer",
        type=txn.transaction_type.value,
        source=source,
        source_id=None if hidden else txn.id,
        face_amount=amount,
        legs=legs,
        counts_as_cash=False if via_unbilled else None,
        **extra,
    )


def collect_events(
    db: Session,
    start: datetime,
    end: datetime,
    *,
    user_id: int,
    accounts: Optional[list] = None,
    tag_id: Optional[int] = None,
) -> List[dict]:
    """Every dated event in ``[start, end)``, each with per-account legs.

    Sources: active budget-entry occurrences, unposted transactions, one dated
    payable per credit-card statement cycle due in the window, and one per loan due
    date (``source`` "loan", on the loan's paying account; a planned non-prepayment
    transfer into the loan covers the oldest open due date, a recurring transfer
    occurrence into it its own due date, see services/loans.py). Occurrences of a
    budget entry scheduled on a credit card are charges on that card's statement,
    not cash events (see ``_card_entry_charges``). A card without cycle settings
    has no statements, so occurrences scheduled on it stay cash events and
    transfers touching it move no cash (see ``_transfer_event``). Events that move no
    projection cash are included (``counts_as_cash`` False) so listings can show
    them; cash views must filter on ``counts_as_cash``.

    The scope is every active account the caller holds a role on (``accounts``,
    default ``get_account_balances``). Every unposted transaction and active
    budget entry the caller may read is collected, of any type: the caller's
    own, plus any touching a scoped account, whoever created it. Legs are built
    only for scoped accounts, so another user's account (or an inactive one) is
    never exposed; an entry's overflow account is kept only when it is scoped
    too. The caller's own entries with no account keep a cash leg with no
    account, which lands in unassigned cash. A transaction leg is cash only
    when its account is one of the scoped projection-cash accounts; a card's
    own leg is never cash, while the other side of a card payment or cash
    advance is (see ``_transfer_event``).

    Spending wallets are not projection cash. Transfers into or out of one keep
    their legs (the wallet's never cash, see ``_transfer_event``); a wallet's other
    unposted transactions and budget entries funded from a wallet (other than
    recurring transfers) are skipped. Whether an account is a wallet is read from
    the account itself (``wallet_ids_of``), so a wallet outside the scope or
    inactive is still a wallet. A statement payable funded from a wallet has a
    non-cash funding leg: the wallet's money left projection cash when it was
    topped up, so paying the card from it must not take cash out a second time.
    A loan payable's leg is on the loan's paying account and routed like a
    transfer leg: cash only when that account is a scoped projection-cash
    account, non-cash on a scoped wallet, and absent when the account is outside
    the scope; a loan outside the scope paid from a scoped account is projected
    too, so the payment leaves cash once, in the paying account's projection.
    When the caller holds no role on such a loan (``account_role``), its
    payable is a neutral "Loan payment": amounts and dates only, with no loan
    name, ``source_id`` or ``loan_due_date``. The same holds for a planned or
    recurring transfer into a loan the caller cannot access (see
    ``_transfer_event``): it keeps its amounts, date and in-scope legs only.
    A budget entry with ``transfer_to_account_id`` is a recurring transfer: each
    occurrence is a transfer event with legs on its scoped accounts.
    An occurrence already materialised is suppressed: a transaction of the
    entry's creator with this ``budget_entry_id`` dated the same calendar day
    stands in for it (each transaction suppresses at most one occurrence; see
    ``_linked_occurrence_days``), so a ``materialize`` with ``advance=False``
    does not move the money twice.

    Balances change only when a transaction is posted, so an unposted transaction
    dated before ``start`` is a pending movement not yet in the opening balance: it
    is emitted dated at ``start`` with ``overdue`` True and its ``original_date``.
    Overdue charges on a credit card are skipped (they reach cash through their
    statements); a non-transfer row's card involvement comes from ``account_id``
    alone, never from leftover ``transfer_*`` fields. Overdue card transfers are
    handled like in-window ones: an overdue card payment is still cash leaving at
    ``start`` (its statement is netted by it, so the cash appears only here), and
    an overdue cash advance is cash arriving at ``start`` (its statement bills it).

    With ``tag_id`` (a ``?tag=`` filter, already limited to the caller's usable
    tags) the projection is built exactly as above and then only the events
    whose source carries the tag effectively are kept (``_keep_tagged``). The
    scope does not change: the same accounts, opening balances and legs, so
    closings are today's balances plus the tagged events alone.
    """
    start = _naive(start)
    end = _naive(end)
    if accounts is None:
        accounts = get_account_balances(db, user_id)
    cash_ids = {a.id for a in accounts if is_projection_cash(a)}
    card_ids = {a.id for a in accounts if a.account_type == AccountType.CREDIT}
    loans = [a for a in accounts if a.account_type == AccountType.LOAN]
    loan_ids = frozenset(a.id for a in loans)
    # In-scope wallets: their legs are kept (never as cash).
    scoped_wallet_ids = frozenset(a.id for a in accounts if is_spending_wallet(a))
    # Cards whose statements are modelled; the rest keep their charges as cash.
    billed_ids = {a.id for a in accounts
                  if a.id in card_ids and resolve_cycle_fields(a) is not None}
    scoped_ids = cash_ids | card_ids | scoped_wallet_ids

    events: List[dict] = []
    redactor = Redactor(db, user_id)

    # Every record of any type the caller created or that touches an account
    # in the scope (loans included), kept only when the caller may read it.
    scope_account_ids = {a.id for a in accounts}
    entries = [e for e in db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user_id, scope_account_ids),
        BudgetEntry.is_active.is_(True),
    ).all() if can_read_record(db, user_id, e)]

    txns = [t for t in db.query(Transaction).filter(
        readable_criterion(Transaction, user_id, scope_account_ids),
        Transaction.is_posted.is_(False),
        Transaction.transaction_date < end,
    ).all() if can_read_record(db, user_id, t)]

    # Every wallet any event references, in scope or not.
    wallet_ids = scoped_wallet_ids | wallet_ids_of(db, (
        *(acc for e in entries for acc in (e.account_id, e.transfer_to_account_id)),
        *(acc for t in txns
          for acc in (t.account_id, t.transfer_from_account_id, t.transfer_to_account_id)),
        *(acc for a in accounts if a.id in billed_ids
          for acc in (a.payment_account_id, a.payment_overflow_account_id)),
        *(a.payment_account_id for a in loans),
    ))

    # Every loan any transfer references, in scope or not (loan payments are payables).
    known_loan_ids = loan_ids | _loan_ids_of(db, (
        *(e.transfer_to_account_id for e in entries),
        *(t.transfer_to_account_id for t in txns
          if t.transaction_type == TransactionType.TRANSFER),
    ))

    # Active loans outside the scope paid from an in-scope account: their
    # payables are projected here too (see below).
    outside_payable_loans = [
        a for a in db.query(Account).filter(
            Account.account_type == AccountType.LOAN,
            Account.is_active.is_(True),
            Account.payment_account_id.in_(scoped_ids),
        ).all() if a.id not in loan_ids
    ] if scoped_ids else []
    # Loans outside the scope the caller holds no role on: every event paying one
    # (derived payable, planned or recurring transfer) is a neutral "Loan payment".
    outside_loans = {a.id: a for a in outside_payable_loans}
    missing = known_loan_ids - loan_ids - set(outside_loans)
    if missing:
        outside_loans.update(
            (a.id, a) for a in db.query(Account).filter(Account.id.in_(missing)).all())
    hidden_loan_ids = frozenset(
        lid for lid, a in outside_loans.items() if account_role(user_id, a) == NONE)

    # Active billed cards outside the scope whose statement payment (primary or
    # overflow) comes from an in-scope account: internal liability discovery.
    # Routing is same-owner, so each is the paying account owner's card. Their
    # payables are computed from every row and entry on them (internal inputs)
    # and emitted only as neutral "Card payment" events (see below).
    outside_cards = [
        a for a in db.query(Account).filter(
            Account.account_type == AccountType.CREDIT,
            Account.is_active.is_(True),
            or_(Account.payment_account_id.in_(scoped_ids),
                Account.payment_overflow_account_id.in_(scoped_ids)),
        ).all()
        if a.id not in card_ids and resolve_cycle_fields(a) is not None
        and account_role(user_id, a) == NONE
    ] if scoped_ids else []
    # Cards outside the scope that transfers pay into (or draw from): a payment
    # into a billed one is a card payment; one without cycle settings moves no cash.
    referenced_cards = {
        a.id: a for a in db.query(Account).filter(
            Account.id.in_({
                acc for t in txns if t.transaction_type == TransactionType.TRANSFER
                for acc in (t.transfer_from_account_id, t.transfer_to_account_id)
            } | {e.transfer_to_account_id for e in entries if e.transfer_to_account_id}),
            Account.account_type == AccountType.CREDIT,
        ).all() if a.id not in card_ids
    }
    outside_billed = {cid for cid, a in referenced_cards.items()
                      if resolve_cycle_fields(a) is not None}
    outside_unbilled = frozenset(set(referenced_cards) - outside_billed)
    transfer_billed_ids = billed_ids | outside_billed

    # Transactions already materialised from a recurring transfer entry, by day:
    # each stands in for one occurrence on its calendar day (as in
    # _card_entry_charges), since the posted transfer has already moved the balance.
    transfer_entry_ids = [e.id for e in entries if e.transfer_to_account_id is not None]
    records = {(BudgetEntry, e.id): e for e in entries}
    records.update(((Transaction, t.id), t) for t in txns)
    linked = _linked_occurrence_days(db, transfer_entry_ids)

    card_entries = []
    for entry in entries:
        # Overflow routing only onto a scoped account, on every entry type.
        overflow_id = entry.overflow_account_id if entry.overflow_account_id in scoped_ids else None
        if entry.transfer_to_account_id is not None:
            # Only the scoped legs are kept (see _transfer_event).
            for occ in iter_occurrences(entry, start, end):
                key = (entry.id, occ.date())
                if linked[key]:
                    linked[key] -= 1
                    continue  # already materialised (e.g. advance=False)
                events.append(_transfer_event(
                    SimpleNamespace(
                        id=entry.id,
                        account_id=entry.account_id,
                        transfer_from_account_id=entry.account_id,
                        transfer_to_account_id=entry.transfer_to_account_id,
                        amount=entry.amount,
                        transfer_fee=0,
                        transaction_type=TransactionType.TRANSFER,
                        description=entry.name,
                    ),
                    cash_ids, card_ids, date=occ, billed_ids=transfer_billed_ids,
                    wallet_ids=scoped_wallet_ids, known_wallet_ids=wallet_ids,
                    loan_ids=loan_ids, known_loan_ids=known_loan_ids,
                    hidden_loan_ids=hidden_loan_ids, unbilled_ids=outside_unbilled,
                    source="budget_entry",
                    overflow_account_id=overflow_id, origin=(BudgetEntry, entry.id),
                ))
            continue
        if entry.account_id in wallet_ids:
            continue  # wallet-funded: spending from a wallet is not projection cash
        if entry.account_id in billed_ids:
            card_entries.append(entry)
            continue
        sign = Decimal("1") if entry.entry_type == BudgetEntryType.INCOME else Decimal("-1")
        # A leg on a scoped account; the caller's own entry with no account keeps
        # a cash leg with no account (unassigned cash). Any other account is
        # outside the scope, so the occurrence is listed with no leg.
        if entry.account_id in scoped_ids or (
                entry.account_id is None and entry.user_id == user_id):
            legs = [_leg(entry.account_id, sign * Decimal(str(entry.amount)), overflow_id)]
        else:
            legs = []
        for occ in iter_occurrences(entry, start, end):
            events.append(_event(
                date=occ,
                name=entry.name,
                type=entry.entry_type.value,
                source="budget_entry",
                source_id=entry.id,
                face_amount=entry.amount,
                legs=legs,
                origin=(BudgetEntry, entry.id),
            ))

    for txn in txns:
        if txn.transaction_type != TransactionType.TRANSFER and txn.account_id in wallet_ids:
            continue  # wallet spending/income is not projection cash
        when = _naive(txn.transaction_date)
        overdue: dict = {}
        if when < start:
            # Only a transfer's transfer_* fields are meaningful: a row edited from a
            # transfer into a debit/credit may still carry stale ones.
            if txn.transaction_type != TransactionType.TRANSFER and txn.account_id in card_ids:
                continue
            when, overdue = start, {"overdue": True, "original_date": when}
        if txn.transaction_type == TransactionType.TRANSFER:
            events.append(_transfer_event(txn, cash_ids, card_ids, date=when,
                                          billed_ids=transfer_billed_ids,
                                          wallet_ids=scoped_wallet_ids,
                                          known_wallet_ids=wallet_ids, loan_ids=loan_ids,
                                          known_loan_ids=known_loan_ids,
                                          hidden_loan_ids=hidden_loan_ids,
                                          unbilled_ids=outside_unbilled,
                                          origin=(Transaction, txn.id), **overdue))
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
            legs=([_leg(txn.account_id, amt, cash=txn.account_id in cash_ids)]
                  if txn.account_id in scoped_ids else []),
            origin=(Transaction, txn.id),
            **overdue,
        ))

    cards = {a.id: a for a in accounts if a.id in billed_ids}
    projected_charges = _card_entry_charges(db, card_entries, cards, start, end, events)

    # Each credit card contributes one dated payable per billing cycle due in the
    # window, derived from its own transactions (see services/statements.py) and
    # the projected charges of budget entries scheduled on it.
    # A funding or overflow account outside the projection scope (one the caller
    # can't view, or an inactive one) gets no leg, and its id is never emitted
    # (STU-227), as for loan dues.
    for p in get_statement_payables(db, [a for a in accounts if a.id in card_ids], start, end,
                                    projected_charges=projected_charges):
        extra = {k: v for k, v in p.items() if k not in {
            "date", "name", "amount", "type", "source", "source_id",
            "funding_account_id", "overflow_account_id",
        }}
        funding = p["funding_account_id"] if p["funding_account_id"] in scoped_ids else None
        overflow = p["overflow_account_id"] if p["overflow_account_id"] in scoped_ids else None
        events.append(_event(
            date=p["date"],
            name=p["name"],
            type=p["type"],
            source=p["source"],
            source_id=p["source_id"],
            face_amount=-p["amount"],
            legs=([_leg(funding, p["amount"], overflow, cash=funding not in wallet_ids)]
                  if funding is not None else []),
            origin=(Account, p["source_id"]),  # the card
            **extra,
        ))

    # Discovered cards: neutral "Card payment" events from internal inputs. A
    # leg only when the statement's primary payment account is in scope (with
    # its overflow only when that is in scope too). With a hidden primary there
    # is no leg and no overflow move, whatever the overflow: no routing is
    # computed for the caller, so nothing about the hidden account can be read
    # from it.
    if outside_cards:
        hidden_cards = {a.id: a for a in outside_cards}
        card_rows = db.query(BudgetEntry).filter(
            BudgetEntry.account_id.in_(list(hidden_cards)),
            BudgetEntry.is_active.is_(True),
            BudgetEntry.transfer_to_account_id.is_(None),
        ).all()
        hidden_charges = _card_entry_charges(db, card_rows, hidden_cards, start, end, None)
        for p in get_statement_payables(db, outside_cards, start, end,
                                        projected_charges=hidden_charges):
            card = hidden_cards[p["source_id"]]
            primary = p["funding_account_id"] if p["funding_account_id"] in scoped_ids else None
            overflow = (p["overflow_account_id"]
                        if primary is not None and p["overflow_account_id"] in scoped_ids
                        else None)
            overdue = {k: p[k] for k in ("overdue", "original_date") if k in p}
            events.append(_limit(_event(
                date=p["date"],
                name=CARD_PAYMENT,
                type=p["type"],
                source=p["source"],
                source_id=None,
                face_amount=0,
                legs=([_leg(primary, p["amount"], overflow, cash=primary not in wallet_ids)]
                      if primary is not None else []),
                origin=(Account, card.id),
                **overdue,
            ), redactor, name=CARD_PAYMENT, currency=card.currency, kind="card_payment"))

    # Each loan contributes a dated payable per due date, less what the planned
    # payments into it cover (see services/loans.py). Recurring transfers into a
    # loan are projected past the window end, as a payment late for a due date in
    # the window still covers it; one already materialised is skipped, as above.
    # They are found by the loan alone, so an entry another user created (paid
    # from their own bank) still covers this loan; such an entry moves no cash
    # here, since its source account is outside this projection.
    #
    # The payable is paid from the loan's paying account, so it is routed like
    # a transfer leg: it moves cash only in a projection that holds that account
    # as projection cash. An in-scope loan paid from an account outside the
    # scope keeps the event with no leg (listed, no cash), and an active loan
    # outside the scope paid from an in-scope account is projected here too, so
    # its cash leaves the paying account's projection exactly once. A loan the
    # caller cannot access is shown as a neutral payment (no name, id or due
    # date), so projecting it never discloses the loan.
    payable_loans = loans + outside_payable_loans
    payable_loan_ids = [a.id for a in payable_loans]
    loan_entries = db.query(BudgetEntry).filter(
        BudgetEntry.transfer_to_account_id.in_(payable_loan_ids),
        BudgetEntry.is_active.is_(True),
    ).all() if payable_loan_ids else []
    linked_covers = _linked_occurrence_days(db, [e.id for e in loan_entries])
    projected_covers: dict = {}
    for entry in loan_entries:
        for occ in iter_occurrences(entry, start, end + COVER_HORIZON):
            key = (entry.id, occ.date())
            if linked_covers[key]:
                linked_covers[key] -= 1
                continue
            projected_covers.setdefault(entry.transfer_to_account_id, []).append(
                (occ.date(), _money(entry.amount)))
    loans_by_id = {a.id: a for a in payable_loans}
    for p in build_loan_payables(db, payable_loans, start, end, projected_covers):
        hidden = p["source_id"] in hidden_loan_ids
        extra = {k: v for k, v in p.items() if k not in {
            "date", "name", "amount", "type", "source", "source_id",
            "funding_account_id", "overflow_account_id",
        } and not (hidden and k not in ("overdue", "original_date"))}
        payer = p["funding_account_id"]
        event = _event(
            date=p["date"],
            name="Loan payment" if hidden else p["name"],
            type=p["type"],
            source=p["source"],
            source_id=None if hidden else p["source_id"],
            face_amount=-p["amount"],
            # Cash only on a scoped projection-cash account; a scoped wallet's leg
            # is kept as non-cash, and an account outside the scope has no leg.
            legs=([_leg(payer, p["amount"], None, cash=payer in cash_ids)]
                  if payer in scoped_ids else []),
            origin=(Account, p["source_id"]),  # the loan
            **extra,
        )
        if hidden:
            event = _limit(event, redactor, name=LOAN_PAYMENT,
                           currency=loans_by_id[p["source_id"]].currency, kind="loan_payment")
        events.append(event)

    # Records the caller sees Limited (see app/core/redaction.py) become limited
    # events: the displayed name only, no source id, no fee or statement detail.
    for e in events:
        record = records.get(e["origin"])
        if record is None or e.get("view") == LIMITED:
            continue
        if redactor.view(record) != LIMITED:
            continue
        _limit(e, redactor, name=redactor.display_description(record),
               currency=record.currency, kind=_record_kind(e, redactor, record))

    if tag_id is not None:
        events = _keep_tagged(db, events, tag_id)
    for e in events:
        del e["origin"]
    return events


# Keys a limited event never carries: the hidden source's id and details.
_LIMITED_DROPPED = ("transfer_fee", "statement_close", "statement_balance", "loan_due_date")


def _limit(e: dict, redactor, *, name: str, currency, kind: str) -> dict:
    """Make ``e`` a limited event, in place (see ``limited_event`` for its public shape).

    Its name becomes the displayed one and its source id and details are
    dropped. For a payment to a hidden loan or card ``face_amount`` is
    ``|cash_delta|`` (no split, no statement total); otherwise it stays the
    amount as entered, which the limited record shows too. Every engine field
    it needs (date, legs, amount, flags) stays.
    """
    for key in _LIMITED_DROPPED:
        e.pop(key, None)
    legs = e.get("legs") or []
    e.update({
        "view": LIMITED,
        "name": name,
        "source_id": None,
        "face_amount": (abs(e["amount"]) if kind in ("loan_payment", "card_payment")
                        else e["face_amount"]),
        "currency": getattr(currency, "value", currency),
        "kind": kind,
        "account": redactor.account_ref(legs[0]["account_id"]) if legs else None,
    })
    return e


def _record_kind(e: dict, redactor, record) -> str:
    """A limited record event's kind: what it is, without naming its source."""
    if e["type"] == TransactionType.TRANSFER.value:
        target = redactor.access.account(record.transfer_to_account_id)
        if target is not None and not redactor.can_view(target.id):
            if target.account_type == AccountType.LOAN:
                return "loan_payment"
            if target.account_type == AccountType.CREDIT:
                return "card_payment"
        return "transfer"
    if e["type"] in (TransactionType.DEBIT.value, BudgetEntryType.EXPENSE.value):
        return "expense"
    return "income"


def limited_event(e: dict, public_id: str) -> dict:
    """The public shape of a limited event (``LimitedEvent``).

    ``public_id`` is opaque and per response; ``cash_delta`` is the sum of the
    event's cash legs on scope accounts.
    """
    def day(d):
        if d is None:
            return None
        return (d.date() if isinstance(d, datetime) else d).isoformat()

    return {
        "view": LIMITED,
        "public_id": public_id,
        "date": day(e["date"]),
        "original_date": day(e.get("original_date")),
        "overdue": bool(e.get("overdue")),
        "display_name": e["name"],
        "face_amount": round(float(e["face_amount"]), 2),
        "cash_delta": round(float(e["amount"]), 2),
        "currency": e.get("currency"),
        "account": e.get("account"),
        "kind": e.get("kind"),
    }


def _keep_tagged(db: Session, events: List[dict], tag_id: int) -> List[dict]:
    """The events whose source carries ``tag_id`` effectively (``app/core/tags.py``).

    A source is the record an event comes from: a transaction or recurring
    entry by its effective tags, and a card statement or loan due by the card's
    or loan's own tags, as one whole event. Each event is kept or dropped once,
    so nothing is counted twice.
    """
    ids: dict = {}
    for e in events:
        model, record_id = e["origin"]
        ids.setdefault(model, set()).add(record_id)
    tagged = {model: ids_with_effective_tag(db, model, record_ids, tag_id)
              for model, record_ids in ids.items()}
    return [e for e in events if e["origin"][1] in tagged[e["origin"][0]]]


def _linked_occurrence_days(db: Session, entry_ids: list) -> Counter:
    """``{(entry id, day): count}`` of transactions materialised from each entry.

    Each stands in for one occurrence on its calendar day. Only the entry
    creator's transactions count: another user's row naming the entry is a
    stale reference (left by the entity era) and suppresses nothing. So do
    only transactions on the entry's own account: one recorded on another
    account (the creator's private one, say) never suppresses an occurrence
    projected on a shared account.
    """
    if not entry_ids:
        return Counter()
    rows = (
        db.query(Transaction.budget_entry_id, Transaction.transaction_date)
        .join(BudgetEntry, BudgetEntry.id == Transaction.budget_entry_id)
        .filter(Transaction.budget_entry_id.in_(entry_ids),
                Transaction.user_id == BudgetEntry.user_id,
                Transaction.account_id == BudgetEntry.account_id)
    )
    return Counter((entry_id, _naive(when).date()) for entry_id, when in rows)


def _card_entry_charges(db: Session, entries: list, cards: dict, start: datetime,
                        end: datetime, events: Optional[List[dict]]) -> dict:
    """Projected statement charges for budget entries scheduled on a credit card.

    A card-backed occurrence is not a cash event: it is a charge on the card, so it
    is billed on the statement cycle containing its date and reaches cash inside
    that statement's payable, funded from the card's ``payment_account_id``.
    ``cards`` maps each entry's ``account_id`` to its card.

    Occurrences are taken from ``next_occurrence`` onward (not just from ``start``),
    but one dated before ``start`` is billed only while its statement is not yet
    due: due on or after ``start``, it is still an unbilled charge on that cycle.
    A lapsed occurrence whose statement fell due before ``start`` is dropped, as a
    cash entry's occurrences before ``start`` are: nothing advances
    ``next_occurrence`` except materialising, so billing every occurrence since a
    stale one would invent overdue statements nobody recorded.

    An occurrence whose linked transaction already exists is suppressed: a
    transaction of the entry's creator with this ``budget_entry_id`` dated the same
    calendar day stands in for it (each transaction suppresses at most one
    occurrence), since that transaction is itself a line item on the card. This is what keeps a
    ``materialize`` with ``advance=False`` from billing twice. Matching is by day
    only: materialising with a custom ``transaction_date`` on another day and
    ``advance=False`` suppresses nothing, so that occurrence is still billed too.

    In-window occurrences are appended to ``events`` as non-cash listings, like
    unposted card charges; with ``events`` None (a discovered card's internal
    inputs) nothing is listed. Returns ``{card_id: [line items]}``.
    """
    if not entries:
        return {}
    linked = _linked_occurrence_days(db, [e.id for e in entries])
    charges: dict = {}
    for entry in entries:
        income = entry.entry_type == BudgetEntryType.INCOME
        amount = Decimal(str(entry.amount))
        card = cards[entry.account_id]
        for occ in iter_occurrences(entry, _naive(entry.next_occurrence), end):
            key = (entry.id, occ.date())
            if linked[key]:
                linked[key] -= 1
                continue
            if occ < start and statement_due_date(card, occ.date()) < start:
                continue  # lapsed: its statement fell due before the window
            charges.setdefault(entry.account_id, []).append(SimpleNamespace(
                transaction_date=occ,
                amount=amount,
                transaction_type=TransactionType.CREDIT if income else TransactionType.DEBIT,
            ))
            if occ >= start and events is not None:
                events.append(_event(
                    date=occ,
                    name=entry.name,
                    type=entry.entry_type.value,
                    source="budget_entry",
                    source_id=entry.id,
                    face_amount=entry.amount,
                    legs=[_leg(entry.account_id, amount if income else -amount, cash=False)],
                    origin=(BudgetEntry, entry.id),
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


def _projection_accounts(db: Session, user_id: int):
    """Accounts in scope, plus the projection-cash opening balance per account."""
    accounts = get_account_balances(db, user_id)
    opening_by_account = {
        a.id: Decimal(str(a.balance)) for a in accounts if is_projection_cash(a)
    }
    account_names = {a.id: a.name for a in accounts}
    return accounts, opening_by_account, account_names


def project_running_balance(
    db: Session,
    user_id: int,
    days: int = 60,
    reference: Optional[datetime] = None,
    tag_id: Optional[int] = None,
) -> dict:
    """Build the dated running-balance timeline over the next ``days`` days.

    With ``tag_id`` only the tagged events count (see ``collect_events``).
    """
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)

    # Available cash is projection-cash accounts only (see is_projection_cash).
    accounts, opening_by_account, account_names = _projection_accounts(db, user_id)
    opening = sum(opening_by_account.values(), Decimal("0"))

    events = collect_events(db, start, end, user_id=user_id, accounts=accounts, tag_id=tag_id)
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
        "events": [_timeline_event(e, i) for i, e in enumerate(result["events"], start=1)],
    }


def _timeline_event(e: dict, index: int) -> dict:
    """A timeline event: the full shape, or a limited event plus its running balance."""
    def f(x):
        return float(x) if isinstance(x, Decimal) else x

    if e.get("view") == LIMITED:
        return {**limited_event(e, f"e{index}"), "running_balance": f(e["running_balance"])}
    return {
        "date": e["date"].isoformat() if e["date"] is not None else None,
        "name": e["name"],
        "amount": f(e["amount"]),
        "type": e["type"],
        "source": e["source"],
        "source_id": e["source_id"],
        "running_balance": f(e["running_balance"]),
    }

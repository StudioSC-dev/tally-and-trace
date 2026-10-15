"""
Cash-flow projection engine for Tally & Trace.

Given a set of accounts, budget entries (recurring income/expenses), and
unposted transactions, this service generates a forward-looking timeline.
"""

from __future__ import annotations

from calendar import monthrange
from collections import Counter
from datetime import MAXYEAR, date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from types import SimpleNamespace
from typing import Dict, Iterator, List, Optional, Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.access import (
    NONE, TAG_VIEWER, VIEW_ROLES, account_role, readable_criterion, tag_shared_account_ids,
    touches_accounts, viewable_account_ids, viewable_accounts,
)
from app.core.redaction import CARD_PAYMENT, LIMITED, LOAN_PAYMENT, Redactor
from app.core.tags import effective_tag_criterion, ids_with_effective_tag
from app.core.time import naive_utc_now
from app.services.loans import COVER_HORIZON, build_loan_payables, normalise_cover
from app.services.statements import (
    get_statement_payables, resolve_cycle_fields, statement_due_date,
)
from app.models.account import Account, AccountType
from app.models.account_share import AccountShare
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType, pending_face
from app.models.transaction import RecurrenceFrequency
from app.services.fx import FxMeta, FxRates, convert


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

    ``is_active`` decides which legs a projection keeps, never whether an
    account is a wallet: an entry funded from an inactive wallet is still wallet
    spending, not projection cash. Callers pass only accounts the caller can
    view, so a hidden account's flag never changes what they are shown.
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
    """The projection's scope: every active account the user sees (any role,
    ``tag_viewer`` included: a sharer's Household-tagged accounts)."""
    return viewable_accounts(db, user_id, active_only=True, roles=VIEW_ROLES).all()


def project_cashflow(
    db: Session,
    user_id: int,
    months: int = 6,
    reference: Optional[datetime] = None,
    tag_id: Optional[int] = None,
    fx: Optional[FxRates] = None,
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

    Every figure is the user's default currency only (STU-236, plan D3); a
    cross-currency transfer between two projection-cash accounts is money
    moved (``cashflow_by_currency``), in no column here but in ``net``.
    """
    boundaries = _month_boundaries(months, reference)
    p = Projection(db, user_id, boundaries[0], boundaries[-1], tag_id=tag_id, fx=fx)
    return [{k: v for k, v in period.items() if k in LEGACY_PERIOD_KEYS}
            for period in _cashflow_periods(p, p.default, boundaries, rows=False)]


LEGACY_PERIOD_KEYS = (
    "period_label", "period_start", "period_end", "opening_balance", "income", "expenses",
    "unposted_expenses", "statement_payables", "net", "closing_balance", "by_account",
    "unassigned_closing", "overflow_moves",
)


def _month_boundaries(months: int, reference: Optional[datetime]) -> list:
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = start.replace(day=1)
    return [start] + [_add_months(month_start, i) for i in range(1, months + 1)]


def _cashflow_periods(p: "Projection", currency: str, boundaries: list, *,
                      rows: bool) -> List[dict]:
    """One currency's periods (see ``project_cashflow`` and ``cashflow_by_currency``).

    Each period has the legacy keys plus ``moved_in``, ``moved_out`` and
    ``loan_payables``; with ``rows`` its ``by_account`` and ``overflow_moves``
    rows carry ``currency`` too.
    """
    opening_by_account, cash_events = p.run(currency)
    opening = sum(opening_by_account.values(), Decimal("0"))
    routing = _route_legs(
        opening_by_account, cash_events, p.names,
        checkpoints=[b.date() for b in boundaries[1:]], currency_of=p.currencies,
    )

    def f(x: Decimal) -> float:
        return round(float(x), 2)

    tag = {"currency": currency} if rows else {}
    timeline = []
    for i in range(len(boundaries) - 1):
        period_start, period_end = boundaries[i], boundaries[i + 1]
        in_period = [e for e in cash_events if period_start <= _naive(e["date"]) < period_end]

        def regular(e) -> Decimal:
            # Money moved across currencies is neither income nor expense (plan C3).
            return e["amount"] - e["moved"]

        def total(source: str, sign: int = 0) -> Decimal:
            amounts = (regular(e) for e in in_period if e["source"] == source)
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
        moved_in = sum((e["moved"] for e in in_period if e["moved"] > 0), Decimal("0"))
        moved_out = -sum((e["moved"] for e in in_period if e["moved"] < 0), Decimal("0"))
        loans = total("loan")
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
            "moved_in": f(moved_in),
            "moved_out": f(moved_out),
            "loan_payables": f(loans),
            "net": f(net),
            "closing_balance": f(closing),
            "by_account": [
                {
                    "account_id": a["account_id"],
                    "account_name": a["account_name"],
                    "closing_balance": f(a["closing_balance"]),
                    **tag,
                }
                for a in account_closings(snapshot, opening_by_account, p.names)
            ],
            "unassigned_closing": f(snapshot["unassigned"]),
            "overflow_moves": [{**m, **tag} for m in serialize_overflow_moves([
                m for m in routing["overflow_moves"]
                if period_start.date() <= m["date"] < period_end.date()
            ])],
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
    """Single-currency test reference; never called from routes.

    Return every dated event from ``collect_events`` within the next N days
    (budget-entry occurrences, unposted transactions, credit-card statement
    payables and loan payables on due dates), sorted by date. ``amount`` is the unsigned amount as entered.
    """
    start, end = _upcoming_window(days, reference)
    return upcoming_items(collect_events(db, start, end, user_id=user_id, tag_id=tag_id))


def upcoming_items(events: List[dict]) -> List[dict]:
    """Single-currency test reference; never called from routes.

    ``collect_events`` events as upcoming items (``get_upcoming_items``), sorted by date.
    """
    items = [
        {
            "name": e["name"],
            "amount": e["face_amount"],
            "due_date": _naive(e["date"]).date().isoformat(),
            "entry_type": e["type"],
            "source": e["source"],
            "source_id": e["source_id"],
            # Only on a Household occurrence the caller sees in full (their own).
            **({"household_occurrence": True} if e.get("household_occurrence") else {}),
            # Only in a Household view (services/household.household_upcoming).
            **({"currency": e["currency"]} if "currency" in e else {}),
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
    """Single-currency test reference; never called from routes.

    Cash outflows due within the next N days, with the account each draws on.

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
    fx: Optional[FxRates] = None,
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
    # The accounts the caller sees (inactive ones included, ``tag_viewer`` too),
    # as in the period summary: a top-up counts only when its source is one of
    # them, and a return only when both the wallet and the destination are.
    from app.core.access import household_grants

    scope_ids = viewable_account_ids(db, user_id, roles=VIEW_ROLES)
    # Every entry the caller may read: their own, any touching an account they
    # hold a direct role on, whoever created it, and through a tag share the
    # sharer's own (rules (b2) and (c)).
    query = db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user_id, viewable_account_ids(db, user_id),
                           household_grants(db, user_id)),
        BudgetEntry.is_active.is_(True),
    )
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(BudgetEntry, tag_id))
    entries = query.all()
    # Wallets among those accounts only: whether an account the caller can't
    # view is a wallet never moves a total (for a user with no shares every
    # referenced account is their own, so nothing changes).
    referenced = {
        acc_id for e in entries
        for acc_id in (e.account_id, e.transfer_to_account_id) if acc_id in scope_ids
    }
    wallet_ids = set(wallet_ids_of(db, referenced))

    buckets = _disposable_buckets(db, user_id, entries, scope_ids, wallet_ids, Money(db, fx))
    row = buckets.get(default_currency(db, user_id)) or _DisposableBucket()
    return {k: v for k, v in row.as_dict().items() if k in DISPOSABLE_KEYS}


DISPOSABLE_KEYS = ("monthly_income", "monthly_expenses", "monthly_disposable")


class _DisposableBucket:
    """One currency's monthly figures (``get_disposable_income``)."""

    def __init__(self):
        self.income: float = 0.0
        self.expenses: float = 0.0
        self.moved_in: float = 0.0
        self.moved_out: float = 0.0

    def as_dict(self) -> dict:
        # Money moved across currencies is neither income nor expense (plan C3).
        disposable = self.income - self.expenses + self.moved_in - self.moved_out
        return {
            "monthly_income": round(self.income, 2),
            "monthly_expenses": round(self.expenses, 2),
            "moved_in": round(self.moved_in, 2),
            "moved_out": round(self.moved_out, 2),
            "monthly_disposable": round(disposable, 2),
        }


def _disposable_buckets(db: Session, user_id: int, entries: list, scope_ids, wallet_ids,
                        money: Money) -> dict:
    """``get_disposable_income``'s figures per currency (plan C3, D2).

    An entry counts in its account's currency (an accountless one, or one
    on an account outside the caller's scope: its own, at its face), its
    amount estimated into that currency when it differs; one with no stored
    rate is left out. A recurring transfer between two projection-cash
    accounts in different currencies is money moved: ``moved_out`` in the
    source's currency and ``moved_in`` in the destination's, each leg counted
    on its own (a leg with no stored rate is left out, the other kept).
    """
    buckets: dict = {}

    def bucket(currency) -> _DisposableBucket:
        return buckets.setdefault(currency, _DisposableBucket())

    def monthly(entry, currency) -> Optional[float]:
        if currency is None or _code(entry.currency) == currency:
            return _monthly_equivalent(entry.amount, entry.cadence)
        figure, _ = money.to(entry.amount, entry.currency, currency)
        return None if figure is None else _monthly_equivalent(figure, entry.cadence)

    cash_ids = {
        a.id for a in db.query(Account).filter(Account.id.in_(set(scope_ids))).all()
        if is_projection_cash(a)
    } if scope_ids else set()

    for entry in entries:
        src = entry.account_id
        # An account outside the caller's scope (the creator who lost access
        # to it) is never read: its entry counts in its own currency, at its
        # face, so that account's currency never reaches a total (plan G3).
        src_cur = (money.currency_of(src) if src in scope_ids else None) or _code(entry.currency)
        if entry.transfer_to_account_id is not None:
            dst = entry.transfer_to_account_id
            to_wallet = dst in wallet_ids
            from_wallet = src in wallet_ids
            if src not in scope_ids:
                continue  # inbound from outside the caller's scope
            if to_wallet and not from_wallet:
                amount = monthly(entry, src_cur)
                if amount is not None:
                    bucket(src_cur).expenses += amount
            elif from_wallet and not to_wallet and dst in scope_ids:
                amount = monthly(entry, src_cur)
                if amount is not None:
                    bucket(src_cur).expenses -= amount
            elif src in cash_ids and dst in cash_ids:
                dst_cur = money.currency_of(dst)
                if dst_cur != src_cur:
                    # Each leg on its own: one with no stored rate is left out,
                    # never the other, whose figure is known.
                    out, got = monthly(entry, src_cur), monthly(entry, dst_cur)
                    if out is not None:
                        bucket(src_cur).moved_out += out
                    if got is not None:
                        bucket(dst_cur).moved_in += got
            continue
        if entry.user_id != user_id and src not in scope_ids:
            continue  # another user's entry paid from outside the caller's accounts
        amount = monthly(entry, src_cur)
        if amount is None:
            continue
        if entry.entry_type == BudgetEntryType.INCOME:
            bucket(src_cur).income += amount
            if src in wallet_ids:
                bucket(src_cur).expenses += amount  # income into a wallet is a top-up
        elif src not in wallet_ids:
            bucket(src_cur).expenses += amount
    return buckets


def disposable_by_currency(db: Session, user_id: int, tag_id: Optional[int] = None,
                           fx: Optional[FxRates] = None) -> dict:
    """``/forecast/disposable``: the default currency's three figures, plus
    ``by_currency`` rows (``moved_in``/``moved_out`` too) and ``currencies``.
    Its rows are monthly equivalents of recurring entries; none is listed, so
    ``fx`` reports no rows."""
    from app.core.access import household_grants

    scope_ids = viewable_account_ids(db, user_id, roles=VIEW_ROLES)
    query = db.query(BudgetEntry).filter(
        readable_criterion(BudgetEntry, user_id, viewable_account_ids(db, user_id),
                           household_grants(db, user_id)),
        BudgetEntry.is_active.is_(True),
    )
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(BudgetEntry, tag_id))
    entries = query.all()
    referenced = {
        acc_id for e in entries
        for acc_id in (e.account_id, e.transfer_to_account_id) if acc_id in scope_ids
    }
    wallet_ids = set(wallet_ids_of(db, referenced))
    money = Money(db, fx)
    buckets = _disposable_buckets(db, user_id, entries, scope_ids, wallet_ids, money)
    default = default_currency(db, user_id)
    rows = [{"currency": c, **(buckets.get(c) or _DisposableBucket()).as_dict()}
            for c in ordered_currencies(buckets, default)]
    accounts = get_account_balances(db, user_id)
    collector = FxCollector()
    return {
        **{k: rows[0][k] for k in DISPOSABLE_KEYS},
        "by_currency": rows,
        "currencies": response_currencies({_code(a.currency) for a in accounts}
                                          | set(buckets), collector, default),
        "fx": collector.as_dict(),
    }


_CENTS = Decimal("0.01")


def _money(x) -> Decimal:
    """Coerce a float/Decimal/int into a 2dp Decimal (money is stored as float today)."""
    return Decimal(str(x)).quantize(_CENTS, rounding=ROUND_HALF_UP)


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _code(currency) -> Optional[str]:
    return getattr(currency, "value", currency)


class Money:
    """Figures in an account's currency, at one request's stored rates (plan B6, B7).

    ``fx`` is the request's ``FxRates``; without one, ``FxRates.offline(db)``
    is built the first time a figure actually needs converting, so a
    projection with nothing to convert never asks for a rate.
    """

    def __init__(self, db: Session, fx: Optional[FxRates] = None):
        self.db = db
        self._fx = fx
        self._currency: dict = {}

    @property
    def fx(self) -> FxRates:
        if self._fx is None:
            self._fx = FxRates.offline(self.db)
        return self._fx

    def seed(self, accounts) -> None:
        for a in accounts:
            self._currency[a.id] = _code(a.currency)

    def currency_of(self, account_id) -> Optional[str]:
        if account_id is None:
            return None
        if account_id not in self._currency:
            account = self.db.get(Account, account_id) if self.db is not None else None
            self._currency[account_id] = _code(account.currency) if account else None
        return self._currency[account_id]

    def to(self, amount, base, quote) -> tuple:
        """``(figure in quote, estimate)``.

        Same currency (or either unknown): ``amount`` itself and no estimate.
        Otherwise ``estimate`` is ``{original_amount, original_currency, rate}``
        and the figure is ``amount × rate``, or None when no rate is stored
        (the item is unconverted; ``rate`` is then None too).
        """
        amount = _money(amount)
        base, quote = _code(base), _code(quote)
        if base is None or quote is None or base == quote:
            return amount, None
        rate = self.fx.rate(base, quote)
        estimate = {"original_amount": amount, "original_currency": base, "rate": rate}
        if rate is None:
            return None, estimate
        return convert(amount, rate.rate), estimate


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
    - Stops at the last date ``datetime`` can hold rather than raising, so an
      unbounded walk (``end`` of ``datetime.max``) ends there.
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
            if y > MAXYEAR or datetime(y, m, 1) > end:
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
        try:
            occ = _next_occurrence(occ, entry.cadence)
        except (OverflowError, ValueError):
            return  # past the last date datetime can hold


def iter_window_occurrences(entry, start: datetime, end: datetime) -> Iterator[tuple]:
    """Yield ``(date, original)`` for a budget entry's occurrences owed in ``[start, end)``.

    An installment (``end_mode == "after_occurrences"`` with a ``max_occurrences``
    cap) whose ``next_occurrence`` is before ``start`` is walked from
    ``next_occurrence``: each occurrence before ``start`` is still owed, since
    nothing advances the schedule except recording it, so it is yielded as ``(start, occurrence)``, overdue on the window start
    like an overdue unposted transaction, and it uses up its place in the cap.
    Every other occurrence is ``(occurrence, None)``. Any other entry is walked from
    ``start`` (``iter_occurrences``): an open-ended schedule's missed occurrences
    are dropped, so a stale schedule cannot flood the projection. An
    ``after_occurrences`` entry with no cap is walked that way too. Callers
    suppress a recorded occurrence on ``original`` (when set), its own day.
    """
    start, end = _naive(start), _naive(end)
    anchor = _naive(entry.next_occurrence)
    capped = (getattr(entry, "end_mode", None) == "after_occurrences"
              and getattr(entry, "max_occurrences", None) is not None)
    if capped and anchor < start < end:
        for occ in iter_occurrences(entry, anchor, end):
            yield (start, occ) if occ < start else (occ, None)
        return
    for occ in iter_occurrences(entry, start, end):
        yield occ, None


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
        for key in ("row", "cash_currency"):
            if key in e:
                # A per-currency run's listing row and currency, for serialisers.
                out_events[-1][key] = e[key]
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


# Internal per-currency keys every event carries inside this module; collect_events
# drops them unless asked (``detail``), so a default caller's events are unchanged.
DETAIL_KEYS = ("leg_currencies", "rows", "cash_by_currency", "moved_by_currency",
               "estimate", "face_currency", "unconverted", "household_bucket")


def _row(currency, amount, estimate=None) -> dict:
    """A listing row: an unsigned figure in ``currency`` (None: unconverted)."""
    return {"currency": _code(currency), "amount": amount, "estimate": estimate}


def _meta(ev: dict, leg_currencies: List[Optional[str]], rows: List[dict], face_currency,
          moved: Optional[dict] = None) -> dict:
    """Attach the per-currency detail (plan C1) to an event built by ``_event``.

    ``leg_currencies`` runs parallel to ``ev["legs"]``: each leg's account
    currency (a leg with no account: the entry's). ``cash_by_currency`` sums
    the cash legs per currency, when the event moves cash; the raw ``amount``
    sums them across currencies and is not a total for a mixed event.
    ``rows`` are its listing rows, one per currency it shows in.
    ``moved_by_currency`` is a cross-currency transfer between two
    projection-cash accounts: the part of each leg that is money moved
    (``moved_out`` in the source currency, ``moved_in`` in the destination's),
    never income or expense.
    """
    cash: dict = {}
    if ev["counts_as_cash"]:
        for leg, currency in zip(ev["legs"], leg_currencies):
            if leg["cash"]:
                cash[currency] = cash.get(currency, Decimal("0")) + leg["amount"]
    ev.update({
        "leg_currencies": list(leg_currencies),
        "rows": rows,
        "cash_by_currency": cash,
        "moved_by_currency": {c: m for c, m in (moved or {}).items() if c in cash},
        "estimate": {r["currency"]: r["estimate"] for r in rows if r["estimate"] is not None},
        "face_currency": _code(face_currency),
        "unconverted": any(r["amount"] is None for r in rows),
    })
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
                    overflow_account_id: Optional[int] = None,
                    money: Optional[Money] = None, face_currency=None, **extra) -> dict:
    """A transfer: -(amount + fee) on the source, +amount on the destination.

    Each leg is in its own account's currency (plan A3, B6): the source moves
    by ``amount + fee`` in the transfer's ``face_currency`` (the source's, by
    rule; a legacy row in another is estimated into the source's), and the
    destination by ``received_amount`` when stored, else by ``amount``
    estimated at the stored rate into the destination's currency. A leg with
    no rate is left out (unconverted).

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
    ``known_wallet_ids`` are every wallet the caller can view, in the projection
    scope or not (an inactive one); a cash-funded transfer into one of them is marked ``top_up`` (spending,
    so a payable), even when the wallet itself has no leg here. Likewise a
    cash-funded transfer into a loan (``loan_ids`` in scope, ``known_loan_ids``
    any other the caller references) is marked ``loan_payment``. A transfer
    into a loan the caller cannot access (``hidden_loan_ids``) is a neutral
    "Loan payment": no description, ``source_id`` or ``transfer_fee`` (the
    interest), only its amounts, date and in-scope legs.

    ``unbilled_ids`` are cards outside the scope without cycle settings that the
    caller can view (an inactive one): a transfer touching one moves no cash, as
    for a scoped one. A card the caller can't view is never in it.

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
    cards that have them (cycle settings; default: every card); ``collect_events``
    passes a card the caller can't view as billed whatever its settings, so those
    settings never decide what moves their cash. A transfer
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
    money = money or Money(None)
    face = _code(face_currency)
    src_cur = money.currency_of(src) if src in scoped else None
    dst_cur = money.currency_of(dst) if dst in scoped else None
    out, out_estimate = money.to(amount + fee, face, src_cur or face)
    sent, _ = money.to(amount, face, src_cur or face)
    received = getattr(txn, "received_amount", None)
    if received is not None:
        got, got_estimate = _money(received), None
    else:
        got, got_estimate = money.to(amount, face, dst_cur or face)
    legs, leg_currencies, rows = [], [], []
    if src in scoped:
        if out is not None:
            legs.append(_leg(src, -out, overflow_account_id, cash=src_cash))
            leg_currencies.append(src_cur)
        rows.append(_row(src_cur, sent, out_estimate and {**out_estimate,
                                                           "original_amount": _money(amount)}))
    if dst in scoped:
        if got is not None:
            legs.append(_leg(dst, got, cash=dst in cash_ids and not via_unbilled))
            leg_currencies.append(dst_cur)
        if src not in scoped or dst_cur != src_cur:
            rows.append(_row(dst_cur, got, got_estimate))
    if not rows:
        rows.append(_row(face, _money(amount)))
    moved = {}
    if src_cash and dst in cash_ids and src_cur != dst_cur:
        if sent is not None:
            moved[src_cur] = -sent
        if got is not None:
            moved[dst_cur] = got
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
    return _meta(_event(
        date=date or _naive(txn.transaction_date),
        name="Loan payment" if hidden else txn.description or "Unposted transfer",
        type=txn.transaction_type.value,
        source=source,
        source_id=None if hidden else txn.id,
        face_amount=amount,
        legs=legs,
        counts_as_cash=False if via_unbilled else None,
        **extra,
    ), leg_currencies, rows, face, moved)


def collect_events(
    db: Session,
    start: datetime,
    end: datetime,
    *,
    user_id: int,
    accounts: Optional[list] = None,
    tag_id: Optional[int] = None,
    household=None,
    keep_origin: bool = False,
    fx: Optional[FxRates] = None,
    detail: bool = False,
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
    the account itself (``wallet_ids_of``), so an inactive wallet is still a
    wallet; an account the caller can't view is never read as one, so its flag
    changes nothing they are shown. A statement payable funded from a wallet has a
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
    An occurrence already recorded is suppressed, for every kind of entry
    (cash account, no account, card with or without cycle settings, recurring
    transfer): a transaction of the entry's creator with this
    ``budget_entry_id`` stands in for the occurrence it fulfils
    (``occurrence_date``, set by ``materialize``; else the one on its
    ``transaction_date``'s calendar day). A materialised row does so only while
    it is still on the entry's account(s) (anywhere for an entry with none); a
    row linked by hand keeps the shared-account rule of
    ``linked_transactions``. Each transaction suppresses
    at most one occurrence (see ``_linked_occurrence_days``), so a
    ``materialize`` with ``advance=False``, or a row linked to the entry by
    hand, does not move the money twice, and a late payment that advances the
    schedule does not hide the next occurrence.

    Balances change only when a transaction is posted, so an unposted transaction
    dated before ``start`` is a pending movement not yet in the opening balance: it
    is emitted dated at ``start`` with ``overdue`` True and its ``original_date``.
    So is a capped installment's (``after_occurrences``) occurrence before ``start``
    that nothing recorded: it is still owed, and it keeps its place in the cap,
    while an open-ended entry's occurrences before ``start`` are dropped (see
    ``iter_window_occurrences``). Such an occurrence is suppressed on its
    original day, and a recurring transfer into a loan covers that day's due
    date with it.
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

    With ``household`` (a ``HouseholdGrant``; ``accounts`` must then be its
    Household view scope, ``services/household.household_accounts``) this is
    that sharer's Household view: only records touching a scope account
    (the caller's own private records are outside it), only that sharer's
    Household occurrences, statement legs only on scope accounts, and every
    card outside the scope that a scope account pays (primary or overflow)
    discovered as a neutral "Card payment", whatever the caller's role on it.
    ``keep_origin`` keeps each event's internal ``origin`` (model, id) for
    callers in this service layer; it never reaches a response.

    Currencies (STU-236, plan B6, B7, C1): every leg's ``amount`` is in its
    own account's currency. A figure in another currency (an unposted row's
    foreign face, ``pending_face``; a recurring entry in another currency than
    its account's; a transfer's destination with no ``received_amount``; a
    legacy statement or loan payable funded from another currency) is
    estimated at the stored rate (``fx``, offline when None) when its leg is
    built, and a leg with no stored rate is left out (unconverted). With
    ``detail`` each event also keeps the internal per-currency keys
    (``DETAIL_KEYS``: ``cash_by_currency``, ``estimate``, ``face_currency``,
    its listing ``rows``, ...); by default they are dropped, so a caller that
    never asks gets exactly the events it always got.
    """
    start = _naive(start)
    end = _naive(end)
    if accounts is None:
        accounts = get_account_balances(db, user_id)
    money = Money(db, fx)
    money.seed(accounts)
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
    # in the scope (loans included), kept only when the caller may read it
    # (rules (a), (b), and through a tag share (b2) and (c): never another
    # user's records on a sharer's account). With no tag shares this is the
    # creator's records plus those touching a scoped account.
    scope_account_ids = {a.id for a in accounts}
    access = redactor.access
    direct_ids = viewable_account_ids(db, user_id)
    grants = list(access.grants.values())

    def disclosed(model):
        if household is not None:
            return (readable_criterion(model, user_id, direct_ids, grants),
                    touches_accounts(model, scope_account_ids))
        return (readable_criterion(model, user_id, direct_ids, grants),
                or_(model.user_id == user_id, touches_accounts(model, scope_account_ids)))

    entries = [e for e in db.query(BudgetEntry).filter(
        *disclosed(BudgetEntry),
        BudgetEntry.is_active.is_(True),
    ).all() if access.readable(e)]

    txns = [t for t in db.query(Transaction).filter(
        *disclosed(Transaction),
        Transaction.is_posted.is_(False),
        Transaction.transaction_date < end,
    ).all() if access.readable(t)]

    # Every wallet any event references among the accounts the caller can view
    # (inactive ones included). Whether an account they can't view is a wallet
    # never changes what they are shown; for a user with no shares every
    # referenced account is their own, so nothing changes.
    viewable_ids = viewable_account_ids(db, user_id, roles=VIEW_ROLES)
    wallet_ids = scoped_wallet_ids | wallet_ids_of(db, (acc for acc in (
        *(acc for e in entries for acc in (e.account_id, e.transfer_to_account_id)),
        *(acc for t in txns
          for acc in (t.account_id, t.transfer_from_account_id, t.transfer_to_account_id)),
        *(acc for a in accounts if a.id in billed_ids
          for acc in (a.payment_account_id, a.payment_overflow_account_id)),
        *(a.payment_account_id for a in loans),
    ) if acc in viewable_ids))

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
        and (household is not None or account_role(user_id, a) == NONE)
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
    # A card the caller can't view counts as billed whatever its cycle settings,
    # so the visible leg of a transfer touching it always moves cash and those
    # hidden settings change nothing they are shown. For a user with no shares
    # every referenced card is their own, so nothing changes.
    outside_billed = {cid for cid, a in referenced_cards.items()
                      if cid not in viewable_ids or resolve_cycle_fields(a) is not None}
    outside_unbilled = frozenset(set(referenced_cards) - outside_billed)
    transfer_billed_ids = billed_ids | outside_billed

    # Transactions already recorded for an entry's occurrences, by day: each stands
    # in for the one occurrence it fulfils (as in _card_entry_charges), since
    # the transaction itself is the movement (posted: already in the balance;
    # unposted: listed below). Fetched once for every entry walked here; entries on
    # billed cards are suppressed in _billed_card_occurrences instead.
    walked_entry_ids = [e.id for e in entries if e.transfer_to_account_id is not None
                        or (e.account_id not in wallet_ids and e.account_id not in billed_ids)]
    records = {(BudgetEntry, e.id): e for e in entries}
    records.update(((Transaction, t.id), t) for t in txns)
    linked = _linked_occurrence_days(db, walked_entry_ids)

    card_entries = []
    for entry in entries:
        # Overflow routing only onto a scoped account, on every entry type.
        overflow_id = entry.overflow_account_id if entry.overflow_account_id in scoped_ids else None
        if entry.transfer_to_account_id is not None:
            # Only the scoped legs are kept (see _transfer_event).
            for occ, original in iter_window_occurrences(entry, start, end):
                key = (entry.id, (original or occ).date())
                if linked[key]:
                    linked[key] -= 1
                    continue  # already materialised (e.g. advance=False)
                overdue = ({"overdue": True, "original_date": original}
                           if original is not None else {})
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
                    money=money, face_currency=entry.currency, **overdue,
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
        # An entry in another currency than its account's is estimated (plan B6).
        legs, leg_currencies = [], []
        if entry.account_id in scoped_ids or (
                entry.account_id is None and entry.user_id == user_id):
            leg_currency = money.currency_of(entry.account_id) or _code(entry.currency)
            figure, estimate = money.to(entry.amount, entry.currency, leg_currency)
            rows = [_row(leg_currency, figure, estimate)]
            if figure is not None:
                legs, leg_currencies = [_leg(entry.account_id, sign * figure, overflow_id)], [
                    leg_currency]
        else:
            rows = [_row(entry.currency, _money(entry.amount))]
        for occ, original in iter_window_occurrences(entry, start, end):
            key = (entry.id, (original or occ).date())
            if linked[key]:
                linked[key] -= 1
                continue  # already recorded (e.g. advance=False)
            overdue = ({"overdue": True, "original_date": original}
                       if original is not None else {})
            events.append(_meta(_event(
                date=occ,
                name=entry.name,
                type=entry.entry_type.value,
                source="budget_entry",
                source_id=entry.id,
                face_amount=entry.amount,
                legs=legs,
                origin=(BudgetEntry, entry.id),
                **overdue,
            ), leg_currencies, rows, entry.currency))

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
                                          origin=(Transaction, txn.id), money=money,
                                          face_currency=txn.currency, **overdue))
            continue
        if txn.transaction_type not in (TransactionType.CREDIT, TransactionType.DEBIT):
            continue  # a credit is an inflow, a debit an outflow
        # A charge on a credit card is NOT a cash outflow on its purchase date — the
        # cash leaves when that card's statement is paid, which is modelled as a
        # dated statement payable below. Its leg is therefore non-cash.
        # A face in another currency than the account's is estimated from the
        # face (pending_face), never from an actual figure kept in ``amount``.
        legs, leg_currencies = [], []
        face, face_currency = pending_face(txn)
        if txn.account_id in scoped_ids:
            leg_currency = money.currency_of(txn.account_id)
            if _code(face_currency) != leg_currency and face is not None:
                figure, estimate = money.to(face, face_currency, leg_currency)
            else:
                figure, estimate = _money(txn.amount), None
            rows = [_row(leg_currency, figure, estimate)]
            if figure is not None:
                sign = (Decimal("1") if txn.transaction_type == TransactionType.CREDIT
                        else Decimal("-1"))
                legs = [_leg(txn.account_id, sign * figure, cash=txn.account_id in cash_ids)]
                leg_currencies = [leg_currency]
        else:
            rows = [_row(txn.currency, _money(txn.amount))]
        events.append(_meta(_event(
            date=when,
            name=txn.description or "Unposted transaction",
            type=txn.transaction_type.value,
            source="transaction",
            source_id=txn.id,
            face_amount=txn.amount,
            legs=legs,
            origin=(Transaction, txn.id),
            **overdue,
        ), leg_currencies, rows, face_currency))

    cards = {a.id: a for a in accounts if a.id in billed_ids}
    projected_charges = _card_entry_charges(db, card_entries, cards, start, end, events,
                                            money=money)

    # Household occurrences: each sharer's explicitly Household-tagged records
    # outside the scope (a bill on their private card or wallet), listed with
    # no leg and de-duplicated against in-scope card payments (services/household.py).
    # Outside the active scope: an account the caller also sees directly is in
    # the normal projection's scope, so a record on it is never listed twice.
    for grant in ([household] if household is not None else grants):
        events.extend(_household_events(db, redactor, user_id, grant, accounts, start, end,
                                        money))

    # Each credit card contributes one dated payable per billing cycle due in the
    # window, derived from its own transactions (see services/statements.py) and
    # the projected charges of budget entries scheduled on it.
    # A funding or overflow account the caller can't view gets no leg, and its id
    # is never emitted (STU-227). One they can view keeps its leg even when
    # inactive, as before shared accounts, so a user with no shares projects
    # exactly as then.
    # In a Household view only scope accounts get legs.
    leg_ids = scoped_ids if household is not None else viewable_ids
    for p in get_statement_payables(db, [a for a in accounts if a.id in card_ids], start, end,
                                    projected_charges=projected_charges,
                                    viewable_ids=viewable_ids, fx=money.fx):
        line_estimate = p.pop("line_estimate", None)
        extra = {k: v for k, v in p.items() if k not in {
            "date", "name", "amount", "type", "source", "source_id",
            "funding_account_id", "overflow_account_id",
        }}
        funding = p["funding_account_id"] if p["funding_account_id"] in leg_ids else None
        overflow = p["overflow_account_id"] if p["overflow_account_id"] in leg_ids else None
        card = cards.get(p["source_id"]) or next(
            a for a in accounts if a.id == p["source_id"])
        legs, leg_currencies, rows = _payable_legs(
            money, funding, overflow, p["amount"], card.currency, line_estimate,
            cash=funding not in wallet_ids)
        statement = _meta(_event(
            date=p["date"],
            name=p["name"],
            type=p["type"],
            source=p["source"],
            source_id=p["source_id"],
            face_amount=-p["amount"],
            legs=legs,
            origin=(Account, p["source_id"]),  # the card
            **extra,
        ), leg_currencies, rows, card.currency)
        if access.role(card.id) == TAG_VIEWER:
            # Seen through a tag share: no statement detail (as a hidden card's).
            _limit(statement, redactor, name=p["name"], currency=card.currency,
                   kind="card_payment")
        events.append(statement)

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
        hidden_charges = _card_entry_charges(db, card_rows, hidden_cards, start, end, None,
                                             money=money)
        for p in get_statement_payables(db, outside_cards, start, end,
                                        projected_charges=hidden_charges,
                                        viewable_ids=viewable_ids, fx=money.fx):
            line_estimate = p.pop("line_estimate", None)
            card = hidden_cards[p["source_id"]]
            primary = p["funding_account_id"] if p["funding_account_id"] in scoped_ids else None
            overflow = (p["overflow_account_id"]
                        if primary is not None and p["overflow_account_id"] in scoped_ids
                        else None)
            overdue = {k: p[k] for k in ("overdue", "original_date") if k in p}
            legs, leg_currencies, rows = _payable_legs(
                money, primary, overflow, p["amount"], card.currency, line_estimate,
                cash=primary not in wallet_ids)
            events.append(_limit(_meta(_event(
                date=p["date"],
                name=CARD_PAYMENT,
                type=p["type"],
                source=p["source"],
                source_id=None,
                face_amount=0,
                legs=legs,
                origin=(Account, card.id),
                **overdue,
            ), leg_currencies, rows, card.currency), redactor, name=CARD_PAYMENT,
                currency=card.currency, kind="card_payment"))

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
        for occ, original in iter_window_occurrences(entry, start, end + COVER_HORIZON):
            day = (original or occ).date()  # an overdue cover is dated its own day
            key = (entry.id, day)
            if linked_covers[key]:
                linked_covers[key] -= 1
                continue
            projected_covers.setdefault(entry.transfer_to_account_id, []).append(
                (day, _money(entry.amount), entry))
    loans_by_id = {a.id: a for a in payable_loans}
    # A legacy cover from another currency is normalised into the loan's first;
    # one with no stored rate is not netted (plan B6, services/loans.py).
    for loan_id, covers in list(projected_covers.items()):
        loan = loans_by_id[loan_id]
        kept = []
        for day, cash, entry in covers:
            cash = normalise_cover(db, loan, cash, money.currency_of(entry.account_id)
                                   or _code(entry.currency), money.fx)
            if cash is not None:
                kept.append((day, cash))
        projected_covers[loan_id] = kept
    for p in build_loan_payables(db, payable_loans, start, end, projected_covers,
                                 fx=money.fx):
        hidden = p["source_id"] in hidden_loan_ids
        extra = {k: v for k, v in p.items() if k not in {
            "date", "name", "amount", "type", "source", "source_id",
            "funding_account_id", "overflow_account_id",
        } and not (hidden and k not in ("overdue", "original_date"))}
        payer = p["funding_account_id"]
        # Cash only on a scoped projection-cash account; a scoped wallet's leg
        # is kept as non-cash, and an account outside the scope has no leg.
        legs, leg_currencies, rows = _payable_legs(
            money, payer if payer in scoped_ids else None, None, p["amount"],
            loans_by_id[p["source_id"]].currency, None, cash=payer in cash_ids)
        event = _meta(_event(
            date=p["date"],
            name="Loan payment" if hidden else p["name"],
            type=p["type"],
            source=p["source"],
            source_id=None if hidden else p["source_id"],
            face_amount=-p["amount"],
            legs=legs,
            origin=(Account, p["source_id"]),  # the loan
            **extra,
        ), leg_currencies, rows, loans_by_id[p["source_id"]].currency)
        if hidden:
            event = _limit(event, redactor, name=LOAN_PAYMENT,
                           currency=loans_by_id[p["source_id"]].currency, kind="loan_payment")
        elif access.role(p["source_id"]) == TAG_VIEWER:
            # Seen through a tag share: the loan's name, no schedule detail.
            event = _limit(event, redactor, name=p["name"],
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
        if not keep_origin:
            del e["origin"]
        if not detail:
            for key in DETAIL_KEYS:
                e.pop(key, None)
    return events


def _payable_legs(money: Money, funding, overflow, amount, currency, line_estimate,
                  *, cash: bool) -> tuple:
    """``(legs, leg_currencies, rows)`` of a statement or loan payable.

    ``amount`` (negative) is in the card's or loan's ``currency``. Its leg is
    on ``funding`` (None: no leg), in that account's currency: a legacy
    payable funded from another currency is estimated there at the stored
    rate (with no rate it has no leg: unconverted). ``line_estimate`` is a
    statement's own estimate (from estimated lines), shown when the payable
    itself needs no conversion. A payable estimated twice (its lines into the
    card's currency, then the total into the funding account's) carries every
    contributing rate, as a statement over several rates does
    (``statements.statement_estimate``, ``row_labels``): no single ``rate``
    or original figure, stale when any rate is, dated by the earliest.
    """
    owed = -_money(amount)
    if funding is None:
        return [], [], [_row(currency, owed, line_estimate)]
    funding_currency = money.currency_of(funding)
    figure, estimate = money.to(owed, currency, funding_currency)
    if figure is not None and estimate is not None and line_estimate is not None:
        estimate = {"rates": [*estimate_rates(line_estimate), estimate["rate"]]}
    rows = [_row(funding_currency, figure, estimate or line_estimate)]
    if figure is None:
        return [], [], rows
    return [_leg(funding, -figure, overflow, cash=cash)], [funding_currency], rows


def _household_events(db: Session, redactor, user_id: int, grant, scope: list,
                      start: datetime, end: datetime, money: Optional[Money] = None
                      ) -> List[dict]:
    """Household occurrences (``services/household.py``) as listed events.

    ``scope`` is the projection's active scope (``collect_events``'s
    ``accounts``): the Household view scope in a Household view, every account
    the caller can view otherwise. A record touching any of it is an ordinary
    event there, never also an occurrence, so each record appears once.

    No legs and ``counts_as_cash`` False: ``cash_delta`` 0, never cash and
    never in unassigned cash. ``face_amount`` is the occurrence's remainder.
    One the caller sees Limited (anyone but its creator) is a limited event
    of kind "household" with a neutral account reference; one they see in
    full (their own, in their own Household view) carries
    ``household_occurrence``. Its listing row is in the occurrence's
    ``currency`` (services/household.py: when the caller reads the record in
    full, the card's or the account's, else the record's).
    """
    from app.services.household import household_occurrences

    out = []
    viewable_ids = viewable_account_ids(db, user_id, roles=VIEW_ROLES)
    for occ in household_occurrences(db, grant, scope, start, end, recorded=False,
                                     viewable_ids=viewable_ids, access=redactor.access,
                                     fx=money.fx if money is not None else None):
        record = occ.record
        is_txn = isinstance(record, Transaction)
        limited = redactor.view(record) == LIMITED
        # The listing row keeps the occurrence's FX state (plan B5): an
        # estimate, or no figure when unconverted (so in no total). Only a full
        # row shows it; a Limited event shows its approved face and currency,
        # with no new fields (plan G).
        row = _row(occ.currency, None if occ.unconverted else occ.remainder,
                   None if limited else occ.estimate)
        event = _meta(_event(
            date=occ.date,
            name=record.description if is_txn else record.name,
            type=record.transaction_type.value if is_txn else record.entry_type.value,
            source="transaction" if is_txn else "budget_entry",
            source_id=record.id,
            face_amount=occ.remainder,
            legs=[],
            counts_as_cash=False,
            origin=(type(record), record.id),
            household_occurrence=True,
            household_bucket=occ.month(),
            **occ.extra,
        ), [], [row], record.currency)
        if limited:
            _limit(event, redactor, name=redactor.display_description(record),
                   currency=record.currency, kind="household")
            event["account"] = redactor.account_ref(record.account_id)
        out.append(event)
    return out


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
    event's cash legs on scope accounts. A row split by currency (plan C4)
    carries ``cash_currency``: its ``amount`` is that currency's cash, and a
    payment to a hidden card or loan shows that cash as its face, in that
    currency, so the hidden account's own currency is never shown.
    """
    def day(d):
        if d is None:
            return None
        return (d.date() if isinstance(d, datetime) else d).isoformat()

    face, currency = e["face_amount"], e.get("currency")
    if e.get("kind") in ("loan_payment", "card_payment") and e.get("cash_currency"):
        face, currency = abs(e["amount"]), e["cash_currency"]
    return {
        "view": LIMITED,
        "public_id": public_id,
        "date": day(e["date"]),
        "original_date": day(e.get("original_date")),
        "overdue": bool(e.get("overdue")),
        "display_name": e["name"],
        "face_amount": round(float(face), 2),
        "cash_delta": round(float(e["amount"]), 2),
        "currency": currency,
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


def linked_transactions(db: Session, entry_ids, *, occurrence_match: bool = False) -> List[tuple]:
    """``[(entry id, day)]``: the transactions that stand for an entry's
    occurrences (materialised from it, or linked to it by hand). The day is the
    occurrence a materialised row fulfils (``occurrence_date``, the entry's
    ``next_occurrence`` when it was materialised), else its ``transaction_date``
    (a row linked by hand, or one recorded before ``occurrence_date`` existed).

    Only the entry creator's transactions count: another user's row naming the
    entry is a stale reference (left by the entity era; the same-owner rule
    allows no new one) and stands for nothing.

    For an entry touching no shared account the creator's row counts on
    whichever account it was recorded (as before shared accounts, so a user
    with no shares gets exactly the same result as then). For an entry touching
    an account with any share (an ``AccountShare``, or its owner's Household tag
    on it shared with anyone, the ``tag_viewer`` path in ``app/core/access.py``),
    only a row touching nothing but the entry's own accounts counts: for an
    ordinary entry a debit or credit (never a transfer) on its account, which is
    what ``materialize`` records; for a recurring transfer a transfer from its
    source into its destination. Everyone who can see that account sees the
    entry, and a row touching any other account (the creator's private one, or
    another user's they hold a role on), which a viewer may not be able to read,
    must change nothing they are shown.

    With ``occurrence_match`` (suppressing projected occurrences,
    ``_linked_occurrence_days``) a materialised row (``occurrence_date`` set)
    counts only while it passes that account check, shared or not: moved off the
    entry's account(s) it stands for nothing. An entry with no account has none
    to check, so its creator's materialised rows count anywhere. The check reads
    the entry's current account(s), so a later change to the entry's account
    counts as a move, and the occurrence is projected again. A row linked by
    hand (``occurrence_date`` null, which includes one relinked to another
    entry) keeps the rule above. Without ``occurrence_match`` (counting paid
    occurrences) the rule above holds for every row.
    """
    entry_ids = list(entry_ids)
    if not entry_ids:
        return []
    rows = (
        db.query(Transaction.budget_entry_id,
                 func.coalesce(Transaction.occurrence_date, Transaction.transaction_date),
                 Transaction.transaction_type, Transaction.account_id,
                 Transaction.transfer_from_account_id, Transaction.transfer_to_account_id,
                 BudgetEntry.account_id, BudgetEntry.transfer_to_account_id,
                 BudgetEntry.overflow_account_id, Transaction.occurrence_date.isnot(None))
        .join(BudgetEntry, BudgetEntry.id == Transaction.budget_entry_id)
        .filter(Transaction.budget_entry_id.in_(entry_ids),
                Transaction.user_id == BudgetEntry.user_id)
        .all()
    )
    touched = {acc for row in rows for acc in row[6:9] if acc is not None}
    shared = {acc for (acc,) in db.query(Account.id).filter(
        Account.id.in_(touched),
        or_(Account.id.in_(select(AccountShare.account_id)),
            Account.id.in_(tag_shared_account_ids())))} if touched else set()

    def on_entry_accounts(row) -> bool:
        _, _, kind, account, src, dst, entry_account, entry_dst, _, _ = row
        if entry_dst is not None:
            return (kind == TransactionType.TRANSFER and (src or account) == entry_account
                    and dst == entry_dst)
        return kind != TransactionType.TRANSFER and account == entry_account

    def counts(row) -> bool:
        if occurrence_match and row[9]:  # materialised: only on the entry's account(s)
            return row[6] is None or on_entry_accounts(row)
        return not shared.intersection(row[6:9]) or on_entry_accounts(row)

    return [(row[0], row[1]) for row in rows if counts(row)]


def _linked_occurrence_days(db: Session, entry_ids: list) -> Counter:
    """``{(entry id, day): count}`` of the transactions standing for each entry's
    occurrences (``linked_transactions`` with ``occurrence_match``): each stands
    in for one occurrence, the one it fulfils (else the one on its own calendar
    day). A materialised row counts only while it is still on the entry's
    account(s); a row linked by hand keeps the shared-account rule."""
    return Counter((entry_id, _naive(when).date())
                   for entry_id, when in linked_transactions(db, entry_ids,
                                                             occurrence_match=True))


def _card_entry_charges(db: Session, entries: list, cards: dict, start: datetime,
                        end: datetime, events: Optional[List[dict]],
                        money: Optional[Money] = None) -> dict:
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
    transaction of the entry's creator with this ``budget_entry_id`` stands in for
    the occurrence it fulfils (``occurrence_date``, set by ``materialize``; else
    the one on its ``transaction_date``'s calendar day), and each transaction
    suppresses at most one occurrence, since that transaction is itself a line
    item on the card. This is what keeps a ``materialize`` with ``advance=False``
    from billing twice, even with a custom ``transaction_date`` on another day. A
    materialised row moved off the card stands for nothing, so its occurrence is
    billed again; a row linked by hand keeps the shared-account rule of
    ``linked_transactions``.

    In-window occurrences are appended to ``events`` as non-cash listings, like
    unposted card charges; with ``events`` None (a discovered card's internal
    inputs) nothing is listed. Returns ``{card_id: [line items]}``.

    Each line item is in the card's currency: an entry in another currency is
    estimated at the stored rate (``money``; offline rates when None) and
    carries that ``estimate``; one with no stored rate bills nothing and is
    listed unconverted.
    """
    if not entries:
        return {}
    money = money or Money(db)
    charges: dict = {}
    for entry, occ in _billed_card_occurrences(db, entries, cards, start, end):
        income = entry.entry_type == BudgetEntryType.INCOME
        card_currency = _code(cards[entry.account_id].currency)
        amount, estimate = money.to(entry.amount, entry.currency, card_currency)
        if amount is not None:
            charges.setdefault(entry.account_id, []).append(SimpleNamespace(
                transaction_date=occ,
                amount=amount,
                transaction_type=TransactionType.CREDIT if income else TransactionType.DEBIT,
                **({"estimate": estimate} if estimate is not None else {}),
            ))
        if occ >= start and events is not None:
            legs = ([_leg(entry.account_id, amount if income else -amount, cash=False)]
                    if amount is not None else [])
            events.append(_meta(_event(
                date=occ,
                name=entry.name,
                type=entry.entry_type.value,
                source="budget_entry",
                source_id=entry.id,
                face_amount=entry.amount,
                legs=legs,
                origin=(BudgetEntry, entry.id),
            ), [card_currency] if legs else [], [_row(card_currency, amount, estimate)],
                entry.currency))
    return charges


def _billed_card_occurrences(db: Session, entries: list, cards: dict, start: datetime,
                             end: datetime) -> Iterator[tuple]:
    """Lazily yield ``(entry, occurrence)`` for each card-backed occurrence before
    ``end`` that ``_card_entry_charges`` bills, in its order: linked occurrences
    suppressed and lapsed ones (statement due before ``start``) dropped."""
    linked = _linked_occurrence_days(db, [e.id for e in entries])
    for entry in entries:
        card = cards[entry.account_id]
        for occ in iter_occurrences(entry, _naive(entry.next_occurrence), end):
            key = (entry.id, occ.date())
            if linked[key]:
                linked[key] -= 1
                continue
            if occ < start and statement_due_date(card, occ.date()) < start:
                continue  # lapsed: its statement fell due before the window
            yield entry, occ


def has_unsuppressed_occurrence(db: Session, entries: list, start: datetime) -> bool:
    """Whether any of ``entries`` still occurs on or after ``start``, at any
    horizon, once each occurrence a linked transaction stands for is suppressed
    (``_linked_occurrence_days``, as the loan-cover and card-charge walks do).
    An installment's unrecorded occurrence before ``start`` still counts, as owed
    on ``start``, and is suppressed on its own day (``iter_window_occurrences``)."""
    if not entries:
        return False
    linked = _linked_occurrence_days(db, [e.id for e in entries])
    for entry in entries:
        for occ, original in iter_window_occurrences(entry, start, datetime.max):
            key = (entry.id, (original or occ).date())
            if linked[key]:
                linked[key] -= 1
                continue
            return True
    return False


def card_entries_still_bill(db: Session, card, entries: list, start: datetime) -> bool:
    """Whether budget entries scheduled on ``card`` still bill it from ``start`` on.

    On a card with cycle settings this is the projection's own computation:
    ``_card_entry_charges`` with ``start`` as the window start and no window
    end, so it is True when an occurrence before ``start`` is still billed on a
    statement not yet due, or when any later occurrence is, with materialised
    occurrences suppressed; it stops at the first billed occurrence. A card
    without cycle settings bills no statements, so it is
    ``has_unsuppressed_occurrence``, which suppresses recorded occurrences as
    ``collect_events`` does for the occurrences it lists on such a card.
    """
    if resolve_cycle_fields(card) is None:
        return has_unsuppressed_occurrence(db, entries, start)
    if not entries:
        return False
    billed = _billed_card_occurrences(db, entries, {card.id: card}, start, datetime.max)
    return next(billed, None) is not None


def _route_legs(
    opening_by_account: dict,
    events: List[dict],
    account_names: dict,
    checkpoints: Sequence[date] = (),
    currency_of: Optional[dict] = None,
) -> dict:
    """Walk events' cash legs per account with primary → overflow routing.

    With ``currency_of`` (account id -> currency) an overflow account in
    another currency than the leg's is never pulled from (plan C2): the
    shortfall stays on the primary account with ``overflow_used`` 0.

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
            if (ov is not None and currency_of is not None
                    and currency_of.get(ov) != currency_of.get(acc)):
                ov = None  # no routing across currencies
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
    fx: Optional[FxRates] = None,
) -> dict:
    """Build the dated running-balance timeline over the next ``days`` days.

    With ``tag_id`` only the tagged events count (see ``collect_events``).
    Every figure is the user's default currency only (STU-236, plan D3; the
    other currencies are ``timeline_by_currency``'s).
    """
    start, end = _timeline_window(days, reference)
    p = Projection(db, user_id, start, end, tag_id=tag_id, fx=fx)
    return _timeline(p, p.default, start, end, rows=False)


def _timeline_window(days: int, reference: Optional[datetime]) -> tuple:
    # Naive: compared against the naive next_occurrence / transaction_date columns.
    now = reference or naive_utc_now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=days)


def _timeline(p: "Projection", currency: str, start: datetime, end: datetime, *,
              rows: bool) -> dict:
    """One currency's running-balance timeline (``project_running_balance``)."""
    # Available cash is projection-cash accounts only (see is_projection_cash).
    opening_by_account, cash_events = p.run(currency, rows=rows)
    opening = sum(opening_by_account.values(), Decimal("0"))

    result = build_timeline(opening, cash_events)
    routing = _route_legs(opening_by_account, cash_events, p.names, currency_of=p.currencies)
    result["account_shortfalls"] = routing["shortfalls"]
    # Per-account closings at window end exclude virtual overflow pulls; those
    # are reported separately so the closings stay a plain sum of scheduled legs.
    result["by_account"] = account_closings(routing["final"], opening_by_account, p.names)
    result["unassigned_closing"] = routing["final"]["unassigned"]
    result["overflow_moves"] = routing["overflow_moves"]
    result["window_start"] = start.date()
    result["window_end"] = end.date()
    return result


# ---------------------------------------------------------------------------
# Per-currency projections (STU-236, plan C, D)
#
# Each currency is projected on its own: an account's legs stay in its
# currency, opening balances are split by account currency, and nothing is
# ever added across currencies. The default currency's run supplies every
# legacy scalar; ``by_currency`` rows carry every currency's, default first.
# Full listed rows carry their ``currency`` and, when estimated, the B5
# labels; Limited rows keep their epic shape (``limited_event``).
# ---------------------------------------------------------------------------

def default_currency(db: Session, user_id: int) -> str:
    """The user's default currency, PHP when unset (plan C5)."""
    from app.models.user import User

    user = db.get(User, user_id)
    return _code(getattr(user, "default_currency", None)) or "PHP"


def ordered_currencies(currencies, default: str, *, keep_default: bool = True) -> List[str]:
    """Default first (always, with ``keep_default``), then alphabetical."""
    present = {c for c in currencies if c}
    rest = sorted(present - {default})
    return ([default] if keep_default or default in present else []) + rest


class _CurrencyLookup:
    """``currency_of`` for ``_route_legs``: any account id, looked up once."""

    def __init__(self, money: Money):
        self.money = money

    def get(self, account_id, default=None):
        return self.money.currency_of(account_id) or default


class Projection:
    """One caller's projection events and opening balances, split by currency."""

    def __init__(self, db: Session, user_id: int, start: datetime, end: datetime, *,
                 tag_id: Optional[int] = None, fx: Optional[FxRates] = None):
        self.db = db
        self.user_id = user_id
        self.accounts, self.opening_by_account, self.names = _projection_accounts(db, user_id)
        self.money = Money(db, fx)
        self.money.seed(self.accounts)
        self.currencies = _CurrencyLookup(self.money)
        self.default = default_currency(db, user_id)
        self.events = collect_events(db, start, end, user_id=user_id, accounts=self.accounts,
                                     tag_id=tag_id, fx=self.money.fx if fx else None,
                                     detail=True)
        self.cash_events = [e for e in self.events if e["counts_as_cash"]]

    def run(self, currency: str, *, rows: bool = True) -> tuple:
        """``(opening_by_account, cash events)`` of one currency (plan C2).

        Each event keeps only its legs in ``currency``, its ``amount`` is that
        currency's cash, and ``moved`` its money moved; with ``rows`` it also
        carries its listing ``row`` in that currency.
        """
        opening = {a: v for a, v in self.opening_by_account.items()
                   if self.money.currency_of(a) == currency}
        events = []
        for e in self.cash_events:
            if currency not in e["cash_by_currency"]:
                continue
            ev = {**e,
                  "legs": [leg for leg, c in zip(e["legs"], e["leg_currencies"])
                           if c == currency],
                  "cash_currency": currency,
                  "amount": e["cash_by_currency"][currency],
                  "moved": e["moved_by_currency"].get(currency, Decimal("0"))}
            if rows:
                ev["row"] = next((r for r in e["rows"] if r["currency"] == currency),
                                 _row(currency, abs(ev["amount"])))
            events.append(ev)
        return opening, events

    def run_currencies(self) -> List[str]:
        """Every currency with an opening account or cash, the default first."""
        found = {self.money.currency_of(a) for a in self.opening_by_account}
        found |= {c for e in self.cash_events for c in e["cash_by_currency"]}
        return ordered_currencies(found, self.default)

    def account_currencies(self) -> set:
        """The currencies of the caller's viewable active accounts."""
        return {_code(a.currency) for a in self.accounts}


class FxCollector:
    """A response's ``fx`` and ``currencies`` from the full rows it shows (plan G3).

    Only full rows are added: a Limited row's estimate never adds its pair,
    and only full rows count as unconverted. Each unconverted row is counted
    once however many lists show it.
    """

    def __init__(self):
        self.meta = FxMeta()
        self.currencies: set = set()
        self._unconverted: set = set()

    def row(self, key, row: dict) -> dict:
        """Record one full row (``key`` identifies it) and return its labels."""
        if row["currency"]:
            self.currencies.add(row["currency"])
        if row["amount"] is None:
            if key not in self._unconverted:
                self._unconverted.add(key)
                self.meta.add_unconverted()
        elif row["estimate"] is not None:
            for rate in estimate_rates(row["estimate"]):
                self.meta.add(rate)
        return row_labels(row)

    def as_dict(self) -> dict:
        meta = self.meta.as_dict()
        return {
            "rates": [{**r, "rate": float(r["rate"]), "as_of": r["as_of"].isoformat()}
                      for r in meta["rates"]],
            "unconverted_count": meta["unconverted_count"],
        }


def estimate_rates(estimate: dict) -> list:
    """Every rate an estimate used: its ``rates`` (a statement over several
    lines, ``statements.statement_estimate``), else its one ``rate``."""
    rates = estimate.get("rates")
    return list(rates) if rates else [estimate["rate"]]


def row_labels(row: dict) -> dict:
    """The B5 labels of a full row: none when it needed no conversion.

    Over several rates (a statement whose lines span currencies) there is no
    single ``rate``: it is left out, ``rate_stale`` is true when any rate is
    stale and ``rate_as_of`` is the earliest.
    """
    estimate = row["estimate"]
    if estimate is None:
        return {}

    def num(x):
        return round(float(x), 2) if x is not None else None

    # No single original figure (a statement over lines in several currencies):
    # the keys are left out, never sent as null.
    original = ({"original_amount": num(estimate["original_amount"]),
                 "original_currency": estimate["original_currency"]}
                if estimate.get("original_currency") is not None else {})
    if row["amount"] is None:
        return {"unconverted": True, **original}
    rates = estimate_rates(estimate)
    single = {"rate": float(estimate["rate"].rate)} if "rate" in estimate else {}
    return {
        "estimated": True,
        **original,
        **single,
        "rate_as_of": min(r.as_of for r in rates).isoformat(),
        "rate_stale": any(r.stale for r in rates),
    }


def _row_key(e: dict, currency) -> tuple:
    day = e["date"]
    day = _naive(day).date() if isinstance(day, datetime) else day
    return (e["source"], e.get("source_id"), day, e["name"], currency)


def collect_unconverted(collector: FxCollector, events: List[dict]) -> None:
    """Count the full events with no stored rate: they move no cash, so no
    per-currency run shows them, but the response still reports them."""
    for e in events:
        if e.get("view") == LIMITED:
            continue
        for row in e.get("rows") or ():
            if row["amount"] is None:
                collector.row(_row_key(e, row["currency"]), row)


def response_currencies(p_currencies: set, collector: FxCollector, default: str) -> List[str]:
    """``currencies``: viewable active accounts' plus full rows', no placeholder."""
    return ordered_currencies(p_currencies | collector.currencies, default, keep_default=False)


def timeline_by_currency(db: Session, user_id: int, days: int = 60,
                         reference: Optional[datetime] = None, tag_id: Optional[int] = None,
                         fx: Optional[FxRates] = None) -> dict:
    """``/forecast/timeline``: the default currency's timeline as the scalars,
    plus ``by_currency`` (one row per currency), ``currencies`` and ``fx``."""
    start, end = _timeline_window(days, reference)
    p = Projection(db, user_id, start, end, tag_id=tag_id, fx=fx)
    collector = FxCollector()
    rows = []
    # Limited public ids are opaque and per response: numbered once across
    # every row, so distinct rows never share one. The default row comes
    # first, so a single-currency response keeps ``e1``, ``e2``, ... and the
    # scalars (the default row) reuse its ids.
    numbered = 0
    for currency in p.run_currencies():
        result = _timeline(p, currency, start, end, rows=True)
        row = serialize_currency_timeline(result, currency, collector, first_id=numbered + 1)
        numbered += len(result["events"])
        rows.append(row)
    collect_unconverted(collector, p.events)
    default = {k: v for k, v in rows[0].items() if k != "currency"}
    return {
        "window_start": start.date().isoformat(),
        "window_end": end.date().isoformat(),
        **default,
        "by_currency": rows,
        "currencies": response_currencies(p.account_currencies(), collector, p.default),
        "fx": collector.as_dict(),
    }


def serialize_currency_timeline(result: dict, currency: str, collector: FxCollector,
                                first_id: int = 1) -> dict:
    """One ``by_currency`` timeline row: ``serialize_timeline`` with ``currency``
    on every full listed row and the labels on estimated events. Its events
    are numbered from ``first_id`` (``timeline_by_currency``)."""
    body = serialize_timeline(result, first_id=first_id)
    tag = {"currency": currency}
    events = []
    for e, out in zip(result["events"], body["events"]):
        if e.get("view") != LIMITED:
            row = e.get("row") or _row(currency, abs(e["amount"]))
            out = {**out, **tag, **collector.row(_row_key(e, currency), row)}
        events.append(out)
    return {
        "currency": currency,
        "opening_balance": body["opening_balance"],
        "lowest_balance": body["lowest_balance"],
        "trough_date": body["trough_date"],
        "closing_balance": body["closing_balance"],
        "shortfall": body["shortfall"],
        "shortfalls": [{**s, **tag} for s in body["shortfalls"]],
        "account_shortfalls": [{**s, **tag} for s in body["account_shortfalls"]],
        "by_account": [{**a, **tag} for a in body["by_account"]],
        "unassigned_closing": body["unassigned_closing"],
        "overflow_moves": [{**m, **tag} for m in body["overflow_moves"]],
        "events": events,
    }


def cashflow_by_currency(db: Session, user_id: int, months: int = 6,
                         reference: Optional[datetime] = None, tag_id: Optional[int] = None,
                         fx: Optional[FxRates] = None,
                         collector: Optional[FxCollector] = None) -> dict:
    """``/forecast/cashflow``: each period's default-currency scalars plus
    ``by_currency`` rows; ``currencies`` and ``fx`` for the response.

    A row's ``net`` is ``income - expenses - unposted_expenses -
    statement_payables + moved_in - moved_out + loan_payables`` (plan C3).
    """
    boundaries = _month_boundaries(months, reference)
    p = Projection(db, user_id, boundaries[0], boundaries[-1], tag_id=tag_id, fx=fx)
    collector = collector or FxCollector()
    per_currency = {c: _cashflow_periods(p, c, boundaries, rows=True)
                    for c in p.run_currencies()}
    # Full rows in the window (their pairs and currencies), as the timeline shows them.
    for c in per_currency:
        for e in p.run(c)[1]:
            if e.get("view") != LIMITED:
                collector.row(_row_key(e, c), e["row"])
    collect_unconverted(collector, p.events)
    periods = []
    for i in range(months):
        rows = [{"currency": c, **{k: v for k, v in periods_c[i].items()
                                   if k not in ("period_label", "period_start", "period_end")}}
                for c, periods_c in per_currency.items()]
        default = per_currency[p.default][i]
        periods.append({**{k: default[k] for k in LEGACY_PERIOD_KEYS}, "by_currency": rows})
    return {"periods": periods,
            "currencies": response_currencies(p.account_currencies(), collector, p.default),
            "fx": collector.as_dict()}


def upcoming_by_currency(db: Session, user_id: int, days: int = 30,
                         reference: Optional[datetime] = None, tag_id: Optional[int] = None,
                         fx: Optional[FxRates] = None,
                         collector: Optional[FxCollector] = None,
                         ids: Optional["PublicIds"] = None) -> dict:
    """``/forecast/upcoming``: every item with its ``currency`` (a full one), plus
    ``currencies`` and ``fx``. No ``by_currency``: the list has no totals.
    ``ids`` numbers its limited items (``PublicIds``; a new one by default)."""
    start, end = _upcoming_window(days, reference)
    accounts = get_account_balances(db, user_id)
    events = collect_events(db, start, end, user_id=user_id, accounts=accounts,
                            tag_id=tag_id, fx=fx, detail=True, keep_origin=True)
    collector = collector or FxCollector()
    items = currency_upcoming_items(events, collector, ids)
    default = default_currency(db, user_id)
    return {"items": items,
            "currencies": response_currencies({_code(a.currency) for a in accounts},
                                              collector, default),
            "fx": collector.as_dict()}


def _limited_rows(e: dict) -> List[dict]:
    """A limited event per currency it moves cash in (plan C4); one with no
    cash (or unconverted) keeps ``cash_delta`` 0."""
    cash = e.get("cash_by_currency") or {}
    if len(cash) == 1:
        ((currency, amount),) = cash.items()
        return [{**e, "amount": amount, "cash_currency": currency}]
    if not cash:
        return [e]
    return [{**e, "amount": amount, "cash_currency": currency}
            for currency, amount in sorted(cash.items())]


class PublicIds:
    """Limited public ids, numbered once per response across all its lists.

    ``e1``, ``e2``, ... in the order occurrences are first numbered; the same
    occurrence (its source record, date and cash currency) keeps its id in
    every list of the response, and distinct occurrences never share one. A
    response with one list gets one fresh allocator, so it numbers from ``e1``.
    """

    def __init__(self):
        self._count = 0
        self._ids: Dict[tuple, List[str]] = {}

    def assign(self, events: List[dict]) -> List[str]:
        """One id per event of one list, in order."""
        seen: Dict[tuple, int] = {}
        out = []
        for e in events:
            key = _occurrence_key(e)
            n = seen.get(key, 0)
            seen[key] = n + 1
            ids = self._ids.setdefault(key, [])
            if n == len(ids):  # a further occurrence with this key
                self._count += 1
                ids.append(f"e{self._count}")
            out.append(ids[n])
        return out


def _occurrence_key(e: dict) -> tuple:
    """What identifies a limited occurrence across a response's lists: its
    source record (``origin``, internal only; the public fields when absent),
    its date and the currency row it sits in."""
    origin = e.get("origin")
    if origin is not None:
        origin = (origin[0].__name__, origin[1])
    else:
        origin = (e["source"], e["name"], e.get("kind"))
    return (origin, _naive(e["date"]).date(), e.get("cash_currency"))


def currency_upcoming_items(events: List[dict], collector: Optional[FxCollector] = None,
                            ids: Optional[PublicIds] = None) -> List[dict]:
    """``collect_events(detail=True)`` events as upcoming items, one per currency.

    A full event becomes one item per listing row (a cross-currency transfer:
    one in each currency), each with ``currency``, its ``amount`` in that
    currency (None when unconverted) and the B5 labels. A limited event keeps
    the public shape (``limited_event``), split per currency it moves cash in,
    and its public ids are assigned after the split.
    """
    collector = collector or FxCollector()
    items = []
    for e in events:
        if e.get("view") == LIMITED:
            continue
        for row in e["rows"]:
            amount = row["amount"]
            items.append({
                "name": e["name"],
                "amount": round(float(amount), 2) if amount is not None else None,
                "due_date": _naive(e["date"]).date().isoformat(),
                "entry_type": e["type"],
                "source": e["source"],
                "source_id": e["source_id"],
                **({"household_occurrence": True} if e.get("household_occurrence") else {}),
                "currency": row["currency"],
                **collector.row(_row_key(e, row["currency"]), row),
            })
    limited = sorted((r for e in events if e.get("view") == LIMITED for r in _limited_rows(e)),
                     key=_event_sort_key)
    items += [limited_event(e, public_id)
              for e, public_id in zip(limited, (ids or PublicIds()).assign(limited))]
    items.sort(key=lambda x: x.get("due_date") or x["date"])
    return items


def payables_by_currency(db: Session, user_id: int, days: int = 30,
                         reference: Optional[datetime] = None, tag_id: Optional[int] = None,
                         fx: Optional[FxRates] = None,
                         collector: Optional[FxCollector] = None,
                         ids: Optional[PublicIds] = None) -> List[dict]:
    """``get_payables`` split by currency (plan C4): each event's sign filter and
    amount read its cash in each currency, never the raw ``amount``. A full
    payable carries ``currency`` and the B5 labels; an unconverted one moves no
    cash, so it is not a payable. ``ids`` numbers its limited payables
    (``PublicIds``, shared across a response's lists; a new one by default)."""
    start, end = _upcoming_window(days, reference)
    accounts = get_account_balances(db, user_id)
    names = {a.id: a.name for a in accounts}
    events = collect_events(db, start, end, user_id=user_id, accounts=accounts, tag_id=tag_id,
                            fx=fx, detail=True, keep_origin=True)
    collector = collector or FxCollector()
    payables = []
    limited = []  # (position in payables, event): numbered together below
    split = []
    for e in events:
        if not e["counts_as_cash"]:
            continue
        for currency, amount in e["cash_by_currency"].items():
            legs = [leg for leg, c in zip(e["legs"], e["leg_currencies"]) if c == currency]
            split.append({**e, "amount": amount, "legs": legs, "cash_currency": currency})
    for e in sorted(split, key=_event_sort_key):
        if e["amount"] >= 0:
            continue
        if (e["type"] == TransactionType.TRANSFER.value and not e.get("card_payment")
                and not e.get("top_up") and not e.get("loan_payment")):
            continue
        if e.get("view") == LIMITED:
            limited.append((len(payables), e))
            payables.append(None)
            continue
        currency = e["cash_currency"]
        primary = e["legs"][0] if e["legs"] else {}
        acc = primary.get("account_id")
        ov = primary.get("overflow_account_id")
        row = next((r for r in e["rows"] if r["currency"] == currency),
                   _row(currency, -e["amount"]))
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
            "currency": currency,
            **collector.row(_row_key(e, currency), row),
        })
    public_ids = (ids or PublicIds()).assign([e for _, e in limited])
    for (position, e), public_id in zip(limited, public_ids):
        payables[position] = limited_event(e, public_id)
    return payables


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


def serialize_timeline(result: dict, first_id: int = 1) -> dict:
    """Convert a build_timeline/project_running_balance result to JSON-friendly types.

    A limited event's ``public_id`` is ``e`` plus its position among the
    events, counted from ``first_id``.
    """
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
        "events": [_timeline_event(e, i)
                   for i, e in enumerate(result["events"], start=first_id)],
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

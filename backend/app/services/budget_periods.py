"""A budget envelope's windows, carry-over and counted rows (STU-795).

Every read of a budget's figures comes from here: the allocation list, detail and
progress, ``GET /allocations/{id}/periods`` and ``GET /allocations/{id}/transactions``.
So after a roll with no writes, the card, the history and the drill-down agree.

**What counts** (one predicate everywhere, ``counts`` / ``membership_criterion`` and
the set-based form in ``_spent``): the envelope owner's own posted debit and credit
rows, in one of ``configuration.category_ids`` and, when
``configuration.account_ids`` is set, on one of those accounts. A row linked by
``allocation_id`` counts whatever its category or account. Membership is the
envelope's current one for every window; boundaries and limits are historical.

**Windows**: the current window (``period_start`` .. ``period_end`` on the
allocation), then the stored closed windows (``budget_periods``) newest first, then,
when fewer than 11 are stored, windows generated back from the oldest known start by
the current cadence: each is [``_start_of_period(next_start - 1 day)``, ``next_start``),
``estimated``, with the current limit and no carry. At most ``HISTORY`` are shown.

**Closing windows** (``roll``): a roll stores every window it passes in one set-based
``INSERT ... SELECT`` (on conflict do nothing) and advances the current window, in
the caller's transaction. Writes call it holding the owner's budget lock and the
allocation's row lock; reads call ``roll_for_read``, which takes both, re-reads the
allocation, rolls and commits before anything is serialized.

**Spent** per window: one statement for every envelope read (``_spent``). It reads
the owners' posted rows once over [earliest window start, latest window end), buckets
each into its windows in SQL and groups by window and currency. Each currency
subtotal is converted once to the envelope's currency (``fx.convert``, rounded to
cents) at the request's rates; one with no rate is left out and named in ``missing``.
Spent is debits less credits, floored at 0. A window starting beyond the horizon
(now + 14 h) counts nothing.

**Carry**: only within a chain, the stored windows sharing a ``carry_from`` and then
the current window when its ``carry_over_from`` is that value. A chain opens at 0 and
is computed over all of it, rows older than the ones shown included.
``available = limit + carry_in``, ``remaining = available - spent`` (both may be
negative) and the next window's ``carry_in`` is this one's ``remaining``. A window
missing a rate is not ``complete``; every later window of its chain is
``provisional`` and names the upstream currencies in ``inherited_missing``.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import and_, bindparam, false, or_, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session
from sqlalchemy.types import Boolean, DateTime, Integer

from app.core import locking
from app.models.account import Account
from app.models.allocation import Allocation, AllocationType, BudgetPeriodFrequency
from app.models.budget_period import BudgetPeriod
from app.models.transaction import Transaction, TransactionType
from app.models.user import CurrencyType
from app.services.fx import FxRates, convert

ZERO = Decimal("0")
# Windows shown: the current one and up to 11 before it.
HISTORY = 12
COUNTED_TYPES = (TransactionType.DEBIT, TransactionType.CREDIT)


# --- the clock and the period helpers ---------------------------------------------------------
# The period helpers live with the transaction writes (``routers/transactions.py``), which
# roll budgets as rows land; read through that module so one clock (its ``naive_utc_now``)
# decides every roll and every horizon.

def _tx():
    from app.routers import transactions

    return transactions


def now() -> datetime:
    """Naive UTC now, the clock the transaction writes roll by."""
    return _tx().naive_utc_now()


def horizon(at: Optional[datetime] = None) -> datetime:
    """The latest moment a window may start and still count (UTC+14's today)."""
    tx = _tx()
    return (at or tx.naive_utc_now()) + tx._MAX_UTC_OFFSET


def naive_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def current_window(allocation: Allocation) -> Tuple[datetime, datetime]:
    """The allocation's current window as stored (its end derived when missing)."""
    tx = _tx()
    frequency = allocation.period_frequency or BudgetPeriodFrequency.MONTHLY
    start = naive_utc(allocation.period_start)
    if start is None:
        start = tx._start_of_period(now(), frequency)
    end = naive_utc(allocation.period_end) or tx._compute_period_end(start, frequency)
    return start, end


# --- membership -------------------------------------------------------------------------------

def _int_ids(value) -> List[int]:
    ids: List[int] = []
    for v in value if isinstance(value, list) else []:
        try:
            ids.append(int(v))
        except (TypeError, ValueError):
            continue
    return list(dict.fromkeys(ids))


def category_ids(allocation: Allocation) -> Set[int]:
    """The category ids a budget's configuration names, ignoring any that aren't ids."""
    return set(_int_ids((allocation.configuration or {}).get("category_ids")))


def account_ids(allocation: Allocation) -> List[int]:
    """The accounts a budget is limited to; empty means every account."""
    return _int_ids((allocation.configuration or {}).get("account_ids"))


def budget_limit(allocation: Allocation) -> Optional[Decimal]:
    """A budget's limit: ``target_amount``, else ``monthly_target``; None without either."""
    for value in (allocation.target_amount, allocation.monthly_target):
        if value is not None:
            return Decimal(str(value))
    return None


def counts(allocation: Allocation, *, allocation_id: Optional[int],
           category_id: Optional[int], account_id: Optional[int]) -> bool:
    """Whether a posted debit or credit of the owner's with these references counts."""
    if allocation_id is not None and allocation_id == allocation.id:
        return True
    if category_id is None or category_id not in category_ids(allocation):
        return False
    accounts = account_ids(allocation)
    return not accounts or account_id in accounts


def membership_criterion(allocation: Allocation):
    """``counts`` as a criterion on ``Transaction`` (the owner's rows only)."""
    matches = [Transaction.allocation_id == allocation.id]
    categories = category_ids(allocation)
    if categories:
        by_category = Transaction.category_id.in_(categories)
        accounts = account_ids(allocation)
        if accounts:
            by_category = and_(by_category, Transaction.account_id.in_(accounts))
        matches.append(by_category)
    return and_(Transaction.user_id == allocation.user_id, or_(*matches))


def counted_criterion(allocation: Allocation, start: datetime, end: datetime):
    """The rows a window ``[start, end)`` of the budget counts: posted debits and
    credits that are members. A window starting beyond the horizon counts nothing."""
    if start > horizon():
        return false()
    return and_(membership_criterion(allocation),
                Transaction.is_posted.is_(True),
                Transaction.transaction_type.in_(COUNTED_TYPES),
                Transaction.transaction_date >= start,
                Transaction.transaction_date < end)


# --- closing windows --------------------------------------------------------------------------

_STORE = text(
    'INSERT INTO budget_periods (allocation_id, start, "end", "limit", currency, carry_from) '
    'SELECT CAST(:allocation_id AS integer), w.start, w.finish, CAST(:limit AS numeric), '
    'CAST(:currency AS currencytype), CAST(:carry_from AS timestamp) '
    'FROM unnest(CAST(:starts AS timestamp[]), CAST(:ends AS timestamp[])) AS w(start, finish) '
    "ON CONFLICT (allocation_id, start) DO NOTHING"
).bindparams(bindparam("starts", type_=ARRAY(DateTime)),
             bindparam("ends", type_=ARRAY(DateTime)))


def store(db: Session, allocation: Allocation, windows: Sequence[Tuple[datetime, datetime]]) -> None:
    """Store closed windows under the allocation's settings now, in one statement."""
    if not windows:
        return
    currency = allocation.currency or CurrencyType.PHP
    db.execute(_STORE, {
        "allocation_id": allocation.id,
        "starts": [naive_utc(s) for s, _ in windows],
        "ends": [naive_utc(e) for _, e in windows],
        "limit": budget_limit(allocation),
        "currency": getattr(currency, "value", currency),
        "carry_from": naive_utc(allocation.carry_over_from),
    })


def roll(db: Session, allocation: Allocation,
         references: Iterable[Optional[datetime]] = (None,), *, keep: bool = True) -> bool:
    """Close every elapsed window of a budget and advance its current window.

    ``references`` are the dates a write touches (None is now); a row dated in a
    later window, no later than the horizon, advances early (``_ensure_budget_period``).
    Every window passed is stored under the allocation's settings at the roll, in one
    statement, unless ``keep`` is false (a type change into budget, whose earlier
    windows were never a budget's). The caller holds the owner's budget lock and the
    allocation's row lock, read fresh; nothing is committed. Returns whether the
    window moved.
    """
    tx = _tx()
    closed: List[tuple] = []
    before = (allocation.period_start, allocation.period_end)
    for reference in references:
        tx._ensure_budget_period(allocation, reference, closed)
    if keep and allocation.allocation_type == AllocationType.BUDGET:
        store(db, allocation, closed)
    return bool(closed) or before != (allocation.period_start, allocation.period_end)


def needs_roll(allocation: Allocation, at: Optional[datetime] = None) -> bool:
    """Whether a budget's stored window has elapsed (or was never set)."""
    if allocation.allocation_type != AllocationType.BUDGET:
        return False
    if allocation.period_start is None:
        return True
    return current_window(allocation)[1] <= (at or now())


def roll_for_read(db: Session, allocations: Iterable[Allocation]) -> None:
    """Before a read serializes: roll every elapsed budget among ``allocations``.

    In a short transaction of its own: the owner's budget lock, then the budgets
    locked and re-read, so a roll never writes over an edit committed meanwhile;
    each still elapsed is rolled (its windows stored) and its total recomputed;
    then committed. Nothing is written when no budget has elapsed.
    """
    tx = _tx()
    stale = [a for a in allocations if needs_roll(a)]
    if not stale:
        return
    for owner_id in sorted({a.user_id for a in stale}):
        locking.lock_owner_budgets(db, owner_id)
    for allocation in tx._lock_allocations(db, stale):
        if needs_roll(allocation):
            tx._recompute_budget_total(db, allocation, [None])
    db.commit()


def newest_stored_end(db: Session, allocation_id: int) -> Optional[datetime]:
    from sqlalchemy import func

    return db.query(func.max(BudgetPeriod.end)).filter(
        BudgetPeriod.allocation_id == allocation_id).scalar()


def has_stored(db: Session, allocation_id: int) -> bool:
    return db.query(BudgetPeriod.id).filter(
        BudgetPeriod.allocation_id == allocation_id).first() is not None


# --- the read-time snapshot -------------------------------------------------------------------

@dataclass(eq=False)
class Window:
    start: datetime
    end: datetime
    limit: Optional[Decimal]
    carry_from: Optional[datetime] = None
    estimated: bool = False
    is_current: bool = False
    before_created: bool = False
    subtotals: Dict[str, Decimal] = field(default_factory=dict)
    spent: Decimal = ZERO
    missing: List[str] = field(default_factory=list)
    carry_in: Decimal = ZERO
    available: Optional[Decimal] = None
    remaining: Optional[Decimal] = None
    provisional: bool = False
    inherited_missing: List[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.missing

    def as_dict(self) -> dict:
        """The ``GET /allocations/{id}/periods`` body; times as aware UTC."""
        return {
            "start": self.start.replace(tzinfo=timezone.utc),
            "end": self.end.replace(tzinfo=timezone.utc),
            "limit": self.limit, "carry_in": self.carry_in, "available": self.available,
            "spent": self.spent, "remaining": self.remaining, "complete": self.complete,
            "missing": list(self.missing), "provisional": self.provisional,
            "inherited_missing": list(self.inherited_missing), "estimated": self.estimated,
            "before_created": self.before_created, "is_current": self.is_current,
        }

    def current_fields(self) -> dict:
        """The current window's fields on an allocation response."""
        return {"current_amount": self.spent, "carry_in": self.carry_in,
                "available": self.available, "complete": self.complete,
                "missing": list(self.missing), "provisional": self.provisional,
                "inherited_missing": list(self.inherited_missing)}


@dataclass
class Snapshot:
    allocation: Allocation
    # The windows shown, newest (the current one) first.
    windows: List[Window]

    @property
    def current(self) -> Window:
        return self.windows[0]

    def window_at(self, start: datetime) -> Optional[Window]:
        return next((w for w in self.windows if w.start == start), None)


def _stored(db: Session, ids: List[int]) -> Dict[int, List[BudgetPeriod]]:
    rows: Dict[int, List[BudgetPeriod]] = {}
    for row in (db.query(BudgetPeriod).filter(BudgetPeriod.allocation_id.in_(ids))
                .order_by(BudgetPeriod.allocation_id, BudgetPeriod.start)):
        rows.setdefault(row.allocation_id, []).append(row)
    return rows


def _plan(allocation: Allocation, stored: List[BudgetPeriod]) -> Tuple[List[Window], List[List[Window]]]:
    """The windows shown (newest first) and the carry chains, oldest window first."""
    tx = _tx()
    frequency = allocation.period_frequency or BudgetPeriodFrequency.MONTHLY
    limit = budget_limit(allocation)
    start, end = current_window(allocation)
    current = Window(start, end, limit, carry_from=naive_utc(allocation.carry_over_from),
                     is_current=True)
    closed = [Window(naive_utc(r.start), naive_utc(r.end),
                     Decimal(r.limit) if r.limit is not None else None,
                     carry_from=naive_utc(r.carry_from))
              for r in stored if naive_utc(r.start) < start]
    shown = [current, *reversed(closed[-(HISTORY - 1):])]
    next_start = closed[0].start if closed else start
    while len(shown) < HISTORY:
        begin = tx._start_of_period(next_start - timedelta(days=1), frequency)
        shown.append(Window(begin, next_start, limit, estimated=True))
        next_start = begin

    chains: Dict[datetime, List[Window]] = {}
    for window in closed:
        if window.carry_from is not None:
            chains.setdefault(window.carry_from, []).append(window)
    if current.carry_from is not None:
        chains.setdefault(current.carry_from, []).append(current)
    shown_ids = {id(w) for w in shown}
    wanted = [chain for chain in chains.values() if any(id(w) in shown_ids for w in chain)]
    created = naive_utc(allocation.created_at)
    for window in shown:
        window.before_created = created is not None and window.end <= created
    return shown, wanted


def _carry(window: Window, carry_in: Decimal, inherited: Set[str]) -> None:
    window.carry_in = carry_in
    window.inherited_missing = sorted(inherited)
    window.provisional = bool(inherited)
    window.available = window.limit + carry_in
    window.remaining = window.available - window.spent


def snapshots(db: Session, allocations: Iterable[Allocation],
              fx: FxRates) -> Dict[int, Snapshot]:
    """``{allocation id: snapshot}`` for the budgets among ``allocations``.

    Two statements whatever the number of budgets: their stored windows, and the
    spent statement (``_spent``). Call ``roll_for_read`` first on a read.
    """
    budgets = [a for a in allocations if a.allocation_type == AllocationType.BUDGET]
    if not budgets:
        return {}
    stored = _stored(db, [b.id for b in budgets])
    plans: Dict[int, Tuple[List[Window], List[List[Window]]]] = {}
    for budget in budgets:
        plans[budget.id] = _plan(budget, stored.get(budget.id, []))

    measured: Dict[int, List[Window]] = {}
    for budget in budgets:
        shown, chains = plans[budget.id]
        seen: Set[int] = set()
        windows: List[Window] = []
        for window in [*shown, *(w for chain in chains for w in chain)]:
            if id(window) not in seen:
                seen.add(id(window))
                windows.append(window)
        measured[budget.id] = windows
    _spent(db, budgets, measured, fx)

    result: Dict[int, Snapshot] = {}
    for budget in budgets:
        shown, chains = plans[budget.id]
        in_chain: Set[int] = set()
        for chain in chains:
            carry, inherited = ZERO, set()
            for window in chain:
                in_chain.add(id(window))
                if window.limit is None:
                    # Not a carry-bearing window (no limit): the chain starts again after it.
                    carry, inherited = ZERO, set()
                    continue
                _carry(window, carry, inherited)
                carry = window.remaining
                inherited |= set(window.missing)
        for window in shown:
            if id(window) in in_chain and window.limit is not None:
                continue
            window.carry_in, window.provisional, window.inherited_missing = ZERO, False, []
            if window.limit is not None:
                window.available = window.limit
                window.remaining = window.limit - window.spent
        result[budget.id] = Snapshot(budget, shown)
    return result


def _code(currency) -> str:
    return getattr(currency, "value", currency) or CurrencyType.PHP.value


_SPENT = text("""
WITH rows AS MATERIALIZED (
    SELECT t.user_id, t.allocation_id, t.category_id, t.account_id, t.transaction_date,
           CASE WHEN t.transaction_type = 'credit' THEN -t.amount ELSE t.amount END AS signed,
           COALESCE(t.currency, a.currency)::text AS currency
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.user_id = ANY(CAST(:owners AS integer[]))
      AND t.is_posted IS TRUE
      AND t.transaction_type IN ('debit', 'credit')
      AND t.transaction_date >= CAST(:low AS timestamp)
      AND t.transaction_date < CAST(:high AS timestamp)
),
envelopes AS (
    SELECT * FROM unnest(CAST(:env_ids AS integer[]), CAST(:env_owners AS integer[]),
                         CAST(:env_all_accounts AS boolean[]))
        AS e(id, owner_id, all_accounts)
),
categories AS (
    SELECT * FROM unnest(CAST(:cat_env AS integer[]), CAST(:cat_ids AS integer[])) AS c(env_id, category_id)
),
accounts AS (
    SELECT * FROM unnest(CAST(:acct_env AS integer[]), CAST(:acct_ids AS integer[])) AS c(env_id, account_id)
),
windows AS (
    SELECT * FROM unnest(CAST(:win_env AS integer[]), CAST(:win_idx AS integer[]),
                         CAST(:win_start AS timestamp[]), CAST(:win_end AS timestamp[]))
        AS w(env_id, idx, start, finish)
),
counted AS (
    SELECT e.id AS env_id, r.transaction_date, r.signed, r.currency
    FROM envelopes e
    JOIN rows r ON r.user_id = e.owner_id
    WHERE r.allocation_id = e.id
       OR (EXISTS (SELECT 1 FROM categories c
                   WHERE c.env_id = e.id AND c.category_id = r.category_id)
           AND (e.all_accounts
                OR EXISTS (SELECT 1 FROM accounts c
                           WHERE c.env_id = e.id AND c.account_id = r.account_id)))
)
SELECT w.env_id, w.idx, k.currency, SUM(k.signed)
FROM windows w
JOIN counted k ON k.env_id = w.env_id
             AND k.transaction_date >= w.start AND k.transaction_date < w.finish
GROUP BY w.env_id, w.idx, k.currency
""").bindparams(
    bindparam("owners", type_=ARRAY(Integer)),
    bindparam("env_ids", type_=ARRAY(Integer)),
    bindparam("env_owners", type_=ARRAY(Integer)),
    bindparam("env_all_accounts", type_=ARRAY(Boolean)),
    bindparam("cat_env", type_=ARRAY(Integer)),
    bindparam("cat_ids", type_=ARRAY(Integer)),
    bindparam("acct_env", type_=ARRAY(Integer)),
    bindparam("acct_ids", type_=ARRAY(Integer)),
    bindparam("win_env", type_=ARRAY(Integer)),
    bindparam("win_idx", type_=ARRAY(Integer)),
    bindparam("win_start", type_=ARRAY(DateTime)),
    bindparam("win_end", type_=ARRAY(DateTime)),
)


def _spent(db: Session, budgets: List[Allocation], measured: Dict[int, List[Window]],
           fx: FxRates) -> None:
    """Fill each window's subtotals, spent and missing currencies, in one statement."""
    limit = horizon()
    params = {k: [] for k in ("env_ids", "env_owners", "env_all_accounts", "cat_env",
                              "cat_ids", "acct_env", "acct_ids", "win_env", "win_idx",
                              "win_start", "win_end")}
    by_key: Dict[Tuple[int, int], Window] = {}
    for budget in budgets:
        params["env_ids"].append(budget.id)
        params["env_owners"].append(budget.user_id)
        accounts = account_ids(budget)
        params["env_all_accounts"].append(not accounts)
        for category_id in sorted(category_ids(budget)):
            params["cat_env"].append(budget.id)
            params["cat_ids"].append(category_id)
        for account_id in accounts:
            params["acct_env"].append(budget.id)
            params["acct_ids"].append(account_id)
        for idx, window in enumerate(measured[budget.id]):
            if window.start > limit:
                continue  # a window that has not started counts nothing
            by_key[(budget.id, idx)] = window
            params["win_env"].append(budget.id)
            params["win_idx"].append(idx)
            params["win_start"].append(window.start)
            params["win_end"].append(window.end)
    if by_key:
        rows = db.execute(_SPENT, {
            **params,
            "owners": sorted({b.user_id for b in budgets}),
            "low": min(params["win_start"]),
            "high": max(params["win_end"]),
        }).all()
        for env_id, idx, currency, total in rows:
            window = by_key[(env_id, idx)]
            window.subtotals[currency] = window.subtotals.get(currency, ZERO) + Decimal(total)
    quotes = {b.id: _code(b.currency) for b in budgets}
    for budget in budgets:
        for window in measured[budget.id]:
            converted, missing = ZERO, []
            for currency, amount in sorted(window.subtotals.items()):
                rate = fx.rate(currency, quotes[budget.id])
                if rate is None:
                    missing.append(currency)
                    continue
                converted += convert(amount, rate.rate)
            window.spent = max(ZERO, converted)
            window.missing = missing


# --- the drill-down ---------------------------------------------------------------------------

def counted_rows(db: Session, allocation: Allocation, window: Window):
    """The query for the rows a window counts, newest first (date, then id)."""
    return (db.query(Transaction)
            .filter(counted_criterion(allocation, window.start, window.end))
            .order_by(Transaction.transaction_date.desc(), Transaction.id.desc()))


def row_currency(db: Session, txn: Transaction) -> str:
    """A row's currency: its own, else its account's (as the spent statement reads it)."""
    if txn.currency is not None:
        return _code(txn.currency)
    account = db.get(Account, txn.account_id)
    return _code(account.currency if account else None)

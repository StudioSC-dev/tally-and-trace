"""Monthly free flow per currency, from posted transactions and savings goals (STU-788).

The rules are section 2 of ``.claude/plans/wishlist-net-flow-plan.md``; this
module follows its wording and numbering.

Scope (2.1). Only the caller's own accounts (``OWNER_ROLES``) and the posted
rows on them count, whoever posted them. An account that is not an own account
is *outside*: only its id is ever compared, to tell that it is outside; its
type, currency, balance and flags are never read. On a row someone else
posted, only the account ids, type, amount, stored currency, fee and date are
read; its category is not (the grouped query keys a row's category only when
the row is the caller's own).

Classes. An own account is Savings (``SAVINGS``), Loan (``LOAN``) or Pool
(every other type; the spending-wallet flag is not used).

Window (2.3). Full Manila calendar months, from the month after the caller's
earliest row up to last month, the latest 12 at most. Each term is its total
over the window divided by ``sample_months``.

Single currency first (2.4). Nothing is converted. A caller whose money or
goals cross currencies is *cross-currency*: every row is then ``incomplete``
and no figure is used for a rate or a date.

Recurring entries, ``monthly_disposable`` and the period summary are not read.
"""
from calendar import monthrange
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import DateTime, Integer, case, column, func, null, or_, select, values
from sqlalchemy.orm import Session

from app.core.access import OWNER_ROLES
from app.core.time import MANILA_OFFSET, manila_day
from app.models.account import Account, AccountType
from app.models.allocation import Allocation, AllocationType
from app.models.transaction import Transaction, TransactionType
from app.schemas.allocation import TRANSACTION_TOTAL, goal_mode
from app.services.allocation_rank import RANKED_TYPES
from app.services.savings_progress import _account_ids, _code, _savings_category_id, since

ZERO = Decimal("0")
CENT = Decimal("0.01")

# Account classes (2.1).
SAVINGS, LOAN, POOL, OUTSIDE_CLASS = "savings", "loan", "pool", "outside"
# The one key every outside counter-account collapses into (2.3). Ids start at 1.
OUTSIDE = 0

# Row statuses (2.4), in precedence order.
NOT_ESTIMATED, INCOMPLETE, NO_PROJECTION, OK = "not_estimated", "incomplete", "no_projection", "ok"

INCOMPLETE_NOTE = ("Money in more than one currency is involved, "
                   "so this cannot be estimated yet")

# The known limitations of 2.4, for the UI's "based on your last N full months"
# note. The relabelled-account cases are stated here because no rule detects them.
LIMITATIONS = (
    "Single currency first: if you moved money between your own accounts in different "
    "currencies in these months, changed an account's currency, or have a goal that spans "
    "currencies, there is no estimate. " + INCOMPLETE_NOTE + ".",
    "An account's currency can be relabelled by hand. A transfer edited after such a change "
    "is re-stamped with the new currency, and an account with a balance but no rows in these "
    "months leaves no trace, so neither is detected; the balance is read as the account now "
    "states it.",
    "A shortfall in one currency removes free flow in the others, but free flow in one "
    "currency is never used to cover a shortfall in another.",
    "A goal's balance counts only on your own savings accounts. A goal that tracks a checking "
    "or wallet account is treated as holding nothing there, so it reserves its whole pace.",
    "It is what happened, not what is scheduled. A new bill, a new loan, a raise or a lost "
    "income shows only once it has posted, and takes up to 12 months to count in full.",
    "It is a plain average. A one-off windfall raises it and a one-off large purchase lowers "
    "it for up to 12 months.",
    "Money arriving from accounts you do not own, including a partner's shared account, is "
    "not income. Income and spending on accounts shared with you are not counted.",
    "Income paid straight into a savings account is not income here. Spending paid straight "
    "from one is spending.",
    "A savings account flagged as a spending wallet is still a savings account: topping it up "
    "counts as saving and spending from it counts as spending.",
    "A goal past its target date reserves everything it still needs, every month, until the "
    "goal is edited.",
    "Saving recorded as a debit in a savings category is counted as spending, and saving "
    "toward a goal-type goal is never matched to it, so both are reserved cautiously.",
)


# --- results ------------------------------------------------------------------------------

@dataclass
class FreeFlowRow:
    """One currency's figures (2.4). A figure the status leaves out is None."""
    currency: str
    status: str
    sample_months: int
    income: Optional[Decimal] = None
    spending: Optional[Decimal] = None
    debt_paid: Optional[Decimal] = None
    net_flow: Optional[Decimal] = None
    saved: Optional[Decimal] = None
    goal_top_up: Optional[Decimal] = None
    reserved: Optional[Decimal] = None
    free_flow: Optional[Decimal] = None
    shortfall: Optional[Decimal] = None


@dataclass
class FreeFlowGoal:
    """One goal that can reserve (2.5). Figures are None when the caller is not estimated."""
    allocation_id: int
    rank: Optional[int]
    currency: str
    pace: Optional[Decimal] = None
    fed: Optional[Decimal] = None
    top_up: Optional[Decimal] = None
    underfunded: Optional[Decimal] = None
    unreserved: bool = False
    overdue: bool = False


@dataclass
class FreeFlow:
    """The caller's free flow: ``status`` is the caller-wide one (``not_estimated``,
    ``incomplete``, or ``ok`` when each row has its own)."""
    status: str
    sample_months: int
    rows: List[FreeFlowRow]
    goals: List[FreeFlowGoal]
    limitations: Tuple[str, ...] = LIMITATIONS

    def row(self, currency: str) -> Optional[FreeFlowRow]:
        return next((r for r in self.rows if r.currency == currency), None)


# --- small helpers ------------------------------------------------------------------------

def _cents(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _cents_up(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_CEILING)


def _money(value) -> Decimal:
    return Decimal(str(value)) if value is not None else ZERO


def _month_index(day: date) -> int:
    return day.year * 12 + day.month - 1


def _month_of(index: int) -> date:
    year, month = divmod(index, 12)
    return date(year, month + 1, 1)


def _utc_of_manila(day: date) -> datetime:
    """Manila midnight of ``day`` as the naive UTC instant ``transaction_date`` stores."""
    return datetime.combine(day, time()) - MANILA_OFFSET


def window(earliest: Optional[date], today: date) -> Tuple[date, int]:
    """``(first month, sample_months)``: full Manila months from the month after
    ``earliest`` (the caller's earliest row's Manila day) to last month, the
    latest 12 at most. No row, or a first row this month or last, gives 0."""
    current = _month_index(today)
    if earliest is None:
        return _month_of(current), 0
    first = max(_month_index(earliest) + 1, current - 12)
    return _month_of(first), max(current - first, 0)


def months_left(target: date, today: date) -> int:
    """Full Manila calendar months that start after this month and end on or
    before ``target``, at least 1. The target month counts only when ``target``
    is its last day."""
    span = _month_index(target) - _month_index(today)
    last_day = monthrange(target.year, target.month)[1]
    return max(span - 1 + (1 if target.day == last_day else 0), 1)


def account_class(account_type) -> str:
    if account_type == AccountType.SAVINGS:
        return SAVINGS
    if account_type == AccountType.LOAN:
        return LOAN
    return POOL


@dataclass
class _Own:
    id: int
    cls: str
    currency: str
    balance: Decimal


@dataclass
class _Terms:
    """A currency's window totals (the row table's terms)."""
    income: Decimal = ZERO
    spending: Decimal = ZERO
    debt_paid: Decimal = ZERO
    saved_in: Decimal = ZERO
    saved_out: Decimal = ZERO
    savings_spent: Decimal = ZERO


@dataclass
class _SavingsAccountFlow:
    """One own Savings account's window totals, for the per-account fed cap."""
    pool_in: Decimal = ZERO        # row 6
    pool_out: Decimal = ZERO       # row 7
    spent: Decimal = ZERO          # savings_spent on it
    to_savings: Decimal = ZERO     # row 13 out of it

    def net(self) -> Decimal:
        return max(self.pool_in - self.pool_out - self.spent - self.to_savings, ZERO)


# --- the grouped query (2.3) --------------------------------------------------------------

def _source():
    """A row's own-side account: a transfer's source, else its account."""
    return case(
        (Transaction.transaction_type == TransactionType.TRANSFER,
         func.coalesce(Transaction.transfer_from_account_id, Transaction.account_id)),
        else_=Transaction.account_id,
    )


def earliest_row(db: Session, own_ids: Set[int]) -> Optional[datetime]:
    """The caller's earliest posted row (2.1): on an own account, or from one."""
    if not own_ids:
        return None
    return db.execute(select(func.min(Transaction.transaction_date)).where(
        Transaction.is_posted.is_(True), _source().in_(own_ids))).scalar()


def grouped_rows(db: Session, uid: int, own_ids: Set[int], start: datetime, end: datetime,
                 tracked_categories: Iterable[int]) -> list:
    """The window's posted rows, summed in one grouped query.

    Keys: Manila month, source account, counter-account (a transfer's own
    destination, ``OUTSIDE`` for every account that is not own, None for a
    debit or credit), type, stored currency, and the category, only on the
    caller's own rows and only when a goal tracks it (else None). Sums: amount
    and transfer fee. The number of rows is bounded by months x own accounts x
    (own accounts + 1) x types x currencies x (tracked categories + 1), whatever
    the number of transactions.
    """
    if not own_ids:
        return []
    tracked = sorted(set(tracked_categories))
    source = _source()
    counter = case(
        (Transaction.transaction_type != TransactionType.TRANSFER, null()),
        (Transaction.transfer_to_account_id.in_(own_ids), Transaction.transfer_to_account_id),
        else_=OUTSIDE,
    )
    if tracked:
        category = case(
            ((Transaction.user_id == uid) & Transaction.category_id.in_(tracked),
             Transaction.category_id),
            else_=null(),
        )
    else:
        category = null()
    month = func.date_trunc("month", Transaction.transaction_date + MANILA_OFFSET)
    # Keyed in a subquery, so the grouping names columns and repeats no bound value.
    keyed = select(
        month.label("month"), source.label("source"), counter.label("counter"),
        Transaction.transaction_type.label("type"), Transaction.currency.label("currency"),
        category.label("category"), Transaction.amount.label("amount"),
        func.coalesce(Transaction.transfer_fee, 0).label("fee"),
    ).where(
        Transaction.is_posted.is_(True), source.in_(own_ids),
        Transaction.transaction_date >= start, Transaction.transaction_date < end,
    ).subquery("free_flow_rows")
    keys = (keyed.c.month, keyed.c.source, keyed.c.counter, keyed.c.type, keyed.c.currency,
            keyed.c.category)
    return db.execute(
        select(*keys, func.sum(keyed.c.amount).label("amount"),
               func.sum(keyed.c.fee).label("fee")).group_by(*keys)
    ).all()


# --- the row table (2.2) ------------------------------------------------------------------

@dataclass
class _Classified:
    terms: Dict[str, _Terms] = field(default_factory=lambda: defaultdict(_Terms))
    savings: Dict[int, _SavingsAccountFlow] = field(
        default_factory=lambda: defaultdict(_SavingsAccountFlow))
    # The caller's own row 6 transfers by tracked category and Savings account.
    tagged_in: Dict[int, Dict[int, Decimal]] = field(
        default_factory=lambda: defaultdict(lambda: defaultdict(lambda: ZERO)))
    currencies: Set[str] = field(default_factory=set)
    cross: bool = False


def classify(rows: list, own: Dict[int, _Own]) -> _Classified:
    """Put every grouped row through the row table, or mark the caller cross-currency."""
    out = _Classified()
    for r in rows:
        src = own[r.source]
        stored = _code(r.currency) if r.currency is not None else None
        out.currencies.add(src.currency)
        if stored is not None:
            out.currencies.add(stored)
        # Not classified: a stored currency that is not the account's current one.
        if stored is not None and stored != src.currency:
            out.cross = True
            continue
        dst = own.get(r.counter) if r.counter not in (None, OUTSIDE) else None
        # Not classified: a transfer between own accounts in different currencies.
        if dst is not None and dst.currency != src.currency:
            out.cross = True
            continue
        amount, fee = _money(r.amount), _money(r.fee)
        t = out.terms[src.currency]
        if r.type != TransactionType.TRANSFER:
            credit = r.type == TransactionType.CREDIT
            if src.cls == POOL:
                if credit:
                    t.income += amount                                  # 1
                else:
                    t.spending += amount                                # 2
            elif src.cls == SAVINGS and not credit:
                t.spending += amount                                    # 3a
                t.savings_spent += amount
                out.savings[src.id].spent += amount
            continue                                                    # 3
        to = dst.cls if dst is not None else OUTSIDE_CLASS
        if src.cls == LOAN:
            continue                                                    # 10
        if src.cls == POOL:
            if to == POOL:
                t.spending += fee                                       # 4
            elif to == SAVINGS:
                t.saved_in += amount                                    # 6
                t.spending += fee
                out.savings[dst.id].pool_in += amount
                if r.category is not None:
                    out.tagged_in[r.category][dst.id] += amount
            elif to == LOAN:
                t.debt_paid += amount                                   # 8
                t.spending += fee
            else:
                t.spending += amount + fee                              # 9
            continue
        # The source is Savings.
        if to == POOL:
            t.saved_out += amount                                       # 7
            out.savings[src.id].pool_out += amount
        elif to == LOAN:
            t.debt_paid += amount                                       # 11
            t.spending += fee
            t.savings_spent += amount + fee
            out.savings[src.id].spent += amount + fee
        elif to == OUTSIDE_CLASS:
            t.spending += amount + fee                                  # 12
            t.savings_spent += amount + fee
            out.savings[src.id].spent += amount + fee
        else:
            out.savings[src.id].to_savings += amount + fee              # 13
    return out


# --- goals (2.5) --------------------------------------------------------------------------

GOAL, BALANCE, CATEGORY = "goal", "balance", "category"


@dataclass
class _Goal:
    allocation: Allocation
    currency: str
    kind: str
    accounts: List[int] = field(default_factory=list)   # own Savings accounts it counts
    category: Optional[int] = None
    counted: Dict[str, Decimal] = field(default_factory=dict)   # category goals, by currency
    tagged: Dict[int, Decimal] = field(default_factory=dict)    # into own Savings, by account
    current: Decimal = ZERO
    pace: Decimal = ZERO
    fed: Decimal = ZERO

    @property
    def id(self) -> int:
        return self.allocation.id

    @property
    def target(self) -> Optional[Decimal]:
        t = self.allocation.target_amount
        return Decimal(str(t)) if t is not None else None


def can_reserve(allocation: Allocation) -> bool:
    """A ``monthly_target`` above 0, or both a ``target_amount`` and a ``target_date``."""
    monthly = allocation.monthly_target
    if monthly is not None and Decimal(str(monthly)) > ZERO:
        return True
    return allocation.target_amount is not None and allocation.target_date is not None


def _goals(db: Session, uid: int, own: Dict[int, _Own]) -> List[_Goal]:
    """The caller's goals that can reserve, in rank order."""
    allocations = db.query(Allocation).filter(
        Allocation.user_id == uid,
        Allocation.allocation_type.in_(RANKED_TYPES),
        Allocation.is_active.is_(True),
    ).order_by(Allocation.rank.asc().nullslast(), Allocation.id).all()
    goals = []
    for a in allocations:
        if not can_reserve(a):
            continue
        currency = _code(a.currency)
        if a.allocation_type == AllocationType.GOAL:
            goals.append(_Goal(a, currency, GOAL))
            continue
        mode = goal_mode(a.configuration)
        if mode == TRANSACTION_TOTAL:
            goals.append(_Goal(a, currency, CATEGORY, category=_savings_category_id(a)))
        else:
            ids = [i for i in _account_ids(a, mode) if i in own and own[i].cls == SAVINGS]
            goals.append(_Goal(a, currency, BALANCE, accounts=ids))
    return goals


def _category_counts(db: Session, uid: int, own: Dict[int, _Own], goals: List[_Goal]) -> None:
    """Fill each category goal's ``counted`` and ``tagged``, in one grouped query.

    What a ``transaction_total`` goal counts here: the caller's own posted rows
    in its category on own accounts, from the goal's creation day; of
    transfers, only those whose destination is also an own account. Transfers
    and debits add, credits subtract (as ``savings_progress``).
    """
    wanted = [(g.id, g.category, since(g.allocation)) for g in goals
              if g.kind == CATEGORY and g.category is not None]
    if not wanted or not own:
        return
    own_ids = list(own)
    scope = values(column("allocation_id", Integer), column("category_id", Integer),
                   column("since", DateTime), name="free_flow_goals").data(wanted)
    destination = case((Transaction.transaction_type == TransactionType.TRANSFER,
                        Transaction.transfer_to_account_id), else_=null())
    keyed = (
        select(scope.c.allocation_id.label("allocation_id"),
               Transaction.account_id.label("account_id"), destination.label("destination"),
               Transaction.transaction_type.label("type"), Transaction.currency.label("currency"),
               Transaction.amount.label("amount"))
        .select_from(scope)
        .join(Transaction, (Transaction.user_id == uid)
              & (Transaction.category_id == scope.c.category_id)
              & (Transaction.transaction_date >= scope.c.since))
        .where(Transaction.is_posted.is_(True),
               Transaction.account_id.in_(own_ids),
               or_(Transaction.transaction_type != TransactionType.TRANSFER,
                   Transaction.transfer_to_account_id.in_(own_ids)))
    ).subquery("free_flow_counted")
    keys = (keyed.c.allocation_id, keyed.c.account_id, keyed.c.destination, keyed.c.type,
            keyed.c.currency)
    rows = db.execute(select(*keys, func.sum(keyed.c.amount)).group_by(*keys)).all()
    by_id = {g.id: g for g in goals}
    for allocation_id, account_id, to, kind, stored, total in rows:
        g = by_id[allocation_id]
        currency = _code(stored) if stored is not None else own[account_id].currency
        amount = _money(total)
        signed = -amount if kind == TransactionType.CREDIT else amount
        g.counted[currency] = g.counted.get(currency, ZERO) + signed
        if kind == TransactionType.TRANSFER and to in own and own[to].cls == SAVINGS:
            g.tagged[to] = g.tagged.get(to, ZERO) + amount


def _savings_moves(db: Session, own: Dict[int, _Own],
                   since_by_category: Dict[int, datetime]) -> Dict[int, Dict[Tuple[int, int], Decimal]]:
    """``{category: {(from, to): amount}}``: posted transfers between own Savings
    accounts (row 13, whoever posted them) from each category's earliest goal's
    creation day, in one grouped query."""
    savings_ids = [i for i, a in own.items() if a.cls == SAVINGS]
    if not since_by_category or len(savings_ids) < 2:
        return {}
    scope = values(column("category_id", Integer), column("since", DateTime),
                   name="free_flow_moves").data(sorted(since_by_category.items()))
    keys = (scope.c.category_id, Transaction.account_id, Transaction.transfer_to_account_id)
    rows = db.execute(
        select(*keys, func.sum(Transaction.amount))
        .select_from(scope)
        .join(Transaction, Transaction.transaction_date >= scope.c.since)
        .where(Transaction.is_posted.is_(True),
               Transaction.transaction_type == TransactionType.TRANSFER,
               Transaction.account_id.in_(savings_ids),
               Transaction.transfer_to_account_id.in_(savings_ids))
        .group_by(*keys)
    ).all()
    moves: Dict[int, Dict[Tuple[int, int], Decimal]] = defaultdict(dict)
    for category, source, to, total in rows:
        moves[category][(source, to)] = _money(total)
    return moves


def spread(tagged: Dict[int, Decimal], moves: Dict[Tuple[int, int], Decimal]) -> Dict[int, Decimal]:
    """Where tagged money may be now: each account it was paid into, plus each
    Savings account a later Savings-to-Savings transfer may have carried it to
    (never more than the transfers moved, nor than the tagged total). It is
    counted in every place it may be, so overlap is never missed."""
    total = sum(tagged.values(), ZERO)
    possible = {k: v for k, v in tagged.items() if v > ZERO}
    if total <= ZERO:
        return possible
    for _ in range(len(moves) + 1):
        incoming: Dict[int, Decimal] = defaultdict(lambda: ZERO)
        for (source, to), amount in moves.items():
            incoming[to] += min(possible.get(source, ZERO), amount)
        changed = False
        for to, amount in incoming.items():
            reach = min(total, tagged.get(to, ZERO) + amount)
            if reach > possible.get(to, ZERO):
                possible[to] = reach
                changed = True
        if not changed:
            break
    return possible


def _give_out_current(goals: List[_Goal], own: Dict[int, _Own],
                      moves: Dict[int, Dict[Tuple[int, int], Decimal]]) -> None:
    """Each goal's current, for this calculation only (2.5).

    Money several goals count (an account's balance, a category's rows, or a
    category's transfers into an account a balance goal tracks) is given out in
    rank order: each goal takes what it still needs to reach its
    ``target_amount`` (none without one), and later goals see what is left. A
    goal takes the shared money first: a balance goal takes the category-tagged
    money on its account before the rest, and a category goal's take comes off
    its tagged transfers first, so the lower-ranked goal loses only what the
    higher-ranked one took.
    """
    balance_left = {i: max(a.balance, ZERO) for i, a in own.items() if a.cls == SAVINGS}
    tag_left: Dict[int, Dict[int, Decimal]] = {}
    for g in goals:  # rank order: the first goal of a category locates its tagged money
        if g.kind == CATEGORY and g.category is not None and g.category not in tag_left:
            tag_left[g.category] = spread(g.tagged, moves.get(g.category, {}))
    taken: Dict[int, Decimal] = defaultdict(lambda: ZERO)   # by category goals
    lost: Dict[int, Decimal] = defaultdict(lambda: ZERO)    # to balance goals
    for g in goals:
        target = g.target
        if g.kind == GOAL:
            g.current = _money(g.allocation.current_amount)
            continue
        g.current = ZERO
        if target is None:
            continue
        if g.kind == BALANCE:
            need = max(target, ZERO)
            for account_id in g.accounts:
                take = min(balance_left.get(account_id, ZERO), need)
                if take <= ZERO:
                    continue
                balance_left[account_id] -= take
                need -= take
                g.current += take
                rest = take
                for category in sorted(tag_left):
                    k = min(tag_left[category].get(account_id, ZERO), rest)
                    if k > ZERO:
                        tag_left[category][account_id] -= k
                        lost[category] += k
                        rest -= k
            continue
        if g.category is None:
            continue
        count = max(g.counted.get(g.currency, ZERO), ZERO)
        available = max(count - taken[g.category] - lost[g.category], ZERO)
        g.current = min(available, max(target, ZERO))
        taken[g.category] += g.current
        located = tag_left.get(g.category, {})
        for account_id in sorted(located):
            k = min(located[account_id], g.current)
            if k > ZERO:
                located[account_id] -= k
                balance_left[account_id] = max(balance_left.get(account_id, ZERO) - k, ZERO)


def pace_of(allocation: Allocation, current: Decimal, today: date) -> Tuple[Decimal, bool]:
    """``(pace, overdue)`` by the pace table (2.5), the pace rounded up to the cent."""
    target = allocation.target_amount
    monthly = _money(allocation.monthly_target)
    if target is not None:
        target = Decimal(str(target))
        if current >= target:
            return ZERO, False
        need = target - current
        if allocation.target_date is not None:
            day = manila_day(allocation.target_date)
            return _cents_up(need / months_left(day, today)), day < today
        if monthly > ZERO:
            return _cents_up(min(monthly, need)), False
        return ZERO, False
    if monthly > ZERO:
        return _cents_up(monthly), False
    return ZERO, False


def _feed(goals: List[_Goal], own: Dict[int, _Own], classified: _Classified,
          saved: Dict[str, Decimal], months: int) -> None:
    """Each goal's fed (2.5), as a monthly average, in rank order across modes.

    Money is divisible and feeds one goal at most. Two caps: per Savings
    account, its own net Pool-to-Savings money (rows 6 - 7 - savings_spent -
    row 13 out); per currency, that currency's ``saved``. A balance goal takes
    an account's tagged money first, as for ``current``.
    """
    n = Decimal(months)
    cap = {i: f.net() / n for i, f in classified.savings.items()}
    saved_left = dict(saved)
    tagged = {c: {i: v / n for i, v in by_account.items()}
              for c, by_account in classified.tagged_in.items()}
    for g in goals:
        g.fed = ZERO
        if g.kind == GOAL:
            continue
        left = g.pace

        def take(account_id: int, limit: Decimal) -> Decimal:
            nonlocal left
            if own[account_id].currency != g.currency:
                return ZERO
            f = min(limit, cap.get(account_id, ZERO), left, saved_left.get(g.currency, ZERO))
            if f <= ZERO:
                return ZERO
            cap[account_id] -= f
            saved_left[g.currency] -= f
            left -= f
            g.fed += f
            return f

        if g.kind == BALANCE:
            for account_id in g.accounts:
                rest = take(account_id, cap.get(account_id, ZERO))
                for category in sorted(tagged):
                    k = min(tagged[category].get(account_id, ZERO), rest)
                    if k > ZERO:
                        tagged[category][account_id] -= k
                        rest -= k
        elif g.category is not None:
            by_account = tagged.get(g.category, {})
            for account_id in sorted(by_account):
                by_account[account_id] -= take(account_id, by_account[account_id])


# --- the figures (2.4) --------------------------------------------------------------------

def _own_accounts(ctx) -> Dict[int, _Own]:
    ids = ctx.viewable_ids(roles=OWNER_ROLES)
    if not ids:
        return {}
    rows = ctx.db.query(Account.id, Account.account_type, Account.currency, Account.balance).filter(
        Account.id.in_(ids))
    return {i: _Own(i, account_class(t), _code(c), _money(b)) for i, t, c, b in rows}


def compute(ctx) -> FreeFlow:
    """The caller's free flow (``RequestContext``), read once per request."""
    return ctx.memo(("free_flow", ctx.uid), lambda: _compute(ctx))


def _compute(ctx) -> FreeFlow:
    db, uid, today = ctx.db, ctx.uid, ctx.today
    own = _own_accounts(ctx)
    goals = _goals(db, uid, own)
    earliest = earliest_row(db, set(own))
    first, months = window(manila_day(earliest) if earliest is not None else None, today)
    currencies = {a.currency for a in own.values()} | {g.currency for g in goals}

    _category_counts(db, uid, own, goals)
    since_by_category: Dict[int, datetime] = {}
    for g in goals:
        if g.kind == CATEGORY and g.category is not None:
            start = since(g.allocation)
            if g.category not in since_by_category or start < since_by_category[g.category]:
                since_by_category[g.category] = start
    _give_out_current(goals, own, _savings_moves(db, own, since_by_category))
    overdue = {}
    for g in goals:
        g.pace, overdue[g.id] = pace_of(g.allocation, g.current, today)

    if months == 0:
        rows = [FreeFlowRow(c, NOT_ESTIMATED, 0) for c in sorted(currencies)]
        return FreeFlow(NOT_ESTIMATED, 0, rows, [
            FreeFlowGoal(g.id, g.allocation.rank, g.currency, overdue=overdue[g.id])
            for g in goals])

    tracked = {g.category for g in goals if g.kind == CATEGORY and g.category is not None}
    end = _month_of(_month_index(first) + months)
    classified = classify(
        grouped_rows(db, uid, set(own), _utc_of_manila(first), _utc_of_manila(end), tracked),
        own)
    currencies |= classified.currencies

    cross = classified.cross
    for g in goals:   # a goal counting anything in another currency
        if g.kind == BALANCE and any(own[i].currency != g.currency for i in g.accounts):
            cross = True
        if g.kind == CATEGORY and any(c != g.currency for c in g.counted):
            cross = True

    n = Decimal(months)
    terms = {c: classified.terms.get(c, _Terms()) for c in currencies}
    avg = {c: _Terms(*(getattr(t, f) / n for f in _Terms.__dataclass_fields__))
           for c, t in terms.items()}
    saved_exact = {c: max(t.saved_in - t.saved_out - t.savings_spent, ZERO)
                   for c, t in avg.items()}

    _feed(goals, own, classified, saved_exact, months)

    flows: Dict[int, FreeFlowGoal] = {}
    top_up: Dict[str, Decimal] = defaultdict(lambda: ZERO)
    for g in goals:
        fed = _cents(g.fed)
        flow = FreeFlowGoal(g.id, g.allocation.rank, g.currency, pace=g.pace, fed=fed,
                            top_up=max(g.pace - fed, ZERO), overdue=overdue[g.id])
        if flow.top_up > ZERO and avg[g.currency].income <= ZERO:
            flow.unreserved = True   # cannot be placed: no income in its currency
            cross = True
        top_up[g.currency] += flow.top_up
        flows[g.id] = flow

    rows: List[FreeFlowRow] = []
    for c in sorted(currencies):
        t = avg[c]
        income, spending, debt_paid = _cents(t.income), _cents(t.spending), _cents(t.debt_paid)
        saved = _cents(saved_exact[c])
        if cross:
            rows.append(FreeFlowRow(c, INCOMPLETE, months, income=income, spending=spending,
                                    debt_paid=debt_paid, saved=saved))
            continue
        reserved = saved + top_up[c]
        row = FreeFlowRow(c, NO_PROJECTION if income <= ZERO else OK, months, income=income,
                          spending=spending, debt_paid=debt_paid, saved=saved,
                          goal_top_up=top_up[c], reserved=reserved)
        if row.status == OK:
            row.net_flow = income - spending - debt_paid
            row.shortfall = max(reserved - row.net_flow, ZERO)
            row.free_flow = max(row.net_flow - reserved, ZERO)
        rows.append(row)

    goal_flows = [flows[g.id] for g in goals]
    if cross:
        for flow in goal_flows:
            flow.pace = flow.fed = flow.top_up = flow.underfunded = None
        return FreeFlow(INCOMPLETE, months, rows, goal_flows)

    # A shortfall in one currency leaves no free flow in any (goals come before wants).
    if any(r.status == OK and r.shortfall > ZERO for r in rows):
        for r in rows:
            if r.status == OK:
                r.free_flow = ZERO

    # Underfunded (2.5): in each ok currency, max(net_flow - saved, 0) is given out
    # in rank order to the top-ups reserved there.
    pool = {r.currency: max(r.net_flow - r.saved, ZERO) for r in rows if r.status == OK}
    for flow in goal_flows:
        if flow.currency not in pool:
            continue
        covered = min(pool[flow.currency], flow.top_up)
        pool[flow.currency] -= covered
        flow.underfunded = flow.top_up - covered
    return FreeFlow(OK, months, rows, goal_flows)

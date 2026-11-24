"""A savings allocation's progress, calculated on read from its mode (STU-777).

``configuration.goal_mode`` decides what ``current_amount`` is (missing or
unknown is ``target_balance``):

- ``target_balance``: the linked account's balance (``account_id``);
- ``multi_account``: the sum of the balances of ``configuration.account_ids``;
- ``transaction_total``: the owner's posted transactions in the Savings
  category (``configuration.savings_category_id``) dated on or after the
  allocation's creation day (Manila's calendar, as the app's "today"):
  transfers and debits add, credits subtract, and the total never goes
  below 0.

Every figure is converted to the allocation's currency at the request's rates
(``FxRates``). A figure whose currency has no rate is left out: the result is
then not ``complete`` and ``missing`` names the currencies. A stale rate is
still used, as everywhere else.

Only the allocation owner's own accounts and transactions are ever read, so a
configuration naming another user's account (stale, or written around the
API) contributes nothing. ``progress_for`` answers a whole page in a fixed
number of queries, whatever its size.
"""
from dataclasses import dataclass, field
from datetime import datetime, time
from decimal import Decimal
from typing import Dict, Iterable, List, Optional

from sqlalchemy import DateTime, Integer, String, case, column, func, select, values
from sqlalchemy.orm import Session

from app.core.time import manila_day
from app.models.account import Account
from app.models.allocation import Allocation, AllocationType
from app.models.transaction import Transaction, TransactionType
from app.models.user import CurrencyType
from app.schemas.allocation import MULTI_ACCOUNT, TRANSACTION_TOTAL, goal_mode
from app.services.fx import FxRates, convert

ZERO = Decimal("0")


@dataclass
class SavingsProgress:
    current_amount: Decimal
    source: str
    missing: List[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.missing

    def as_fields(self) -> dict:
        """The response fields this progress sets on an allocation."""
        return {"current_amount": self.current_amount,
                "current_amount_complete": self.complete,
                "current_amount_missing": list(self.missing),
                "current_amount_source": self.source}


def _code(currency) -> str:
    return getattr(currency, "value", currency) or CurrencyType.PHP.value


def _ints(value) -> List[int]:
    """The ids in a configuration list; anything that is not an id is skipped."""
    ids = []
    for v in value if isinstance(value, list) else []:
        try:
            ids.append(int(v))
        except (TypeError, ValueError):
            continue
    return ids


def _account_ids(allocation: Allocation, mode: str) -> List[int]:
    if mode == MULTI_ACCOUNT:
        ids = _ints((allocation.configuration or {}).get("account_ids"))
        return list(dict.fromkeys(ids))
    return [allocation.account_id] if allocation.account_id is not None else []


def _savings_category_id(allocation: Allocation) -> Optional[int]:
    ids = _ints([(allocation.configuration or {}).get("savings_category_id")])
    return ids[0] if ids else None


def since(allocation: Allocation) -> datetime:
    """The first moment a ``transaction_total`` allocation counts: its creation day."""
    return datetime.combine(manila_day(allocation.created_at), time())


class _Totaller:
    """Sums figures into one currency, noting the currencies it had no rate for."""

    def __init__(self, fx: FxRates, quote: str):
        self.fx = fx
        self.quote = quote
        self.total = ZERO
        self.missing: set = set()

    def add(self, amount, currency) -> None:
        base = _code(currency)
        rate = self.fx.rate(base, self.quote)
        if rate is None:
            self.missing.add(base)
            return
        self.total += convert(amount, rate.rate)


def progress_for(db: Session, allocations: Iterable[Allocation],
                 fx: FxRates) -> Dict[int, SavingsProgress]:
    """``{allocation id: progress}`` for the savings allocations among ``allocations``.

    Budgets and goals are left out (their ``current_amount`` is the stored one).
    Two queries at most: the accounts every balance mode names, and one
    grouped sum over the Savings transactions of every ``transaction_total``
    allocation.
    """
    savings = [a for a in allocations if a.allocation_type == AllocationType.SAVINGS]
    if not savings:
        return {}
    modes = {a.id: goal_mode(a.configuration) for a in savings}

    wanted = {i for a in savings if modes[a.id] != TRANSACTION_TOTAL
              for i in _account_ids(a, modes[a.id])}
    owners = {a.user_id for a in savings}
    accounts: Dict[int, Account] = {}
    if wanted:
        accounts = {a.id: a for a in db.query(Account).filter(
            Account.id.in_(wanted), Account.user_id.in_(owners))}

    sums = _transaction_sums(db, [a for a in savings if modes[a.id] == TRANSACTION_TOTAL])

    result: Dict[int, SavingsProgress] = {}
    for allocation in savings:
        mode = modes[allocation.id]
        totaller = _Totaller(fx, _code(allocation.currency))
        if mode == TRANSACTION_TOTAL:
            for currency, amount in sums.get(allocation.id, {}).items():
                totaller.add(amount, currency)
            amount = max(ZERO, totaller.total)
            source = f"Savings transactions since {since(allocation).date().isoformat()}"
        else:
            # Only the owner's own accounts count, whatever the configuration names.
            counted = [accounts[i] for i in _account_ids(allocation, mode)
                       if i in accounts and accounts[i].user_id == allocation.user_id]
            for account in counted:
                totaller.add(account.balance or ZERO, account.currency)
            amount = totaller.total
            if mode == MULTI_ACCOUNT:
                n = len(counted)
                source = f"{n} account{'' if n == 1 else 's'} combined"
            elif counted:
                source = f"Balance of {counted[0].name}"
            else:
                source = "No linked account"
        result[allocation.id] = SavingsProgress(amount, source, sorted(totaller.missing))
    return result


def _transaction_sums(db: Session, allocations: List[Allocation]) -> Dict[int, Dict[str, Decimal]]:
    """``{allocation id: {currency: signed total}}`` in one grouped query.

    Each allocation is joined to its owner's posted rows in its Savings
    category dated from its creation day: transfers and debits add, credits
    subtract. A row's currency is its own, else its account's.
    """
    wanted = [(a.id, a.user_id, _savings_category_id(a), since(a)) for a in allocations]
    wanted = [w for w in wanted if w[2] is not None]
    if not wanted:
        return {}
    scope = values(
        column("allocation_id", Integer), column("owner_id", Integer),
        column("category_id", Integer), column("since", DateTime),
        name="savings_scope",
    ).data(wanted)
    signed = case(
        (Transaction.transaction_type == TransactionType.CREDIT, -Transaction.amount),
        else_=Transaction.amount,
    )
    currency = func.coalesce(Transaction.currency, Account.currency).cast(String)
    rows = db.execute(
        select(scope.c.allocation_id, currency, func.sum(signed))
        .select_from(scope)
        .join(Transaction, (Transaction.user_id == scope.c.owner_id)
              & (Transaction.category_id == scope.c.category_id)
              & (Transaction.transaction_date >= scope.c.since))
        .join(Account, Account.id == Transaction.account_id)
        .where(Transaction.is_posted.is_(True),
               Transaction.transaction_type.in_([TransactionType.TRANSFER,
                                                 TransactionType.DEBIT,
                                                 TransactionType.CREDIT]))
        .group_by(scope.c.allocation_id, currency)
    ).all()
    sums: Dict[int, Dict[str, Decimal]] = {}
    for allocation_id, code, total in rows:
        sums.setdefault(allocation_id, {})[code] = Decimal(total or 0)
    return sums

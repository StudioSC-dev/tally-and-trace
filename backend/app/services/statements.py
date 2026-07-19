"""Credit-card statement modelling for Tally & Trace.

A credit card doesn't spend cash when you swipe it -- it spends cash when you pay
the statement. This module turns a card's transactions into the thing that actually
hits your bank account: **one dated payable per billing cycle**.

The cycle contract (see HANDOVER Session 14 for why):

    billing_cycle_start   day-of-month the statement CLOSES
    days_until_due_date   days from close to payment due (default 21)

    close  = <billing_cycle_start> of month M      e.g. Jul 24
    window = (previous close, close]               e.g. Jun 25 .. Jul 24
    due    = close + days_until_due_date           e.g. Aug 14

Legacy fallback: a card with only ``due_date`` (day-of-month) set is read as
closing ``days_until_due_date`` days *before* that due day, which collapses to the
same (close, due) pair without a second code path. A card with neither field can't
be modelled and is skipped.

The statement balance is derived from the card's own transactions in the window --
matching how the owner keeps per-card SOA ledgers, where line items sum to the
statement balance. DEBIT (a purchase) increases what's owed; CREDIT (a refund or
payment) decreases it. Both posted and unposted transactions count: an unposted
charge inside the window is planned spending that will still land on that
statement. A cycle whose balance is <= 0 produces no payable.

All money is Decimal end to end; dates are naive UTC to match the naive
transaction_date column (see app/core/time.py for the naive/aware split).
"""

from __future__ import annotations

from calendar import monthrange
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Iterator, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.entity_context import scope_criterion

from app.models.account import Account, AccountType
from app.models.transaction import Transaction, TransactionType

DEFAULT_DAYS_UNTIL_DUE = 21


def _clamp_day(year: int, month: int, day: int) -> int:
    """Clamp a day-of-month to the month's length (day 31 -> 30 or 28/29)."""
    return min(day, monthrange(year, month)[1])


def _month_step(year: int, month: int, delta: int) -> Tuple[int, int]:
    index = (year * 12 + (month - 1)) + delta
    return index // 12, index % 12 + 1


def resolve_cycle_fields(card: Account) -> Optional[Tuple[int, int]]:
    """Return ``(close_day, days_until_due)`` for a card, or ``None`` if unmodellable.

    Prefers ``billing_cycle_start`` (the statement close day). Falls back to the
    legacy ``due_date`` day-of-month by working backwards from the due day.
    """
    days_until_due = card.days_until_due_date
    if days_until_due is None:
        days_until_due = DEFAULT_DAYS_UNTIL_DUE

    if card.billing_cycle_start:
        return card.billing_cycle_start, days_until_due

    if card.due_date:
        # Only the due day is known: treat the statement as closing
        # `days_until_due` days earlier, so the (close, due) pair still holds.
        anchor = datetime(2000, 1, _clamp_day(2000, 1, card.due_date))
        return (anchor - timedelta(days=days_until_due)).day, days_until_due

    return None


def iter_statement_cycles(card: Account, start: datetime, end: datetime) -> Iterator[dict]:
    """Yield ``{window_start, close, due}`` for every cycle DUE in ``[start, end)``.

    Walks by close date and reports the cycles whose *payment* lands in the window,
    which is what the cash timeline cares about -- a statement that closed before
    ``start`` but is due inside it must still be paid.
    """
    fields = resolve_cycle_fields(card)
    if fields is None:
        return
    close_day, days_until_due = fields

    # Start far enough back that a cycle closing before the window but due inside
    # it is still produced. Two months of slack covers any close->due offset.
    y, m = _month_step(start.year, start.month, -2)
    guard = 0
    while guard < 60:
        guard += 1
        close = datetime(y, m, _clamp_day(y, m, close_day))
        due = close + timedelta(days=days_until_due)

        if due >= end:
            return

        py, pm = _month_step(y, m, -1)
        prev_close = datetime(py, pm, _clamp_day(py, pm, close_day))

        if due >= start:
            yield {"window_start": prev_close, "close": close, "due": due}

        y, m = _month_step(y, m, 1)


def statement_balance(transactions: List[Transaction], window_start: datetime, close: datetime) -> Decimal:
    """Sum a card's charges over ``(window_start, close]``.

    Purchases add to what's owed, refunds/payments subtract. Transfers are ignored:
    a card payment is recorded as a transfer, and its cash side is already modelled
    on the paying account -- counting it here too would net the statement to zero.
    """
    total = Decimal("0")
    for txn in transactions:
        when = txn.transaction_date
        if when.tzinfo:
            when = when.replace(tzinfo=None)
        if not (window_start < when <= close):
            continue
        if txn.transaction_type == TransactionType.DEBIT:
            total += Decimal(str(txn.amount))
        elif txn.transaction_type == TransactionType.CREDIT:
            total -= Decimal(str(txn.amount))
    return total


def build_statement_payables(
    cards: List[Account],
    transactions_by_card: dict,
    start: datetime,
    end: datetime,
) -> List[dict]:
    """Pure core: turn cards + their transactions into dated payable events.

    Returns timeline events shaped like the ones ``build_timeline`` /
    ``route_accounts`` already consume (negative amount = outflow).
    """
    events: List[dict] = []
    for card in cards:
        card_txns = transactions_by_card.get(card.id, [])
        for cycle in iter_statement_cycles(card, start, end):
            balance = statement_balance(card_txns, cycle["window_start"], cycle["close"])
            if balance <= 0:
                continue  # nothing owed -> nothing to pay
            events.append({
                "date": cycle["due"],
                "name": f"{card.name} statement",
                "amount": -balance,
                "type": "expense",
                "source": "statement",
                "source_id": card.id,
                "funding_account_id": card.payment_account_id,
                "overflow_account_id": card.payment_overflow_account_id,
                "statement_close": cycle["close"],
            })
    return events


def get_statement_payables(
    db: Session,
    user_id: int,
    entity_id: Optional[int],
    start: datetime,
    end: datetime,
) -> List[dict]:
    """DB wrapper: load the user's credit cards and build their statement payables."""
    card_query = db.query(Account).filter(
        scope_criterion(Account, user_id, entity_id),
        Account.is_active.is_(True),
        Account.account_type == AccountType.CREDIT,
    )
    cards = card_query.all()
    if not cards:
        return []

    # Charges are filtered by card id ALONE, not re-scoped by user/entity: the card
    # itself was already access-checked above, and a statement must include every
    # charge on it — including ones a co-member entered in a shared entity.
    card_ids = [c.id for c in cards]
    txns = (
        db.query(Transaction)
        .filter(Transaction.account_id.in_(card_ids))
        .all()
    )
    by_card: dict = {cid: [] for cid in card_ids}
    for txn in txns:
        by_card.setdefault(txn.account_id, []).append(txn)

    return build_statement_payables(cards, by_card, start, end)

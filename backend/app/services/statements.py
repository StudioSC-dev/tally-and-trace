"""Credit-card statement modelling for Tally & Trace.

A credit card doesn't spend cash when you swipe it -- it spends cash when you pay
the statement. This module turns a card's transactions into the thing that actually
hits your bank account: **one dated payable per billing cycle**.

The cycle contract (see HANDOVER Session 14 for why):

    billing_cycle_start   day-of-month the statement CLOSES
    days_until_due_date   days from close to payment due (default 21)

    close  = <billing_cycle_start> of month M      e.g. Jul 24
    window = (previous close, close], whole days   e.g. Jun 25 .. Jul 24
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
statement. A cycle whose balance is <= 0 owes nothing.

Payments are transfers INTO the card (``transfer_to_account_id``), posted or
planned. They are netted against statements, not against the cycle they are dated
in: each payment is consumed exactly once, oldest outstanding statement first,
whether it was made before the close, early, on time or late. A statement's
payable is what remains of its line-item balance after that allocation, so a
fully paid statement has no payable and a partly paid one owes the remainder.
The cash side of a payment is modelled on the paying account by the forecast
engine (a posted one is in its balance, a planned one is a dated outflow), so
each peso of a statement leaves cash exactly once: as payment or as payable.

A transfer OUT of the card (a cash advance or balance transfer) is a line item:
the card is charged the amount plus the transfer fee on the transfer's date, so
the cash it brought in is repaid through that statement.

All money is Decimal end to end; dates are naive UTC to match the naive
transaction_date column (see app/core/time.py for the naive/aware split).
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Iterator, List, Optional, Tuple

from sqlalchemy import and_, or_
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


def iter_cycles_from(card: Account, first: date, end: datetime) -> Iterator[dict]:
    """Yield every cycle from the one containing day ``first`` up to those due before ``end``.

    Unlike ``iter_statement_cycles`` this reaches back to the card's history, which
    is what allocating payments oldest-statement-first needs.
    """
    fields = resolve_cycle_fields(card)
    if fields is None:
        return
    close_day, days_until_due = fields

    y, m = first.year, first.month
    if first.day > _clamp_day(y, m, close_day):
        y, m = _month_step(y, m, 1)
    while True:
        close = datetime(y, m, _clamp_day(y, m, close_day))
        due = close + timedelta(days=days_until_due)
        if due >= end:
            return
        py, pm = _month_step(y, m, -1)
        yield {
            "window_start": datetime(py, pm, _clamp_day(py, pm, close_day)),
            "close": close,
            "due": due,
        }
        y, m = _month_step(y, m, 1)


def allocate_payments(balances: List[Decimal], payments: List[Decimal]) -> List[Decimal]:
    """What each statement still owes after the payments, oldest statement first.

    ``balances`` are statement balances in close order; ``payments`` in date order.
    Each payment is consumed exactly once: it pays down the oldest statement with
    something outstanding and spills any excess into the next one. Payments left
    over after the last statement are a credit on the card and pay nothing here.
    """
    remaining = [max(b, Decimal("0")) for b in balances]
    i = 0
    for amount in payments:
        left = amount
        while left > 0 and i < len(remaining):
            paid = min(left, remaining[i])
            remaining[i] -= paid
            left -= paid
            if remaining[i] == 0:
                i += 1
    return remaining


def _split_card_rows(card_id: int, rows: list) -> Tuple[list, List[Tuple[datetime, Decimal]]]:
    """Separate a card's rows into statement line items and payments into the card.

    Only a transfer's ``transfer_*`` fields are meaningful (a row edited from a
    transfer into a debit may keep stale ones). A transfer into the card is a
    payment; a transfer out of it is a charge of its amount plus fee.
    """
    lines: list = []
    payments: List[Tuple[datetime, Decimal]] = []
    for row in rows:
        if row.transaction_type == TransactionType.TRANSFER:
            amount = Decimal(str(row.amount))
            if getattr(row, "transfer_to_account_id", None) == card_id:
                payments.append((row.transaction_date, amount))
            elif (getattr(row, "transfer_from_account_id", None) or row.account_id) == card_id:
                fee = Decimal(str(getattr(row, "transfer_fee", None) or 0))
                lines.append(SimpleNamespace(
                    transaction_date=row.transaction_date,
                    amount=amount + fee,
                    transaction_type=TransactionType.DEBIT,
                ))
            continue
        lines.append(row)
    payments.sort(key=lambda p: p[0])
    return lines, payments


def statement_balance(transactions: List[Transaction], window_start: datetime, close: datetime) -> Decimal:
    """Sum a card's charges over the calendar days ``(window_start, close]``.

    Days, not instants: ``close`` is midnight of the closing day, but a charge at
    any time ON that day belongs to this statement, and one at any time on the
    previous closing day belongs to the previous statement.

    This is the LINE-ITEM balance: purchases add to what's owed, refunds subtract.
    Transfers are not line items -- a card payment (a transfer into the card) is
    netted against statements by ``allocate_payments`` instead.
    """
    first_excluded, last_included = window_start.date(), close.date()
    total = Decimal("0")
    for txn in transactions:
        if not (first_excluded < txn.transaction_date.date() <= last_included):
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

    ``transactions_by_card`` holds every row touching each card: its own charges
    and refunds, transfers out of it (cash advances, billed as charges) and
    transfers into it (payments). Every cycle from the card's
    first line item onward is balanced and the payments are allocated across them
    (see ``allocate_payments``); a cycle still owing something and due in
    ``[start, end)`` becomes a payable for the remainder.

    A cycle still owing something whose due date is before ``start`` is overdue:
    like an overdue unposted transaction, it is emitted dated ``start`` with
    ``overdue`` True and its due date as ``original_date``.

    Returns timeline events shaped like the ones ``build_timeline`` /
    ``route_accounts`` already consume (negative amount = outflow).
    """
    events: List[dict] = []
    for card in cards:
        lines, payments = _split_card_rows(card.id, transactions_by_card.get(card.id, []))
        if not lines:
            continue  # no charges -> nothing owed, whatever was paid in
        first = min(row.transaction_date for row in lines).date()
        cycles = list(iter_cycles_from(card, first, end))
        balances = [statement_balance(lines, c["window_start"], c["close"]) for c in cycles]
        remaining = allocate_payments(balances, [amount for _, amount in payments])
        for cycle, balance, owed in zip(cycles, balances, remaining):
            if owed <= 0:
                continue  # nothing owed -> nothing to pay
            overdue = {}
            if cycle["due"] < start:
                overdue = {"overdue": True, "original_date": cycle["due"]}
            events.append({
                "date": start if overdue else cycle["due"],
                "name": f"{card.name} statement",
                "amount": -owed,
                "type": "expense",
                "source": "statement",
                "source_id": card.id,
                "funding_account_id": card.payment_account_id,
                "overflow_account_id": card.payment_overflow_account_id,
                "statement_close": cycle["close"],
                "statement_balance": balance,
                **overdue,
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

    # Rows are filtered by card id ALONE, not re-scoped by user/entity: the card
    # itself was already access-checked above, and a statement must include every
    # charge on it and every payment into it — including ones a co-member entered
    # in a shared entity, or a transfer from another entity's account.
    card_ids = [c.id for c in cards]
    txns = (
        db.query(Transaction)
        .filter(or_(
            Transaction.account_id.in_(card_ids),
            and_(
                Transaction.transaction_type == TransactionType.TRANSFER,
                or_(
                    Transaction.transfer_to_account_id.in_(card_ids),
                    Transaction.transfer_from_account_id.in_(card_ids),
                ),
            ),
        ))
        .all()
    )
    by_card: dict = {cid: [] for cid in card_ids}
    for txn in txns:
        touched = {txn.account_id}
        if txn.transaction_type == TransactionType.TRANSFER:
            touched |= {txn.transfer_to_account_id, txn.transfer_from_account_id}
        for cid in touched & set(card_ids):
            by_card[cid].append(txn)

    return build_statement_payables(cards, by_card, start, end)

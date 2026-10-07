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
statement. A cycle whose balance is <= 0 owes nothing; a negative balance (refunds
exceeding charges) is a credit that pays other statements like a payment does.

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

import logging
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

logger = logging.getLogger(__name__)

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


def iter_cycles_from(card: Account, first: date, end: datetime) -> Iterator[dict]:
    """Yield every cycle from the one containing day ``first`` up to those due before ``end``.

    Each cycle is ``{window_start, close, due}``. Walking from the card's first
    line item, not from the window start, reaches back through its history, which
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

    A statement with a negative balance (refunds exceeding charges) owes nothing,
    and its net credit is consumed exactly like a payment: oldest outstanding
    statement first, any excess carrying forward. Payments and credits form one
    pool spent oldest-statement-first, so their order does not change the result.
    """
    remaining = [max(b, Decimal("0")) for b in balances]
    credits = [-b for b in balances if b < 0]
    i = 0
    for amount in [*payments, *credits]:
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
    payments.sort(key=lambda p: p[0].date())
    return lines, payments


def _posted_owed(card_id: int, rows: list) -> Decimal:
    """What a card's POSTED rows say it owes, net of posted payments.

    Mirrors how posting moves an account's stored ``balance`` (routers/
    transactions.py): a debit lowers it, a credit raises it, a transfer lowers the
    source by amount + fee and raises the destination by the amount. A card's
    balance is therefore negative while it is owed, and this is its negation over
    the posted rows alone. Unposted rows and projected charges never touch the
    stored balance, so they are left out.
    """
    owed = Decimal("0")
    for row in rows:
        if not getattr(row, "is_posted", False):
            continue
        amount = Decimal(str(row.amount))
        if row.transaction_type == TransactionType.TRANSFER:
            if getattr(row, "transfer_to_account_id", None) == card_id:
                owed -= amount
            elif (getattr(row, "transfer_from_account_id", None) or row.account_id) == card_id:
                owed += amount + Decimal(str(getattr(row, "transfer_fee", None) or 0))
        elif row.transaction_type == TransactionType.DEBIT:
            owed += amount
        elif row.transaction_type == TransactionType.CREDIT:
            owed -= amount
    return owed


def _trim_closed(cycles: List[dict], balances: List[Decimal], start: datetime,
                 excess: Decimal) -> Tuple[List[Decimal], Decimal]:
    """Cut ``excess`` from closed cycles' positive balances, oldest first.

    Returns the cut balances and the amount cut. Runs before payments are
    allocated, so no payment is ever spent on debt the cut removes.
    """
    cut_balances = list(balances)
    left = excess
    for i, cycle in enumerate(cycles):
        if left <= 0 or cycle["close"].date() >= start.date():
            break
        cut = min(left, max(cut_balances[i], Decimal("0")))
        cut_balances[i] -= cut
        left -= cut
    return cut_balances, excess - left


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

    Incomplete-history guard: history the ledger lacks (payments never entered as
    transfers, an opening balance never entered as charges) would otherwise surface
    as phantom unpaid statements. A card's stored ``balance`` (negative = owed) is
    the authority on what it owes. When its posted rows say it owes MORE than that
    (``_posted_owed`` > -balance), the gap is debt the stored balance says was
    settled, so it is cut from the balances of CLOSED cycles (closing day before
    ``start``), oldest first, since recent statements are the more reliable ones.
    The cut happens BEFORE payments are allocated: the gap acts as an unrecorded
    payment restricted to closed cycles, spent first, so a recorded or planned
    payment is never consumed by debt the stored balance says is already settled
    (which would leave the debt it was meant for owed a second time). Open cycles
    are never cut. When the stored balance owes MORE than the posted rows (gap < 0,
    e.g. an opening balance never entered as charges), the difference is a
    synthetic opening statement placed before the oldest cycle: payments and
    credits pay it first, oldest first as usual, but it is never emitted as a
    payable or overdue event, so the guard never adds debt of its own. A card
    whose history is complete has no gap and is untouched. A card without a
    ``balance`` skips the guard.

    Returns timeline events shaped like the ones ``build_timeline`` /
    ``route_accounts`` already consume (negative amount = outflow).
    """
    events: List[dict] = []
    for card in cards:
        lines, payments = _split_card_rows(card.id, transactions_by_card.get(card.id, []))
        if not lines:
            continue  # no charges -> nothing owed, whatever was paid in
        # Calendar dates: rows may mix naive and aware datetimes.
        first = min(row.transaction_date.date() for row in lines)
        cycles = list(iter_cycles_from(card, first, end))
        balances = [statement_balance(lines, c["window_start"], c["close"]) for c in cycles]
        owing = balances
        opening = Decimal("0")
        stored = getattr(card, "balance", None)
        if stored is not None:
            rows = transactions_by_card.get(card.id, [])
            gap = _posted_owed(card.id, rows) + Decimal(str(stored))
            if gap > 0:
                owing, trimmed = _trim_closed(cycles, balances, start, gap)
                if trimmed > 0:
                    logger.warning(
                        "Card %s: trimmed %s from closed statements not reflected in its "
                        "stored balance (incomplete history)", card.id, trimmed)
            elif gap < 0:
                opening = -gap
        # The opening statement (0 when there is none) only absorbs payments.
        remaining = allocate_payments([opening, *owing],
                                      [amount for _, amount in payments])[1:]
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
    projected_charges: Optional[dict] = None,
) -> List[dict]:
    """DB wrapper: load the user's credit cards and build their statement payables.

    ``projected_charges`` is ``{card_id: [line items]}`` for charges that have no
    transaction yet (budget entries scheduled on a card); each is billed like a
    transaction on its date.
    """
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
    for cid, lines in (projected_charges or {}).items():
        if cid in by_card:
            by_card[cid].extend(lines)

    return build_statement_payables(cards, by_card, start, end)

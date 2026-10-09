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

from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Iterator, List, Optional, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session


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


def iter_cycles_from(card: Account, first: date, end: datetime,
                     through: Optional[date] = None) -> Iterator[dict]:
    """Yield every cycle from the one containing day ``first`` up to those due before ``end``.

    Each cycle is ``{window_start, close, due}``. Walking from the card's first
    line item, not from the window start, reaches back through its history, which
    is what allocating payments oldest-statement-first needs.

    With ``through``, the walk also continues past ``end`` until it has yielded
    the cycle containing day ``through``, so a line item dated after the window
    (a refund whose credit pays an earlier statement) still gets its cycle.
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
        py, pm = _month_step(y, m, -1)
        window_start = datetime(py, pm, _clamp_day(py, pm, close_day))
        if due >= end and (through is None or window_start.date() >= through):
            return
        yield {
            "window_start": window_start,
            "close": close,
            "due": due,
        }
        y, m = _month_step(y, m, 1)


def statement_due_date(card: Account, day: date) -> Optional[datetime]:
    """Due date of the card's statement whose cycle contains calendar day ``day``.

    ``None`` for a card without cycle settings.
    """
    # end=datetime.min stops the walk right after the cycle containing ``day``.
    cycle = next(iter_cycles_from(card, day, datetime.min, through=day), None)
    return cycle["due"] if cycle else None


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


def unspent_pool(balances: List[Decimal], payments: List[Decimal],
                 remaining: List[Decimal]) -> Decimal:
    """What ``allocate_payments`` left of its pool: payments and net credits it
    did not spend because no statement was left owing anything."""
    pool = sum(payments, Decimal("0")) + sum((-b for b in balances if b < 0), Decimal("0"))
    spent = sum((max(b, Decimal("0")) for b in balances), Decimal("0")) - sum(
        remaining, Decimal("0"))
    return pool - spent


def settle_projected(cycles: List[dict], owed: List[Decimal], pool: Decimal,
                     projected: list) -> List[Decimal]:
    """Apply projected line items on top of the settled recorded ledger.

    ``owed`` is what each cycle still owes after ``allocate_payments`` ran over
    the recorded rows alone, and ``pool`` what that left unspent. Projected rows
    never reopen that settlement, so they cannot change what a recorded payment
    or credit already paid:

    - a projected charge adds to the cycle containing it;
    - the unspent recorded pool then pays outstanding cycles oldest first;
    - a projected credit (an income scheduled on the card) pays, in date order,
      the oldest outstanding statement due on or after its date. It never
      reaches a statement already due before it was credited, so one dated
      after a window cannot change a payable inside it.
    """
    owed = list(owed)

    def spend(amount: Decimal, i: int) -> None:
        while amount > 0 and i < len(owed):
            paid = min(amount, owed[i])
            owed[i] -= paid
            amount -= paid
            i += 1

    credits = []
    for row in projected:
        day = row.transaction_date.date()
        amount = Decimal(str(row.amount))
        if row.transaction_type == TransactionType.CREDIT:
            credits.append((day, amount))
            continue
        if row.transaction_type != TransactionType.DEBIT:
            continue
        for i, cycle in enumerate(cycles):
            if cycle["window_start"].date() < day <= cycle["close"].date():
                owed[i] += amount
                break
    spend(pool, 0)
    for day, amount in sorted(credits, key=lambda c: c[0]):
        first = next((i for i, c in enumerate(cycles) if c["due"].date() >= day), len(cycles))
        spend(amount, first)
    return owed


def _split_card_rows(card_id: int, rows: list, unbilled_ids: frozenset = frozenset(),
                     ) -> Tuple[list, List[Tuple[datetime, Decimal]]]:
    """Separate a card's rows into statement line items and payments into the card.

    Only a transfer's ``transfer_*`` fields are meaningful (a row edited from a
    transfer into a debit may keep stale ones). A transfer into the card is a
    payment; a transfer out of it is a charge of its amount plus fee.

    A transfer from a card in ``unbilled_ids`` (no cycle settings) is not a
    payment: no statement of that card bills it, so no cash ever leaves for it
    (the forecast treats it as moving no cash, see ``forecast._transfer_event``),
    and netting it would make the debt it moved disappear.
    """
    lines: list = []
    payments: List[Tuple[datetime, Decimal]] = []
    for row in rows:
        if row.transaction_type == TransactionType.TRANSFER:
            amount = Decimal(str(row.amount))
            if getattr(row, "transfer_to_account_id", None) == card_id:
                source = getattr(row, "transfer_from_account_id", None) or row.account_id
                if source not in unbilled_ids:
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
    unbilled_sources: frozenset = frozenset(),
    projected_by_card: Optional[dict] = None,
) -> List[dict]:
    """Pure core: turn cards + their transactions into dated payable events.

    ``transactions_by_card`` holds every row touching each card: its own charges
    and refunds, transfers out of it (cash advances, billed as charges) and
    transfers into it (payments; one from a card without cycle settings is
    ignored, see ``_split_card_rows``). Such a source is any card in ``cards``
    without cycle settings, plus the ids in ``unbilled_sources``: the caller
    names those from the source account itself, so a card outside ``cards``
    (one the caller holds no role on, or an inactive one) counts too.

    ``projected_by_card`` holds line items that have no transaction yet (budget
    entries scheduled on the card), which the caller projects only up to ``end``.
    The recorded ledger is settled first: every cycle from the card's first line
    item onward is balanced from recorded rows alone and the payments are
    allocated across them (see ``allocate_payments``). Projected rows are applied
    to that result (see ``settle_projected``), so they never change what a
    recorded payment or credit did for an earlier statement. A cycle still owing
    something and due in ``[start, end)`` becomes a payable for the remainder.

    The allocation runs over every cycle up to the one holding the card's last
    line item, even when that cycle is due on or after ``end``: a net-credit cycle
    beyond the window still pays older statements. Only the emitted events are
    limited to the window. So, given the same recorded rows, a payable inside a
    window is the same for any longer window with the same start, whatever
    projected rows the longer window adds: a projected charge dated on or after
    ``end`` lands in a cycle due after ``end`` and only draws on what the earlier
    cycles left of the pool, and a projected credit dated on or after ``end`` only
    pays statements due on or after its date.

    A cycle still owing something whose due date is before ``start`` is overdue:
    like an overdue unposted transaction, it is emitted dated ``start`` with
    ``overdue`` True and its due date as ``original_date``.

    Returns timeline events shaped like the ones ``build_timeline`` /
    ``route_accounts`` already consume (negative amount = outflow).
    """
    events: List[dict] = []
    unbilled_ids = unbilled_sources | frozenset(
        c.id for c in cards if resolve_cycle_fields(c) is None)
    for card in cards:
        lines, payments = _split_card_rows(
            card.id, transactions_by_card.get(card.id, []), unbilled_ids)
        projected = (projected_by_card or {}).get(card.id, [])
        if not lines and not projected:
            continue  # no charges -> nothing owed, whatever was paid in
        # Calendar dates: rows may mix naive and aware datetimes.
        days = [row.transaction_date.date() for row in [*lines, *projected]]
        cycles = list(iter_cycles_from(card, min(days), end, through=max(days)))
        recorded = [statement_balance(lines, c["window_start"], c["close"]) for c in cycles]
        paid_in = [amount for _, amount in payments]
        settled = allocate_payments(recorded, paid_in)
        remaining = settle_projected(
            cycles, settled, unspent_pool(recorded, paid_in, settled), projected)
        balances = [statement_balance([*lines, *projected], c["window_start"], c["close"])
                    for c in cycles]
        for cycle, balance, owed in zip(cycles, balances, remaining):
            if owed <= 0 or cycle["due"] >= end:
                continue  # nothing owed, or due after the window
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
    cards: List[Account],
    start: datetime,
    end: datetime,
    projected_charges: Optional[dict] = None,
) -> List[dict]:
    """DB wrapper: build the statement payables of ``cards``.

    ``cards`` are the credit cards in the caller's projection scope (active
    accounts the caller holds a role on, see ``collect_events``); access is
    decided there, through ``app.core.access``.

    ``projected_charges`` is ``{card_id: [line items]}`` for charges that have no
    transaction yet (budget entries scheduled on a card); each is billed on the
    cycle containing its date, after the recorded rows are settled (see
    ``build_statement_payables``).
    """
    cards = [c for c in cards if c.account_type == AccountType.CREDIT]
    if not cards:
        return []

    # Rows are filtered by card id ALONE, not re-scoped by user: the card itself
    # is already in the caller's scope, and a statement must include every
    # charge on it and every payment into it, whoever entered it, including a
    # transfer from an account outside the caller's scope.
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

    # Whether a payment's source card is billed is a fact about that account, not
    # about this view: it is loaded by id, outside the card scope above, so a
    # payment from an out-of-scope or inactive card without cycle settings
    # still does not net the statement it was paid into.
    source_ids = {
        txn.transfer_from_account_id or txn.account_id
        for txn in txns
        if txn.transaction_type == TransactionType.TRANSFER
        and txn.transfer_to_account_id in card_ids
    }
    unbilled_sources = frozenset()
    if source_ids:
        unbilled_sources = frozenset(
            a.id for a in db.query(Account).filter(Account.id.in_(source_ids))
            if a.account_type == AccountType.CREDIT and resolve_cycle_fields(a) is None
        )

    return build_statement_payables(cards, by_card, start, end, unbilled_sources,
                                    projected_by_card=projected_charges)

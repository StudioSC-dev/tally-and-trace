"""A card's statements as of a date, from the app's own statement helpers (check 2).

``statement_history`` is not an as-of function: it loads every row touching the
card, pending and future ones included. This runs the same body on the rows that
were posted before ``T`` only, with the rows and unbilled-source set computed
exactly as the app computes them (``_card_rows``).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import List

from sqlalchemy.orm import Session

from app.core.access import viewable_account_ids
from app.services.statements import (
    _card_rows, _split_card_rows, allocate_payments, iter_cycles_from, resolve_cycle_fields,
    statement_balance,
)


def naive(value: datetime) -> datetime:
    """The value without its zone, as ``forecast._naive`` reads it: the columns are
    ``timestamptz`` in the database (the models declare them naive), so the driver
    returns them in the session time zone."""
    return value.replace(tzinfo=None) if value.tzinfo else value


def computed_cycles(db: Session, card, owner_id: int, T: datetime) -> List[dict]:
    """Every cycle walked for ``card`` as of ``T``: ``{close, due, balance, owed}``.

    Empty when the card has no posted line item before ``T`` (no cycle is walked)
    or no cycle settings. Rows touching the card are kept only when posted and
    dated before ``T``; the unbilled-source set comes from the unfiltered rows,
    which only affects payments that are present. Posted rows are already in the
    card's currency (check 7), so lines are not normalised.
    """
    if resolve_cycle_fields(card) is None:
        return []
    by_card, unbilled = _card_rows(db, [card.id], viewable_account_ids(db, owner_id))
    rows = [r for r in by_card.get(card.id, []) if r.is_posted and naive(r.transaction_date) < T]
    lines, payments = _split_card_rows(card.id, rows, unbilled)
    if not lines:
        return []
    days = [row.transaction_date.date() for row in lines]
    cycles = list(iter_cycles_from(card, min(days), datetime.min,
                                   through=(T - timedelta(days=1)).date()))
    balances = [statement_balance(lines, c["window_start"], c["close"]) for c in cycles]
    owed = allocate_payments(balances, [amount for _, amount in payments])
    return [{"close": c["close"].date(), "due": c["due"].date(), "balance": b, "owed": o}
            for c, b, o in zip(cycles, balances, owed)]


def compared_set(cycles: List[dict]) -> List[dict]:
    """Every cycle still owing something, plus the last one walked (the cycle
    holding ``T`` - 1 day), even at zero. Paid historical cycles are left out."""
    if not cycles:
        return []
    last = len(cycles) - 1
    return [c for i, c in enumerate(cycles) if c["owed"] > 0 or i == last]

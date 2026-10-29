"""Possible duplicates of a card installment's months, and the months they hold (STU-343).

A **candidate** for occurrence ``o`` of entry ``e`` is a transaction that is a
DEBIT on ``e``'s card, owned by ``e``'s creator, linked to no entry, in the
card's currency for exactly ``e.amount``, dated within three days of ``o``,
posted or pending. Candidates are the creator's rows only: a link counts only
for a row the entry's creator owns (``forecast._linked_rows``).

A month is **held** when it is due, unrecorded, has no linked row and has a
candidate not already used by another held month. The assignment is canonical
per (creator, card): it is computed over every active, reviewed card
installment of that creator on that card (the universe), whatever subset a
caller passes and whatever the caller can see, so every caller sees the same
held months.

Models are imported at module level; ``forecast`` helpers are imported inside
the functions, so ``forecast`` can import this module without a cycle.
"""
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, List, Tuple

from sqlalchemy import tuple_
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType

WINDOW_DAYS = 3  # a candidate is dated within this many days of the occurrence


def duplicate_candidates(db: Session, entry, occurrences: Iterable[datetime]
                         ) -> Dict[date, List[Transaction]]:
    """``{occurrence day: [candidate]}`` for ``entry``'s ``occurrences``, one query.

    Days with no candidate are left out. Each list is in id order; a
    transaction may be listed under two days.
    """
    days = sorted({occ.date() for occ in occurrences})
    if not days or entry.account_id is None:
        return {}
    card = db.get(Account, entry.account_id)
    if card is None:
        return {}
    window = timedelta(days=WINDOW_DAYS)
    low = datetime.combine(days[0] - window, datetime.min.time())
    high = datetime.combine(days[-1] + window + timedelta(days=1), datetime.min.time())
    rows = (
        db.query(Transaction)
        .filter(Transaction.transaction_type == TransactionType.DEBIT,
                Transaction.account_id == entry.account_id,
                Transaction.user_id == entry.user_id,
                Transaction.budget_entry_id.is_(None),
                Transaction.currency == card.currency,
                Transaction.amount == entry.amount,
                Transaction.transaction_date >= low,
                Transaction.transaction_date < high)
        .order_by(Transaction.id)
        .all()
    )
    out: Dict[date, List[Transaction]] = {}
    for day in days:
        found = [txn for txn in rows
                 if abs((txn.transaction_date.date() - day).days) <= WINDOW_DAYS]
        if found:
            out[day] = found
    return out


def _universe(db: Session, entries) -> List[BudgetEntry]:
    """Every active, reviewed card installment of each (creator, card) pair in ``entries``."""
    from app.services.recurring_kinds import is_card_installment

    pairs = {(e.user_id, e.account_id) for e in entries if e.account_id is not None}
    if not pairs:
        return []
    rows = (
        db.query(BudgetEntry)
        .filter(tuple_(BudgetEntry.user_id, BudgetEntry.account_id).in_(sorted(pairs)),
                BudgetEntry.is_active.is_(True),
                BudgetEntry.installment_reviewed_at.isnot(None))
        .order_by(BudgetEntry.id)
        .all()
    )
    return [e for e in rows if is_card_installment(e, db.get(Account, e.account_id))]


def held_assignment(db: Session, entries, through: date) -> Dict[Tuple[int, date], int]:
    """``{(entry id, occurrence day): transaction id}``: the held months of the
    universe of ``entries`` (every active, reviewed card installment of each of
    their (creator, card) pairs) through the day ``through``, and the candidate
    each one is held by.

    Each due unrecorded occurrence with no linked row (posted or pending) takes
    one unused candidate. Occurrences go in order of (day, entry id); each
    takes, of its unused candidates, the one with the smallest day gap, then
    the earliest ``transaction_date``, then the lowest id. The result depends
    only on the universe and ``through``.
    """
    from app.services.forecast import _linked_rows, _naive, unrecorded_occurrences

    universe = _universe(db, list(entries))
    if not universe:
        return {}
    linked = {(entry_id, _naive(when).date()) for entry_id, when, _, _ in _linked_rows(
        db, [e.id for e in universe], occurrence_match=True)}
    unrecorded = unrecorded_occurrences(db, universe, through)
    open_months: List[Tuple[date, int]] = []
    candidates: Dict[Tuple[int, date], List[Transaction]] = {}
    for entry in universe:
        days = [occ for occ in unrecorded[entry.id] if (entry.id, occ.date()) not in linked]
        for day, found in duplicate_candidates(db, entry, days).items():
            candidates[(entry.id, day)] = found
            open_months.append((day, entry.id))

    used: set = set()
    held: Dict[Tuple[int, date], int] = {}
    for day, entry_id in sorted(open_months):
        free = [txn for txn in candidates[(entry_id, day)] if txn.id not in used]
        if not free:
            continue
        best = min(free, key=lambda txn: (abs((txn.transaction_date.date() - day).days),
                                          txn.transaction_date, txn.id))
        used.add(best.id)
        held[(entry_id, day)] = best.id
    return held


def held_occurrences(db: Session, entries, through: date) -> Counter:
    """``Counter[(entry id, occurrence day)]`` of the held months of the
    universe of ``entries`` (``held_assignment``'s keys). Callers read only
    their own keys."""
    return Counter(held_assignment(db, entries, through).keys())

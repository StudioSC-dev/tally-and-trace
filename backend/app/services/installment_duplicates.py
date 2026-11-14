"""Possible duplicates of an auto-posted entry's months, and the months they hold (STU-343).

A **candidate** for occurrence ``o`` of entry ``e`` is a transaction that is a
DEBIT on ``e``'s account (a card, or a cash entry's bank account), owned by
``e``'s creator, linked to no entry, in the account's currency for exactly
``e.amount``, dated within three days of ``o``'s
effective date (a forced date, services/payment_dates.py, is where the charge is
expected; the keys stay nominal), posted or pending. Candidates are the creator's rows only: a link counts only
for a row the entry's creator owns (``forecast._linked_rows``).

A month is **held** when it is due, unrecorded, has no linked row and has a
candidate not already used by another held month. The assignment is canonical
per (creator, account): it is computed over every active, reviewed card
installment and every active autopay cash entry of that creator on that account
(the universe), whatever subset a caller passes and whatever the caller can
see, so every caller sees the same held months.

Models are imported at module level; ``forecast`` helpers are imported inside
the functions, so ``forecast`` can import this module without a cycle.
"""
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy import or_, tuple_
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType
from app.services.payment_dates import Moved, effective, load_entry_overrides

WINDOW_DAYS = 3  # a candidate is dated within this many days of the occurrence


def duplicate_candidates(db: Session, entry, occurrences: Iterable[datetime],
                         moved: Optional[Moved] = None) -> Dict[date, List[Transaction]]:
    """``{occurrence day: [candidate]}`` for ``entry``'s nominal ``occurrences``,
    one query, each window centred on the effective date (``moved``).

    Days with no candidate are left out. Each list is in id order; a
    transaction may be listed under two days.
    """
    days = {occ.date(): effective(moved, occ.date()) for occ in sorted(occurrences)}
    if not days or entry.account_id is None:
        return {}
    card = db.get(Account, entry.account_id)
    if card is None:
        return {}
    window = timedelta(days=WINDOW_DAYS)
    low = datetime.combine(min(days.values()) - window, datetime.min.time())
    high = datetime.combine(max(days.values()) + window + timedelta(days=1),
                            datetime.min.time())
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
    for day, centre in days.items():
        found = [txn for txn in rows
                 if abs((txn.transaction_date.date() - centre).days) <= WINDOW_DAYS]
        if found:
            out[day] = found
    return out


def _universe(db: Session, entries) -> List[BudgetEntry]:
    """Every active, reviewed card installment and active autopay cash entry of
    each (creator, account) pair in ``entries``."""
    return _read_universe(db, {(e.user_id, e.account_id) for e in entries
                               if e.account_id is not None})


def _read_universe(db: Session, pairs) -> List[BudgetEntry]:
    from app.services.recurring_kinds import auto_posts, is_card_installment

    if not pairs:
        return []
    rows = (
        db.query(BudgetEntry)
        .filter(tuple_(BudgetEntry.user_id, BudgetEntry.account_id).in_(sorted(pairs)),
                BudgetEntry.is_active.is_(True),
                or_(BudgetEntry.installment_reviewed_at.isnot(None),
                    BudgetEntry.auto_post_enabled.is_(True)))
        .order_by(BudgetEntry.id)
        .all()
    )
    out = []
    for e in rows:
        account = db.get(Account, e.account_id)
        if (e.installment_reviewed_at is not None if is_card_installment(e, account)
                else e.auto_post_enabled and auto_posts(e, account)):
            out.append(e)
    return out


def held_assignment(db: Session, entries, through: date) -> Dict[Tuple[int, date], int]:
    """``{(entry id, occurrence day): transaction id}``: the held months of the
    universe of ``entries`` (``_universe``) through the day ``through``, and the
    candidate each one is held by.

    Each due unrecorded occurrence with no linked row (posted or pending) takes
    one unused candidate. Occurrences go in order of (effective date, entry
    id); each takes, of its unused candidates, the one with the smallest day gap
    from that date, then the earliest ``transaction_date``, then the lowest id.
    The result depends only on the universe, its forced dates and ``through``.

    A candidate belongs to one (creator, account) pair, so each pair's held
    months depend on that pair's entries alone. Inside a request with a context
    (``app/core/context.py``) they are computed once per pair, for every pair the
    request may walk (``RequestContext.entry_pairs``) on the first call.
    """
    from app.core.context import context_of

    entries = list(entries)
    ctx = context_of(db)
    if ctx is None:
        universe = _universe(db, entries)
        return _held_assignment(db, universe, through) if universe else {}
    pairs = {(e.user_id, e.account_id) for e in entries if e.account_id is not None}
    held: Dict[Tuple[int, date], int] = {}
    for by_pair in ctx.by_id(("held", through), pairs,
                             lambda wanted: _held_by_pair(db, wanted, through),
                             universe=ctx.entry_pairs).values():
        held.update(by_pair or {})
    return held


def _held_by_pair(db: Session, pairs, through: date) -> Dict[tuple, Dict[Tuple[int, date], int]]:
    """``{(creator, account): held_assignment}`` of ``pairs``, in one pass."""
    universe = _read_universe(db, set(pairs))
    if not universe:
        return {}
    pair_of = {e.id: (e.user_id, e.account_id) for e in universe}
    out: Dict[tuple, Dict[Tuple[int, date], int]] = {}
    for key, txn_id in _held_assignment(db, universe, through).items():
        out.setdefault(pair_of[key[0]], {})[key] = txn_id
    return out


def _held_assignment(db: Session, universe: List[BudgetEntry], through: date
                     ) -> Dict[Tuple[int, date], int]:
    from app.services.forecast import _linked_rows, _naive, unrecorded_occurrences

    linked = {(entry_id, _naive(when).date()) for entry_id, when, _, _ in _linked_rows(
        db, [e.id for e in universe], occurrence_match=True)}
    unrecorded = unrecorded_occurrences(db, universe, through)
    forced = load_entry_overrides(db, [e.id for e in universe])
    wanted = {}
    for entry in universe:
        moved = forced.get(entry.id)
        wanted[entry.id] = (moved, [occ for occ in unrecorded[entry.id]
                                    if (entry.id, occ.date()) not in linked])
    found = _candidates(db, universe, wanted)
    open_months: List[Tuple[date, int, date]] = []
    candidates: Dict[Tuple[int, date], List[Transaction]] = {}
    for entry in universe:
        moved = wanted[entry.id][0]
        for day, rows in found.get(entry.id, {}).items():
            candidates[(entry.id, day)] = rows
            open_months.append((effective(moved, day), entry.id, day))

    used: set = set()
    held: Dict[Tuple[int, date], int] = {}
    for centre, entry_id, day in sorted(open_months):
        free = [txn for txn in candidates[(entry_id, day)] if txn.id not in used]
        if not free:
            continue
        best = min(free, key=lambda txn: (abs((txn.transaction_date.date() - centre).days),
                                          txn.transaction_date, txn.id))
        used.add(best.id)
        held[(entry_id, day)] = best.id
    return held


def _candidates(db: Session, entries: List[BudgetEntry], wanted: Dict[int, tuple]
                ) -> Dict[int, Dict[date, List[Transaction]]]:
    """``{entry id: duplicate_candidates(entry, occurrences, moved)}`` for every
    entry of ``wanted`` (``{entry id: (moved, occurrences)}``), in one query: the
    rows of every entry's (account, creator) over the span of all their windows,
    each entry then keeping its own as ``duplicate_candidates`` selects them."""
    days = {e.id: {occ.date(): effective(wanted[e.id][0], occ.date())
                   for occ in sorted(wanted[e.id][1])}
            for e in entries if e.account_id is not None and wanted[e.id][1]}
    cards = {e.id: db.get(Account, e.account_id) for e in entries if e.id in days}
    days = {i: d for i, d in days.items() if cards[i] is not None}
    if not days:
        return {}
    window = timedelta(days=WINDOW_DAYS)
    centres = [c for d in days.values() for c in d.values()]
    low = datetime.combine(min(centres) - window, datetime.min.time())
    high = datetime.combine(max(centres) + window + timedelta(days=1), datetime.min.time())
    by_id = {e.id: e for e in entries}
    rows = (
        db.query(Transaction)
        .filter(Transaction.transaction_type == TransactionType.DEBIT,
                tuple_(Transaction.account_id, Transaction.user_id).in_(
                    sorted({(by_id[i].account_id, by_id[i].user_id) for i in days})),
                Transaction.budget_entry_id.is_(None),
                Transaction.transaction_date >= low,
                Transaction.transaction_date < high)
        .order_by(Transaction.id)
        .all()
    )
    out: Dict[int, Dict[date, List[Transaction]]] = {}
    for entry_id, entry_days in days.items():
        entry, card = by_id[entry_id], cards[entry_id]
        mine = [txn for txn in rows
                if txn.account_id == entry.account_id and txn.user_id == entry.user_id
                and txn.currency == card.currency and txn.amount == entry.amount]
        for day, centre in entry_days.items():
            found = [txn for txn in mine
                     if abs((txn.transaction_date.date() - centre).days) <= WINDOW_DAYS]
            if found:
                out.setdefault(entry_id, {})[day] = found
    return out


def held_occurrences(db: Session, entries, through: date) -> Counter:
    """``Counter[(entry id, occurrence day)]`` of the held months of the
    universe of ``entries`` (``held_assignment``'s keys). Callers read only
    their own keys."""
    return Counter(held_assignment(db, entries, through).keys())

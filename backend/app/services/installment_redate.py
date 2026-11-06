"""Re-date existing card installments onto the statement close (PR3).

A card installment created after PR3 is stored monthly on the card's close day
(``routers/budget_entries._installment_on_close``). This module converts the
ones stored before: it is the only conversion path, driven by
``scripts/redate_card_installments.py`` (docs/installment-redate.md).

It covers every **legacy** card installment (``recurring_kinds
.is_card_installment`` but not ``is_normalised_installment``) on a card with a
statement cycle, active or paused, with ``max_occurrences > 0``. Each entry
runs in its own savepoint and is either converted whole or refused and left
unchanged; its transaction then ends (committed with ``apply``, rolled back in
a dry run), so no lock is held into the next entry.

**Per entry.**

1. Locks, in ``core/locking.py`` order: the creator's budget lock, the entry
   (re-checked on the locked row), each linked row (``forecast._linked_rows``
   with ``occurrence_match``, the creator's) in ascending id, then the card,
   whose cycle settings are re-read from the locked row. Allocations are
   locked last, inside ``redate_row``.
2. Refusals, before anything is written: a cadence other than monthly; a
   linked row not on the installment's card (a hand-linked bank debit:
   stamping ``occurrence_date`` on it would change which occurrence it
   suppresses); a row whose occurrence day and ``transaction_date`` are on
   different statements; two rows on one statement; a posted row on or after
   the new ``next_occurrence`` or a pending one after it; a new date outside
   the record-date range.
3. Map: each linked row's ``transaction_date`` and ``occurrence_date`` both
   become the close of the statement its ``transaction_date`` is on; the
   entry's ``next_occurrence`` becomes the close of its own statement (time of
   day kept), ``anchor_day`` the close day and ``day_rule`` None.
   ``is_active``, ``max_occurrences`` and ``occurrences_paid_offset`` are never
   written.
4. Checks around the write, each refusing the entry (the savepoint is rolled
   back) unless the mapped "before" equals the "after":

   - the held-month assignment (``installment_duplicates.held_assignment``)
     over the entry's (creator, card) universe through ``today + 62`` days,
     including which candidate holds each month;
   - the card's billed installment occurrences as the forecast computes them
     (``forecast._billed_card_occurrences``), at ``start`` = today and at
     every remaining occurrence of the entry's schedule, old days and new
     closes, on or after today;
   - the entry's linked-row membership (``_linked_rows`` with
     ``occurrence_match``);
   - ``max_occurrences``, ``occurrences_paid_offset`` and the paid count;
   - the line-item balance of every affected statement.

The report lists ids, dates and refusal reasons only, never an amount.
"""
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core import locking
from app.core.record_dates import refuse_record_date
from app.core.time import manila_today, utc_now
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
from app.services.recurrence import canon
from app.services.statements import (
    iter_cycles_from, resolve_cycle_fields, statement_balance, statement_close)

HELD_HORIZON_DAYS = 62


class Refused(Exception):
    """An entry left unchanged; the message is the report's reason."""


@dataclass
class RowChange:
    txn_id: int
    old_date: date
    new_date: date
    old_occurrence: Optional[date]


@dataclass
class EntryResult:
    entry_id: int
    card_id: Optional[int]
    status: str  # "converted", "refused" or "skipped"
    reason: Optional[str] = None
    old_next: Optional[date] = None
    new_next: Optional[date] = None
    old_anchor: Optional[int] = None
    new_anchor: Optional[int] = None
    rows: List[RowChange] = field(default_factory=list)

    def lines(self) -> List[str]:
        head = f"entry {self.entry_id} card {self.card_id}"
        if self.status == "refused":
            return [f"{head}: REFUSED: {self.reason}"]
        if self.status == "skipped":
            return [f"{head}: skipped: {self.reason}"]
        out = [f"{head}: next {self.old_next} -> {self.new_next}, "
               f"anchor {self.old_anchor} -> {self.new_anchor}"]
        for row in self.rows:
            occurrence = row.old_occurrence.isoformat() if row.old_occurrence else "none"
            out.append(f"  txn {row.txn_id}: date {row.old_date} -> {row.new_date}, "
                       f"occurrence {occurrence} -> {row.new_date}")
        return out


def _day(value: datetime) -> date:
    return canon(value).date()


def _on(value: datetime, day: date) -> datetime:
    """``value`` moved onto ``day``, its time of day kept (UTC components, naive)."""
    return canon(value).replace(year=day.year, month=day.month, day=day.day)


def _is_legacy(entry: BudgetEntry, card: Optional[Account]) -> bool:
    from app.services.recurring_kinds import (
        installment_close_day, is_normalised_installment)

    return (installment_close_day(entry, card) is not None
            and (entry.max_occurrences or 0) > 0
            and not is_normalised_installment(entry, card))


def candidate_ids(db: Session) -> List[int]:
    """Ids of every legacy card installment on a card with a cycle, active or
    paused, with payments left, in id order."""
    rows = (db.query(BudgetEntry)
            .join(Account, Account.id == BudgetEntry.account_id)
            .filter(Account.account_type == AccountType.CREDIT,
                    BudgetEntry.max_occurrences > 0)
            .order_by(BudgetEntry.id)
            .all())
    return [e.id for e in rows if _is_legacy(e, db.get(Account, e.account_id))]


def redate_row(db: Session, txn: Transaction, new_date: datetime) -> None:
    """Move a row's ``transaction_date`` and nothing else, keeping its budgets right.

    The account, amount, type and posted state do not change, so the budgets
    the row counts toward are the same before and after: they are read
    (``_counted_allocations``), locked in ascending id (``_lock_allocations``,
    the last step of the lock order), the date set and the row's
    ``updated_at`` bumped, then each budget's total recomputed at the old and
    the new date (``_recompute_budget_total``). Balances are untouched. Used
    by this module only; the general transaction update is not.
    """
    from app.routers.transactions import (
        _counted_allocations, _lock_allocations, _recompute_budget_total)

    old_date = txn.transaction_date
    allocations = _lock_allocations(db, _counted_allocations(
        db, user_id=txn.user_id, transaction_type=txn.transaction_type, amount=txn.amount,
        is_posted=txn.is_posted, allocation_id=txn.allocation_id,
        category_id=txn.category_id))
    txn.transaction_date = new_date
    txn.updated_at = utc_now()
    db.flush()
    for allocation in allocations:
        _recompute_budget_total(db, allocation, [old_date, new_date])


# --- snapshots --------------------------------------------------------------------------------

def _card_installments(db: Session, card: Account) -> List[BudgetEntry]:
    """Every active card installment on ``card``, whoever created it: the
    entries whose billed months the forecast would project on it."""
    from app.services.recurring_kinds import is_card_installment

    rows = (db.query(BudgetEntry)
            .filter(BudgetEntry.account_id == card.id, BudgetEntry.is_active.is_(True))
            .order_by(BudgetEntry.id).all())
    return [e for e in rows if is_card_installment(e, card)]


def _billed(db: Session, card: Account, start: date) -> Counter:
    """``Counter[(entry id, day)]`` of the card's billed installment occurrences
    with the forecast's window starting on ``start``."""
    from app.services.forecast import _billed_card_occurrences

    entries = _card_installments(db, card)
    if not entries:
        return Counter()
    begin = datetime.combine(start, time())
    return Counter((entry.id, nominal.date()) for entry, _, nominal in _billed_card_occurrences(
        db, entries, {card.id: card}, begin, datetime.max))


def _linked(db: Session, entry_id: int) -> set:
    from app.services.forecast import _linked_rows

    return {(txn_id, canon(when).date()) for _, when, txn_id, _ in _linked_rows(
        db, [entry_id], occurrence_match=True)}


def _held(db: Session, entry: BudgetEntry, through: date) -> Dict[Tuple[int, date], int]:
    from app.services.installment_duplicates import held_assignment

    return held_assignment(db, [entry], through)


def _paid(db: Session, entry: BudgetEntry) -> Optional[int]:
    from app.services.forecast import occurrences_paid

    return occurrences_paid(db, [entry])[entry.id]


def _statement_balances(db: Session, card: Account, closes: Iterable[date]) -> Dict[date, object]:
    """The line-item balance of each statement closing on one of ``closes``."""
    rows = (db.query(Transaction)
            .filter(Transaction.account_id == card.id,
                    Transaction.transaction_type.in_([TransactionType.DEBIT,
                                                      TransactionType.CREDIT]))
            .all())
    out = {}
    for close in sorted(set(closes)):
        out[close] = statement_balance(rows, _window_start(card, close),
                                       datetime.combine(close, time()))
    return out


def _window_start(card: Account, close: date) -> datetime:
    """The previous close of the statement closing on ``close``: its cycle's
    ``window_start`` (``statements.iter_cycles_from``), as ``due_in_order`` reads it."""
    return next(iter_cycles_from(card, close, datetime.min, through=close,
                                 due_overrides={}))["window_start"]


def _schedule_days(entry: BudgetEntry) -> List[date]:
    from app.services.forecast import _naive, capped_distinct_days

    start = _naive(entry.next_occurrence)
    return [occ.date() for occ in capped_distinct_days(
        entry, start, datetime.max, max_steps=2 * (entry.max_occurrences or 0) + 2)]


# --- one entry --------------------------------------------------------------------------------

def _redate_entry(db: Session, entry_id: int, today: date) -> EntryResult:
    """Lock, check, map and write one entry inside the caller's savepoint.

    Raises ``Refused`` (the caller rolls the savepoint back) for any refusal."""
    found = db.get(BudgetEntry, entry_id)
    if found is None:
        return EntryResult(entry_id, None, "skipped", "entry is gone")
    locking.lock_owner_budgets(db, found.user_id)
    entry = locking.lock_entry(db, entry_id)
    if entry is None:
        return EntryResult(entry_id, None, "skipped", "entry is gone")
    card_id = entry.account_id
    if not _is_legacy(entry, db.get(Account, card_id) if card_id else None):
        return EntryResult(entry_id, card_id, "skipped", "no longer a legacy card installment")

    from app.services.forecast import _linked_rows

    selected = sorted(txn_id for _, _, txn_id, _ in _linked_rows(
        db, [entry.id], occurrence_match=True))
    rows = [locking.lock_transaction(db, txn_id) for txn_id in selected]
    if any(row is None for row in rows) or sorted(
            txn_id for _, _, txn_id, _ in _linked_rows(
                db, [entry.id], occurrence_match=True)) != selected:
        raise Refused("its linked transactions changed while they were locked")
    card = locking.lock_accounts(db, [card_id]).get(card_id)
    if not _is_legacy(entry, card):
        return EntryResult(entry_id, card_id, "skipped", "no longer a legacy card installment")
    close_day = resolve_cycle_fields(card)[0]

    # --- refusals before any write
    if entry.cadence != RecurrenceFrequency.MONTHLY:
        raise Refused(f"cadence is {entry.cadence.value}, not monthly")
    for row in rows:
        if row.account_id != entry.account_id:
            raise Refused(f"linked transaction {row.id} is not on the installment's card")
    old_next = canon(entry.next_occurrence)
    new_next_day = statement_close(card, old_next.date())
    plan: List[Tuple[Transaction, date]] = []
    seen: Dict[date, int] = {}
    for row in rows:
        identity = _day(row.occurrence_date or row.transaction_date)
        close = statement_close(card, _day(row.transaction_date))
        if statement_close(card, identity) != close:
            raise Refused(f"linked transaction {row.id}'s occurrence and date are on "
                          "different statements")
        if close in seen:
            raise Refused(f"linked transactions {seen[close]} and {row.id} are on the same "
                          "statement")
        seen[close] = row.id
        if row.is_posted and close >= new_next_day:
            raise Refused(f"posted linked transaction {row.id} would be on or after the new "
                          "next occurrence")
        if not row.is_posted and close > new_next_day:
            raise Refused(f"pending linked transaction {row.id} would be after the new next "
                          "occurrence")
        try:
            refuse_record_date(close)
        except HTTPException:
            raise Refused(f"linked transaction {row.id}'s new date is outside the "
                          "record-date range") from None
        plan.append((row, close))

    # --- before
    through = today + timedelta(days=HELD_HORIZON_DAYS)
    old_days = _schedule_days(entry)
    day_map = {day: statement_close(card, day) for day in old_days}
    counts_before = (entry.max_occurrences, entry.occurrences_paid_offset, _paid(db, entry))
    held_before = _held(db, entry, through)
    linked_before = _linked(db, entry.id)
    boundaries = sorted({today, *(d for d in old_days if d >= today),
                         *(d for d in day_map.values() if d >= today)})
    billed_before = {start: _billed(db, card, start) for start in boundaries}
    affected = {close for _, close in plan} | {
        statement_close(card, _day(row.transaction_date)) for row, _ in plan}
    balances_before = _statement_balances(db, card, affected)

    def mapped(day: date) -> date:
        return day_map.get(day) or statement_close(card, day)

    def map_keys(counter_or_dict):
        if isinstance(counter_or_dict, Counter):
            out = Counter()
            for (eid, day), n in counter_or_dict.items():
                out[(eid, mapped(day) if eid == entry.id else day)] += n
            return out
        return {(eid, mapped(day) if eid == entry.id else day): value
                for (eid, day), value in counter_or_dict.items()}

    # --- write
    result = EntryResult(entry_id, card_id, "converted", old_next=old_next.date(),
                         new_next=new_next_day, old_anchor=entry.anchor_day,
                         new_anchor=close_day)
    for row, close in plan:
        old_date = _day(row.transaction_date)
        old_occurrence = _day(row.occurrence_date) if row.occurrence_date else None
        new_date = _on(row.transaction_date, close)
        if old_date == close and old_occurrence == close:
            continue
        row.occurrence_date = new_date
        redate_row(db, row, new_date)
        result.rows.append(RowChange(row.id, old_date, close, old_occurrence))
    entry.next_occurrence = _on(entry.next_occurrence, new_next_day)
    entry.anchor_day = close_day
    entry.day_rule = None
    entry.updated_at = utc_now()
    db.flush()
    db.expire_all()
    entry = db.get(BudgetEntry, entry_id)
    card = db.get(Account, card_id)

    # --- after
    counts_after = (entry.max_occurrences, entry.occurrences_paid_offset, _paid(db, entry))
    if counts_after != counts_before:
        raise Refused("the payment counts would change")
    if _held(db, entry, through) != map_keys(held_before):
        raise Refused("a possible duplicate would hold a different month")
    if _linked(db, entry.id) != {(txn_id, mapped(day)) for txn_id, day in linked_before}:
        raise Refused("its linked transactions would stand for different months")
    for start in boundaries:
        if _billed(db, card, start) != map_keys(billed_before[start]):
            raise Refused(f"the forecast from {start.isoformat()} would bill different months")
    if _statement_balances(db, card, affected) != balances_before:
        raise Refused("a statement balance would change")
    return result


def run(db: Session, *, apply: bool, today: Optional[date] = None) -> List[EntryResult]:
    """Convert every legacy card installment; each entry in its own savepoint.

    Each entry's transaction ends before the next entry's owner lock is taken,
    so no lock is held across entries (the ``core/locking.py`` order holds per
    entry): with ``apply`` it is committed, without it rolled back. A dry run
    therefore checks each entry against the stored data, without the changes
    an apply would already have made to the entries before it, and writes
    nothing.
    """
    today = today or manila_today()
    results: List[EntryResult] = []
    try:
        for entry_id in candidate_ids(db):
            savepoint = db.begin_nested()
            try:
                result = _redate_entry(db, entry_id, today)
            except Refused as exc:
                savepoint.rollback()
                db.expire_all()
                found = db.get(BudgetEntry, entry_id)
                result = EntryResult(entry_id, found.account_id if found else None,
                                     "refused", str(exc))
            except Exception:
                savepoint.rollback()
                raise
            else:
                savepoint.commit()
            results.append(result)
            if apply:
                db.commit()
            else:
                db.rollback()  # releases every lock the entry took
    finally:
        if not apply:
            db.rollback()
    return results


def summary(results: List[EntryResult]) -> List[str]:
    lines = [line for result in results for line in result.lines()]
    converted = [r for r in results if r.status == "converted"]
    lines.append(f"changes: {len(converted)} entries, "
                 f"{sum(len(r.rows) for r in converted)} transactions; "
                 f"refused: {sum(r.status == 'refused' for r in results)}; "
                 f"skipped: {sum(r.status == 'skipped' for r in results)}")
    return lines

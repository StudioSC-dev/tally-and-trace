"""Change one card's statement closing day, all or nothing (STU-744).

The app keeps one closing day for a card's whole history
(``statements.resolve_cycle_fields``), so a new day re-places every row and
re-keys every statement. ``PUT /accounts/{id}`` therefore refuses (409) a
close-day change while the card has a card installment with payments left or a
printed due. This module makes the change for one card, driven by
``scripts/change_card_close_day.py`` (docs/close-day-change.md), inside one
savepoint of the caller's transaction: either everything below is written or
nothing is.

1. Locks, in ``core/locking.py`` order: the budget lock of every creator of an
   open installment on the card (ascending owner id), each such entry
   (ascending id), each linked row (``forecast._linked_rows`` with
   ``occurrence_match``, ascending id), then the card. The installment set and
   the linked rows are re-read under the card lock and must not have changed.
   The re-date of each entry (``installment_redate.redate_one``) takes the
   same locks again (all already held) and then the allocations.
2. Refusals before any write: not a credit card, no statement cycle, a legacy
   card with only ``due_date``, a day outside 1-31, the day it already has.
3. Before: every line item of the card placed on its statement under the old
   day, read on ``today`` (``statements.statement_day``).
4. Write ``billing_cycle_start`` (the store's flush hook repopulates the
   card's stored statements). Move each ``card_statement_due_overrides`` and
   ``card_statement_minimums`` row from its old close to the new close of the
   same calendar month (the new day clamped to the month's length, as the
   cycle code clamps). Refused when a row is not on an old close, a moved
   printed due would not be after its close or out of order
   (``statements.due_override_conflicts``), or a moved minimum would land on a
   statement not yet closed.
5. Re-date every card installment on the card with payments left
   (``max_occurrences > 0``, active or paused, any creator) onto the new close
   with the re-date's own mapping and checks. One refused entry refuses the
   whole change; every reason is reported. So does a date on an old close
   that would move anywhere but the new close of the same month (``_same_month``:
   a change to an earlier day would move each charge a month on). Completed
   installments and their rows are not touched.
6. After: every re-dated entry is normalised on the new close; the card's
   total of statement line items (sum and count over every statement) is the
   same; each closed statement, its old close mapped to the new close of the
   same month, holds the same rows, count and balance unless the caller
   accepts the history shift (the affected statements and the moved row ids
   are reported either way); ``statements_store.verify_card`` passes.

The report lists ids, dates and refusal reasons only, never an amount.
"""
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core import locking
from app.core.time import manila_today, utc_now
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.card_statement_due_override import CardStatementDueOverride
from app.models.card_statement_minimum import CardStatementMinimum
from app.models.transaction import Transaction, TransactionType
from app.services import installment_redate
from app.services.statements import (
    _clamp_day, _row_amount, _split_card_rows, cycle_balances, due_override_conflicts,
    iter_cycles_from, place_days, resolve_cycle_fields, statement_close, statement_day)


class _Refused(Exception):
    """The change is refused before anything is written; the message is the reason."""


@dataclass
class Moved:
    """A statement-keyed row moved from ``old_close`` to ``new_close``."""
    row_id: int
    old_close: date
    new_close: date


@dataclass
class StatementShift:
    """A closed statement whose rows, count or balance would differ."""
    old_close: date
    new_close: date
    moved_in: List[int]
    moved_out: List[int]


@dataclass
class ChangeResult:
    card_id: int
    new_day: int
    old_day: Optional[int] = None
    status: str = "refused"  # "changed" or "refused"
    reasons: List[str] = field(default_factory=list)
    dues: List[Moved] = field(default_factory=list)
    minimums: List[Moved] = field(default_factory=list)
    entries: List[installment_redate.EntryResult] = field(default_factory=list)
    shifts: List[StatementShift] = field(default_factory=list)
    history_accepted: bool = False

    def lines(self) -> List[str]:
        out = [f"card {self.card_id}: close day {self.old_day} -> {self.new_day}"]
        for kind, rows in (("printed due", self.dues), ("minimum due", self.minimums)):
            for row in rows:
                out.append(f"  {kind} {row.row_id}: statement {row.old_close} -> "
                           f"{row.new_close}")
        for entry in self.entries:
            out.extend(f"  {line}" for line in entry.lines())
        for shift in self.shifts:
            out.append(f"  past statement {shift.old_close} -> {shift.new_close}: "
                       f"moved in {_ids(shift.moved_in)}; moved out {_ids(shift.moved_out)}")
        if self.shifts:
            out.append("  past statements change: "
                       + ("accepted" if self.history_accepted else "not accepted"))
        if self.status == "changed":
            out.append(f"result: CHANGED: {len(self.entries)} entries, "
                       f"{sum(len(e.rows) for e in self.entries)} transactions, "
                       f"{len(self.dues)} printed dues, {len(self.minimums)} minimum dues")
        else:
            out.append("result: REFUSED (nothing written)")
            out.extend(f"  reason: {reason}" for reason in self.reasons)
        return out


def _ids(ids: List[int]) -> str:
    return ", ".join(f"txn {i}" for i in ids) if ids else "none"


def _view(card: Account, close_day: Optional[int]) -> SimpleNamespace:
    """``card``'s cycle settings with ``close_day`` as its ``billing_cycle_start``."""
    return SimpleNamespace(id=card.id, account_type=card.account_type,
                           billing_cycle_start=close_day, due_date=card.due_date,
                           days_until_due_date=card.days_until_due_date)


def new_close(old_close: date, new_day: int) -> date:
    """The close on ``new_day`` in ``old_close``'s month, clamped to its length."""
    return date(old_close.year, old_close.month,
                _clamp_day(old_close.year, old_close.month, new_day))


# --- locks ------------------------------------------------------------------------------------

def _open_installments(db: Session, card: Optional[Account]) -> List[BudgetEntry]:
    """The card installments on ``card`` with payments left, active or paused,
    any creator's (``routers.accounts._has_open_installments``), in id order."""
    from app.services.recurring_kinds import is_card_installment

    if card is None:
        return []
    rows = (db.query(BudgetEntry)
            .filter(BudgetEntry.account_id == card.id, BudgetEntry.max_occurrences > 0)
            .order_by(BudgetEntry.id).all())
    return [e for e in rows if is_card_installment(e, card)]


def _linked_ids(db: Session, entry_ids: List[int]) -> List[int]:
    from app.services.forecast import _linked_rows

    return sorted({txn_id for _, _, txn_id, _ in _linked_rows(
        db, entry_ids, occurrence_match=True)})


def _lock(db: Session, card_id: int) -> Tuple[Optional[Account], List[int]]:
    """Take every lock in ``core/locking.py`` order; ``(card, entry ids)``."""
    entries = _open_installments(db, db.get(Account, card_id))
    entry_ids = [e.id for e in entries]
    for owner_id in sorted({e.user_id for e in entries}):
        locking.lock_owner_budgets(db, owner_id)
    for entry_id in entry_ids:
        locking.lock_entry(db, entry_id)
    linked = _linked_ids(db, entry_ids)
    for txn_id in linked:
        locking.lock_transaction(db, txn_id)
    card = locking.lock_accounts(db, [card_id]).get(card_id)
    if ([e.id for e in _open_installments(db, card)] != entry_ids
            or _linked_ids(db, entry_ids) != linked):
        raise _Refused("its installments or their linked transactions changed while they "
                       "were locked; run it again")
    return card, entry_ids


# --- statements -------------------------------------------------------------------------------

Placed = Dict[date, Tuple[int, Decimal, frozenset]]


def _lines(db: Session, card: Account) -> list:
    """The card's line items (``statements._split_card_rows``), posted or not."""
    rows = (db.query(Transaction)
            .filter(or_(Transaction.account_id == card.id,
                        Transaction.transfer_from_account_id == card.id,
                        Transaction.transfer_to_account_id == card.id))
            .order_by(Transaction.id).all())
    lines, _ = _split_card_rows(card.id, rows, keep_source=True)
    return lines


def _line_id(line) -> int:
    source = getattr(line, "source", None)
    return source.id if source is not None else line.id


def _signed(line) -> Decimal:
    if line.transaction_type == TransactionType.DEBIT:
        return _row_amount(line)
    if line.transaction_type == TransactionType.CREDIT:
        return -_row_amount(line)
    return Decimal("0")


def _placed(lines: list, view, today: date) -> Placed:
    """``{close: (line count, line balance, row ids)}`` of every statement holding
    a line item under ``view``'s settings, read on ``today``."""
    found: Dict[date, list] = {}
    for line in lines:
        close = statement_close(view, statement_day(line, today))
        found.setdefault(close, []).append(line)
    return {close: (len(held), sum((_signed(x) for x in held), Decimal("0")),
                    frozenset(_line_id(x) for x in held))
            for close, held in found.items()}


def _total(lines: list, view, today: date) -> Tuple[Decimal, int]:
    """The sum and count of the line items over every statement from the first
    line's to the last's under ``view``, walked as the cycle code walks them."""
    days = [statement_day(line, today) for line in lines]
    if not days:
        return Decimal("0"), 0
    cycles = list(iter_cycles_from(view, min(days), datetime.min, through=max(days),
                                   due_overrides={}))
    placed = place_days(days, cycles)
    balances = cycle_balances(lines, placed, len(cycles))
    return sum(balances, Decimal("0")), sum(1 for i in placed if i is not None)


def _shifts(before: Placed, after: Placed, old_day: int, new_day: int,
            today: date) -> List[StatementShift]:
    """Each closed statement (under either day) whose rows, count or balance
    differ, its old close mapped to the new close of the same month."""
    months = {(c.year, c.month) for c in before if c < today} | {
        (c.year, c.month) for c in after if c < today}
    empty = (0, Decimal("0"), frozenset())
    out = []
    for year, month in sorted(months):
        old = date(year, month, _clamp_day(year, month, old_day))
        new = date(year, month, _clamp_day(year, month, new_day))
        was, now = before.get(old, empty), after.get(new, empty)
        if was != now:
            out.append(StatementShift(old, new, sorted(now[2] - was[2]), sorted(was[2] - now[2])))
    return out


# --- statement-keyed rows ---------------------------------------------------------------------

def _plan_moves(db: Session, card: Account, old_view, new_view, new_day: int, today: date,
                reasons: List[str]) -> Tuple[list, list]:
    """``(dues, minimums)``: ``[(row, new close)]`` for each, with any refusal
    added to ``reasons``."""
    dues = (db.query(CardStatementDueOverride)
            .filter(CardStatementDueOverride.account_id == card.id)
            .order_by(CardStatementDueOverride.statement_close).all())
    minimums = (db.query(CardStatementMinimum)
                .filter(CardStatementMinimum.account_id == card.id)
                .order_by(CardStatementMinimum.statement_close).all())
    plan_dues, plan_minimums = [], []
    for kind, rows, plan in (("printed due", dues, plan_dues),
                             ("minimum due", minimums, plan_minimums)):
        for row in rows:
            if statement_close(old_view, row.statement_close) != row.statement_close:
                reasons.append(f"{kind} {row.id} is on {row.statement_close}, not a statement "
                               "close of the card")
                continue
            plan.append((row, new_close(row.statement_close, new_day)))
    late = [(row, close) for row, close in plan_dues if row.due_date <= close]
    for row, close in late:
        reasons.append(f"printed due {row.id} ({row.due_date}) would not be after its new "
                       f"close {close}")
    if not late:
        conflicts = due_override_conflicts(new_view, {c: r.due_date for r, c in plan_dues})
        for close in conflicts:
            reasons.append(f"the printed due on the statement closing {close} would be out of "
                           "order with its neighbours")
    for row, close in plan_minimums:
        if close >= today:
            reasons.append(f"minimum due {row.id} would move to {close}, a statement not yet "
                           "closed")
    return plan_dues, plan_minimums


def _billed_on(row) -> date:
    """The day the bank billed ``row`` on, as if posted: the later of its own day
    and its ``posting_date``'s Manila day (``statements.statement_day``)."""
    return statement_day(SimpleNamespace(transaction_date=row.transaction_date,
                                         is_posted=True, posting_date=row.posting_date),
                         date.min)


def _gap_plan(db: Session, entry_id: int, old_view, new_view, new_day: int, today: date,
              reasons: List[str]) -> Optional[dict]:
    """The re-date's ``kept`` and ``next_close`` for an entry with a gap row, None
    for an entry without one, or ``{}`` with reasons added when refused.

    A gap row is a linked row billed after the old close of a month and on or
    before the new close of that month: a later close day puts it on that
    month's statement, a month before the one its occurrence stood for. It
    keeps its dates (the bank printed them); its occurrence becomes that
    statement's close. The unpaid schedule moves earlier by the same number of
    cycles: ``next_occurrence`` becomes the first close after the latest
    linked occurrence, which must equal the same-month close of the old one
    moved back by that shift."""
    entry = db.get(BudgetEntry, entry_id)
    rows = [db.get(Transaction, txn_id) for txn_id in _linked_ids(db, [entry_id])]
    kept: Dict[int, date] = {}
    occurrences: Dict[int, date] = {}
    shifts = set()
    refused = []
    for row in rows:
        billed = _billed_on(row)
        landed = statement_close(new_view, billed)
        if landed >= new_close(statement_close(old_view, billed), new_day):
            # The redate's own mapping: the close of the statement its date is on.
            occurrences[row.id] = statement_close(new_view, row.transaction_date.date())
            continue
        if not row.is_posted:
            refused.append(f"entry {entry_id}: pending linked transaction {row.id} falls "
                           "between the old and the new close; post it first")
            continue
        identity = (row.occurrence_date or row.transaction_date).date()
        shifts.add(_month_index(statement_close(new_view, identity)) - _month_index(landed))
        kept[row.id] = occurrences[row.id] = landed
    if not kept and not refused:
        return None
    by_day: Dict[date, int] = {}
    for txn_id, day in sorted(occurrences.items()):
        if day in by_day:
            refused.append(f"entry {entry_id}: linked transactions {by_day[day]} and {txn_id} "
                           f"would both stand for the occurrence on {day}")
        by_day.setdefault(day, txn_id)
    if not refused:
        next_close = statement_close(new_view, max(occurrences.values()) + timedelta(days=1))
        same_month = new_close(statement_close(old_view, entry.next_occurrence.date()), new_day)
        if len(shifts) != 1 or _month_index(same_month) - _month_index(next_close) not in shifts:
            refused.append(f"entry {entry_id}: its unpaid schedule would not move by whole "
                           f"cycles (next occurrence {entry.next_occurrence.date()} -> "
                           f"{next_close})")
        elif next_close < today:
            refused.append(f"entry {entry_id}: its next occurrence would move to {next_close}, "
                           "a statement that has already closed")
    if refused:
        reasons.extend(refused)
        return {}
    return {"kept": kept, "next_close": next_close}


def _month_index(day: date) -> int:
    return day.year * 12 + day.month


def _same_month(entry: installment_redate.EntryResult, old_day: int, new_day: int,
                reasons: List[str], shifted: bool = False) -> None:
    """Refuse a re-date that takes a date on an old close anywhere but the new
    close of the same month. The re-date maps a day to the close of the
    statement it is on under the new day; for a later day that is the same
    month's close, for an earlier one the next month's (a charge on the 14th
    is past a close on the 13th), which would move a paid installment a month
    on. Which statement such a charge belongs to is the owner's call, so it is
    refused rather than guessed."""
    def check(what: str, old: Optional[date], new: Optional[date]) -> None:
        if old is None or new is None:
            return
        if old.day == _clamp_day(old.year, old.month, old_day) and new != new_close(
                old, new_day):
            reasons.append(f"entry {entry.entry_id}: {what} on {old} would move to {new}, not "
                           f"to {new_close(old, new_day)}, the new close of the same month")

    if not shifted:  # a gap row moved the schedule earlier on purpose (``_gap_plan``)
        check("its next occurrence", entry.old_next, entry.new_next)
    for row in entry.rows:
        check(f"linked transaction {row.txn_id}", row.old_date, row.new_date)


# --- the change -------------------------------------------------------------------------------

def _change(db: Session, result: ChangeResult, accept_history_shift: bool,
            today: date) -> None:
    card, entry_ids = _lock(db, result.card_id)
    if card is None:
        raise _Refused("the card does not exist")
    result.old_day = card.billing_cycle_start
    if card.account_type != AccountType.CREDIT:
        raise _Refused("it is not a credit card")
    if card.billing_cycle_start is None:
        if card.due_date:
            raise _Refused("it has only a legacy due day (due_date); set its closing day "
                           "first")
        raise _Refused("it has no statement cycle")
    if not 1 <= result.new_day <= 31:
        raise _Refused("the closing day must be from 1 to 31")
    if result.new_day == card.billing_cycle_start:
        raise _Refused(f"it already closes on day {result.new_day}")
    old_day, new_day = card.billing_cycle_start, result.new_day
    old_view, new_view = _view(card, old_day), _view(card, new_day)
    reasons = result.reasons

    lines = _lines(db, card)
    before, total_before = _placed(lines, old_view, today), _total(lines, old_view, today)
    plan_dues, plan_minimums = _plan_moves(db, card, old_view, new_view, new_day, today,
                                           reasons)

    moved = not reasons
    gaps = {entry_id: _gap_plan(db, entry_id, old_view, new_view, new_day, today, reasons)
            for entry_id in entry_ids}

    # --- write
    card.billing_cycle_start = new_day
    card.updated_at = utc_now()
    db.flush()
    if moved:
        for plan, out in ((plan_dues, result.dues), (plan_minimums, result.minimums)):
            for row, close in plan:
                out.append(Moved(row.id, row.statement_close, close))
                row.statement_close = close
        db.flush()
    for entry_id in entry_ids:
        shift = gaps.get(entry_id)
        if shift == {}:  # refused by ``_gap_plan``; its reasons are listed
            continue
        entry_result = installment_redate.redate_one(db, entry_id, today, **(shift or {}))
        result.entries.append(entry_result)
        if entry_result.status == "refused":
            reasons.append(f"entry {entry_id}: {entry_result.reason}")
        elif entry_result.status == "converted":
            _same_month(entry_result, old_day, new_day, reasons, shifted=bool(shift))

    # --- after
    db.expire_all()
    card = db.get(Account, result.card_id)
    if resolve_cycle_fields(card) != resolve_cycle_fields(new_view):
        reasons.append("the card's closing day was not written")
    from app.services.recurring_kinds import is_normalised_installment

    for entry_id in entry_ids:
        entry = db.get(BudgetEntry, entry_id)
        if not is_normalised_installment(entry, card) and gaps.get(entry_id) != {} and not any(
                r.entry_id == entry_id and r.status == "refused" for r in result.entries):
            reasons.append(f"entry {entry_id} is not on the new close")
    for model, kind in ((CardStatementDueOverride, "printed due"),
                        (CardStatementMinimum, "minimum due")) if moved else ():
        for row in db.query(model).filter(model.account_id == card.id).order_by(model.id):
            if statement_close(new_view, row.statement_close) != row.statement_close:
                reasons.append(f"{kind} {row.id} would be on {row.statement_close}, not a "
                               "close of the card")
    lines = _lines(db, card)
    if _total(lines, new_view, today) != total_before:
        reasons.append("the card's total of statement line items would change")
    result.shifts = _shifts(before, _placed(lines, new_view, today), old_day, new_day, today)
    result.history_accepted = accept_history_shift
    if result.shifts and not accept_history_shift:
        reasons.append("past statements would change (listed above); pass the accept flag "
                       "to accept")
    if not reasons:
        _verify_store(db, card, today, reasons)


def _verify_store(db: Session, card: Account, today: date, reasons: List[str]) -> None:
    from app.core.access import viewable_account_ids
    from app.models.user import User
    from app.services.statements_store import verify_card

    got = verify_card(db, card, viewable_account_ids(db, db.get(User, card.user_id)), today)
    if not (got["rows_equal"] and got["summaries_equal"]):
        reasons.append("the stored statements would not match the rows")


def change_close_day(db: Session, card_id: int, new_day: int, *,
                     accept_history_shift: bool = False,
                     today: Optional[date] = None) -> ChangeResult:
    """Change ``card_id``'s closing day to ``new_day`` inside the caller's
    transaction, in a savepoint: written whole (``changed``) or rolled back
    (``refused``, every reason listed). Nothing is committed: the caller ends
    the transaction (``run``)."""
    today = today or manila_today()
    result = ChangeResult(card_id=card_id, new_day=new_day)
    savepoint = db.begin_nested()
    try:
        _change(db, result, accept_history_shift, today)
    except _Refused as exc:
        result.reasons.append(str(exc))
    except Exception:
        savepoint.rollback()
        raise
    if result.reasons:
        savepoint.rollback()
        db.expire_all()
        result.status = "refused"
    else:
        savepoint.commit()
        result.status = "changed"
    return result


def run(db: Session, card_id: int, new_day: int, *, apply: bool,
        accept_history_shift: bool = False, today: Optional[date] = None) -> ChangeResult:
    """The change, committed with ``apply`` when it is not refused; otherwise
    (a dry run, or a refusal) rolled back, so a dry run checks everything an
    apply would and writes nothing."""
    try:
        result = change_close_day(db, card_id, new_day,
                                  accept_history_shift=accept_history_shift, today=today)
        if apply and result.status == "changed":
            db.commit()
    finally:
        db.rollback()
    return result

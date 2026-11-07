"""Repair a card row's posted day, and list what the posted-date rule moves.

Card rows are placed on statements by ``statements.statement_day``: a posted
row by the later of its own day and its posted day, an unposted one rolled to
the cycle open today. Driven by ``scripts/repair_statement_posting.py``.

**The listing** (``moves``) reads every line item of every credit card with a
statement cycle (its charges and refunds, and each transfer out of it: a cash
advance) and lists each one whose close under the rule differs from the close
of its own day: every posted row that moves and every unposted row that
rolls. Each entry carries ids, the card, the dates, both closes, the posted
flag and whether it is linked to a budget entry that is a card installment.
Payments into a card are never moved and never listed.

**The repair** (``repair``) sets a named row's ``posting_date`` to its own day
(midnight of ``transaction_date``'s day, the stored form of a posted day), so
it returns to the statement of its own day. No column marks a row as
imported, so each row is named explicitly. A row is refused unless it is a
listed posted row (a line item of a card with a cycle, posted, whose posted day
moves it to a later statement). Locks are taken in ``core/locking.py`` order:
the owner's budget lock, the row, then the card. Around the write it checks,
refusing (the savepoint is rolled back) unless each holds: the sum of the
card's statement balances and the card's stored balance are unchanged, the
row is on the statement of its own day, and no other row of the card
changed. Budgets do not read ``posting_date``, so none is recomputed.

The report lists ids, dates and refusal reasons only, never an amount.
"""
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from typing import Iterable, List, Optional, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core import locking
from app.core.time import manila_day, manila_today, utc_now
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType
from app.services.statements import resolve_cycle_fields, statement_close, statement_day


class Refused(Exception):
    """A row left unchanged; the message is the report's reason."""


@dataclass
class Move:
    txn_id: int
    card_id: int
    own_day: date
    posted_day: Optional[date]
    old_close: date
    new_close: date
    posted: bool
    entry_id: Optional[int]
    installment: bool

    def line(self) -> str:
        posted = self.posted_day.isoformat() if self.posted_day else "none"
        return (f"  {'posted' if self.posted else 'unposted'} txn {self.txn_id} card "
                f"{self.card_id}: date {self.own_day}, posted day {posted}, close "
                f"{self.old_close} -> {self.new_close}, entry {self.entry_id or 'none'}, "
                f"installment {'yes' if self.installment else 'no'}")


@dataclass
class RepairResult:
    txn_id: int
    status: str  # "repaired" or "refused"
    reason: Optional[str] = None
    old_posted: Optional[date] = None
    old_close: Optional[date] = None
    new_close: Optional[date] = None

    def line(self, apply: bool) -> str:
        if self.status == "refused":
            return f"repair txn {self.txn_id}: REFUSED: {self.reason}"
        done = "written" if apply else "checked, rolled back (dry run)"
        return (f"repair txn {self.txn_id}: posted day {self.old_posted} -> its own day, "
                f"close {self.old_close} -> {self.new_close}: {done}")


def _card_of(row) -> Optional[int]:
    """The card a line item is billed on: its account, or the source of a
    transfer out. None for a payment into a card (never a line item)."""
    if row.transaction_type == TransactionType.TRANSFER:
        return row.transfer_from_account_id or row.account_id
    if row.transaction_type in (TransactionType.DEBIT, TransactionType.CREDIT):
        return row.account_id
    return None


def _billed_cards(db: Session, ids: Optional[Iterable[int]] = None) -> dict:
    query = db.query(Account).filter(Account.account_type == AccountType.CREDIT)
    if ids is not None:
        query = query.filter(Account.id.in_(list(ids)))
    return {a.id: a for a in query.all() if resolve_cycle_fields(a) is not None}


def _move(db: Session, row: Transaction, card: Account, today: date) -> Optional[Move]:
    own = row.transaction_date.date()
    old, new = statement_close(card, own), statement_close(card, statement_day(row, today))
    if old == new:
        return None
    entry = db.get(BudgetEntry, row.budget_entry_id) if row.budget_entry_id else None
    from app.services.recurring_kinds import is_card_installment

    return Move(row.id, card.id, own,
                manila_day(row.posting_date) if row.posting_date is not None else None,
                old, new, bool(row.is_posted), row.budget_entry_id,
                entry is not None and is_card_installment(entry, card))


def moves(db: Session, today: date) -> List[Move]:
    """Every card line item whose close under the posted-date rule, read on
    ``today``, differs from its own day's close: posted first, then unposted,
    each in card then id order."""
    cards = _billed_cards(db)
    if not cards:
        return []
    ids = list(cards)
    rows = (db.query(Transaction)
            .filter(or_(Transaction.account_id.in_(ids),
                        Transaction.transfer_from_account_id.in_(ids)))
            .order_by(Transaction.id).all())
    out = []
    for row in rows:
        card_id = _card_of(row)
        if card_id not in cards:
            continue
        found = _move(db, row, cards[card_id], today)
        if found is not None:
            out.append(found)
    return sorted(out, key=lambda m: (not m.posted, m.card_id, m.txn_id))


def _card_figures(db: Session, card: Account, today: date) -> Tuple[Decimal, Decimal]:
    """The sum of the card's statement balances and its stored balance."""
    from app.core.access import viewable_account_ids
    from app.services.statements import statement_history

    history = statement_history(db, card, datetime.combine(today, time()),
                                viewable_account_ids(db, card.user_id))
    return sum((s["balance"] for s in history), Decimal("0")), Decimal(str(card.balance or 0))


def _card_rows_state(db: Session, card_id: int, skip: int) -> list:
    rows = (db.query(Transaction)
            .filter(or_(Transaction.account_id == card_id,
                        Transaction.transfer_from_account_id == card_id,
                        Transaction.transfer_to_account_id == card_id),
                    Transaction.id != skip)
            .order_by(Transaction.id).all())
    return [(r.id, r.transaction_date, r.posting_date, r.is_posted, r.amount,
             r.transaction_type, r.account_id) for r in rows]


def _repair_row(db: Session, txn_id: int, today: date) -> RepairResult:
    """Lock, check and write one row inside the caller's savepoint.

    Raises ``Refused`` (the caller rolls the savepoint back) for any refusal."""
    found = db.get(Transaction, txn_id)
    if found is None:
        raise Refused("no such transaction")
    locking.lock_owner_budgets(db, found.user_id)
    row = locking.lock_transaction(db, txn_id)
    if row is None:
        raise Refused("no such transaction")
    card_id = _card_of(row)
    if card_id is None:
        raise Refused("not a card line item (a payment or another type)")
    card = locking.lock_accounts(db, [card_id]).get(card_id)
    if card is None or card.account_type != AccountType.CREDIT:
        raise Refused("not on a credit card")
    if resolve_cycle_fields(card) is None:
        raise Refused("its card has no statement cycle")
    if not row.is_posted:
        raise Refused("not posted")
    if row.posting_date is None:
        raise Refused("it has no posted day")
    move = _move(db, row, card, today)
    if move is None:
        raise Refused("its posted day does not move it to another statement")

    figures_before = _card_figures(db, card, today)
    others_before = _card_rows_state(db, card_id, row.id)
    row.posting_date = datetime.combine(row.transaction_date.date(), time())
    row.updated_at = utc_now()
    db.flush()
    db.expire_all()
    row = db.get(Transaction, txn_id)
    card = db.get(Account, card_id)
    if statement_close(card, statement_day(row, today)) != move.old_close:
        raise Refused("it would not return to the statement of its own day")
    if _card_rows_state(db, card_id, row.id) != others_before:
        raise Refused("another row of the card would change")
    if _card_figures(db, card, today) != figures_before:
        raise Refused("the card's statement total or balance would change")
    return RepairResult(txn_id, "repaired", old_posted=move.posted_day,
                        old_close=move.new_close, new_close=move.old_close)


def repair(db: Session, txn_ids: Iterable[int], *, apply: bool,
           today: Optional[date] = None) -> List[RepairResult]:
    """Repair each named row in its own savepoint; with ``apply`` each is
    committed, without it rolled back, so a dry run writes nothing."""
    today = today or manila_today()
    results: List[RepairResult] = []
    try:
        for txn_id in dict.fromkeys(txn_ids):
            savepoint = db.begin_nested()
            try:
                result = _repair_row(db, txn_id, today)
            except Refused as exc:
                savepoint.rollback()
                db.expire_all()
                result = RepairResult(txn_id, "refused", str(exc))
            except Exception:
                savepoint.rollback()
                raise
            else:
                savepoint.commit()
            results.append(result)
            if apply:
                db.commit()
            else:
                db.rollback()  # releases every lock the row took
    finally:
        if not apply:
            db.rollback()
    return results


def report(found: List[Move], results: List[RepairResult], *, apply: bool,
           today: date) -> List[str]:
    posted = [m for m in found if m.posted]
    unposted = [m for m in found if not m.posted]
    lines = [f"read on {today.isoformat()} (Manila)",
             f"posted rows whose close changes: {len(posted)}"]
    lines += [m.line() for m in posted]
    lines.append(f"unposted rows that roll: {len(unposted)}")
    lines += [m.line() for m in unposted]
    lines += [r.line(apply) for r in results]
    if results:
        lines.append(f"repairs: {sum(r.status == 'repaired' for r in results)}; "
                     f"refused: {sum(r.status == 'refused' for r in results)}")
    return lines


def run(db: Session, txn_ids: Iterable[int], *, apply: bool,
        today: Optional[date] = None) -> List[str]:
    """The listing, then the repairs; the report's lines. The listing is read
    before any repair, so it shows what the rule moves in the stored data."""
    today = today or manila_today()
    try:
        found = moves(db, today)
    finally:
        db.rollback()
    results = repair(db, txn_ids, apply=apply, today=today)
    return report(found, results, apply=apply, today=today)

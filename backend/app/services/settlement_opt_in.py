"""Turn autopay on for named entries and loans (settlement plan, PR 9).

Driven by ``scripts/set_settlement.py`` (docs/settlement-opt-in.md). Each record
named by the operator runs in its own transaction, under the locks the toggle
takes, through the toggle's own service code: ``posting.autopay_toggle_block``
and ``posting.turn_on_autopay`` for an entry, ``posting.loan_block`` and
``posting.turn_on_loan_autopay`` for a loan. Nothing is selected implicitly.

Per record, in order:

1. Locks (``core/locking.py`` order): the owner's budget lock, then the entry,
   or ``posting.lock_loan`` (the loan and its paying account).
2. Precheck, read on the locked rows: the block reason, whether the flag is
   already on, the count of past due dates no posted row stands for
   (``posting.autopay_preview`` / ``posting.loan_autopay_preview``, the toggle's
   own count) and, for a loan, the ids of any active recurring transfer into it.
   A record that fails is refused and left unchanged. One already on is left
   alone, which is what makes a rerun change nothing.
3. The count computed in step 2 is the ``expected_due`` handed to the toggle's
   service call in the same transaction; if it differs, the call is a 409 and
   nothing is written.
4. The run posts the catch-up as the job would. A stop for short funds, a
   possible duplicate or a pending planned payment is a hold: the flag stays on
   and the rest is reported as held, not as an error.
5. ``apply`` commits; a dry run rolls back (no rows or balances change; id numbers may
   skip), so what it reports is what the real
   run did on the same rows.

The report holds ids, dates and reason codes only, never an amount.
"""
from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core import locking
from app.core.time import manila_today
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction
from app.models.user import User
from app.services import posting
from app.services.forecast import unrecorded_occurrences


@dataclass
class Result:
    kind: str                       # "entry" or "loan"
    record_id: int
    status: str                     # "refused", "already_on", "would_turn_on", "turned_on"
    reason: Optional[str] = None    # the refusal reason code
    due_dates: List[date] = field(default_factory=list)
    # (transaction id or None for a row not yet written, date) of what posts.
    posted: List[tuple] = field(default_factory=list)
    held: Optional[str] = None      # why the catch-up stopped short, flag still on
    feeding: Optional[List[int]] = None  # loan: active recurring transfers into it


def _refused(kind: str, record_id: int, reason: str, **extra) -> Result:
    return Result(kind, record_id, "refused", reason=reason, **extra)


def _done(apply: bool) -> str:
    return "turned_on" if apply else "would_turn_on"


def _entry(db: Session, entry_id: int, apply: bool) -> Result:
    entry = db.get(BudgetEntry, entry_id)
    if entry is None:
        return _refused("entry", entry_id, "not_found")
    locking.lock_owner_budgets(db, entry.user_id)
    db.expire_all()
    entry = locking.lock_entry(db, entry_id)
    if entry is None:
        return _refused("entry", entry_id, "not_found")
    actor = db.get(User, entry.user_id)
    if not entry.account_id:
        return _refused("entry", entry_id, "no_account")
    account = db.get(Account, entry.account_id)
    block = posting.autopay_toggle_block(entry, account)
    if block is not None:
        return _refused("entry", entry_id, block)
    today = manila_today()
    due = unrecorded_occurrences(db, [entry], today)[entry.id]
    dates = [occ.date() for occ in due]
    if entry.auto_post_enabled:
        return Result("entry", entry_id, "already_on", due_dates=dates)
    expected = posting.autopay_preview(db, entry)["due_count"]
    try:
        run = posting.turn_on_autopay(db, entry, actor, expected)
    except HTTPException as exc:
        db.rollback()
        return _refused("entry", entry_id, f"http_{exc.status_code}", due_dates=dates)
    moved = [item for item in run.recorded if item.outcome != posting.Outcome.ALREADY_POSTED]
    # A dry run rolls back, so the id of a row it created means nothing: "new".
    posted = [(None if item.outcome == posting.Outcome.CREATED and not apply
               else item.transaction.id, item.transaction.transaction_date.date())
              for item in moved]
    return Result("entry", entry_id, _done(apply), due_dates=dates, posted=posted,
                  held=run.blocker)


def _loan(db: Session, loan_id: int, apply: bool) -> Result:
    loan = db.get(Account, loan_id)
    if loan is None or loan.account_type != AccountType.LOAN:
        return _refused("loan", loan_id, "not_found" if loan is None else "not_loan")
    loan = posting.lock_loan(db, loan_id, loan.user_id)
    if loan is None:
        return _refused("loan", loan_id, "changed")
    caller = db.get(User, loan.user_id)
    feeding = posting.loan_feeding_entries(db, loan)
    block = posting.loan_block(db, loan, caller)
    if block is not None:
        return _refused("loan", loan_id, block, feeding=feeding)
    today = manila_today()
    plan = posting.loan_plan(db, loan, today, caller)
    dates = [day for day, _, _ in plan.due]
    if loan.auto_post_enabled:
        return Result("loan", loan_id, "already_on", due_dates=dates, feeding=feeding)
    expected = posting.loan_autopay_preview(db, loan, caller)["due_count"]
    before = {row_id for (row_id,) in db.query(Transaction.id).filter(
        Transaction.transfer_to_account_id == loan.id)}
    try:
        posting.turn_on_loan_autopay(db, loan, caller, expected)
    except HTTPException as exc:
        db.rollback()
        return _refused("loan", loan_id, f"http_{exc.status_code}", due_dates=dates,
                        feeding=feeding)
    db.flush()
    rows = db.query(Transaction).filter(
        Transaction.transfer_to_account_id == loan.id,
        Transaction.id.notin_(before) if before else True).order_by(Transaction.id).all()
    posted = [(row.id if apply else None, row.transaction_date.date()) for row in rows]
    rest = posting.loan_plan(db, loan, today, caller)
    return Result("loan", loan_id, _done(apply), due_dates=dates, posted=posted,
                  held=rest.blocker if rest.due else None, feeding=feeding)


def run(db: Session, *, entry_ids: List[int], loan_ids: List[int], apply: bool) -> List[Result]:
    """Run the named records, entries first, each in its own transaction."""
    results = []
    jobs = [(_entry, i) for i in entry_ids] + [(_loan, i) for i in loan_ids]
    for fn, record_id in jobs:
        try:
            result = fn(db, record_id, apply)
        except BaseException:
            db.rollback()
            raise
        if apply and result.status == "turned_on":
            db.commit()
        else:
            db.rollback()
        results.append(result)
    return results


def summary(results: List[Result], apply: bool) -> List[str]:
    """The report: ids, dates and reason codes. Never an amount."""
    lines = []
    for r in results:
        lines.append(f"{r.kind} {r.record_id}:")
        if r.feeding is not None:
            lines.append("  recurring transfer into loan: "
                         + (", ".join(f"entry {i}" for i in r.feeding) if r.feeding else "none"))
        if r.status == "refused":
            lines.append(f"  precheck: refused ({r.reason})")
            if r.due_dates:
                lines.append("  due: " + _dates(r.due_dates))
            lines.append("  result: refused, nothing written")
            continue
        lines.append("  precheck: ok")
        lines.append(f"  due: {len(r.due_dates)}" + (f" ({_dates(r.due_dates)})"
                                                     if r.due_dates else ""))
        if r.status == "already_on":
            lines.append("  result: already on, no change")
            continue
        for txn_id, when in r.posted:
            lines.append(f"  {'posted' if apply else 'would post'}: "
                         f"txn {txn_id if txn_id is not None else 'new'} {when.isoformat()}")
        if r.held:
            lines.append(f"  held: {r.held} (flag stays on; the job retries)")
        lines.append("  result: " + ("turned on" if apply else "dry run, no rows or balances change"))
    changed = sum(1 for r in results if r.status == "turned_on")
    refused = sum(1 for r in results if r.status == "refused")
    lines.append(f"changes: {changed} records; refused: {refused}")
    return lines


def _dates(days: List[date]) -> str:
    return ", ".join(day.isoformat() for day in days)

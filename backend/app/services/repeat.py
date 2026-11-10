"""A transaction that repeats: one request records a transaction and starts the
recurring entry it is the first occurrence of (STU-584, ``POST /transactions/repeating``).

The entry starts on the transaction's date (a card installment on the
statement close holding it, ``budget_entries._installment_on_close``), and the
transaction is linked to that first occurrence (``occurrence_date``, set here,
never by the client). The schedule then moves as Mark paid would have moved it
for the same record: past the first occurrence when the row is posted or is an
unposted card expense (Charged), and not at all for any other unposted row,
which stands for occurrence 1 until Mark paid posts it.

Nothing here commits. The locks follow ``core/locking.py``: the owner's budget
lock first, then the card (an installment's close), then the transaction's
accounts in ascending id and its allocations (``add_transaction``). The new
entry is invisible to anyone else until the caller commits, so it takes no row
lock.
"""
from typing import Optional, Tuple

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core import locking
from app.core.time import manila_today
from app.models.account import Account
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction, TransactionType
from app.models.user import User
from app.schemas.budget_entry import BudgetEntryCreate
from app.schemas.transaction import RepeatSchedule, TransactionCreate
from app.services import loans as loan_svc
from app.services import posting
from app.services.recurring_kinds import entry_kind

AUTOPAY_DUE_MESSAGE = ("Turn autopay on from the recurring entry, where you confirm the "
                       "payments it would post")
CARD_EXPENSE_KINDS = ("subscription", "installment", "bill")


def _face(txn_in: TransactionCreate, account: Optional[Account]) -> Tuple[float, object]:
    """The entry's ``(amount, currency)``: the transaction's face, as
    ``add_transaction`` labels it. A transfer is in its source's currency; a
    debit or credit with a ``projected_amount`` is that figure in the face
    currency (``projected_currency``, else the ``currency`` sent, else the
    account's); without one, ``amount`` in the currency the row is stored in
    (the account's when posted, else the one sent)."""
    if account is None:
        return txn_in.amount, txn_in.currency  # access is refused before this is read
    if txn_in.transaction_type == TransactionType.TRANSFER:
        return txn_in.amount, account.currency
    named = txn_in.currency if "currency" in txn_in.model_fields_set else None
    if txn_in.projected_amount is not None:
        return txn_in.projected_amount, txn_in.projected_currency or named or account.currency
    if txn_in.is_posted:
        return txn_in.amount, account.currency
    return txn_in.amount, named or account.currency


def _entry_in(txn_in: TransactionCreate, repeat: RepeatSchedule,
              account: Optional[Account]) -> BudgetEntryCreate:
    """The entry the transaction starts, as ``POST /budget-entries/`` would take it.
    Only the day fields and ``billing_kind`` the request named are passed, so
    their create defaults hold."""
    amount, currency = _face(txn_in, account)
    fields = {
        "name": txn_in.description,
        "entry_type": (BudgetEntryType.INCOME
                       if txn_in.transaction_type == TransactionType.CREDIT
                       else BudgetEntryType.EXPENSE),
        "amount": amount,
        "currency": currency,
        "cadence": repeat.cadence,
        "next_occurrence": txn_in.transaction_date,
        "lead_time_days": 0,
        "end_mode": repeat.end_mode,
        "end_date": repeat.end_date,
        "max_occurrences": repeat.max_occurrences,
        "account_id": txn_in.account_id,
        "transfer_to_account_id": (txn_in.transfer_to_account_id
                                   if txn_in.transaction_type == TransactionType.TRANSFER
                                   else None),
        "category_id": txn_in.category_id,
        "allocation_id": txn_in.allocation_id,
        "tag_ids": txn_in.tag_ids,
    }
    for name in ("anchor_day", "day_rule", "billing_kind"):
        if name in repeat.model_fields_set:
            fields[name] = getattr(repeat, name)
    try:
        return BudgetEntryCreate(**fields)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors(include_url=False)) from None


def _turn_on_autopay(db: Session, entry: BudgetEntry, account: Optional[Account]) -> None:
    """Autopay on in the same commit, under the toggle's rules: a block is the
    toggle's refusal, and anything left due through Manila's today after the
    first record is a 422 (turning it on would post those payments unconfirmed)."""
    from app.routers.budget_entries import (
        ENDED_MESSAGE, PAUSED_MESSAGE, SETTLEMENT_BLOCK_MESSAGES)
    from app.services.forecast import unrecorded_occurrences

    block = posting.autopay_toggle_block(entry, account)
    if block == "card_installment":
        raise HTTPException(status_code=400,
                            detail="Review the installment to turn auto-post on")
    if block in ("ended", "paused"):
        raise HTTPException(status_code=409,
                            detail=ENDED_MESSAGE if block == "ended" else PAUSED_MESSAGE)
    if block is not None:
        raise HTTPException(status_code=400, detail=SETTLEMENT_BLOCK_MESSAGES[block])
    if unrecorded_occurrences(db, [entry], manila_today())[entry.id]:
        raise HTTPException(status_code=422, detail=AUTOPAY_DUE_MESSAGE)
    entry.auto_post_enabled = True
    entry.installment_reviewed_at = None


def create_repeating(db: Session, actor: User, txn_in: TransactionCreate,
                     repeat: RepeatSchedule) -> Tuple[Transaction, BudgetEntry]:
    """Add the entry, its first transaction, the advance and the autopay flag,
    without committing. Any refusal is raised before the caller commits, so the
    caller's rollback leaves nothing written."""
    from app.routers.budget_entries import add_budget_entry
    from app.routers.transactions import add_transaction

    locking.lock_owner_budgets(db, actor.id)
    account = db.get(Account, txn_in.account_id)
    entry = add_budget_entry(db, actor, _entry_in(txn_in, repeat, account))
    occurrence = entry.next_occurrence
    txn = add_transaction(db, actor, txn_in.model_copy(update={"budget_entry_id": entry.id}))
    # The occurrence this row fulfils, set by the server as Mark paid sets it.
    txn.occurrence_date = occurrence
    if txn.is_posted or entry_kind(entry, account) in CARD_EXPENSE_KINDS:
        posting.advance_past(entry, occurrence)
        if not entry.is_active:
            # One payment and done: as Mark paid, a loan fed by it stops autopay.
            loan_svc.transfers_stopped(db, [entry.transfer_to_account_id])
    # The links and the schedule are read by query; the session does not autoflush.
    db.flush()
    if repeat.settlement == "autopay":
        _turn_on_autopay(db, entry, account)
        db.flush()
    return txn, entry

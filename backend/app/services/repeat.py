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
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Tuple, Union

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


@dataclass(frozen=True)
class _EntrySource:
    """What an entry is built from, whichever record it starts from: a
    transaction being recorded (``_source_from_create``) or a saved one being
    made to repeat. ``face_is_projected`` says the face came from
    ``projected_*``, so a refusal of ``amount`` or ``currency`` names those."""
    description: Optional[str]
    transaction_type: TransactionType
    amount: float
    currency: object
    date: datetime
    account_id: Optional[int]
    transfer_to_account_id: Optional[int]
    category_id: Optional[int]
    allocation_id: Optional[int]
    tag_ids: Optional[List[int]]
    face_is_projected: bool


def _source_from_create(txn_in: TransactionCreate,
                        account: Optional[Account]) -> _EntrySource:
    """The source of the entry a transaction being recorded starts."""
    amount, currency = _face(txn_in, account)
    return _EntrySource(
        description=txn_in.description,
        transaction_type=txn_in.transaction_type,
        amount=amount,
        currency=currency,
        date=txn_in.transaction_date,
        account_id=txn_in.account_id,
        transfer_to_account_id=txn_in.transfer_to_account_id,
        category_id=txn_in.category_id,
        allocation_id=txn_in.allocation_id,
        tag_ids=txn_in.tag_ids,
        face_is_projected=(txn_in.projected_amount is not None
                           and txn_in.transaction_type != TransactionType.TRANSFER),
    )


def _entry_in(source: _EntrySource, repeat: RepeatSchedule) -> BudgetEntryCreate:
    """The entry the transaction starts, as ``POST /budget-entries/`` would take it.
    Only the day fields and ``billing_kind`` the request named are passed, so
    their create defaults hold."""
    fields = {
        "name": source.description,
        "entry_type": (BudgetEntryType.INCOME
                       if source.transaction_type == TransactionType.CREDIT
                       else BudgetEntryType.EXPENSE),
        "amount": source.amount,
        "currency": source.currency,
        "cadence": repeat.cadence,
        "next_occurrence": source.date,
        "lead_time_days": 0,
        "end_mode": repeat.end_mode,
        "end_date": repeat.end_date,
        "max_occurrences": repeat.max_occurrences,
        "account_id": source.account_id,
        "transfer_to_account_id": (source.transfer_to_account_id
                                   if source.transaction_type == TransactionType.TRANSFER
                                   else None),
        "category_id": source.category_id,
        "allocation_id": source.allocation_id,
        "tag_ids": source.tag_ids,
    }
    for name in ("anchor_day", "day_rule", "billing_kind"):
        if name in repeat.model_fields_set:
            fields[name] = getattr(repeat, name)
    try:
        return BudgetEntryCreate(**fields)
    except ValidationError as exc:
        raise RequestValidationError([
            {**error, "loc": _request_loc(error["loc"], source)}
            for error in exc.errors(include_url=False)]) from None


# Where each entry field comes from in the request, so a refusal names the field sent.
TRANSACTION_SOURCES = {
    "name": "description", "entry_type": "transaction_type", "next_occurrence": "transaction_date",
    "account_id": "account_id", "transfer_to_account_id": "transfer_to_account_id",
    "category_id": "category_id", "allocation_id": "allocation_id", "tag_ids": "tag_ids",
}


def _request_loc(loc: tuple, source: Union[_EntrySource, TransactionCreate]) -> tuple:
    """An entry-build error's location in the request body: ``("body", "transaction",
    field)`` for a field taken from the transaction (``amount`` and ``currency`` are
    ``projected_*`` when the face came from them), else ``("body", "repeat", ...)``,
    which also takes the entry-level checks (no field: the ends)."""
    if isinstance(source, TransactionCreate):
        source = _source_from_create(source, None)
    field, rest = (loc[0], tuple(loc[1:])) if loc else (None, ())
    if field in ("amount", "currency"):
        return ("body", "transaction",
                f"projected_{field}" if source.face_is_projected else field, *rest)
    if field in TRANSACTION_SOURCES:
        return ("body", "transaction", TRANSACTION_SOURCES[field], *rest)
    return ("body", "repeat", *loc)


def _link_first_occurrence(db: Session, entry: BudgetEntry, txn: Transaction,
                           account: Optional[Account]) -> None:
    """Link ``txn`` to the entry's first occurrence and move the schedule as Mark
    paid would for the same record: past it when the row is posted or is an
    unposted card expense (Charged), not at all for any other unposted row,
    which stands for occurrence 1 until Mark paid posts it. Not flushed."""
    occurrence = entry.next_occurrence
    txn.budget_entry_id = entry.id
    txn.is_recurring = True
    txn.recurrence_frequency = entry.cadence
    # The occurrence this row fulfils, set by the server as Mark paid sets it.
    txn.occurrence_date = occurrence
    if txn.is_posted or entry_kind(entry, account) in CARD_EXPENSE_KINDS:
        posting.advance_past(entry, occurrence)
        if not entry.is_active:
            # One payment and done: as Mark paid, a loan fed by it stops autopay.
            loan_svc.transfers_stopped(db, [entry.transfer_to_account_id])


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
    entry = add_budget_entry(db, actor, _entry_in(_source_from_create(txn_in, account), repeat))
    txn = add_transaction(db, actor, txn_in.model_copy(update={"budget_entry_id": entry.id}))
    _link_first_occurrence(db, entry, txn, account)
    # The links and the schedule are read by query; the session does not autoflush.
    db.flush()
    if repeat.settlement == "autopay":
        _turn_on_autopay(db, entry, account)
        db.flush()
    return txn, entry

"""Recording a recurring entry's occurrence: one no-commit primitive (STU-343).

``materialize`` (Mark paid) and ``materialize-due`` (Post N due) both lock the
owner's budgets and then the entry, validate it, and call ``record_occurrence``
for each occurrence they record, then commit once. Nothing here commits.

An occurrence is recorded once. A row already linked to it (``occurrence_links``
in services/forecast.py, the projection's own rule) is reused: a posted one
only moves the schedule on, a pending one is posted through the same update
path as ``PUT /transactions/{id}`` (``apply_transaction_update``). Only an
occurrence with no linked row gets a new transaction.
"""
from calendar import monthrange
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core import locking
from app.core.access import RecordAccess
from app.core.tags import copy_explicit_tags
from app.core.time import utc_now
from app.models.account import Account
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
from app.models.user import User
from app.schemas.budget_entry import BudgetEntryMaterialize
from app.schemas.transaction import TransactionUpdate
from app.services import loans as loan_svc
from app.services.forecast import (
    _naive, _next_occurrence, iter_occurrences, occurrence_links, unrecorded_occurrences,
)
from app.services.recurring_kinds import is_capped


class Outcome(str, Enum):
    CREATED = "created"
    POSTED_PENDING = "posted_pending"
    ALREADY_POSTED = "already_posted"


@dataclass
class Recorded:
    transaction: Transaction
    outcome: Outcome
    occurrence: datetime
    skipped: List[datetime] = field(default_factory=list)


def _day_after(day: date) -> datetime:
    return datetime.combine(day + timedelta(days=1), datetime.min.time())


def schedule_walk(entry, through: date) -> List[datetime]:
    """The entry's occurrences from ``next_occurrence`` through the day ``through``
    (inclusive), as the projection walks them (cap and end date respected)."""
    return list(iter_occurrences(entry, _naive(entry.next_occurrence), _day_after(through)))


def _utc_naive(value: datetime) -> datetime:
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def resolve_occurrence(db: Session, entry, requested: Optional[datetime]
                       ) -> Tuple[datetime, List[datetime]]:
    """``(occurrence, skipped)``: the occurrence a Mark paid records and every
    earlier unrecorded one it leaves behind.

    No request records ``next_occurrence`` (the legacy contract), skipping
    nothing. A request is matched by calendar day against the schedule from
    ``next_occurrence``: no match (a day before it included) is a 422; on a
    capped entry anything but ``next_occurrence`` is a 409, since its months
    are counted down in order. ``skipped`` is every occurrence in
    ``[next_occurrence, occurrence)`` that no posted linked row stands for,
    complete however many there are.
    """
    if requested is None:
        return _naive(entry.next_occurrence), []
    day = _utc_naive(requested).date()
    match = next((occ for occ in schedule_walk(entry, day) if occ.date() == day), None)
    if match is None:
        raise HTTPException(status_code=422, detail="Not an occurrence of this schedule")
    if is_capped(entry) and match != _naive(entry.next_occurrence):
        raise HTTPException(status_code=409, detail="Record the oldest unrecorded month first")
    skipped = [occ for occ in unrecorded_occurrences(db, [entry], day)[entry.id] if occ < match]
    return match, skipped


def pending_update_for(db: Session, actor: User, entry, txn: Transaction,
                       payload: BudgetEntryMaterialize) -> TransactionUpdate:
    """The update that posts a pending linked row with the materialise money,
    meaning what it means on create.

    Always ``is_posted``, plus ``transaction_date`` and ``received_amount`` when
    supplied. On a loan payment row (``loan_payment_kind`` set) both accounts are
    locked first (row, then accounts: the global order), then: an ``amount``
    without a ``transfer_fee`` is total cash, split into principal and interest
    as ``_loan_payment_stamp`` splits it on create; an ``amount`` with a fee is
    the principal and the fee the interest; no ``amount`` keeps the row's own
    principal and interest. On any other row ``amount`` when supplied, and
    ``transfer_fee`` only when sent.
    """
    fields: dict = {"is_posted": True}
    if payload.transaction_date is not None:
        fields["transaction_date"] = payload.transaction_date
    if payload.received_amount is not None:
        fields["received_amount"] = payload.received_amount
    fee_sent = "transfer_fee" in payload.model_fields_set
    if txn.loan_payment_kind:
        locking.lock_accounts(db, [txn.transfer_from_account_id, txn.transfer_to_account_id])
        if payload.amount is not None:
            if fee_sent:
                fields["amount"] = payload.amount
                fields["transfer_fee"] = payload.transfer_fee
            else:
                loan = db.get(Account, txn.transfer_to_account_id)
                try:
                    principal, interest = loan_svc.split_payment(loan, payload.amount)
                except loan_svc.LoanError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                fields["amount"] = float(principal)
                fields["transfer_fee"] = float(interest)
    else:
        if payload.amount is not None:
            fields["amount"] = payload.amount
        if fee_sent:
            fields["transfer_fee"] = payload.transfer_fee
    return TransactionUpdate(**fields)


def advance_occurrence(entry: BudgetEntry, current: datetime) -> datetime:
    """Return the occurrence following ``current`` for this entry's cadence.

    Fixed-step cadences go through ``step_occurrence`` (services/recurrence.py),
    which follows the entry's ``anchor_day`` or ``day_rule`` and keeps the aware
    value's tzinfo, so materialize's ``end_date`` comparison never mixes naive and
    aware values.
    """
    from app.services.recurrence import step_occurrence

    if entry.cadence == RecurrenceFrequency.SEMI_MONTHLY:
        d1 = entry.semi_monthly_day_1 or 1
        d2 = entry.semi_monthly_day_2 or 15
        days = sorted({d1, d2})
        months = [(current.year, current.month)]
        months.append((current.year + 1, 1) if current.month == 12 else (current.year, current.month + 1))
        candidates = []
        for (y, m) in months:
            last = monthrange(y, m)[1]
            for d in days:
                candidates.append(current.replace(year=y, month=m, day=min(d, last)))
        future = sorted(c for c in candidates if c > current)
        return future[0] if future else _next_occurrence(current, RecurrenceFrequency.MONTHLY)

    return step_occurrence(entry, current)


def _create(db: Session, entry, actor: User, payload: BudgetEntryMaterialize,
            occurrence: datetime) -> Transaction:
    """A new posted row for ``occurrence``: the materialise create body."""
    from app.routers.transactions import add_transaction, exchange_rate
    from app.schemas.transaction import TransactionCreate

    # An entry in another currency than its account's (for a transfer, the
    # source's) posts the figure the account was actually charged, which only
    # the caller knows; the entry's own figure is kept as the face.
    account = db.get(Account, entry.account_id)
    if account is not None and entry.currency != account.currency:
        if payload.amount is None:
            raise HTTPException(
                status_code=400,
                detail=f"Enter the amount charged in {account.currency.value}")
        currency_fields = {
            "currency": account.currency,
            "projected_amount": entry.amount,
            "projected_currency": entry.currency,
            "original_amount": entry.amount,
            "original_currency": entry.currency,
            "exchange_rate": exchange_rate(payload.amount, entry.amount),
        }
    else:
        currency_fields = {"currency": entry.currency}
    amount = payload.amount if payload.amount is not None else entry.amount
    if entry.transfer_to_account_id:
        # A recurring transfer posts as a transfer: -(amount + fee) on the source,
        # +amount on the destination, like any other transfer transaction.
        txn_type = TransactionType.TRANSFER
        transfer_fields = {
            "transfer_from_account_id": entry.account_id,
            "transfer_to_account_id": entry.transfer_to_account_id,
        }
        if "transfer_fee" in payload.model_fields_set:
            # Left out otherwise, so a loan payment is split into principal and
            # interest (``_loan_payment_stamp``); any other transfer has no fee.
            transfer_fields["transfer_fee"] = payload.transfer_fee
        # Required across currencies (``_received_amount``): the entry stores no
        # expected figure for the destination.
        transfer_fields["received_amount"] = payload.received_amount
    else:
        txn_type = (
            TransactionType.CREDIT if entry.entry_type == BudgetEntryType.INCOME
            else TransactionType.DEBIT
        )
        transfer_fields = {}

    txn_create = TransactionCreate(
        account_id=entry.account_id,
        amount=amount,
        transaction_type=txn_type,
        transaction_date=payload.transaction_date or occurrence,
        category_id=entry.category_id,
        allocation_id=entry.allocation_id,
        budget_entry_id=entry.id,
        description=entry.name,
        is_posted=True,
        **currency_fields,
        **transfer_fields,
    )
    # The entry's creator owns the transaction; the caller is its actor.
    db_txn = add_transaction(db, actor, txn_create, owner=entry.user)
    # The occurrence this row fulfils: projected occurrences are suppressed by
    # it, not by ``transaction_date``. Set on the row, not in
    # ``TransactionCreate``, so no client can set it.
    db_txn.occurrence_date = occurrence
    # The entry's explicit tags, in the same commit as the transaction.
    copy_explicit_tags(db, entry.id, db_txn.id)
    return db_txn


def _advance(entry: BudgetEntry, occurrence: datetime) -> None:
    """Move ``next_occurrence`` past ``occurrence``; a capped entry uses up one
    occurrence, and the entry is deactivated past its end date or its last one."""
    next_occ = advance_occurrence(entry, occurrence)
    deactivate = False
    # Compared as naive UTC: the stored columns may come back aware or naive.
    if (entry.end_mode == "on_date" and entry.end_date
            and _utc_naive(next_occ) > _utc_naive(entry.end_date)):
        deactivate = True
    if entry.end_mode == "after_occurrences" and entry.max_occurrences is not None:
        entry.max_occurrences = max(entry.max_occurrences - 1, 0)
        if entry.max_occurrences <= 0:
            deactivate = True
    if deactivate:
        entry.is_active = False
    else:
        entry.next_occurrence = next_occ
    entry.updated_at = utc_now()


def record_occurrence(db: Session, entry, actor: User, payload: BudgetEntryMaterialize,
                      occurrence: datetime) -> Recorded:
    """Record ``occurrence`` of ``entry`` once, without committing.

    The caller holds the owner's budget lock and then the entry lock, and has
    validated the entry. More than one linked row is a 409. One posted row
    records nothing new (``already_posted``; with ``advance`` False a 409). One
    pending row is locked and posted as ``actor`` (``pending_update_for``,
    ``apply_transaction_update``), a 409 when ``actor`` cannot edit it
    (``posted_pending``). No linked row gets a new posted transaction dated
    ``payload.transaction_date`` or the occurrence (``created``). With
    ``payload.advance`` the schedule then moves past ``occurrence``.
    """
    from app.routers.transactions import apply_transaction_update

    links = occurrence_links(db, entry, occurrence.date())
    if len(links) > 1:
        raise HTTPException(
            status_code=409,
            detail="This occurrence has more than one linked transaction; "
                   "resolve them on the Transactions page")
    if links and links[0][1]:
        if not payload.advance:
            raise HTTPException(status_code=409, detail="This occurrence is already recorded")
        txn = db.get(Transaction, links[0][0])
        outcome = Outcome.ALREADY_POSTED
    elif links:
        txn = locking.lock_transaction(db, links[0][0])
        if txn is None or txn.is_posted:
            raise HTTPException(status_code=409,
                                detail="This occurrence's transaction changed; try again")
        if not RecordAccess(db, actor).permissions(txn)["can_edit"]:
            raise HTTPException(
                status_code=409,
                detail="This occurrence is recorded on a transaction you can't edit")
        txn = apply_transaction_update(db, actor, txn,
                                       pending_update_for(db, actor, entry, txn, payload))
        if txn.occurrence_date is None:
            txn.occurrence_date = occurrence
        outcome = Outcome.POSTED_PENDING
    else:
        txn = _create(db, entry, actor, payload, occurrence)
        outcome = Outcome.CREATED

    if payload.advance:
        _advance(entry, occurrence)
    db.flush()
    return Recorded(transaction=txn, outcome=outcome, occurrence=occurrence)

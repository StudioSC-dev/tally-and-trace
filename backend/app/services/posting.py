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
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core import locking
from app.core.access import RecordAccess
from app.core.tags import copy_explicit_tags
from app.core.time import manila_today, utc_now
from app.models.account import Account
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
from app.models.user import User
from app.schemas.budget_entry import BudgetEntryMaterialize
from app.schemas.transaction import TransactionUpdate
from app.services import loans as loan_svc
from app.services.forecast import (
    _linked_rows, _naive, _next_occurrence, distinct_days, iter_occurrences, occurrence_links,
)
from app.services.recurring_kinds import entry_kind, is_capped


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
    (inclusive), as the projection walks them (cap and end date respected), all
    of them: not the projection's step guard but one step per day from
    ``next_occurrence`` to ``through`` (every cadence moves at least a day a
    step, and a semi-monthly step is a month), which a complete walk never
    reaches. Each calendar day is one occurrence (``distinct_days``): a
    semi-monthly schedule's two days clamped onto one are listed, counted and
    recorded once."""
    start, end = _naive(entry.next_occurrence), _day_after(through)
    bound = max((end - start).days, 0) + 2
    return distinct_days(iter_occurrences(entry, start, end, max_steps=bound))


def first_occurrence(entry) -> datetime:
    """The schedule's first occurrence from ``next_occurrence``, as the
    projection shows it: ``next_occurrence`` itself, except a semi-monthly one
    stored off its days, whose first is its next scheduled day (days 1/15 from
    Oct 18: Nov 1). ``next_occurrence`` when the walk yields nothing (past its
    end date or cap)."""
    start = _naive(entry.next_occurrence)
    try:
        end = start + timedelta(days=32)  # a semi-monthly gap is at most 31 days
    except OverflowError:
        end = datetime.max
    return next(iter_occurrences(entry, start, end, max_steps=3), start)


OCCURRENCE_HORIZON = timedelta(days=730)  # the furthest occurrence a request may name


def refuse_far_occurrence(day: date) -> None:
    """422 for a requested occurrence more than two years (730 days) after
    Manila's today: the walk to it is complete, one step per day, so an
    unbounded request (9999-12-31) would walk millions of steps."""
    if day > manila_today() + OCCURRENCE_HORIZON:
        raise HTTPException(status_code=422,
                            detail="Choose an occurrence no more than two years from today")


def _utc_naive(value: datetime) -> datetime:
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def resolve_occurrence(db: Session, entry, requested: Optional[datetime]
                       ) -> Tuple[datetime, List[datetime]]:
    """``(occurrence, skipped)``: the occurrence a Mark paid records and every
    earlier unrecorded one it leaves behind.

    No request records the schedule's first occurrence (``first_occurrence``:
    ``next_occurrence``, the legacy contract, unless a semi-monthly one is
    stored off its days), skipping nothing. A request more than two years
    ahead is a 422 (``refuse_far_occurrence``). A request is matched by
    calendar day against the schedule from ``next_occurrence``: no match (a
    day before it, or an off-day ``next_occurrence``, included) is a 422; on a
    capped entry anything but the schedule's first occurrence is a 409, since
    its months are counted down in order. ``skipped`` is every occurrence in
    ``[next_occurrence, occurrence)`` that no posted linked row stands for,
    complete however many there are.
    """
    if requested is None:
        return first_occurrence(entry), []
    day = _utc_naive(requested).date()
    refuse_far_occurrence(day)
    walk = schedule_walk(entry, day)
    match = next((occ for occ in walk if occ.date() == day), None)
    if match is None:
        raise HTTPException(status_code=422, detail="Not an occurrence of this schedule")
    if is_capped(entry) and match != walk[0]:
        raise HTTPException(status_code=409, detail="Record the oldest unrecorded month first")
    # ``unrecorded_occurrences``' rule over the complete walk: each posted
    # linked row stands for one occurrence on its day.
    posted = Counter(_naive(when).date() for _, when, _, is_posted in _linked_rows(
        db, [entry.id], occurrence_match=True) if is_posted)
    skipped = []
    for occ in walk:
        if occ >= match:
            break
        if posted[occ.date()]:
            posted[occ.date()] -= 1
            continue
        skipped.append(occ)
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


OCCURRENCES_FIRST = 30   # the first occurrences from next_occurrence always listed
OCCURRENCES_AROUND = 31  # and every one within this many days of today


def entry_occurrences(db: Session, entry, include: Optional[date]) -> dict:
    """The occurrences Mark paid offers (``GET /budget-entries/{id}/occurrences``).

    The schedule is walked from ``next_occurrence`` to the later of Manila's
    today + 31 days and ``include``. Listed: the first 30 occurrences, every
    one within 31 days of today, and ``include`` (a 422 when it is not an
    occurrence of the schedule from ``next_occurrence``, or more than two years
    ahead: ``refuse_far_occurrence``); ``omitted`` counts the
    walked ones left out. A capped entry lists only the walk's first
    occurrence, its oldest unrecorded month. ``due_unposted`` counts due occurrences no posted
    row stands for, and ``oldest_due`` / ``latest_due`` are the first and last
    of them (None when there are none), from the whole walk, listed or not;
    each occurrence's ``skipped_before`` counts the unrecorded ones before it.
    ``oldest_unrecorded`` is the first occurrence of the whole walk (due or
    not) that no posted row stands for (None when there is none), and each
    listed occurrence's ``omitted_before`` counts the walked ones left out of
    the listing immediately before it (0 when it follows the previous listed
    one, or is the walk's first).
    """
    if include is not None:
        refuse_far_occurrence(include)
    today = manila_today()
    around = timedelta(days=OCCURRENCES_AROUND)
    walk = schedule_walk(entry, max(today + around, include or today))
    if include is not None and include not in {occ.date() for occ in walk}:
        raise HTTPException(status_code=422, detail="Not an occurrence of this schedule")

    links = defaultdict(list)
    for _, when, _, is_posted in _linked_rows(db, [entry.id], occurrence_match=True):
        links[_naive(when).date()].append(is_posted)
    posted = Counter({day: sum(flags) for day, flags in links.items()})

    rows = []
    unrecorded = due_unposted = 0
    oldest_due = latest_due = oldest_unrecorded = None
    for occ in walk:
        day = occ.date()
        flags = links.get(day, [])
        linked = (None if not flags else "ambiguous" if len(flags) > 1
                  else "posted" if flags[0] else "pending")
        rows.append({"occurrence_date": day, "due": day <= today, "linked": linked,
                     "skipped_before": unrecorded})
        if posted[day]:
            posted[day] -= 1
            continue
        unrecorded += 1
        oldest_unrecorded = oldest_unrecorded or day
        if day <= today:
            due_unposted += 1
            oldest_due = oldest_due or day
            latest_due = day

    capped = is_capped(entry)
    if capped:
        kept = [0] if rows else []
    else:
        kept = [i for i, r in enumerate(rows)
                if i < OCCURRENCES_FIRST
                or today - around <= r["occurrence_date"] <= today + around
                or r["occurrence_date"] == include]
    listed, previous = [], -1
    for i in kept:
        listed.append({**rows[i], "omitted_before": i - previous - 1})
        previous = i
    account = db.get(Account, entry.account_id) if entry.account_id else None
    return {
        "entry_id": entry.id,
        "today": today,
        "capped": capped,
        "kind": entry_kind(entry, account),
        "due_unposted": due_unposted,
        "oldest_due": oldest_due,
        "latest_due": latest_due,
        "oldest_unrecorded": oldest_unrecorded,
        "omitted": len(walk) - len(listed),
        "occurrences": listed,
    }


def materialize_due(db: Session, entry, actor: User) -> List[Recorded]:
    """Record every due occurrence of ``entry`` (Post N due), without committing.

    The caller holds the owner's budget lock and then the entry lock, and has
    checked the entry may be posted this way (a non-capped subscription or cash
    expense in its account's currency). The due set is the schedule from
    ``next_occurrence`` through Manila's today. Every pending row linked to it
    is locked first, in ascending id, before anything is created, so the lock
    order stays owner, entry, transaction rows, accounts. Then every due
    occurrence goes through ``record_occurrence`` in order, dated on its own
    day; a posted one only advances the schedule, so it never stalls behind a
    recorded month. A 409 on any occurrence leaves the caller to roll back.
    """
    due = schedule_walk(entry, manila_today())
    days = {occ.date() for occ in due}
    pending = sorted(txn_id for _, when, txn_id, is_posted in _linked_rows(
        db, [entry.id], occurrence_match=True)
        if not is_posted and _naive(when).date() in days)
    for txn_id in pending:
        locking.lock_transaction(db, txn_id)
    return [record_occurrence(db, entry, actor, BudgetEntryMaterialize(transaction_date=occ), occ)
            for occ in due]

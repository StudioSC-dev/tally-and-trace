"""Recording a recurring entry's occurrence: one no-commit primitive (STU-343).

``materialize`` (Mark paid) and ``materialize-due`` (Post N due) both lock the
owner's budgets and then the entry, validate it, and call ``record_occurrence``
for each occurrence they record, then commit once. Nothing here commits.

An occurrence is recorded once. A row already linked to it (``occurrence_links``
in services/forecast.py, the projection's own rule) is reused: a posted one
only moves the schedule on, a pending one is posted through the same update
path as ``PUT /transactions/{id}`` (``apply_transaction_update``). Only an
occurrence with no linked row gets a new transaction.

Charged (``is_posted`` False, a card expense only, checked by the router)
records the occurrence as one new pending debit linked to it, and refuses an
occurrence that already has a linked row: a pending one is posted on the
Transactions page, a posted one is already recorded.

A forced date (``services/payment_dates.py``) moves when an occurrence is due
and how a new row is dated, and nothing else: ``occurrence_date``, the links, the
schedule's walk and its advance all stay on the nominal date.

A loan has no occurrence links. ``post_due_loans`` recomputes its open due dates
under the account locks after each post, so a hand payment settles a due date
(``loans.settle_posted``, by cash) and the run finds nothing open.
"""
from calendar import monthrange
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from types import SimpleNamespace
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core import locking
from app.core.access import MANAGE_ROLES, RecordAccess, account_role
from app.core.record_dates import refuse_record_date
from app.core.tags import copy_explicit_tags
from app.core.time import manila_today, utc_now
from app.models.account import Account, AccountType
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.payment_date_override import PaymentDateOverride
from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
from app.models.user import User
from app.schemas.budget_entry import BudgetEntryMaterialize
from app.schemas.transaction import TransactionUpdate
from app.services import loans as loan_svc
from app.services.forecast import (
    _linked_rows, _naive, _next_occurrence, capped_distinct_days, iter_occurrences,
    occurrence_links,
)
from app.services.payment_dates import (
    CLEAR_OUT_OF_ORDER, OVERRIDE_REACH, Moved, clear_override, effective, effective_at, extend,
    in_order, load_entry_overrides, load_loan_overrides, refuse_forced_date, set_override,
)
from app.services.recurring_kinds import (
    auto_posts, entry_kind, is_capped, is_card_installment, settlement_block,
)


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
    reaches. Each calendar day is one occurrence (``capped_distinct_days``): a
    semi-monthly schedule's two days clamped onto one are listed, counted and
    recorded once, and a cap counts the merged days."""
    start, end = _naive(entry.next_occurrence), _day_after(through)
    bound = max((end - start).days, 0) + 2
    return capped_distinct_days(entry, start, end, max_steps=bound)


def _moved(db: Session, entry) -> Moved:
    """``entry``'s forced dates, read now: a caller holding the entry lock sees
    every override written before it."""
    return load_entry_overrides(db, [entry.id]).get(entry.id, {})


def due_walk(db: Session, entry, through: date) -> List[datetime]:
    """``schedule_walk`` read on the effective date: the nominal occurrences whose
    effective date is on or before ``through``, walked the reach past it for an
    entry with overrides. Forced dates keep the schedule's order, so this is a
    prefix of the schedule."""
    moved = _moved(db, entry)
    if not moved:
        return schedule_walk(entry, through)
    return [occ for occ in schedule_walk(entry, through + OVERRIDE_REACH)
            if effective(moved, occ.date()) <= through]


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
FAR_OCCURRENCE = "Choose an occurrence no more than two years from today"


def refuse_far_occurrence(day: date) -> None:
    """422 for a requested occurrence more than two years (730 days) after
    Manila's today: the walk to it is complete, one step per day, so an
    unbounded request (9999-12-31) would walk millions of steps."""
    if day > manila_today() + OCCURRENCE_HORIZON:
        raise HTTPException(status_code=422, detail=FAR_OCCURRENCE)


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
    ahead is a 422 (``refuse_far_occurrence``), as is one too far ahead to
    convert to UTC; one too far back to convert is off the schedule, a 422
    too. A request is matched by
    calendar day against the schedule from ``next_occurrence``: no match (a
    day before it, or an off-day ``next_occurrence``, included) is a 422; on a
    capped entry anything but the schedule's first occurrence is a 409, since
    its months are counted down in order. ``skipped`` is every occurrence in
    ``[next_occurrence, occurrence)`` that no posted linked row stands for,
    complete however many there are.
    """
    if requested is None:
        return first_occurrence(entry), []
    try:
        day = _utc_naive(requested).date()
    except OverflowError:
        # Past the last (or before the first) instant ``datetime`` holds in UTC.
        if requested.year >= 9999:
            raise HTTPException(status_code=422, detail=FAR_OCCURRENCE) from None
        raise HTTPException(status_code=422,
                            detail="Not an occurrence of this schedule") from None
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


def _neighbours(db: Session, entry, day: date) -> Tuple[Optional[date], date]:
    """The effective dates of the occurrences either side of the nominal ``day``,
    a 422 when ``day`` is not an occurrence of the walk from ``next_occurrence``.
    The first has no previous. The next is the schedule's next step (``_advance``'s),
    past the cap or the end date too, so raising either later cannot put the
    last occurrence's forced date out of order."""
    refuse_far_occurrence(day)
    walk = schedule_walk(entry, day)
    if not walk or walk[-1].date() != day:
        raise HTTPException(status_code=422, detail="Not an occurrence of this schedule")
    moved = _moved(db, entry)
    previous = effective(moved, walk[-2].date()) if len(walk) > 1 else None
    return previous, effective(moved, advance_occurrence(entry, walk[-1]).date())


def _next_is_scheduled(entry, day: date) -> bool:
    """Whether the step after the nominal ``day`` is a real occurrence: inside the
    cap and the end date. ``_neighbours``' next is the bare step, which may not be."""
    walk = schedule_walk(entry, day)
    following = advance_occurrence(entry, walk[-1]).date()
    through = schedule_walk(entry, following)
    return bool(through) and through[-1].date() == following


ALREADY_RECORDED = "This occurrence is already recorded; change the transaction's date"
STATEMENT_CLOSED = "That date is on a statement that has already closed"


def refuse_closed_statement(card: Account, day: date) -> None:
    """422 for a ``day`` inside a closed statement of ``card``. A card with no
    cycle has no statements to close."""
    from app.services.statements import statement_close

    close = statement_close(card, day)
    if close is not None and close < manila_today():
        raise HTTPException(status_code=422, detail=STATEMENT_CLOSED)


def set_forced_date(db: Session, entry, actor: User, day: date, forced: date,
                    card: Optional[Account] = None, overlap: bool = False) -> None:
    """Force the occurrence on the nominal ``day`` to ``forced``, without committing.

    The caller holds the owner's budget lock and then the entry lock. 422 when
    ``day`` is not an occurrence of the walk; 409 when a row, posted or pending,
    is linked to it; 422 past the reach, out of order or outside the record
    dates, and on ``card`` (a locked credit account) inside a closed statement:
    that is what the bank printed. ``forced`` equal to ``day`` clears the
    override instead (``clear_forced_date``), which restores what the schedule
    says even on a closed statement. ``overlap`` lets ``forced`` equal the next
    occurrence's effective date (never the previous one's), and only when that
    occurrence exists: the last of a capped or end-dated schedule stays strict.
    Every other refusal stands.
    """
    previous, following = _neighbours(db, entry, day)
    if occurrence_links(db, entry, day):
        raise HTTPException(status_code=409, detail=ALREADY_RECORDED)
    if forced == day:
        clear_forced_date(db, entry, day)
        return
    refuse_forced_date(day, forced, previous, following,
                       overlap and _next_is_scheduled(entry, day))
    if card is not None:
        refuse_closed_statement(card, forced)
    set_override(db, actor.id, day, forced, budget_entry_id=entry.id)


def clear_forced_date(db: Session, entry, day: date) -> None:
    """Clear the override on the nominal ``day`` if there is one, without
    committing. A 409 when the neighbours were forced past the nominal date, so
    clearing would break the order; a row left on a date no longer in the walk
    is inert, and goes."""
    if day in _moved(db, entry) and any(
            occ.date() == day for occ in schedule_walk(entry, day)):
        previous, following = _neighbours(db, entry, day)
        if not in_order(previous, day, following):
            raise HTTPException(status_code=409, detail=CLEAR_OUT_OF_ORDER)
    clear_override(db, day, budget_entry_id=entry.id)


def _create(db: Session, entry, actor: User, payload: BudgetEntryMaterialize,
            occurrence: datetime) -> Transaction:
    """A new row for ``occurrence``, posted unless ``payload.is_posted`` is
    False (Charged): the materialise create body. Dated
    ``payload.transaction_date`` or the effective date; ``occurrence_date`` stays
    the nominal ``occurrence``."""
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

    when = effective_at(_moved(db, entry), occurrence)
    if payload.transaction_date is None:
        # The date is the server's own (the occurrence): a legacy schedule's
        # old occurrence is a 422 here, not a ValidationError from the model.
        refuse_record_date(when)
    txn_create = TransactionCreate(
        account_id=entry.account_id,
        amount=amount,
        transaction_type=txn_type,
        transaction_date=payload.transaction_date or when,
        category_id=entry.category_id,
        allocation_id=entry.allocation_id,
        budget_entry_id=entry.id,
        description=entry.name,
        is_posted=payload.is_posted,
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


def advance_past(entry: BudgetEntry, occurrence: datetime) -> None:
    """``_advance`` for a caller that has recorded ``occurrence`` itself (services/repeat.py)."""
    _advance(entry, occurrence)


def record_occurrence(db: Session, entry, actor: User, payload: BudgetEntryMaterialize,
                      occurrence: datetime) -> Recorded:
    """Record ``occurrence`` of ``entry`` once, without committing.

    The caller holds the owner's budget lock and then the entry lock, and has
    validated the entry. More than one linked row is a 409. One posted row
    records nothing new (``already_posted``; with ``advance`` False a 409). One
    pending row is locked and posted as ``actor`` (``pending_update_for``,
    ``apply_transaction_update``), a 409 when ``actor`` cannot edit it
    (``posted_pending``). No linked row gets a new posted transaction dated
    ``payload.transaction_date`` or the effective date (``created``). With
    ``payload.is_posted`` False (Charged) the new row is pending, and any
    linked row is a 409. With ``payload.advance`` the schedule then moves past
    ``occurrence``.
    """
    from app.routers.transactions import apply_transaction_update

    links = occurrence_links(db, entry, occurrence.date())
    if len(links) > 1:
        raise HTTPException(
            status_code=409,
            detail="This occurrence has more than one linked transaction; "
                   "resolve them on the Transactions page")
    if links and not payload.is_posted:
        raise HTTPException(
            status_code=409,
            detail="This occurrence is already recorded" if links[0][1]
            else "This occurrence is already charged; post it on the Transactions page")
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
        was_active = entry.is_active
        _advance(entry, occurrence)
        if was_active and not entry.is_active:
            loan_svc.transfers_stopped(db, [entry.transfer_to_account_id])
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

    ``occurrence_date`` stays nominal, the date a Mark paid sends back. Each row
    adds ``effective_date``, its forced date or that same day, and ``due``,
    ``oldest_due``, ``latest_due`` and the distance from today read it. An
    occurrence forced into the walked range from past its end is walked too.
    """
    if include is not None:
        refuse_far_occurrence(include)
    today = manila_today()
    around = timedelta(days=OCCURRENCES_AROUND)
    through = max(today + around, include or today)
    moved = _moved(db, entry)
    if moved:
        walk = [occ for occ in schedule_walk(entry, through + OVERRIDE_REACH)
                if occ.date() <= through or effective(moved, occ.date()) <= through]
    else:
        walk = schedule_walk(entry, through)
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
        when = effective(moved, day)
        rows.append({"occurrence_date": day, "effective_date": when, "due": when <= today,
                     "linked": linked, "skipped_before": unrecorded})
        if posted[day]:
            posted[day] -= 1
            continue
        unrecorded += 1
        oldest_unrecorded = oldest_unrecorded or day
        if when <= today:
            due_unposted += 1
            oldest_due = oldest_due or when
            latest_due = when

    capped = is_capped(entry)
    if capped:
        kept = [0] if rows else []
    else:
        kept = [i for i, r in enumerate(rows)
                if i < OCCURRENCES_FIRST
                or today - around <= r["effective_date"] <= today + around
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
    ``next_occurrence`` whose effective date is through Manila's today
    (``due_walk``). Every pending row linked to it
    is locked first, in ascending id, before anything is created, so the lock
    order stays owner, entry, transaction rows, accounts. Then every due
    occurrence goes through ``record_occurrence`` in order, dated on its
    effective date; a posted one only advances the schedule, so it never stalls behind a
    recorded month. A 409 on any occurrence leaves the caller to roll back.
    """
    due = due_walk(db, entry, manila_today())
    moved = _moved(db, entry)
    # Each due occurrence is posted on its own day, so one outside the allowed
    # range refuses the whole request, before anything is written (Post N due
    # on a decades-old schedule would otherwise write rows the bounds forbid).
    for occ in due:
        refuse_record_date(effective_at(moved, occ))
    days = {occ.date() for occ in due}
    pending = sorted(txn_id for _, when, txn_id, is_posted in _linked_rows(
        db, [entry.id], occurrence_match=True)
        if not is_posted and _naive(when).date() in days)
    for txn_id in pending:
        locking.lock_transaction(db, txn_id)
    return [record_occurrence(db, entry, actor,
                              BudgetEntryMaterialize(transaction_date=effective_at(moved, occ)),
                              occ)
            for occ in due]


# --- Auto-post: card installments (STU-343 Plan B) and autopay cash entries -------------------

@dataclass
class PostPlan:
    """What a recorder would record for one auto-posted entry, written nowhere.

    ``walk`` is what the job, the page-open trigger and the backstop record, in
    order: the schedule from ``next_occurrence`` through ``through``
    (``due_walk``), posted-linked months included (they only advance the
    schedule), cut before the first held month and, on a cash entry, before the
    first the balance does not cover, or empty behind any other blocker. ``due``
    (the months no posted row stands for) and ``postable``
    (the ``due`` months in ``walk``) are for counts and labels only.
    """
    walk: List[datetime]
    due: List[datetime]
    postable: List[datetime]
    blocker: Optional[str]


def _funded(db: Session, entry, account: Account, walk: List[datetime]) -> List[datetime]:
    """The months of ``walk`` that ``account``'s posted balance covers, oldest
    first and cumulatively, stopping at the first it does not: no partial
    payment. A posted-linked month moves no money, so it passes whatever the
    balance, a pending-linked one moves its own amount, and a new row the
    entry's. ``overflow_account_id`` plays no part: ``_create`` posts to the
    primary account only."""
    links = {_naive(when).date(): (txn_id, is_posted) for _, when, txn_id, is_posted
             in _linked_rows(db, [entry.id], occurrence_match=True)}
    balance = Decimal(str(account.balance))
    funded = []
    for occ in walk:
        txn_id, is_posted = links.get(occ.date(), (None, False))
        amount = (0 if is_posted else db.get(Transaction, txn_id).amount if txn_id
                  else entry.amount)
        cost = Decimal(str(amount))
        if cost > 0 and cost > balance:
            break
        balance -= cost
        funded.append(occ)
    return funded


def post_plan(db: Session, entry, actor: User, through: date, held: Counter,
              access: RecordAccess) -> PostPlan:
    """The months ``actor`` would record for ``entry`` through ``through``, and why not.

    ``held`` is ``installment_duplicates.held_occurrences`` (its keys for this
    entry are read); ``access`` is ``actor``'s ``RecordAccess``. The blocker
    is the first that applies: ``unreviewed`` (a card installment only),
    ``auto_post_off``, ``blocked:<reason>`` (``recurring_kinds.settlement_block``),
    ``blocked:ambiguous`` (a walk day with more than one linked row, which
    ``record_occurrence`` refuses), ``creator_no_access``,
    ``caller_no_access``, ``held`` (a due month is held: the months before the
    first held one stay in ``walk``). On a cash entry the walk is then cut by
    ``_funded``, and a cut makes the blocker ``insufficient_funds``; a recorder
    holds the account lock so the balance it reads cannot move under it.
    """
    from app.services.forecast import unrecorded_occurrences

    due = unrecorded_occurrences(db, [entry], through)[entry.id]
    full_walk = due_walk(db, entry, through)
    account = db.get(Account, entry.account_id) if entry.account_id else None
    block = settlement_block(entry, account)
    card_installment = is_card_installment(entry, account)
    blocker: Optional[str] = None
    first_held: Optional[date] = None
    if card_installment and entry.installment_reviewed_at is None:
        blocker = "unreviewed"
    elif not entry.auto_post_enabled:
        blocker = "auto_post_off"
    elif block is not None:
        blocker = f"blocked:{block}"
    else:
        days = {occ.date() for occ in full_walk}
        links = Counter(_naive(when).date() for _, when, _, _ in _linked_rows(
            db, [entry.id], occurrence_match=True))
        creator = db.get(User, entry.user_id)
        if any(links[day] > 1 for day in days):
            blocker = "blocked:ambiguous"
        elif creator is None or not RecordAccess(db, creator).permissions(entry)["can_edit"]:
            blocker = "creator_no_access"
        elif not access.permissions(entry)["can_edit"]:
            blocker = "caller_no_access"
        else:
            held_days = [occ.date() for occ in due if held[(entry.id, occ.date())]]
            if held_days:
                blocker = "held"
                first_held = min(held_days)
    if blocker is None:
        walk = full_walk
    elif blocker == "held":
        walk = [occ for occ in full_walk if occ.date() < first_held]
    else:
        walk = []
    if blocker in (None, "held") and not card_installment:
        funded = _funded(db, entry, account, walk)
        if len(funded) < len(walk):
            walk, blocker = funded, "insufficient_funds"
    walked = {occ.date() for occ in walk}
    postable = [occ for occ in due if occ.date() in walked]
    return PostPlan(walk=walk, due=due, postable=postable, blocker=blocker)


@dataclass
class EntryPosting:
    """One entry's run: the plan's blocker (None for an uncut walk) and what was recorded."""
    blocker: Optional[str]
    recorded: List[Recorded]

    @property
    def posted(self) -> int:
        """Months that moved money: ``created`` and ``posted_pending``."""
        return sum(1 for item in self.recorded if item.outcome != Outcome.ALREADY_POSTED)


def _post_entry_due(db: Session, entry, actor: User, through: date, *,
                    hold_duplicates: bool) -> EntryPosting:
    """Record ``entry``'s walk through ``through`` as ``actor``, without committing.

    The caller holds the creator's owner lock and then the entry lock, and has
    checked the entry. With ``hold_duplicates`` the walk is ``post_plan``'s
    (cut before the first held month, empty behind any other blocker);
    without it (the review, which has just resolved this entry's candidates)
    it is the uncut ``due_walk``. Every pending row linked to a day of the
    ``due_walk`` is locked first, in ascending id, as ``materialize_due`` does,
    and then a cash entry's account, so the plan reads its balance under the
    lock. No ``transaction_date`` is passed: a new row is dated on its effective
    date and a linked pending row keeps its own date. A 409 or 400 from
    ``record_occurrence`` is left to the caller, which rolls back.
    """
    from app.services.installment_duplicates import held_occurrences

    walk = due_walk(db, entry, through)
    days = {occ.date() for occ in walk}
    pending = sorted(txn_id for _, when, txn_id, is_posted in _linked_rows(
        db, [entry.id], occurrence_match=True)
        if not is_posted and _naive(when).date() in days)
    for txn_id in pending:
        locking.lock_transaction(db, txn_id)
    blocker = None
    if hold_duplicates:
        if not is_card_installment(entry, db.get(Account, entry.account_id)):
            locking.lock_accounts(db, [entry.account_id])
        plan = post_plan(db, entry, actor, through, held_occurrences(db, [entry], through),
                         RecordAccess(db, actor))
        walk, blocker = plan.walk, plan.blocker
    recorded = [record_occurrence(db, entry, actor, BudgetEntryMaterialize(), occ)
                for occ in walk]
    return EntryPosting(blocker=blocker, recorded=recorded)


def has_ended(e, today: date) -> bool:
    """Whether the schedule is over: a capped entry's last occurrence used up, or
    an end date before ``today`` (Manila). An inactive entry that has not ended
    is paused."""
    return bool(
        (is_capped(e) and e.max_occurrences <= 0)
        or (e.end_mode == "on_date" and e.end_date is not None
            and _naive(e.end_date).date() < today))


def autopay_toggle_block(entry, account: Optional[Account]) -> Optional[str]:
    """Why autopay cannot be turned on for ``entry``, or None: ``card_installment``
    (the review turns that on), ``ended`` or ``paused`` (a capped entry used up, or
    inactive), else ``settlement_block``'s reason. The order is the toggle's."""
    if is_card_installment(entry, account):
        return "card_installment"
    if is_capped(entry) and entry.max_occurrences <= 0:
        return "ended"
    if not entry.is_active:
        return "ended" if has_ended(entry, manila_today()) else "paused"
    return settlement_block(entry, account)


AUTOPAY_COUNT_CHANGED = "The number of missed payments has changed; check them and try again"


def autopay_preview(db: Session, entry) -> dict:
    """``GET .../auto-post-preview``: ``block`` (``settlement_block``), and the
    occurrences due through Manila's today that no posted row stands for:
    ``due_count`` and ``oldest``, the first one's effective date."""
    from app.services.forecast import unrecorded_occurrences

    account = db.get(Account, entry.account_id) if entry.account_id else None
    due = unrecorded_occurrences(db, [entry], manila_today())[entry.id]
    return {"block": settlement_block(entry, account), "due_count": len(due),
            "oldest": effective(_moved(db, entry), due[0].date()) if due else None}


def turn_on_autopay(db: Session, entry, actor: User, expected_due: Optional[int]) -> EntryPosting:
    """Turn autopay on for a cash entry and post what is due, without committing.

    The caller holds the owner's budget lock and then the entry lock, and has
    checked ``settlement_block``. ``expected_due`` must be the due count the
    owner confirmed (none when nothing is due), else a 409 that changes nothing;
    an occurrence outside the record dates is a 422, also before any write. The
    run is the job's (``_post_entry_due``), so a funds or duplicate stop leaves
    the flag on and the rest flagged. A leftover review stamp goes with it: the
    job would ignore the flag otherwise (``auto_posts``).
    """
    from app.services.forecast import unrecorded_occurrences

    today = manila_today()
    due = unrecorded_occurrences(db, [entry], today)[entry.id]
    if (expected_due or 0) != len(due):
        raise HTTPException(status_code=409, detail=AUTOPAY_COUNT_CHANGED)
    moved = _moved(db, entry)
    for occ in due:
        refuse_record_date(effective_at(moved, occ))
    entry.auto_post_enabled = True
    entry.installment_reviewed_at = None
    entry.updated_at = utc_now()
    # The duplicate universe reads the flag by query; the session does not autoflush.
    db.flush()
    return _post_entry_due(db, entry, actor, today, hold_duplicates=True)


@dataclass
class AutoPostResult:
    posted: int = 0
    skipped: Counter = field(default_factory=Counter)
    entries: List[dict] = field(default_factory=list)
    loans: List[dict] = field(default_factory=list)


# A ``post_plan`` or ``loan_plan`` blocker as a skip reason; None is not a skip.
BLOCKER_REASONS = {"held": "possible_duplicate", "creator_no_access": "no_access",
                   "caller_no_access": "no_access", "insufficient_funds": "insufficient_funds",
                   "planned_payment": "planned_payment", "needs_amount": "needs_amount"}


def blocker_reason(blocker: Optional[str]) -> Optional[str]:
    if blocker is None or blocker in ("unreviewed", "auto_post_off", "blocked:inactive"):
        return None
    if blocker.startswith("blocked:"):
        return blocker.split(":", 1)[1]
    return BLOCKER_REASONS[blocker]


def _failure_reason(exc: HTTPException) -> str:
    """The skip reason of an ``HTTPException`` from ``record_occurrence``."""
    detail = str(exc.detail)
    if exc.status_code == 409 and "more than one linked" in detail:
        return "ambiguous"
    if exc.status_code == 409 and "can't edit" in detail:
        return "pending_not_editable"
    if exc.status_code == 400 and "amount charged" in detail:
        return "needs_amount"
    return "error"


def _auto_post_scope(db: Session, through: date, actor_scope: Optional[User],
                     entry_ids) -> List[Tuple[int, int]]:
    """``[(entry id, creator id)]`` in id order: active, auto-post-on entries that
    ``auto_posts`` admits (a stray flag on anything else is ignored) with a next
    occurrence on or before ``through``, or a later one forced on or before it (a
    forced date stays within the reach); only ``entry_ids`` when given; for a
    caller, only entries the caller can edit."""
    from app.core.access import editable_account_ids

    forced = db.query(PaymentDateOverride.budget_entry_id).filter(
        PaymentDateOverride.budget_entry_id.isnot(None),
        PaymentDateOverride.effective_date <= through)
    query = (
        db.query(BudgetEntry, Account)
        .join(Account, Account.id == BudgetEntry.account_id)
        .filter(BudgetEntry.is_active.is_(True),
                BudgetEntry.auto_post_enabled.is_(True),
                or_(BudgetEntry.next_occurrence < _day_after(through),
                    and_(BudgetEntry.next_occurrence < _day_after(through) + OVERRIDE_REACH,
                         BudgetEntry.id.in_(forced))))
    )
    if entry_ids is not None:
        query = query.filter(BudgetEntry.id.in_(list(entry_ids)))
    if actor_scope is not None:
        query = query.filter(BudgetEntry.account_id.in_(editable_account_ids(db, actor_scope)))
    entries = [entry for entry, account in query.order_by(BudgetEntry.id).all()
               if auto_posts(entry, account)]
    if actor_scope is not None:
        access = RecordAccess(db, actor_scope)
        entries = [e for e in entries if access.permissions(e)["can_edit"]]
    return [(e.id, e.user_id) for e in entries]


def post_due_installments(db: Session, *, through: date, actor_scope: Optional[User] = None,
                          entry_ids=None, dry_run: bool = False) -> AutoPostResult:
    """Post every due month of the auto-post-on entries in scope (reviewed card
    installments and autopay cash entries, ``_auto_post_scope``).

    The job (``actor_scope`` None) posts as each entry's creator; the
    backstop and the page-open trigger pass the caller, who is then the actor
    and sees only entries they can edit. Each entry runs in its own
    transaction, committed (rolled back when ``dry_run``) before the next:
    ``expire_all``, the creator's owner lock, the entry lock, then a recheck
    on the locked row with a new ``RecordAccess`` (still on, active, in scope
    and eligible; the creator, and a caller, can still edit it; else skipped),
    then ``_post_entry_due``. An ``HTTPException`` while recording rolls back
    that entry only and records its reason. ``posted`` counts ``created`` and
    ``posted_pending``; a posted-linked month only advances.
    """
    result = AutoPostResult()
    for entry_id, creator_id in _auto_post_scope(db, through, actor_scope, entry_ids):
        db.expire_all()
        locking.lock_owner_budgets(db, creator_id)
        entry = locking.lock_entry(db, entry_id)
        reason: Optional[str] = None
        posted = 0
        account = db.get(Account, entry.account_id) if entry is not None else None
        if entry is None or not (entry.is_active and entry.auto_post_enabled
                                 and auto_posts(entry, account)):
            db.rollback()
            if entry is not None:
                result.entries.append({"entry_id": entry_id, "posted": 0, "skipped_reason": None})
            continue
        block = settlement_block(entry, account)
        creator = db.get(User, entry.user_id)
        actor = creator if actor_scope is None else actor_scope
        if block is not None:
            reason = None if block == "inactive" else block
        elif creator is None or not RecordAccess(db, creator).permissions(entry)["can_edit"]:
            reason = "no_access"
        elif actor_scope is not None and not RecordAccess(
                db, actor_scope).permissions(entry)["can_edit"]:
            reason = "no_access"
        else:
            try:
                run = _post_entry_due(db, entry, actor, through, hold_duplicates=True)
                posted = run.posted
                reason = blocker_reason(run.blocker)
            except HTTPException as exc:
                db.rollback()
                posted, reason = 0, _failure_reason(exc)
        if dry_run:
            db.rollback()
        else:
            db.commit()
        result.posted += posted
        if reason is not None:
            result.skipped[reason] += 1
        result.entries.append({"entry_id": entry_id, "posted": posted, "skipped_reason": reason})
    return result


# --- Auto-post: loans -------------------------------------------------------------------------

LOAN_CHANGED = "This loan's paying account changed; try again"


def lock_loan(db: Session, loan_id: int, owner_id: int) -> Optional[Account]:
    """The loan, with the owner's budget lock and then the loan and its paying
    account locked, or None once it is gone or was re-routed while waiting: its
    new paying account could sort before a lock already held, so the caller
    gives up rather than break the order. ``record_loan_payment`` locks the same
    accounts and ``add_transaction`` takes owner then accounts, so a hand payment
    and a run queue on the same rows."""
    db.expire_all()
    locking.lock_owner_budgets(db, owner_id)
    loan = db.get(Account, loan_id)
    if loan is None:
        return None
    paying = loan.payment_account_id
    locking.lock_accounts(db, [loan_id, paying])
    return loan if loan.payment_account_id == paying else None


def _paying_account(db: Session, user: Optional[User], loan: Account
                    ) -> Tuple[Optional[Account], Optional[str]]:
    """``(paying account, None)``, or ``(None, reason)`` when ``user`` cannot pay
    the loan from it: ``no_funding_account`` (none set, closed, or not a funding
    account) or ``no_access``. ``routers/accounts.py`` ``_loan_funding`` is the
    rule the Record payment route applies; it refuses a credit card, so a loan is
    never autopaid from one."""
    from app.routers.accounts import _loan_funding

    if user is None:
        return None, "no_access"
    try:
        funding = _loan_funding(db, user, loan, None)
    except HTTPException as exc:
        return None, "no_access" if exc.status_code == 404 else "no_funding_account"
    return (funding, None) if funding.is_active else (None, "no_funding_account")


def loan_feeding_entries(db: Session, loan: Account) -> List[int]:
    """Ids, ascending, of the active recurring transfers into ``loan``."""
    return [entry_id for (entry_id,) in db.query(BudgetEntry.id).filter(
        BudgetEntry.transfer_to_account_id == loan.id,
        BudgetEntry.is_active.is_(True)).order_by(BudgetEntry.id)]


def loan_block(db: Session, loan: Account, caller: Optional[User] = None) -> Optional[str]:
    """Why a loan cannot settle by autopay, or None when it can, read for its
    creator and ``caller`` when given: ``inactive``, ``no_funding_account``,
    ``no_access``, ``no_schedule`` (no first date or payment amount), ``no_rate``
    (the split would invent all-principal), ``foreign_currency``, or
    ``recurring_entry`` (an active recurring transfer into the loan, which would
    pay it twice)."""
    if not loan.is_active:
        return "inactive"
    funding, reason = _paying_account(db, db.get(User, loan.user_id), loan)
    if reason is None and caller is not None:
        reason = _paying_account(db, caller, loan)[1]
    if reason is not None:
        return reason
    if loan.loan_first_payment_date is None or loan.loan_payment_amount is None:
        return "no_schedule"
    if loan.loan_annual_rate is None:
        return "no_rate"
    if funding.currency != loan.currency:
        return "foreign_currency"
    return "recurring_entry" if loan_feeding_entries(db, loan) else None


def _due_loan_dates(db: Session, loan: Account, through: date
                    ) -> List[Tuple[date, datetime, Decimal]]:
    """``(nominal due date, effective date at midnight, still owed)`` of the open
    due dates whose effective date is on or before ``through``, oldest first. A
    part-paid one owes the rest; one owing nothing is not a payment, so it is
    neither counted nor funds-checked. Forced dates keep the schedule's order, so
    this is a prefix of the open due dates."""
    moved = load_loan_overrides(db, [loan.id]).get(loan.id)
    end = _day_after(through)
    rows = []
    for _, due, owed in loan_svc.due_dates(db, loan, extend(end) if moved else end):
        day = effective(moved, due)
        if day <= through and owed > 0:
            rows.append((due, datetime(day.year, day.month, day.day), owed))
    return rows


@dataclass
class LoanStep:
    """A payment a run would record: the due date's nominal ``due``, the
    effective date it is dated ``when``, and its split."""
    due: date
    when: datetime
    principal: Decimal
    interest: Decimal


@dataclass
class LoanPlan:
    """What a run would post for one loan, written nowhere.

    ``due`` is ``_due_loan_dates``' rows and ``steps`` those it would post, oldest
    first, each split on the balance the ones before leave. ``blocker`` says why
    ``steps`` stops short: ``blocked:<reason>`` (``loan_block``), ``caller_no_access``,
    ``planned_payment``, ``insufficient_funds`` or ``needs_amount``.
    """
    due: List[Tuple[date, datetime, Decimal]]
    steps: List[LoanStep]
    blocker: Optional[str]


def loan_plan(db: Session, loan: Account, through: date, caller: Optional[User] = None) -> LoanPlan:
    """The payments a run through ``through`` would record for ``loan``.

    A due date a pending payment covers any part of stops the walk
    (``planned_payment``: the planned row is the owner's). So does one the paying
    account's posted balance does not cover (``insufficient_funds``), cumulatively
    and with no partial payment, and one ``split_due`` refuses (``needs_amount``:
    the final, smaller payment on a fixed loan, which the owner records by hand).
    A recorder holds the account locks, so nothing here moves under it.
    """
    due = _due_loan_dates(db, loan, through)
    block = loan_block(db, loan)
    if block is not None:
        return LoanPlan(due, [], f"blocked:{block}")
    if caller is not None and _paying_account(db, caller, loan)[1] is not None:
        return LoanPlan(due, [], "caller_no_access")
    uncovered = loan_svc.cover_planned([(day, owed) for day, _, owed in due],
                                       loan_svc.planned_covers(db, loan))
    funds = Decimal(str(db.get(Account, loan.payment_account_id).balance))
    # What ``split_due`` reads, carried forward as each step would leave it.
    after = SimpleNamespace(balance=Decimal(str(loan.balance)),
                            loan_payment_amount=loan.loan_payment_amount,
                            loan_annual_rate=loan.loan_annual_rate,
                            loan_amortization=loan.loan_amortization,
                            loan_kind=loan.loan_kind)
    steps: List[LoanStep] = []
    for (day, when, owed), left in zip(due, uncovered):
        if left < owed:
            return LoanPlan(due, steps, "planned_payment")
        if funds < owed:
            return LoanPlan(due, steps, "insufficient_funds")
        try:
            principal, interest = loan_svc.split_due(after, owed)
        except loan_svc.LoanError:
            return LoanPlan(due, steps, "needs_amount")
        funds -= owed
        after.balance += principal
        steps.append(LoanStep(day, when, principal, interest))
    return LoanPlan(due, steps, None)


def cover_released(db: Session, txn, cover: Tuple[int, date]) -> bool:
    """Whether an edit, already flushed, let go of due dates ``txn`` held as a planned
    payment, ``cover`` being its ``planned_cover`` before the edit. The hold is on a
    date, not an amount, so a pending row releases by leaving its day or its loan.
    Posted into the same loan, it releases whatever it left open and due: the walk
    that stopped on it would carry on with no count."""
    loan = db.get(Account, cover[0])
    if loan is None or not loan.auto_post_enabled:
        return False
    if txn.is_posted and txn.transfer_to_account_id == loan.id:
        return bool(_due_loan_dates(db, loan, manila_today()))
    return loan_svc.planned_cover(txn) != cover


def _post_loan_due(db: Session, loan: Account, through: date, caller: Optional[User]
                   ) -> Tuple[int, Optional[str]]:
    """Post ``loan``'s due payments oldest first, without committing, and return
    ``(posted, blocker)``. The caller holds ``lock_loan``'s locks. The plan is
    recomputed after each post, so the split and a ``reduce_term`` preview see the
    new balance and a settled due date is gone. Each row is a posted scheduled
    transfer, the creator's, dated on the effective date. A date outside the
    record dates is left to the caller as a 422."""
    posted = 0
    while True:
        plan = loan_plan(db, loan, through, caller)
        if not plan.steps:
            return posted, plan.blocker if plan.due else None
        step = plan.steps[0]
        refuse_record_date(step.when)
        loan_svc.record_payment(
            db, user_id=loan.user_id, loan=loan, funding=db.get(Account, loan.payment_account_id),
            principal=step.principal, interest=step.interest, kind=loan_svc.SCHEDULED,
            when=step.when, is_posted=True, description=None)
        # The next plan reads the row by query; the session does not autoflush.
        db.flush()
        posted += 1


def loan_autopay_preview(db: Session, loan: Account, caller: User) -> dict:
    """``GET /accounts/{id}/auto-post-preview``: ``block`` (``loan_block``), and the
    due dates through Manila's today still owed: ``due_count`` and ``oldest``, the
    first one's effective date."""
    due = _due_loan_dates(db, loan, manila_today())
    return {"block": loan_block(db, loan, caller), "due_count": len(due),
            "oldest": due[0][1].date() if due else None}


def turn_on_loan_autopay(db: Session, loan: Account, caller: User,
                         expected_due: Optional[int]) -> None:
    """Turn autopay on for a loan and post what is due, without committing.

    ``turn_on_autopay``'s rules: the caller holds ``lock_loan``'s locks and has
    checked ``loan_block``, ``expected_due`` must be the due count the owner
    confirmed, a due date outside the record dates is a 422 before any write, and
    a funds or planned-payment stop leaves the flag on and the rest flagged.
    """
    today = manila_today()
    due = _due_loan_dates(db, loan, today)
    if (expected_due or 0) != len(due):
        raise HTTPException(status_code=409, detail=AUTOPAY_COUNT_CHANGED)
    for _, when, _ in due:
        refuse_record_date(when)
    loan.auto_post_enabled = True
    loan.updated_at = utc_now()
    _post_loan_due(db, loan, today, caller)


def _auto_post_loans(db: Session, actor_scope: Optional[User]) -> List[Tuple[int, int]]:
    """``[(loan id, owner id)]`` in id order: active, flagged loans; for a caller,
    only those the caller manages, since only an owner or admin may see the flag."""
    from app.core.access import editable_account_ids

    query = db.query(Account).filter(Account.account_type == AccountType.LOAN,
                                     Account.is_active.is_(True),
                                     Account.auto_post_enabled.is_(True))
    if actor_scope is not None:
        query = query.filter(Account.id.in_(editable_account_ids(db, actor_scope)))
    return [(loan.id, loan.user_id) for loan in query.order_by(Account.id).all()
            if actor_scope is None or account_role(actor_scope, loan) in MANAGE_ROLES]


def post_due_loans(db: Session, *, through: date, actor_scope: Optional[User] = None,
                   dry_run: bool = False,
                   result: Optional[AutoPostResult] = None) -> AutoPostResult:
    """Post the due payments of the flagged loans in scope, adding to ``result``.

    A second half of ``post_due_installments``, run after it, with the same
    ``actor_scope`` and ``dry_run``. Each loan runs in its own transaction: the
    locks (``lock_loan``), a recheck on the locked row (still on and active; a
    caller still manages it), then ``_post_loan_due``. A loan is listed in
    ``result.loans`` only when it posted or stopped with a due date open.
    """
    result = result if result is not None else AutoPostResult()
    for loan_id, owner_id in _auto_post_loans(db, actor_scope):
        loan = lock_loan(db, loan_id, owner_id)
        posted, reason = 0, None
        if (loan is not None and loan.is_active and loan.auto_post_enabled
                and (actor_scope is None or account_role(actor_scope, loan) in MANAGE_ROLES)):
            try:
                posted, blocker = _post_loan_due(db, loan, through, actor_scope)
                reason = blocker_reason(blocker)
            except HTTPException as exc:
                db.rollback()
                posted, reason = 0, _failure_reason(exc)
        if dry_run:
            db.rollback()
        else:
            db.commit()
        result.posted += posted
        if reason is not None:
            result.skipped[reason] += 1
        if posted or reason is not None:
            result.loans.append({"loan_id": loan_id, "posted": posted, "skipped_reason": reason})
    return result


def _claim_page_open_sql(db: Session, user: User, now: datetime) -> bool:
    """Take ``user``'s page-open slot at ``now``, without committing: one atomic
    ``UPDATE … RETURNING`` that succeeds only when the last claim is older than
    15 minutes (or there is none). A second claim made meanwhile waits on the
    row lock, re-reads the row once the first commits, and returns no row."""
    from sqlalchemy import text

    row = db.execute(text(
        "UPDATE users SET installments_page_posted_at = :now "
        "WHERE id = :uid AND (installments_page_posted_at IS NULL "
        "OR installments_page_posted_at <= CAST(:now AS timestamptz) - interval '15 minutes') "
        "RETURNING id"), {"now": now, "uid": user.id}).first()
    return row is not None


def claim_page_open(db: Session, user: User) -> bool:
    """Whether ``user`` may run the page-open auto-post now; the claim is
    committed on its own, before any posting lock is taken, so a run that then
    fails still uses its 15 minutes."""
    claimed = _claim_page_open_sql(db, user, utc_now())
    db.commit()
    return claimed


# --- Card installment review (STU-343 Plan B) -------------------------------------------------

REVIEW_CHANGED = "This installment changed since you opened the review; reopen it"


@dataclass
class ReviewState:
    """The review of one card installment for one caller (``review_state``).

    ``missed`` is every due month no posted row stands for, through ``through``;
    ``linked`` is each missed day's linked rows (a pending one, posted by the
    review); ``candidates`` is each missed day with no linked row and its
    possible duplicates the caller reads. ``body`` is the GET response and
    ``token`` binds it.
    """
    through: date
    missed: List[datetime]
    linked: dict
    candidates: dict
    body: dict
    token: str


def _aware_utc(value: Optional[datetime]) -> Optional[datetime]:
    """Aware UTC, microseconds kept; a naive value is read as UTC."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    aware = _aware_utc(value)
    return aware.isoformat() if aware is not None else None


def _money(value) -> str:
    from decimal import Decimal

    return str(Decimal(str(value)))


def _row_version(txn: Transaction) -> Optional[str]:
    """A transaction's version: ``updated_at``, else ``created_at``."""
    return _iso(txn.updated_at or txn.created_at)


def review_token(payload: dict) -> str:
    """``sha256`` over the canonical JSON (sorted keys) of ``payload``."""
    import hashlib
    import json

    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def review_state(db: Session, entry, caller: User, today: date) -> ReviewState:
    """What the installment review shows ``caller`` for ``entry`` on Manila's ``today``.

    The caller has already passed ``can_edit`` on the entry. The GET body and
    the POST's binding both come from here.

    - ``missed``: the due months no posted row stands for
      (``unrecorded_occurrences`` through ``today``), each with ``linked``
      "pending" when a pending row is linked to it.
    - ``candidates``: for each missed month with no linked row, its possible
      duplicates (``installment_duplicates.duplicate_candidates``: the
      creator's own unlinked debits of the amount on the card within three
      days), kept only when ``caller`` reads the row (each is checked). No
      row's entry, category or allocation is returned.
    - ``remaining_after``: ``max_occurrences`` less the whole walk through
      ``today`` (``due_walk``, posted-linked months included, since the review
      advances past them); None for an open-ended entry.
    - ``envelope``: the entry's allocation name for its creator only
      (allocations are creator-private), else None.
    - ``past_cycles``: some missed month's statement cycle, read on its effective
      date, closed before ``today``.
    - ``review_token``: ``review_token`` over ``today``, the caller, the
      entry's stored state and version, its forced dates, each missed month with
      its linked rows and each candidate with its version, so a change to any of
      them, another caller or another Manila day gives another token.
    """
    from app.models.allocation import Allocation
    from app.services.forecast import unrecorded_occurrences
    from app.services.installment_duplicates import duplicate_candidates
    from app.services.recurring_kinds import auto_post_block
    from app.services.statements import statement_close

    card = db.get(Account, entry.account_id) if entry.account_id else None
    block = auto_post_block(entry, card)
    missed = unrecorded_occurrences(db, [entry], today)[entry.id]
    moved = _moved(db, entry)
    missed_days = {occ.date() for occ in missed}
    linked: dict = defaultdict(list)
    for _, when, txn_id, _ in _linked_rows(db, [entry.id], occurrence_match=True):
        day = _naive(when).date()
        if day in missed_days:
            linked[day].append(db.get(Transaction, txn_id))
    linked = dict(linked)
    access = RecordAccess(db, caller)
    candidates = {}
    for day, rows in duplicate_candidates(
            db, entry, [occ for occ in missed if occ.date() not in linked], moved).items():
        readable = [txn for txn in rows if access.readable(txn)]
        if readable:
            candidates[day] = readable

    walk = due_walk(db, entry, today)
    remaining_after = (entry.max_occurrences - len(walk)
                       if is_capped(entry) and entry.max_occurrences is not None else None)
    envelope = None
    if entry.user_id == caller.id and entry.allocation_id is not None:
        allocation = db.get(Allocation, entry.allocation_id)
        if allocation is not None:
            envelope = {"allocation_name": allocation.name}
    past_cycles = False
    if card is not None:
        for occ in missed:
            close = statement_close(card, effective(moved, occ.date()))
            if close is not None and close < today:
                past_cycles = True
                break

    reviewed = entry.installment_reviewed_at is not None
    binding = {
        "through": today.isoformat(),
        "caller_id": caller.id,
        "entry_id": entry.id,
        "entry_version": _iso(entry.updated_at),
        "next_occurrence": _naive(entry.next_occurrence).isoformat(),
        "max_occurrences": entry.max_occurrences,
        "is_active": bool(entry.is_active),
        "account_id": entry.account_id,
        "amount": _money(entry.amount),
        "currency": getattr(entry.currency, "value", entry.currency),
        "reviewed": reviewed,
        "auto_post_enabled": bool(entry.auto_post_enabled),
        "forced": sorted([nominal.isoformat(), forced.isoformat()]
                         for nominal, forced in moved.items()),
        "missed": [[occ.date().isoformat(),
                    [[txn.id, bool(txn.is_posted), _row_version(txn)]
                     for txn in linked.get(occ.date(), [])]]
                   for occ in missed],
        "candidates": [[day.isoformat(), txn.id, _row_version(txn), _money(txn.amount),
                        _naive(txn.transaction_date).isoformat(), bool(txn.is_posted),
                        txn.budget_entry_id]
                       for day in sorted(candidates) for txn in candidates[day]],
    }
    token = review_token(binding)
    body = {
        "entry_id": entry.id,
        "name": entry.name,
        "account_name": card.name if card is not None else None,
        "currency": entry.currency,
        "amount": float(entry.amount),
        "reviewed": reviewed,
        "auto_post_enabled": bool(entry.auto_post_enabled),
        "block": block,
        "missed": [{"occurrence_date": occ.date(),
                    "linked": "pending" if any(not txn.is_posted
                                               for txn in linked.get(occ.date(), []))
                    else None}
                   for occ in missed],
        "candidates": [{"occurrence_date": day,
                        "transactions": [{"id": txn.id, "date": _naive(txn.transaction_date).date(),
                                          "amount": float(txn.amount),
                                          "is_posted": bool(txn.is_posted),
                                          "description": txn.description}
                                         for txn in candidates[day]]}
                       for day in sorted(candidates)],
        "remaining_after": remaining_after,
        "envelope": envelope,
        "past_cycles": past_cycles,
        "entry_version": entry.updated_at,
        "review_token": token,
    }
    return ReviewState(through=today, missed=missed, linked=linked, candidates=candidates,
                       body=body, token=token)

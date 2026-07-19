from calendar import monthrange
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.entity_context import (
    can_access_record,
    get_accessible_or_404,
    get_active_entity,
    scope_criterion,
    validate_entity_ownership,
)
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.account import Account
from app.models.category import Category
from app.models.allocation import Allocation
from app.models.entity import Entity
from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
from app.models.user import User
from app.schemas.budget_entry import (
    BudgetEntryCreate,
    BudgetEntryUpdate,
    BudgetEntryResponse,
    BudgetEntryListResponse,
    BudgetEntryMaterialize,
)
from app.schemas.transaction import TransactionResponse
from app.core.time import utc_now

router = APIRouter()


def _attach_occurrence_counts(db: Session, entries: list) -> list:
    """Annotate fixed-term entries with how many occurrences have actually been paid.

    An installment is "n of m". Neither n nor m is a single stored field:
    ``max_occurrences`` is decremented on each materialisation (it means occurrences
    REMAINING, which is also how ``iter_occurrences`` reads it), and ``n`` isn't
    stored at all because ``next_occurrence`` only moves forward. So n is recovered
    from the transactions that materialisation links back via ``budget_entry_id``,
    and the true total is ``n + remaining`` (computed on the client).

    The guard is ``end_mode == "after_occurrences"``, NOT ``max_occurrences`` being
    truthy: a fully-paid installment has ``max_occurrences == 0`` (falsy) but is
    still very much an installment -- it should read "6 of 6", not "Indefinite".

    Consequence worth knowing: an installment whose payments were entered by hand
    rather than via "Mark paid" reads as 0 paid, because nothing links those
    transactions to the entry. Better to under-claim than to invent a number.

    Counted in ONE grouped query rather than per row -- this feeds a list endpoint.
    ``occurrences_paid`` stays ``None`` for open-ended entries, where "n of m" is
    meaningless.
    """
    installments = [e for e in entries if e.end_mode == "after_occurrences"]
    counts: dict = {}
    if installments:
        rows = (
            db.query(Transaction.budget_entry_id, func.count(Transaction.id))
            .filter(Transaction.budget_entry_id.in_([e.id for e in installments]))
            .group_by(Transaction.budget_entry_id)
            .all()
        )
        counts = {entry_id: total for entry_id, total in rows}

    for entry in entries:
        is_installment = entry.end_mode == "after_occurrences"
        entry.occurrences_paid = counts.get(entry.id, 0) if is_installment else None
    return entries


def _ensure_related_resources(
    *,
    db: Session,
    user: User,
    account_id: Optional[int],
    category_id: Optional[int],
    allocation_id: Optional[int],
):
    """Verify the caller may reference each related record.

    Takes the User rather than a bare user_id so it can honour entity sharing: a
    member may attach an entry to a co-member's account/category/allocation within
    an entity they both belong to.
    """
    for model, record_id, label in (
        (Account, account_id, "Account"),
        (Category, category_id, "Category"),
        (Allocation, allocation_id, "Allocation"),
    ):
        if not record_id:
            continue
        record = db.query(model).filter(model.id == record_id).first()
        if not record or not can_access_record(db, user, record):
            raise HTTPException(status_code=404, detail=f"{label} not found")


@router.get("/", response_model=BudgetEntryListResponse)
def list_budget_entries(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    entry_type: Optional[BudgetEntryType] = Query(
        None, description="Filter by entry type (income or expense)"
    ),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    before: Optional[datetime] = Query(
        None, description="Filter entries occurring before this datetime"
    ),
    after: Optional[datetime] = Query(
        None, description="Filter entries occurring after this datetime"
    ),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    query = db.query(BudgetEntry).filter(
        scope_criterion(BudgetEntry, current_user.id, active_entity.id if active_entity else None)
    )

    if entry_type:
        query = query.filter(BudgetEntry.entry_type == entry_type)
    if is_active is not None:
        query = query.filter(BudgetEntry.is_active == is_active)
    if before is not None:
        query = query.filter(BudgetEntry.next_occurrence <= before)
    if after is not None:
        query = query.filter(BudgetEntry.next_occurrence >= after)

    total = query.count()
    entries = (
        query.order_by(BudgetEntry.next_occurrence.asc(), BudgetEntry.id.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    return BudgetEntryListResponse(
        items=_attach_occurrence_counts(db, entries),
        total=total,
        has_more=(offset + len(entries)) < total,
    )


@router.get("/{entry_id}", response_model=BudgetEntryResponse)
def get_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = get_accessible_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    return entry


@router.post("/", response_model=BudgetEntryResponse, status_code=201)
def create_budget_entry(
    entry_in: BudgetEntryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    _ensure_related_resources(
        db=db,
        user=current_user,
        account_id=entry_in.account_id,
        category_id=entry_in.category_id,
        allocation_id=entry_in.allocation_id,
    )

    entry_data = entry_in.dict()
    if entry_data.get("entity_id") is None and active_entity is not None:
        entry_data["entity_id"] = active_entity.id
    else:
        validate_entity_ownership(db, current_user, entry_data.get("entity_id"))

    entry_data["user_id"] = current_user.id
    entry_data["end_mode"] = entry_data.get("end_mode", "indefinite").lower()
    entry = BudgetEntry(**entry_data)

    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.put("/{entry_id}", response_model=BudgetEntryResponse)
def update_budget_entry(
    entry_id: int,
    entry_update: BudgetEntryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = get_accessible_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    prospective_data = entry_update.dict(exclude_unset=True)
    _ensure_related_resources(
        db=db,
        user=current_user,
        account_id=prospective_data.get("account_id", entry.account_id),
        category_id=prospective_data.get("category_id", entry.category_id),
        allocation_id=prospective_data.get("allocation_id", entry.allocation_id),
    )
    if "end_mode" in prospective_data and prospective_data["end_mode"] is not None:
        prospective_data["end_mode"] = prospective_data["end_mode"].lower()

    for field, value in prospective_data.items():
        setattr(entry, field, value)

    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = get_accessible_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    db.delete(entry)
    db.commit()


def _advance_occurrence(entry: BudgetEntry, current: datetime) -> datetime:
    """Return the occurrence following ``current`` for this entry's cadence."""
    from app.services.forecast import _next_occurrence

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

    return _next_occurrence(current, entry.cadence)


@router.post("/{entry_id}/materialize", response_model=TransactionResponse, status_code=201)
def materialize_budget_entry(
    entry_id: int,
    payload: BudgetEntryMaterialize = BudgetEntryMaterialize(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Post a due recurring entry as an actual transaction and advance its schedule.

    Reuses the transaction-create path (so account balances and budget-allocation
    deltas stay consistent), then moves ``next_occurrence`` to the following one —
    deactivating the entry when it passes its end date or exhausts its occurrences.
    """
    from app.routers.transactions import create_transaction
    from app.schemas.transaction import TransactionCreate

    entry = get_accessible_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    if not entry.account_id:
        raise HTTPException(status_code=400, detail="This entry has no account to post to")

    occurrence_date = payload.transaction_date or entry.next_occurrence
    amount = payload.amount if payload.amount is not None else entry.amount
    txn_type = (
        TransactionType.CREDIT if entry.entry_type == BudgetEntryType.INCOME else TransactionType.DEBIT
    )

    txn_create = TransactionCreate(
        account_id=entry.account_id,
        amount=amount,
        currency=entry.currency,
        transaction_type=txn_type,
        transaction_date=occurrence_date,
        category_id=entry.category_id,
        allocation_id=entry.allocation_id,
        entity_id=entry.entity_id,
        budget_entry_id=entry.id,
        description=entry.name,
        is_posted=True,
    )
    db_txn = create_transaction(transaction=txn_create, db=db, current_user=current_user, active_entity=None)

    if payload.advance:
        next_occ = _advance_occurrence(entry, entry.next_occurrence)
        deactivate = False
        if entry.end_mode == "on_date" and entry.end_date and next_occ > entry.end_date:
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
        db.commit()
        db.refresh(db_txn)

    return db_txn


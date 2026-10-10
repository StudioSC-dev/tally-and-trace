from collections import Counter
from calendar import monthrange
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.access import (
    RecordAccess,
    can_edit_account,
    editable_account_ids,
    get_record_or_404,
    readable_criterion,
    require_account,
    require_owned_ref,
    viewable_account_ids,
)
from app.core.tags import (
    TAG_FILTER_HELP, copy_explicit_tags, effective_tag_criterion,
    filter_tag_id, own_tag_ids, replace_own_tags,
)
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.account import Account, AccountType
from app.models.category import Category
from app.models.allocation import Allocation
from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
from app.models.user import User
from app.core.redaction import (
    full_view_criterion, serialize_entries, serialize_entry, serialize_transaction,
)
from app.schemas.budget_entry import (
    BudgetEntryCreate,
    BudgetEntryUpdate,
    BudgetEntryOut,
    BudgetEntryListResponse,
    BudgetEntryMaterialize,
    ZERO_REMAINING_MESSAGE,
    zero_remaining_allowed,
)
from app.schemas.transaction import TransactionOut
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
    ``occurrences_paid_offset`` is the explicit escape hatch: charges paid before
    import (no linked transaction) are added to the linked count.

    Only the transactions ``linked_transactions`` counts (services/forecast.py):
    the entry creator's, and for an entry on a shared account only those on the
    entry's own accounts, so a row on the creator's private account changes
    nothing another user is shown.

    Counted in ONE grouped query rather than per row -- this feeds a list endpoint.
    ``occurrences_paid`` stays ``None`` for open-ended entries, where "n of m" is
    meaningless.
    """
    installments = [e for e in entries if e.end_mode == "after_occurrences"]
    counts: dict = {}
    if installments:
        from app.services.forecast import linked_transactions

        counts = Counter(entry_id for entry_id, _ in linked_transactions(
            db, [e.id for e in installments]))

    for entry in entries:
        is_installment = entry.end_mode == "after_occurrences"
        entry.occurrences_paid = (
            counts.get(entry.id, 0) + (entry.occurrences_paid_offset or 0)
            if is_installment
            else None
        )
    return entries


def _ensure_related_resources(
    *,
    db: Session,
    user: User,
    account_id: Optional[int],
    category_id: Optional[int],
    allocation_id: Optional[int],
    owner: Optional[User] = None,
):
    """Verify the caller may reference each related record.

    The account must be one both the caller and the entry's owner (``owner``,
    default the caller) may change. Categories and allocations are never
    shared: by the same-owner rule they must belong to the caller and to the
    entry's owner.
    """
    if account_id:
        require_account(db, user, account_id, "Account not found", owner=owner)
    require_owned_ref(db, Category, category_id or None, "Category not found", user, owner)
    require_owned_ref(db, Allocation, allocation_id or None, "Allocation not found", user, owner)


PROSPECTIVE_ACCOUNT_FIELDS = (
    ("account_id", "Account not found"),
    ("transfer_to_account_id", "Transfer destination account not found"),
    ("overflow_account_id", "Overflow account not found"),
)


def _ensure_prospective_accounts(db: Session, user: User, entry: BudgetEntry,
                                 prospective_data: dict, owner: User) -> None:
    """404 unless the edit leaves the entry on accounts both the caller and its creator may change.

    Each touched-account column is read as it will be after the update (sent
    or stored). With none left, the entry is accountless and only its creator
    may make that change.
    """
    touched = [
        (prospective_data.get(field, getattr(entry, field)), detail)
        for field, detail in PROSPECTIVE_ACCOUNT_FIELDS
    ]
    touched = [(account_id, detail) for account_id, detail in touched if account_id]
    if not touched:
        if entry.user_id != user.id:
            raise HTTPException(status_code=404, detail="Budget entry not found")
        return
    for account_id, detail in touched:
        require_account(db, user, account_id, detail, owner=owner)


def _validate_overflow_account(db: Session, user: User, overflow_account_id: Optional[int],
                               owner: Optional[User] = None) -> None:
    """An overflow account is a funding source: accessible, not a wallet or a loan.

    Neither a wallet nor a loan is projection cash, so routing cannot pull an
    uncovered payment from one. Access is checked first so the type rules never
    describe an account the caller cannot see.
    """
    if not overflow_account_id:
        return
    account = require_account(db, user, overflow_account_id, "Overflow account not found",
                              owner=owner)
    if account.is_spending_wallet:
        raise HTTPException(
            status_code=400,
            detail="overflow_account_id must be a funding account, not a spending wallet",
        )
    if account.account_type == AccountType.LOAN:
        raise HTTPException(
            status_code=400,
            detail="overflow_account_id must be a funding account, not a loan",
        )


def _validate_entry_account(db: Session, account_id: Optional[int]) -> None:
    """An entry is paid from (or into) its account, so that cannot be a loan.

    A loan holds no cash: paying a bill or a recurring transfer out of one would
    count owed money as cash in the projection. Paying INTO a loan is a
    recurring transfer with the loan as ``transfer_to_account_id``. Run after
    ``_ensure_related_resources``, which checks access.
    """
    if not account_id:
        return
    account = db.query(Account).filter(Account.id == account_id).first()
    if account is not None and account.account_type == AccountType.LOAN:
        raise HTTPException(
            status_code=400,
            detail="A budget entry cannot be paid from a loan; "
                   "use a recurring transfer into the loan instead",
        )


def _validate_transfer_destination(
    db: Session,
    user: User,
    account_id: Optional[int],
    transfer_to_account_id: Optional[int],
    entry_type: BudgetEntryType,
    currency=None,
    owner: Optional[User] = None,
) -> None:
    """A recurring transfer moves money between two accessible non-credit accounts.

    Only an expense entry can be one: an income entry with a destination would
    still materialise as a transfer, so it is rejected rather than ignored.

    The destination may be any account the caller can reference (bank, wallet,
    loan) except a credit card: card payments are netted by statements, and a
    projected one would need a statement cycle to land on. The source must be set
    and not a credit card either (a recurring cash advance is out of scope), so
    transfer entries never become statement charges.

    A transfer into a loan materialises as a scheduled loan payment, which must
    be in the loan's currency from an account in it (``_loan_payment_stamp`` in
    routers/transactions.py). The same rule is checked here, so an entry that
    could never be marked paid is refused when it is saved: the source account
    and the entry's ``currency`` must both match the loan's.
    """
    if not transfer_to_account_id:
        return
    if entry_type != BudgetEntryType.EXPENSE:
        raise HTTPException(
            status_code=400, detail="Only an expense entry can be a recurring transfer"
        )
    destination = db.query(Account).filter(Account.id == transfer_to_account_id).first()
    if (not destination or not can_edit_account(user, destination)
            or (owner is not None and not can_edit_account(owner, destination))):
        raise HTTPException(status_code=404, detail="Transfer destination account not found")
    if destination.account_type == AccountType.CREDIT:
        raise HTTPException(
            status_code=400, detail="A recurring transfer cannot be paid into a credit card"
        )
    if not account_id:
        raise HTTPException(status_code=400, detail="A recurring transfer needs a source account")
    if account_id == transfer_to_account_id:
        raise HTTPException(
            status_code=400, detail="Transfer source and destination must be different"
        )
    source = db.query(Account).filter(Account.id == account_id).first()
    if source is not None and source.account_type == AccountType.CREDIT:
        raise HTTPException(
            status_code=400, detail="A recurring transfer cannot be funded from a credit card"
        )
    if destination.account_type == AccountType.LOAN:
        if source is not None and source.currency != destination.currency:
            raise HTTPException(
                status_code=400,
                detail="A loan is paid from an account in its own currency",
            )
        if currency is not None and currency != destination.currency:
            raise HTTPException(
                status_code=400,
                detail="A recurring loan payment's currency must match the loan's currency",
            )


@router.get("/", response_model=BudgetEntryListResponse)
def list_budget_entries(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
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
    tag: Optional[int] = Query(None, description=TAG_FILTER_HELP),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    viewable = viewable_account_ids(db, current_user)
    query = db.query(BudgetEntry).filter(readable_criterion(BudgetEntry, current_user, viewable))

    if entry_type:
        query = query.filter(BudgetEntry.entry_type == entry_type)
    if is_active is not None:
        # Not in the limited model: filter only the entries the caller sees in full.
        query = query.filter(
            BudgetEntry.is_active == is_active,
            full_view_criterion(BudgetEntry, current_user, viewable,
                                editable_account_ids(db, current_user)))
    if before is not None:
        query = query.filter(BudgetEntry.next_occurrence <= before)
    if after is not None:
        query = query.filter(BudgetEntry.next_occurrence >= after)
    tag_id = filter_tag_id(db, current_user, tag)
    if tag_id is not None:
        query = query.filter(effective_tag_criterion(BudgetEntry, tag_id))

    total = query.count()
    entries = (
        query.order_by(BudgetEntry.next_occurrence.asc(), BudgetEntry.id.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    _attach_occurrence_counts(db, entries)
    return {"items": serialize_entries(db, current_user, entries), "total": total,
            "has_more": (offset + len(entries)) < total}


@router.get("/{entry_id}", response_model=BudgetEntryOut)
def get_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    return serialize_entry(db, current_user, _attach_occurrence_counts(db, [entry])[0])


@router.post("/", response_model=BudgetEntryOut, status_code=201)
def create_budget_entry(
    entry_in: BudgetEntryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    # The caller's own tags only (404 otherwise); linked once the entry exists.
    tag_ids = own_tag_ids(db, current_user, entry_in.tag_ids)
    _ensure_related_resources(
        db=db,
        user=current_user,
        account_id=entry_in.account_id,
        category_id=entry_in.category_id,
        allocation_id=entry_in.allocation_id,
    )
    _validate_entry_account(db, entry_in.account_id)
    _validate_overflow_account(db, current_user, entry_in.overflow_account_id)
    _validate_transfer_destination(
        db, current_user, entry_in.account_id, entry_in.transfer_to_account_id,
        entry_in.entry_type, entry_in.currency,
    )

    entry_data = entry_in.dict()
    entry_data.pop("tag_ids", None)
    entry_data["user_id"] = current_user.id
    entry_data["end_mode"] = entry_data.get("end_mode", "indefinite").lower()
    entry = BudgetEntry(**entry_data)

    db.add(entry)
    db.flush()
    if tag_ids:
        replace_own_tags(db, BudgetEntry, entry.id, current_user, tag_ids)
    db.commit()
    db.refresh(entry)
    return serialize_entry(db, current_user, _attach_occurrence_counts(db, [entry])[0])


@router.put("/{entry_id}", response_model=BudgetEntryOut)
def update_budget_entry(
    entry_id: int,
    entry_update: BudgetEntryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    if not RecordAccess(db, current_user).permissions(entry)["can_edit"]:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    owner = entry.user
    prospective_data = entry_update.dict(exclude_unset=True)
    # The creator's private references, which a non-creator is never shown:
    # any request naming one is refused, null included (clearing is a change),
    # so it can neither change them nor probe their stored values.
    if entry.user_id != current_user.id and any(
            field in prospective_data for field in ("category_id", "allocation_id")):
        raise HTTPException(
            status_code=400,
            detail="Only the recurring entry's creator can change its category or allocation")
    # Tags: the caller's own only, on an entry they may edit (checked above).
    tag_ids = prospective_data.pop("tag_ids", None)
    if tag_ids is not None:
        tag_ids = own_tag_ids(db, current_user, tag_ids)

    def changed(field: str) -> Optional[int]:
        """The request's new reference, or None when it leaves the stored one."""
        value = prospective_data.get(field, getattr(entry, field))
        return value if value != getattr(entry, field) else None

    # Every account the entry will touch is checked as it will be (the write
    # rule), whether the edit changes it or not: the caller and the entry's
    # creator must both be able to change each one. An entry left touching no
    # account is its creator's alone, so only the creator may make it so;
    # otherwise the owner of its accounts could turn it into the creator's
    # accountless entry and move their unassigned cash.
    _ensure_prospective_accounts(db, current_user, entry, prospective_data, owner)
    # A category or allocation only when the edit changes it, so a stored
    # legacy reference never blocks an unrelated edit.
    _ensure_related_resources(
        db=db,
        user=current_user,
        account_id=None,
        category_id=changed("category_id"),
        allocation_id=changed("allocation_id"),
        owner=owner,
    )
    if "account_id" in prospective_data:
        _validate_entry_account(db, prospective_data["account_id"])
    if "overflow_account_id" in prospective_data:
        _validate_overflow_account(db, current_user, prospective_data["overflow_account_id"],
                                   owner=owner)
    _validate_transfer_destination(
        db,
        current_user,
        prospective_data.get("account_id", entry.account_id),
        prospective_data.get("transfer_to_account_id", entry.transfer_to_account_id),
        prospective_data.get("entry_type") or entry.entry_type,
        prospective_data.get("currency") or entry.currency,
        owner=owner,
    )
    if "end_mode" in prospective_data and prospective_data["end_mode"] is not None:
        prospective_data["end_mode"] = prospective_data["end_mode"].lower()

    if not zero_remaining_allowed(
        prospective_data.get("end_mode", entry.end_mode),
        prospective_data.get("max_occurrences", entry.max_occurrences),
        prospective_data.get("is_active", entry.is_active),
    ):
        raise HTTPException(status_code=422, detail=ZERO_REMAINING_MESSAGE)

    for field, value in prospective_data.items():
        setattr(entry, field, value)

    db.add(entry)
    if tag_ids is not None:
        replace_own_tags(db, BudgetEntry, entry.id, current_user, tag_ids)
    db.commit()
    db.refresh(entry)
    return serialize_entry(db, current_user, _attach_occurrence_counts(db, [entry])[0])


@router.delete("/{entry_id}", status_code=204)
def delete_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Delete a recurring entry.

    Under the write rule, the account owner exemption, by its creator, or by
    an owner of any account it touches (an entry moves no balance). Deleting
    it clears ``budget_entry_id`` on the transactions linked to it, so it is
    refused (409) while any of them is not one the caller may edit: a delete
    never changes a transaction the caller could not change directly, whoever
    created it (a creator demoted or revoked on the account their own linked
    transaction sits on included). Deactivating the entry is the way to stop
    it then.
    """
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    access = RecordAccess(db, current_user)
    if not access.permissions(entry)["can_delete"]:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    linked = db.query(Transaction).filter(Transaction.budget_entry_id == entry.id).all()
    if any(not access.permissions(txn)["can_edit"] for txn in linked):
        raise HTTPException(
            status_code=409,
            detail="This recurring entry has transactions you can't edit linked to it; "
                   "deactivate it instead")
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


@router.post("/{entry_id}/materialize", response_model=TransactionOut, status_code=201)
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

    With ``advance`` False the schedule stays put, so for an entry on a credit card
    the projection would bill that occurrence AND the new transaction. It doesn't:
    a transaction linked to the entry suppresses one occurrence dated the same
    calendar day (see ``_card_entry_charges`` in services/forecast.py). A custom
    ``transaction_date`` on another day suppresses nothing, so with ``advance``
    False the occurrence is still projected alongside the transaction.

    A recurring transfer into a loan posts as a scheduled loan payment
    (``loan_payment_kind`` "scheduled", see ``_loan_payment_stamp`` in
    routers/transactions.py: the loan-payment endpoint's rules, except that a
    spending wallet may fund it), so it settles that due date instead of
    leaving it projected after the money left the source. Without a
    ``transfer_fee`` its amount is split into principal and interest; when the
    entry's amount is more than the loan owes plus a month's interest (the
    final, smaller payment) it is refused with a 400 asking for the final
    ``amount`` (``loan_svc.split_payment``).

    The transaction belongs to the entry's creator (``created_by_actor`` is the
    caller), so its category, allocation and tags stay one owner's. The caller
    needs the write rule on the entry: an edit role on every account it
    touches, which its creator must still hold too.

    The entry's explicit tags are copied onto the new transaction in the same
    commit (never the tags it gets from its accounts); later changes to the
    entry's tags leave the transaction as it is.
    """
    from app.routers.transactions import add_transaction
    from app.schemas.transaction import TransactionCreate

    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    if not RecordAccess(db, current_user).permissions(entry)["can_edit"]:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    if not entry.account_id:
        raise HTTPException(status_code=400, detail="This entry has no account to post to")

    occurrence_date = payload.transaction_date or entry.next_occurrence
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
    else:
        txn_type = (
            TransactionType.CREDIT if entry.entry_type == BudgetEntryType.INCOME else TransactionType.DEBIT
        )
        transfer_fields = {}

    txn_create = TransactionCreate(
        account_id=entry.account_id,
        amount=amount,
        currency=entry.currency,
        transaction_type=txn_type,
        transaction_date=occurrence_date,
        category_id=entry.category_id,
        allocation_id=entry.allocation_id,
        budget_entry_id=entry.id,
        description=entry.name,
        is_posted=True,
        **transfer_fields,
    )
    # The entry's creator owns the transaction; the caller is its actor.
    db_txn = add_transaction(db, current_user, txn_create, owner=entry.user)
    # The entry's explicit tags, in the same commit as the transaction.
    copy_explicit_tags(db, entry.id, db_txn.id)
    db.commit()
    db.refresh(db_txn)

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

    return serialize_transaction(db, current_user, db_txn)


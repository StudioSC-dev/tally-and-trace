from collections import Counter
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.core import locking
from app.core.auth import get_current_active_user
from app.core.database import get_db
from app.core.time import manila_midnight, manila_today
from app.core.access import (
    VIEW_ROLES,
    RecordAccess,
    can_edit_account,
    editable_account_ids,
    get_record_or_404,
    household_grants,
    readable_criterion,
    require_account,
    require_owned_ref,
    viewable_account_ids,
)
from app.core.tags import (
    TAG_FILTER_HELP, effective_tag_criterion,
    filter_tag_id, own_tag_ids, replace_own_tags,
)
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.account import Account, AccountType
from app.models.category import Category
from app.models.allocation import Allocation
from app.models.transaction import Transaction
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
    EntryOccurrences,
    MaterializeDueResult,
    ZERO_REMAINING_MESSAGE,
    zero_remaining_allowed,
)
from app.schemas.transaction import TransactionOut
from app.services import posting
from app.services.forecast import _naive, iter_occurrences
from app.services.recurring_kinds import default_billing_kind, entry_kind, is_capped
from app.services.recurrence import DAY_FIELDS, DayRuleError, resolve_day_fields

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


def _validate_overflow_currency(db: Session, account_id: Optional[int],
                                overflow_account_id: Optional[int], currency) -> None:
    """An overflow account covers a shortfall in its own currency only.

    It must be in the entry's account's currency (the entry's own currency when
    it has no account). Run after the access checks on both accounts.
    """
    if not overflow_account_id:
        return
    overflow = db.get(Account, overflow_account_id)
    account = db.get(Account, account_id) if account_id else None
    expected = account.currency if account is not None else currency
    if overflow is not None and expected is not None and overflow.currency != expected:
        raise HTTPException(
            status_code=400,
            detail="overflow_account_id must be in the same currency as the entry's account",
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


def _day_fields(cadence, next_occurrence, sent: dict, stored=None) -> dict:
    """The ``anchor_day`` and ``day_rule`` a write persists (services/recurrence.py
    ``resolve_day_fields``, plan STU-315 section 2.4); 422 when it refuses them.

    ``cadence`` and ``next_occurrence`` are the row as it will be; ``sent`` holds
    the day fields the request named (null included); ``stored`` is the row
    before an update, None on create.
    """
    try:
        return resolve_day_fields(cadence=cadence, next_occurrence=next_occurrence,
                                  sent=sent, stored=stored)
    except DayRuleError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


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
    query = db.query(BudgetEntry).filter(readable_criterion(
        BudgetEntry, current_user, viewable, household_grants(db, current_user)))

    if entry_type:
        query = query.filter(BudgetEntry.entry_type == entry_type)
    if is_active is not None:
        # Not in the limited model: filter only the entries the caller sees in full.
        query = query.filter(
            BudgetEntry.is_active == is_active,
            full_view_criterion(BudgetEntry, current_user,
                                viewable_account_ids(db, current_user, roles=VIEW_ROLES),
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
    _validate_overflow_currency(db, entry_in.account_id, entry_in.overflow_account_id,
                                entry_in.currency)
    _validate_transfer_destination(
        db, current_user, entry_in.account_id, entry_in.transfer_to_account_id,
        entry_in.entry_type, entry_in.currency,
    )

    day_fields = _day_fields(
        entry_in.cadence, entry_in.next_occurrence,
        {f: getattr(entry_in, f) for f in DAY_FIELDS if f in entry_in.model_fields_set})

    entry_data = entry_in.dict()
    entry_data.pop("tag_ids", None)
    entry_data["user_id"] = current_user.id
    entry_data["end_mode"] = entry_data.get("end_mode", "indefinite").lower()
    entry_data.update(day_fields)
    entry = BudgetEntry(**entry_data)
    if "billing_kind" not in entry_in.model_fields_set:
        entry.billing_kind = default_billing_kind(
            db, entry, db.get(Account, entry.account_id) if entry.account_id else None)

    db.add(entry)
    db.flush()
    if tag_ids:
        replace_own_tags(db, BudgetEntry, entry.id, current_user, tag_ids)
    db.commit()
    db.refresh(entry)
    return serialize_entry(db, current_user, _attach_occurrence_counts(db, [entry])[0])


ENDED_MESSAGE = "This entry has ended"
PAUSED_MESSAGE = "This entry is paused"


def _has_ended(e, today: date) -> bool:
    """Whether the schedule is over: a capped entry's last occurrence used up, or
    an end date before ``today`` (Manila). An inactive entry that has not ended
    is paused."""
    return bool(
        (is_capped(e) and e.max_occurrences <= 0)
        or (e.end_mode == "on_date" and e.end_date is not None
            and _naive(e.end_date).date() < today))


def _refuse_paused_or_ended(entry: BudgetEntry) -> None:
    """409 for an entry that cannot be posted to: ended (cap used up, or inactive
    past its end date) or paused (any other inactive entry). An active entry
    past its end date is not refused: its unrecorded occurrences can still be
    recorded."""
    if is_capped(entry) and entry.max_occurrences <= 0:
        raise HTTPException(status_code=409, detail=ENDED_MESSAGE)
    if not entry.is_active:
        raise HTTPException(
            status_code=409,
            detail=ENDED_MESSAGE if _has_ended(entry, manila_today()) else PAUSED_MESSAGE)


def _first_occurrence_from_today(entry: BudgetEntry) -> Optional[datetime]:
    """The schedule's first occurrence on or after Manila's today, walked from
    the stored ``next_occurrence`` (semi-monthly days included, ``end_date``
    respected, the cap not applied), or None when nothing is left."""
    start = manila_midnight()
    end = start + timedelta(days=400)
    anchor = _naive(entry.next_occurrence)
    return next(iter(iter_occurrences(entry, start, end,
                                      max_steps=(end - anchor).days + 2,
                                      apply_cap=False)), None)


@router.put("/{entry_id}", response_model=BudgetEntryOut)
def update_budget_entry(
    entry_id: int,
    entry_update: BudgetEntryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    # Locked and refreshed before its checks and its tag-link writes (STU-226), so
    # an edit and a concurrent materialize or delete of the entry take turns.
    entry = locking.lock_entry(db, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Budget entry not found")
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
    if any(field in prospective_data
           for field in ("account_id", "overflow_account_id", "currency")):
        _validate_overflow_currency(
            db,
            prospective_data.get("account_id", entry.account_id),
            prospective_data.get("overflow_account_id", entry.overflow_account_id),
            prospective_data.get("currency") or entry.currency,
        )
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

    # Resuming a paused entry (stored inactive, the request sets it active). An
    # ended schedule cannot be resumed: checked on the request merged over the
    # stored row, so raising the cap or moving the end date ahead in the same
    # request is allowed. The paused months are skipped below when the request
    # leaves next_occurrence as stored (omitted, or sent unchanged, as the form
    # does) and it is before Manila's today.
    resuming = not entry.is_active and prospective_data.get("is_active") is True
    skip_paused = False
    if resuming:
        merged = SimpleNamespace(**{
            f: prospective_data.get(f, getattr(entry, f))
            for f in ("end_mode", "end_date", "max_occurrences")})
        if _has_ended(merged, manila_today()):
            raise HTTPException(status_code=409, detail=ENDED_MESSAGE)
        sent = prospective_data.get("next_occurrence")
        skip_paused = (
            (sent is None or _naive(sent) == _naive(entry.next_occurrence))
            and _naive(entry.next_occurrence).date() < manila_today())

    if not zero_remaining_allowed(
        prospective_data.get("end_mode", entry.end_mode),
        prospective_data.get("max_occurrences", entry.max_occurrences),
        prospective_data.get("is_active", entry.is_active),
    ):
        raise HTTPException(status_code=422, detail=ZERO_REMAINING_MESSAGE)

    # The day fields as the row will be: the request merged over the stored row.
    prospective_data.update(_day_fields(
        prospective_data.get("cadence") or entry.cadence,
        prospective_data.get("next_occurrence") or entry.next_occurrence,
        {f: prospective_data[f] for f in DAY_FIELDS if f in prospective_data},
        stored=entry))

    for field, value in prospective_data.items():
        setattr(entry, field, value)
    if skip_paused:
        # Skipped occurrences are not counted: max_occurrences and
        # occurrences_paid_offset stay as they are. Nothing left on or after
        # today means the schedule has ended; raising before the commit leaves
        # the row unchanged (get_db closes the session without committing).
        resumed_at = _first_occurrence_from_today(entry)
        if resumed_at is None:
            raise HTTPException(status_code=409, detail=ENDED_MESSAGE)
        entry.next_occurrence = resumed_at
    if entry.billing_kind is None and "billing_kind" not in prospective_data:
        entry.billing_kind = default_billing_kind(
            db, entry, db.get(Account, entry.account_id) if entry.account_id else None)

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
    it then. Locks follow the ledger's global order (``app.core.locking``): the
    owner's budget lock, then the entry ``FOR UPDATE``, before its linked rows
    are nullified and it is deleted.
    """
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    locking.lock_owner_budgets(db, entry.user_id)
    entry = locking.lock_entry(db, entry_id, for_delete=True)
    if entry is None:
        raise HTTPException(status_code=404, detail="Budget entry not found")
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


SKIPPED_HEADER_LIMIT = 60  # the most skipped dates ``X-Occurrences-Skipped`` lists


def _lock_entry_to_post(db: Session, current_user: User, entry_id: int) -> BudgetEntry:
    """The entry, locked in the ledger's order and checked for posting.

    The owner's budget lock, then the entry (``FOR NO KEY UPDATE``), before
    anything is checked (``app.core.locking``): two payments of one entry then
    queue here and the second sees the first's advance; a payment queued behind
    a delete of the entry finds it gone. The caller needs the write rule on the
    entry (404 otherwise), and the entry needs an account to post to.
    """
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    locking.lock_owner_budgets(db, entry.user_id)
    entry = locking.lock_entry(db, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    if not RecordAccess(db, current_user).permissions(entry)["can_edit"]:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    if not entry.account_id:
        raise HTTPException(status_code=400, detail="This entry has no account to post to")
    return entry


@router.get("/{entry_id}/occurrences", response_model=EntryOccurrences)
def list_entry_occurrences(
    entry_id: int,
    include: Optional[date] = Query(
        None, description="An occurrence (YYYY-MM-DD) to list whatever its distance from today"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """The occurrences a Mark paid can record, with what each is already linked
    to (services/posting.py ``entry_occurrences``). Needs ``can_post`` on the
    entry (404 otherwise); an ``include`` off the schedule, or more than two
    years after Manila's today, is a 422."""
    entry = get_record_or_404(db, BudgetEntry, entry_id, current_user, "Budget entry not found")
    if not RecordAccess(db, current_user).permissions(entry)["can_post"]:
        raise HTTPException(status_code=404, detail="Budget entry not found")
    return posting.entry_occurrences(db, entry, include)


def _occurrence_headers(outcome, occurrence: datetime, skipped: list) -> dict:
    """The ``X-Occurrence*`` headers of a Mark paid (listed in main.py's CORS
    ``expose_headers``; read by ``readMaterializeHeaders`` in the shared package)."""
    headers = {
        "X-Occurrence-Outcome": outcome.value,
        "X-Occurrence-Recorded": occurrence.date().isoformat(),
        "X-Occurrences-Skipped-Count": str(len(skipped)),
    }
    if skipped:
        headers["X-Occurrences-Skipped"] = ",".join(
            occ.date().isoformat() for occ in skipped[:SKIPPED_HEADER_LIMIT])
    return headers


@router.post("/{entry_id}/materialize", response_model=TransactionOut, status_code=201)
def materialize_budget_entry(
    entry_id: int,
    payload: BudgetEntryMaterialize = BudgetEntryMaterialize(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    # Last, so a direct call (entry_id, payload, db=, current_user=) still works;
    # FastAPI injects it by its type.
    response: Response = None,
):
    """
    Record one occurrence of a recurring entry (Mark paid) and advance its schedule.

    The occurrence is ``occurrence_date`` (matched by calendar day against the
    schedule from ``next_occurrence``; 422 when it is not one of its
    occurrences or is more than two years after Manila's today), else the
    schedule's first occurrence (``next_occurrence``, or for a semi-monthly one
    stored off its days the next scheduled day). A capped installment records
    its oldest unrecorded month only (409 for a later one). See
    services/posting.py ``record_occurrence``: an occurrence is recorded once.

    - No linked row: a new posted transaction (201, ``created``), dated
      ``transaction_date`` or the occurrence, through the transaction-create
      path (so account balances and budget-allocation deltas stay consistent).
    - One pending linked row: that row is posted as the caller, through the
      ``PUT /transactions/{id}`` path (200, ``posted_pending``); 409 when the
      caller cannot edit it.
    - One posted linked row: nothing new is recorded and the schedule moves on
      (200, ``already_posted``); with ``advance`` False a 409.
    - More than one linked row: 409.

    The body is the transaction. Headers report what was recorded:
    ``X-Occurrence-Outcome``, ``X-Occurrence-Recorded`` (the occurrence's
    day), ``X-Occurrences-Skipped-Count`` (every earlier occurrence left
    unrecorded, always present) and ``X-Occurrences-Skipped`` (the oldest of
    them, at most 60 comma-separated days; absent when there are none).

    With ``advance`` the schedule then moves past the recorded occurrence,
    deactivating the entry when it passes its end date or exhausts its
    occurrences. A capped installment (``end_mode`` "after_occurrences" with
    ``max_occurrences`` set) always advances: ``advance`` False is a 400,
    because a payment that doesn't use up an occurrence would pass the
    installment's total.

    An entry that has ended (its cap used up, or inactive past its end date) is
    refused with a 409 "This entry has ended", and any other inactive entry with
    a 409 "This entry is paused", before anything else is checked or written.

    With ``advance`` False the schedule stays put, so the projection would list
    that occurrence AND the transaction. It doesn't, for every entry type
    (cash, card or transfer): the transaction records the occurrence it fulfils
    (``occurrence_date``), and the transaction suppresses that one occurrence
    while it is still on the entry's account(s) (see ``_linked_occurrence_days``
    and its use in ``collect_events`` in services/forecast.py). This holds with
    a custom ``transaction_date`` on another day too.

    A recurring transfer into a loan posts as a scheduled loan payment
    (``loan_payment_kind`` "scheduled", see ``_loan_payment_stamp`` in
    routers/transactions.py). Without a ``transfer_fee`` its amount is total
    cash, split into principal and interest; with one, the amount is the
    principal and the fee the interest. A pending loan payment being posted
    reads ``amount`` and ``transfer_fee`` the same way, and keeps its own split
    when no ``amount`` is sent (``pending_update_for``).

    An entry in another currency than its account's (for a transfer, the
    source's) needs ``amount``, the figure charged in the account's currency,
    or it is refused with a 400 "Enter the amount charged in {CUR}". A
    recurring transfer between accounts in different currencies needs
    ``received_amount``, or it is refused with a 400 "Enter the amount received".

    A new transaction belongs to the entry's creator (``created_by_actor`` is
    the caller) and gets the entry's explicit tags. The caller needs the write
    rule on the entry: an edit role on every account it touches, which its
    creator must still hold too.

    One commit covers the transaction, its tags and the schedule's advance. The
    owner's budget lock and then the entry are taken before anything is
    checked (``_lock_entry_to_post``).
    """
    entry = _lock_entry_to_post(db, current_user, entry_id)
    _refuse_paused_or_ended(entry)
    if is_capped(entry):
        # An installment's payments are counted down by the advance, so a payment
        # that doesn't advance would pass its total (one past the last is refused
        # as ended above). Without a cap (``max_occurrences`` None) the entry is
        # open-ended, as elsewhere.
        if not payload.advance:
            raise HTTPException(
                status_code=400,
                detail="An installment's payment always advances its schedule")

    occurrence, skipped = posting.resolve_occurrence(db, entry, payload.occurrence_date)
    recorded = posting.record_occurrence(db, entry, current_user, payload, occurrence)
    # The transaction, its balance and budget effects, its tags and the schedule's
    # advance commit together: a failure anywhere leaves none of them.
    db.commit()
    db.refresh(recorded.transaction)

    if response is not None:
        response.status_code = 201 if recorded.outcome == posting.Outcome.CREATED else 200
        response.headers.update(_occurrence_headers(recorded.outcome, occurrence, skipped))
    return serialize_transaction(db, current_user, recorded.transaction)


@router.post("/{entry_id}/materialize-due", response_model=MaterializeDueResult)
def materialize_due_budget_entry(
    entry_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Post every due occurrence of a recurring expense at once (Post N due).

    Due is the schedule from ``next_occurrence`` through today on the Manila
    calendar. Each occurrence is recorded as Mark paid records it
    (services/posting.py ``materialize_due``, ``record_occurrence``), dated on
    its own day: a linked pending row is posted, a linked posted row only moves
    the schedule on, anything else gets a new row. One commit covers them all;
    a 409 on any (more than one row linked to an occurrence, or a pending row
    the caller cannot edit) leaves nothing. Nothing due is a 200 with no
    results.

    Only a non-capped subscription or cash expense in its account's currency:
    an installment is marked paid month by month, a bill and a foreign entry
    each need the amount charged, and income and transfers are refused (400).
    The caller needs the write rule on the entry, as for Mark paid. An ended or
    paused entry is refused with a 409 first, as for Mark paid.
    """
    entry = _lock_entry_to_post(db, current_user, entry_id)
    _refuse_paused_or_ended(entry)
    account = db.get(Account, entry.account_id)
    kind = entry_kind(entry, account)
    if is_capped(entry):
        raise HTTPException(status_code=400, detail="Mark each installment month paid")
    if kind == "bill":
        raise HTTPException(status_code=400,
                            detail="Bills vary: mark each paid with the amount charged")
    if account is not None and entry.currency != account.currency:
        raise HTTPException(status_code=400, detail="Mark each paid with the amount charged")
    if kind not in ("subscription", "cash"):
        raise HTTPException(status_code=400, detail="Post N due is for recurring expenses")

    recorded = posting.materialize_due(db, entry, current_user)
    db.commit()
    for item in recorded:
        db.refresh(item.transaction)
    db.refresh(entry)
    return {
        "entry_id": entry.id,
        "results": [{"occurrence_date": item.occurrence.date(), "outcome": item.outcome.value,
                     "transaction": serialize_transaction(db, current_user, item.transaction)}
                    for item in recorded],
        "next_occurrence": entry.next_occurrence,
        "is_active": entry.is_active,
    }

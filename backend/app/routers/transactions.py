from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_
from typing import List, Optional, Set
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.entity_context import (
    can_access_record,
    get_accessible_or_404,
    get_active_entity,
    scope_criterion,
    validate_entity_ownership,
)
from app.models.transaction import Transaction, TransactionType
from app.schemas.transaction import TransactionCreate, TransactionResponse, TransactionUpdate, TransactionListResponse
from app.models.account import Account, AccountType
from app.services.forecast import is_spending_wallet
from app.services import loans as loan_svc
from app.services.statements import resolve_cycle_fields
from app.routers.accounts import _funding_account, _loan_or_404, _lock
from app.models.category import Category
from app.models.entity import Entity
from app.models.user import User
from app.models.budget_entry import BudgetEntry
from app.models.allocation import Allocation, AllocationType
from app.models.allocation import BudgetPeriodFrequency
from app.core.time import naive_utc_now, utc_now
from datetime import datetime, timedelta, timezone
from calendar import monthrange
from decimal import Decimal
import os
from app.core.config import settings

router = APIRouter()

# Largest UTC offset in use (UTC+14): how far ahead of UTC a user's local "today" can reach.
_MAX_UTC_OFFSET = timedelta(hours=14)


def _D(value) -> Decimal:
    """Normalise a money value (float from a schema, Decimal from the ORM, or None) to Decimal."""
    return Decimal(str(value)) if value is not None else Decimal("0")


def _normalize_reference(reference: Optional[datetime]) -> datetime:
    """Naive UTC, to match the naive allocations.period_start/period_end columns.

    Aware values are converted to UTC first, as Postgres does when it stores them, so a
    row is classified the same way on create as on a later edit or delete. Stored
    timestamptz values read back aware and are converted to UTC here; naive inputs are
    assumed to be UTC, which holds while the session TimeZone is UTC.
    """
    value = reference or naive_utc_now()
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _start_of_period(reference: datetime, frequency: BudgetPeriodFrequency) -> datetime:
    freq = frequency or BudgetPeriodFrequency.MONTHLY
    base = reference.replace(hour=0, minute=0, second=0, microsecond=0)
    if freq == BudgetPeriodFrequency.DAILY:
        return base
    if freq == BudgetPeriodFrequency.WEEKLY:
        return base - timedelta(days=base.weekday())
    if freq == BudgetPeriodFrequency.MONTHLY:
        return base.replace(day=1)
    if freq == BudgetPeriodFrequency.QUARTERLY:
        quarter = (base.month - 1) // 3
        month = quarter * 3 + 1
        return base.replace(month=month, day=1)
    return base


def _add_months(start: datetime, months: int) -> datetime:
    month_index = start.month - 1 + months
    year = start.year + month_index // 12
    month = month_index % 12 + 1
    day = min(start.day, monthrange(year, month)[1])
    return start.replace(year=year, month=month, day=day)


def _compute_period_end(start: datetime, frequency: BudgetPeriodFrequency) -> datetime:
    freq = frequency or BudgetPeriodFrequency.MONTHLY
    if freq == BudgetPeriodFrequency.DAILY:
        return start + timedelta(days=1)
    if freq == BudgetPeriodFrequency.WEEKLY:
        return start + timedelta(weeks=1)
    if freq == BudgetPeriodFrequency.MONTHLY:
        return _add_months(start, 1)
    if freq == BudgetPeriodFrequency.QUARTERLY:
        return _add_months(start, 3)
    return start


def _ensure_budget_period(allocation: Allocation, reference: Optional[datetime]) -> bool:
    """Keep the allocation on the period containing now; report whether ``reference`` is in it.

    The active period is always the one containing the current date, never the one
    containing the triggering row. A missing ``period_start`` is initialised to it, and a
    stale period (``period_end`` <= now, including one whose missing end is derived from
    ``period_start``) is advanced to it with ``current_amount`` reset, as a normal roll
    does. That initialisation or roll is persisted even when the triggering row is then
    excluded, so an out-of-period row leaves the budget on the current period with a
    zero total rather than pinning it to the row's period.

    Users east of UTC send day-precision dates as midnight UTC of their local date, which
    can already be in the next UTC period. So a row at or after ``period_end`` but no
    later than now + ``_MAX_UTC_OFFSET`` (the horizon) advances the period to the one
    containing the row, with the same reset, and counts; rows still in the UTC period
    containing now are then historical, as for any earlier period. A period that starts
    within the horizon is treated as started; one that starts beyond it has not, so it
    is left alone and its rows are excluded. The period is never rewound. ``reference``
    counts only if it falls inside the resulting period and that period has started;
    earlier (historical) rows and rows beyond the horizon in a later period (future) are
    excluded.
    """
    frequency = allocation.period_frequency or BudgetPeriodFrequency.MONTHLY
    normalized_reference = _normalize_reference(reference)
    now = naive_utc_now()
    horizon = now + _MAX_UTC_OFFSET

    period_start = allocation.period_start
    period_end = allocation.period_end
    if period_start:
        period_start = _normalize_reference(period_start)
    if period_end:
        period_end = _normalize_reference(period_end)

    period_changed = False

    if period_start is None:
        period_start = _start_of_period(now, frequency)
        period_end = _compute_period_end(period_start, frequency)
        period_changed = True
    elif period_end is None:
        period_end = _compute_period_end(period_start, frequency)

    while now >= period_end:
        period_start = period_end
        period_end = _compute_period_end(period_start, frequency)
        period_changed = True

    while period_end <= normalized_reference <= horizon:
        period_start = period_end
        period_end = _compute_period_end(period_start, frequency)
        period_changed = True

    if period_changed:
        allocation.current_amount = Decimal("0")
        allocation.period_start = period_start
        allocation.period_end = period_end

    if normalized_reference < period_start or normalized_reference >= period_end or period_start > horizon:
        return False

    allocation.period_start = period_start
    allocation.period_end = period_end
    return True


def _require_account(db: Session, user: User, account_id: Optional[int], detail: str) -> None:
    """404 with ``detail`` unless the caller may use the account (a None id is skipped)."""
    if account_id is None:
        return
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account or not can_access_record(db, user, account):
        raise HTTPException(status_code=404, detail=detail)


def _balance_account_ids(transaction_type, account_id, transfer_from_id, transfer_to_id) -> List[int]:
    """The accounts whose balances a transaction of this shape moves."""
    if transaction_type == TransactionType.TRANSFER:
        ids = [transfer_from_id, transfer_to_id]
    else:
        ids = [account_id]
    return [i for i in ids if i is not None]


LOAN_PAYMENT_FIXED_FIELDS = (
    "transaction_type", "account_id", "transfer_from_account_id", "transfer_to_account_id",
    "currency",
)


def _money_changed(requested: dict, field: str, current, *, none_is_zero: bool = False) -> bool:
    """Whether ``field`` is in the request with a value other than ``current``."""
    if field not in requested:
        return False
    new = requested[field]
    if none_is_zero:
        new, current = new or 0, current or 0
    if new is None or current is None:
        return new is not current
    return Decimal(str(new)) != Decimal(str(current))


def _validate_loan_payment_edit(db: Session, user: User, txn: Transaction, requested: dict) -> None:
    """Keep the loan endpoints' rules on a loan payment edited through this API.

    Its type, accounts and currency are fixed (so a prepayment can never land
    on a fixed loan). The money checks run only when the amount or fee changes, or the
    payment is posted: the result is re-checked against the loan with the
    payment's old effect reversed, and its principal is held to what is owed
    only if the edited row is posted, so a pending payment above the current
    owed amount can still be edited but not posted. A prepayment keeps the
    prepayment endpoint's rules: no interest, and it is not posted (or its
    amount changed while posted) once the loan is ``fixed``.

    Posting the row, or changing its money while it is posted, also re-runs the
    account checks against the accounts as they are now: the destination is
    still a loan, the funding account is still one the caller may use to fund
    it, and the two share a currency. A scheduled payment is held to the rule
    for a transfer into a loan (``_loan_payment_source``: a card or a spending
    wallet may fund it); a prepayment to the prepayment endpoint's
    (``_funding_account``).
    """
    for field in LOAN_PAYMENT_FIXED_FIELDS:
        if field in requested and requested[field] != getattr(txn, field):
            raise HTTPException(
                status_code=400,
                detail="A loan payment's type, accounts and currency cannot be changed; "
                       "delete and re-record the loan payment instead",
            )
    loan = db.query(Account).filter(Account.id == txn.transfer_to_account_id).first()
    old_posted = bool(txn.is_posted)
    posted = bool(requested.get("is_posted", old_posted))
    amount_changed = _money_changed(requested, "amount", txn.amount)
    fee_changed = _money_changed(requested, "transfer_fee", txn.transfer_fee, none_is_zero=True)
    if posted and (not old_posted or amount_changed or fee_changed):
        loan = _loan_or_404(db, user, txn.transfer_to_account_id)
        if txn.loan_payment_kind == loan_svc.PREPAYMENT:
            funding = _funding_account(
                db, user, txn.transfer_from_account_id, "from_account_id", loan.id)
        else:
            funding = _loan_payment_source(db, user, txn.transfer_from_account_id, loan)
        try:
            loan_svc.check_currency(loan, funding)
        except loan_svc.LoanError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if txn.loan_payment_kind == loan_svc.PREPAYMENT:
        interest = requested.get("transfer_fee", txn.transfer_fee)
        if interest is not None and Decimal(str(interest)) != 0:
            raise HTTPException(
                status_code=400,
                detail="A prepayment is extra principal and carries no interest",
            )
        if (posted and (not old_posted or amount_changed)
                and loan_svc.amortization_of(loan) == loan_svc.FIXED):
            raise HTTPException(
                status_code=400,
                detail="Prepayment is not available on a fixed loan (its schedule is the bank's)",
            )
    if not (amount_changed or fee_changed or (posted and not old_posted)):
        return
    try:
        loan_svc.check_edited_payment(
            loan,
            old_principal=txn.amount,
            old_posted=old_posted,
            posted=posted,
            principal=requested.get("amount", txn.amount),
            interest=requested.get("transfer_fee", txn.transfer_fee),
        )
    except loan_svc.LoanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _loan_payment_source(db: Session, user: User, source_id: int, loan: Account) -> Account:
    """The account a transfer into ``loan`` comes from, if it may pay it through this API.

    Access is checked first (404). A generic or recurring transfer into a loan
    may come from any account the caller can use except the loan itself or
    another loan: a credit card or a spending wallet may fund it, as either may
    fund any other transfer (the forecast bills a card-funded payment on the
    card's statement and treats a wallet-funded one as moving no projection
    cash). A card without billing cycle settings may not: no statement bills
    it, so a payment from it would settle the loan without any cash ever
    leaving. The loan endpoints keep their stricter funding rules
    (``_funding_account``).
    """
    if source_id == loan.id:
        raise HTTPException(status_code=400,
                            detail="transfer_from_account_id cannot be the account itself")
    source = db.query(Account).filter(Account.id == source_id).first()
    if not source or not can_access_record(db, user, source):
        raise HTTPException(status_code=404, detail="Source account not found")
    if source.account_type == AccountType.LOAN:
        raise HTTPException(status_code=400,
                            detail="A loan cannot be paid from another loan")
    if source.account_type == AccountType.CREDIT and resolve_cycle_fields(source) is None:
        raise HTTPException(status_code=400,
                            detail="A credit card pays a loan only once it has billing cycle "
                                   "settings (a statement close or due day); set them first")
    return source


def _loan_payment_stamp(db: Session, user: User, loan: Account, source_id: int, *,
                        currency, principal, interest, posted: bool,
                        old_principal=0, old_posted: bool = False) -> dict:
    """The fields that make a transfer into ``loan`` a scheduled loan payment.

    Money paid into a loan through this API (a plain transfer, a transfer edited
    so it lands in a loan, or a recurring transfer entry being materialised) is
    a scheduled payment: it is stamped ``loan_payment_kind`` "scheduled", so once
    posted it settles its due date (services/loans.py) and the loan-payment edit
    rules apply to it afterwards. Extra principal is recorded only through the
    loan-prepayment endpoint.

    The checks are the loan-payment endpoint's except for the source's type
    (``_loan_payment_source``: a card or a spending wallet may fund it, another
    loan may not): the source is in the loan's currency, the row is in that
    currency too (``currency``, when the caller gave one), principal and
    interest are whole cents and move some money, and a posted payment's
    principal fits what is owed once the row's old effect on the loan
    (``old_principal``, if ``old_posted``) is reversed. The loan and source
    account are locked first, as the endpoint does. Nothing is written.

    With ``interest`` None (the caller gave no fee) the amount is split as the
    loan-payment endpoint proposes (``loan_svc.split_payment``): interest a
    month at the loan rate, principal the rest, the cash moved unchanged. A
    fee the caller gave is its own split and is kept.
    """
    funding = _loan_payment_source(db, user, source_id, loan)
    _lock(db, loan, funding)
    if currency is not None and currency != loan.currency:
        raise HTTPException(status_code=400,
                            detail="A loan payment's currency must match the loan's currency")
    try:
        loan_svc.check_currency(loan, funding)
        if interest is None and principal is not None:
            principal, interest = loan_svc.split_payment(loan, principal)
        principal, interest = loan_svc.check_edited_payment(
            loan, old_principal=old_principal, old_posted=old_posted, posted=posted,
            principal=principal, interest=interest)
    except loan_svc.LoanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return dict(amount=principal, transfer_fee=interest, currency=loan.currency,
                loan_payment_kind=loan_svc.SCHEDULED)


def _stamp_loan_payment(db: Session, user: User, transaction: TransactionCreate,
                        transaction_data: dict, source: Account, loan: Account) -> None:
    """Make a new transfer into a loan a scheduled loan payment (``_loan_payment_stamp``)."""
    transaction_data.update(_loan_payment_stamp(
        db, user, loan, source.id,
        currency=transaction.currency if "currency" in transaction.model_fields_set else None,
        principal=transaction.amount,
        interest=(transaction.transfer_fee
                  if "transfer_fee" in transaction.model_fields_set else None),
        posted=transaction.is_posted))


def _stamp_retargeted_loan_payment(db: Session, user: User, txn: Transaction,
                                   requested: dict) -> dict:
    """The stamp for an edit that newly points an unmarked row at a loan, or {}.

    A row with no ``loan_payment_kind`` (a transfer to another account, or a
    debit or credit) that the edit turns into a transfer into a loan gets the
    same classification and checks as a new one, before anything is changed.
    Without it the posted row would not settle its due date and the payable
    would be charged again. The row has no old effect on that loan, so it is
    validated against the loan as it stands. With no fee in the request and
    none on the row, the amount is split into principal and interest as for a
    new payment without a fee.

    An edit never stamps a row that was already a transfer into that same loan
    (a legacy unmarked payment, whatever the edit changes): it stays unmarked,
    so it is edited as a plain transfer and, like every legacy row, never
    counts toward ``payments_made`` (its payment is in
    ``loan_payments_made_offset``). Stamping it would count it a second time.
    """
    if txn.loan_payment_kind:
        return {}
    if requested.get("transaction_type", txn.transaction_type) != TransactionType.TRANSFER:
        return {}
    loan_id = requested.get("transfer_to_account_id", txn.transfer_to_account_id)
    loan = db.query(Account).filter(Account.id == loan_id).first() if loan_id else None
    if loan is None or loan.account_type != AccountType.LOAN:
        return {}
    source_id = requested.get("transfer_from_account_id", txn.transfer_from_account_id)
    if source_id is None:
        return {}  # rejected below as a transfer without a source
    if (txn.transaction_type == TransactionType.TRANSFER
            and txn.transfer_to_account_id == loan.id):
        return {}  # a legacy unmarked payment stays unmarked
    if requested.get("transfer_fee") is not None:
        interest = requested["transfer_fee"]
    else:
        interest = txn.transfer_fee or None
    return _loan_payment_stamp(
        db, user, loan, source_id,
        currency=requested.get("currency"),
        principal=requested.get("amount", txn.amount),
        interest=interest,
        posted=bool(requested.get("is_posted", txn.is_posted)))


def _budget_delta_for_transaction(transaction_type: TransactionType, amount: float) -> float:
    if transaction_type == TransactionType.DEBIT:
        return amount
    if transaction_type == TransactionType.CREDIT:
        return -amount
    return 0.0


def _get_budget_allocations_for_transaction(
    db: Session,
    *,
    user_id: int,
    allocation_id: Optional[int],
    category_id: Optional[int],
) -> List[Allocation]:
    allocations: List[Allocation] = []
    seen: Set[int] = set()

    if allocation_id:
        allocation = (
            db.query(Allocation)
            .filter(
                Allocation.id == allocation_id,
                Allocation.user_id == user_id,
                Allocation.allocation_type == AllocationType.BUDGET,
            )
            .first()
        )
        if allocation:
            allocations.append(allocation)
            seen.add(allocation.id)

    if category_id is not None:
        candidate_budgets = (
            db.query(Allocation)
            .filter(
                Allocation.user_id == user_id,
                Allocation.allocation_type == AllocationType.BUDGET,
            )
            .all()
        )
        for allocation in candidate_budgets:
            if allocation.id in seen:
                continue
            config = allocation.configuration or {}
            raw_category_ids = config.get("category_ids") or []
            normalized_ids: Set[int] = set()
            for value in raw_category_ids:
                try:
                    normalized_ids.add(int(value))
                except (TypeError, ValueError):
                    continue
            if category_id in normalized_ids:
                allocations.append(allocation)
                seen.add(allocation.id)

    return allocations


def _apply_budget_delta(
    allocations: List[Allocation],
    delta: float,
    reference_date: Optional[datetime],
) -> None:
    if not allocations or not delta:
        return

    normalized_reference = _normalize_reference(reference_date)
    now = utc_now()  # allocations.updated_at is timestamptz

    for allocation in allocations:
        if allocation.allocation_type != AllocationType.BUDGET:
            continue
        if not _ensure_budget_period(allocation, normalized_reference):
            continue  # out-of-period row (historical or future): excluded
        allocation.current_amount = _D(allocation.current_amount) + _D(delta)
        allocation.updated_at = now

@router.get("/", response_model=TransactionListResponse)
def get_transactions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    account_ids: Optional[List[int]] = Query(None, alias="account_ids", description="Filter by account IDs"),
    category_ids: Optional[List[int]] = Query(None, alias="category_ids", description="Filter by category IDs"),
    allocation_id: Optional[int] = Query(None, description="Filter by allocation ID"),
    transaction_types: Optional[List[str]] = Query(None, alias="transaction_types", description="Filter by transaction types"),
    start_date: Optional[datetime] = Query(None, description="Start date for filtering"),
    end_date: Optional[datetime] = Query(None, description="End date for filtering"),
    is_reconciled: Optional[bool] = Query(None, description="Filter by reconciliation status"),
    search: Optional[str] = Query(None, description="Search by description"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all transactions with optional filtering"""
    if active_entity is not None:
        # Shared scope: every transaction in the entity, regardless of which member
        # created it. Membership was already proven by get_active_entity.
        query = db.query(Transaction).filter(Transaction.entity_id == active_entity.id)
    else:
        # No entity context: fall back to the user's own accounts (this also keeps
        # transfers where either leg touches one of the user's accounts).
        user_account_ids = [
            a.id for a in db.query(Account.id).filter(Account.user_id == current_user.id).all()
        ]
        query = db.query(Transaction).filter(
            or_(
                Transaction.account_id.in_(user_account_ids),
                Transaction.transfer_from_account_id.in_(user_account_ids),
                Transaction.transfer_to_account_id.in_(user_account_ids)
            )
        )

    if account_ids:
        query = query.filter(
            or_(
                Transaction.account_id.in_(account_ids),
                Transaction.transfer_from_account_id.in_(account_ids),
                Transaction.transfer_to_account_id.in_(account_ids)
            )
        )
    if category_ids:
        query = query.filter(Transaction.category_id.in_(category_ids))
    if allocation_id:
        query = query.filter(Transaction.allocation_id == allocation_id)
    if transaction_types:
        try:
            allowed_types = [TransactionType(item.lower()) for item in transaction_types]
            query = query.filter(Transaction.transaction_type.in_(allowed_types))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid transaction type provided: {exc}") from exc
    if start_date:
        query = query.filter(Transaction.transaction_date >= start_date)
    if end_date:
        query = query.filter(Transaction.transaction_date <= end_date)
    if is_reconciled is not None:
        query = query.filter(Transaction.is_reconciled == is_reconciled)
    if search:
        query = query.filter(Transaction.description.ilike(f"%{search}%"))

    total = query.count()
    transactions = (
        query.order_by(Transaction.transaction_date.desc(), Transaction.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(transactions) < total
    return {"items": transactions, "total": total, "has_more": has_more}

@router.post("/", response_model=TransactionResponse)
def create_transaction(
    transaction: TransactionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """Create a new transaction and update account balance"""
    transaction_data = transaction.dict()
    if transaction_data.get("entity_id") is None and active_entity is not None:
        transaction_data["entity_id"] = active_entity.id
    else:
        validate_entity_ownership(db, current_user, transaction_data.get("entity_id"))
    transaction_data["user_id"] = current_user.id
    transaction_data["transfer_fee"] = transaction.transfer_fee or 0.0
    budget_entry: Optional[BudgetEntry] = None

    if transaction.budget_entry_id:
        budget_entry = db.query(BudgetEntry).filter(
            BudgetEntry.id == transaction.budget_entry_id
        ).first()
        if not budget_entry or not can_access_record(db, current_user, budget_entry):
            raise HTTPException(status_code=404, detail="Budget entry not found")
        transaction_data["budget_entry_id"] = budget_entry.id
    
    if budget_entry:
        transaction_data["is_recurring"] = True
        transaction_data["recurrence_frequency"] = budget_entry.cadence
    else:
        transaction_data["is_recurring"] = False
        transaction_data["recurrence_frequency"] = None
    
    primary_account: Optional[Account] = None
    destination_account: Optional[Account] = None
    
    if transaction.transaction_type == TransactionType.TRANSFER:
        if transaction.transfer_from_account_id is None or transaction.transfer_to_account_id is None:
            raise HTTPException(status_code=400, detail="Transfer transactions require source and destination accounts")
        if transaction.transfer_from_account_id == transaction.transfer_to_account_id:
            raise HTTPException(status_code=400, detail="Transfer accounts must be different")
        if transaction.account_id != transaction.transfer_from_account_id:
            raise HTTPException(status_code=400, detail="For transfers, account_id must match transfer_from_account_id")
        
        primary_account = db.query(Account).filter(
            Account.id == transaction.transfer_from_account_id
        ).first()
        if not primary_account or not can_access_record(db, current_user, primary_account):
            raise HTTPException(status_code=404, detail="Source account not found")
        
        destination_account = db.query(Account).filter(
            Account.id == transaction.transfer_to_account_id
        ).first()
        if not destination_account or not can_access_record(db, current_user, destination_account):
            raise HTTPException(status_code=404, detail="Destination account not found")
        if destination_account.account_type == AccountType.LOAN:
            _stamp_loan_payment(db, current_user, transaction, transaction_data,
                                primary_account, destination_account)
        
        if transaction_data.get("currency") is None:
            transaction_data["currency"] = destination_account.currency
        if transaction_data.get("projected_currency") is None and transaction.projected_amount is not None:
            transaction_data["projected_currency"] = destination_account.currency
        if transaction_data.get("original_currency") is None and transaction.original_amount is not None:
            transaction_data["original_currency"] = destination_account.currency
    else:
        primary_account = db.query(Account).filter(
            Account.id == transaction.account_id
        ).first()
        if not primary_account or not can_access_record(db, current_user, primary_account):
            raise HTTPException(status_code=404, detail="Account not found")
        if transaction_data.get("currency") is None:
            transaction_data["currency"] = primary_account.currency
        if transaction_data.get("projected_currency") is None and transaction.projected_amount is not None:
            transaction_data["projected_currency"] = primary_account.currency
        if transaction_data.get("original_currency") is None and transaction.original_amount is not None:
            transaction_data["original_currency"] = transaction_data["currency"]
    
    db_transaction = Transaction(**transaction_data)
    db.add(db_transaction)
    
    if transaction.transaction_type == TransactionType.CREDIT and transaction.is_posted:
        primary_account.balance = _D(primary_account.balance) + _D(transaction.amount)
    elif transaction.transaction_type == TransactionType.DEBIT and transaction.is_posted:
        primary_account.balance = _D(primary_account.balance) - _D(transaction.amount)
    elif transaction.transaction_type == TransactionType.TRANSFER and transaction.is_posted:
        # The stored split: a loan payment's may differ from the request's.
        principal, fee = transaction_data["amount"], transaction_data["transfer_fee"]
        primary_account.balance = _D(primary_account.balance) - (_D(principal) + _D(fee))
        if destination_account:
            destination_account.balance = _D(destination_account.balance) + _D(principal)

    if transaction.is_posted:
        delta = _budget_delta_for_transaction(transaction.transaction_type, transaction.amount)
        if delta:
            budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=transaction.allocation_id,
                category_id=transaction.category_id,
            )
            _apply_budget_delta(budget_allocations, delta, transaction.transaction_date)
    
    db.commit()
    db.refresh(db_transaction)
    return db_transaction

@router.get("/{transaction_id}", response_model=TransactionResponse)
def get_transaction(transaction_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get a specific transaction by ID"""
    transaction = get_accessible_or_404(db, Transaction, transaction_id, current_user, "Transaction not found")
    return transaction

@router.put("/{transaction_id}", response_model=TransactionResponse)
def update_transaction(transaction_id: int, transaction_update: TransactionUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Update an existing transaction and recalculate account balance"""
    db_transaction = get_accessible_or_404(db, Transaction, transaction_id, current_user, "Transaction not found")

    # Validate before any balance reversal or write.
    requested = transaction_update.dict(exclude_unset=True)
    if "entity_id" in requested:
        validate_entity_ownership(db, current_user, transaction_update.entity_id)

    # Every account the edit touches must be the caller's to use: the ones it
    # reverses (a shared row can move a co-member's private account, which is
    # reported as the row not being found) and the ones it lands on.
    for acc_id in _balance_account_ids(
        db_transaction.transaction_type, db_transaction.account_id,
        db_transaction.transfer_from_account_id, db_transaction.transfer_to_account_id,
    ):
        _require_account(db, current_user, acc_id, "Transaction not found")
    new_type = requested.get("transaction_type", db_transaction.transaction_type)
    if new_type == TransactionType.TRANSFER:
        _require_account(db, current_user, requested.get(
            "transfer_from_account_id", db_transaction.transfer_from_account_id),
            "Source account not found")
        _require_account(db, current_user, requested.get(
            "transfer_to_account_id", db_transaction.transfer_to_account_id),
            "Destination account not found")
    else:
        _require_account(db, current_user, requested.get(
            "account_id", db_transaction.account_id), "Account not found")
    if db_transaction.loan_payment_kind:
        _validate_loan_payment_edit(db, current_user, db_transaction, requested)
    loan_stamp = _stamp_retargeted_loan_payment(db, current_user, db_transaction, requested)

    # Store old values for balance recalculation
    old_amount = db_transaction.amount
    old_type = db_transaction.transaction_type
    old_account_id = db_transaction.account_id
    old_is_posted = db_transaction.is_posted
    old_transfer_fee = db_transaction.transfer_fee or 0.0
    old_transfer_from = db_transaction.transfer_from_account_id
    old_transfer_to = db_transaction.transfer_to_account_id
    old_category_id = db_transaction.category_id
    old_allocation_id = db_transaction.allocation_id
    old_transaction_date = db_transaction.transaction_date
    
    # Reverse previous balance effects if posted
    if old_is_posted:
        if old_type == TransactionType.CREDIT:
            old_account = db.query(Account).filter(Account.id == old_account_id).first()
            if old_account:
                old_account.balance = _D(old_account.balance) - _D(old_amount)
        elif old_type == TransactionType.DEBIT:
            old_account = db.query(Account).filter(Account.id == old_account_id).first()
            if old_account:
                old_account.balance = _D(old_account.balance) + _D(old_amount)
        elif old_type == TransactionType.TRANSFER:
            if old_transfer_from:
                from_account = db.query(Account).filter(Account.id == old_transfer_from).first()
                if from_account:
                    from_account.balance = _D(from_account.balance) + _D(old_amount) + _D(old_transfer_fee)
            if old_transfer_to:
                to_account = db.query(Account).filter(Account.id == old_transfer_to).first()
                if to_account:
                    to_account.balance = _D(to_account.balance) - _D(old_amount)
        old_budget_delta = _budget_delta_for_transaction(old_type, old_amount)
        if old_budget_delta:
            previous_budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=old_allocation_id,
                category_id=old_category_id,
            )
            _apply_budget_delta(previous_budget_allocations, -old_budget_delta, old_transaction_date)
    
    # Update transaction
    update_data = transaction_update.dict(exclude_unset=True)
    if "budget_entry_id" in update_data:
        new_budget_entry_id = update_data.get("budget_entry_id")
        budget_entry = None
        if new_budget_entry_id:
            budget_entry = db.query(BudgetEntry).filter(
                BudgetEntry.id == new_budget_entry_id
            ).first()
            if not budget_entry or not can_access_record(db, current_user, budget_entry):
                raise HTTPException(status_code=404, detail="Budget entry not found")
        setattr(db_transaction, "budget_entry_id", new_budget_entry_id)
        db_transaction.is_recurring = bool(budget_entry)
        db_transaction.recurrence_frequency = budget_entry.cadence if budget_entry else None
        update_data.pop("budget_entry_id", None)

    update_data.pop("is_recurring", None)
    update_data.pop("recurrence_frequency", None)

    for field, value in update_data.items():
        setattr(db_transaction, field, value)
    for field, value in loan_stamp.items():
        setattr(db_transaction, field, value)
    
    db_transaction.updated_at = utc_now()
    db_transaction.transfer_fee = db_transaction.transfer_fee or 0.0
    
    primary_account: Optional[Account] = None
    destination_account: Optional[Account] = None
    
    try:
        if db_transaction.transaction_type == TransactionType.TRANSFER:
            if db_transaction.transfer_from_account_id is None or db_transaction.transfer_to_account_id is None:
                raise HTTPException(status_code=400, detail="Transfer transactions require source and destination accounts")
            if db_transaction.transfer_from_account_id == db_transaction.transfer_to_account_id:
                raise HTTPException(status_code=400, detail="Transfer accounts must be different")
            
            primary_account = db.query(Account).filter(
                Account.id == db_transaction.transfer_from_account_id
            ).first()
            if not primary_account or not can_access_record(db, current_user, primary_account):
                raise HTTPException(status_code=404, detail="Source account not found")
            
            destination_account = db.query(Account).filter(
                Account.id == db_transaction.transfer_to_account_id
            ).first()
            if not destination_account or not can_access_record(db, current_user, destination_account):
                raise HTTPException(status_code=404, detail="Destination account not found")
            
            db_transaction.account_id = db_transaction.transfer_from_account_id
            if db_transaction.currency is None:
                db_transaction.currency = destination_account.currency
            if db_transaction.projected_amount is not None and db_transaction.projected_currency is None:
                db_transaction.projected_currency = destination_account.currency
            if db_transaction.original_amount is not None and db_transaction.original_currency is None:
                db_transaction.original_currency = destination_account.currency
        else:
            primary_account = db.query(Account).filter(
                Account.id == db_transaction.account_id
            ).first()
            if not primary_account or not can_access_record(db, current_user, primary_account):
                raise HTTPException(status_code=404, detail="Account not found")
            if db_transaction.currency is None:
                db_transaction.currency = primary_account.currency
            if db_transaction.projected_amount is not None and db_transaction.projected_currency is None:
                db_transaction.projected_currency = primary_account.currency
            if db_transaction.original_amount is not None and db_transaction.original_currency is None:
                db_transaction.original_currency = db_transaction.currency
    except HTTPException:
        db.rollback()
        raise
    
    # Apply new balance effects if posted
    if db_transaction.is_posted:
        if db_transaction.transaction_type == TransactionType.CREDIT and primary_account:
            primary_account.balance = _D(primary_account.balance) + _D(db_transaction.amount)
        elif db_transaction.transaction_type == TransactionType.DEBIT and primary_account:
            primary_account.balance = _D(primary_account.balance) - _D(db_transaction.amount)
        elif db_transaction.transaction_type == TransactionType.TRANSFER and primary_account and destination_account:
            primary_account.balance = _D(primary_account.balance) - (_D(db_transaction.amount) + _D(db_transaction.transfer_fee))
            destination_account.balance = _D(destination_account.balance) + _D(db_transaction.amount)
        new_budget_delta = _budget_delta_for_transaction(db_transaction.transaction_type, db_transaction.amount)
        if new_budget_delta:
            new_budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=db_transaction.allocation_id,
                category_id=db_transaction.category_id,
            )
            _apply_budget_delta(new_budget_allocations, new_budget_delta, db_transaction.transaction_date)
    
    db.commit()
    db.refresh(db_transaction)
    return db_transaction

@router.delete("/{transaction_id}")
def delete_transaction(transaction_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Delete a transaction and update account balance"""
    db_transaction = get_accessible_or_404(db, Transaction, transaction_id, current_user, "Transaction not found")
    # A shared row can move a co-member's private account: refuse unless the
    # caller may use every account it touches (reported as not found).
    for acc_id in _balance_account_ids(
        db_transaction.transaction_type, db_transaction.account_id,
        db_transaction.transfer_from_account_id, db_transaction.transfer_to_account_id,
    ):
        _require_account(db, current_user, acc_id, "Transaction not found")
    
    # Update account balances if posted
    if db_transaction.is_posted:
        if db_transaction.transaction_type == TransactionType.CREDIT:
            account = db.query(Account).filter(Account.id == db_transaction.account_id).first()
            if account:
                account.balance = _D(account.balance) - _D(db_transaction.amount)
        elif db_transaction.transaction_type == TransactionType.DEBIT:
            account = db.query(Account).filter(Account.id == db_transaction.account_id).first()
            if account:
                account.balance = _D(account.balance) + _D(db_transaction.amount)
        elif db_transaction.transaction_type == TransactionType.TRANSFER:
            if db_transaction.transfer_from_account_id:
                from_account = db.query(Account).filter(Account.id == db_transaction.transfer_from_account_id).first()
                if from_account:
                    from_account.balance = _D(from_account.balance) + _D(db_transaction.amount) + _D(db_transaction.transfer_fee)
            if db_transaction.transfer_to_account_id:
                to_account = db.query(Account).filter(Account.id == db_transaction.transfer_to_account_id).first()
                if to_account:
                    to_account.balance = _D(to_account.balance) - _D(db_transaction.amount)
        budget_delta = _budget_delta_for_transaction(db_transaction.transaction_type, db_transaction.amount)
        if budget_delta:
            budget_allocations = _get_budget_allocations_for_transaction(
                db,
                user_id=current_user.id,
                allocation_id=db_transaction.allocation_id,
                category_id=db_transaction.category_id,
            )
            _apply_budget_delta(budget_allocations, -budget_delta, db_transaction.transaction_date)
    
    db.delete(db_transaction)
    db.commit()
    return {"message": "Transaction deleted successfully"}

@router.post("/{transaction_id}/upload-receipt")
async def upload_receipt(
    transaction_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user)
):
    """Upload a receipt for a transaction"""
    db_transaction = get_accessible_or_404(db, Transaction, transaction_id, current_user, "Transaction not found")
    
    # Validate file type
    file_extension = file.filename.split(".")[-1].lower()
    if file_extension not in settings.ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400, 
            detail=f"File type not allowed. Allowed types: {', '.join(settings.ALLOWED_EXTENSIONS)}"
        )
    
    # Create upload directory if it doesn't exist
    upload_dir = os.path.join(settings.UPLOAD_DIR, "receipts")
    os.makedirs(upload_dir, exist_ok=True)
    
    # Save file
    filename = f"receipt_{transaction_id}_{utc_now().strftime('%Y%m%d_%H%M%S')}.{file_extension}"
    file_path = os.path.join(upload_dir, filename)
    
    with open(file_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)
    
    # Update transaction with receipt URL
    db_transaction.receipt_url = f"/uploads/receipts/{filename}"
    db.commit()
    
    return {"message": "Receipt uploaded successfully", "file_url": db_transaction.receipt_url}

UNCATEGORIZED = "Uncategorized"
TRANSFER_FEES = "Transfer fees"
UNALLOCATED_WALLET_SPEND = "Unallocated wallet spend"
RETURNED_FROM_WALLETS = "Returned from wallets"
LOAN_INTEREST_PREFIX = "Interest: "


def summarize_period(
    transactions, wallet_ids: Set[int], category_names: dict, scope_ids: Set[int],
    loan_names: Optional[dict] = None,
) -> dict:
    """Income, expense and per-category totals for posted transactions.

    ``scope_ids`` are the caller's in-scope accounts. A transfer counts only when
    its source is one of them: a transfer in from an account outside the scope
    (e.g. an entity co-member topping up the caller's wallet) is not the caller's
    spending, so neither its amount nor its fee is expensed.

    Spending wallets (cash on hand, e-wallets) are expensed when topped up, so:

    - expense = non-wallet debits + cash-to-wallet transfers (amount + fee) +
      income received into a wallet + the fee on every other transfer funded from
      a non-wallet account - money moved out of a wallet, unspent, into one of the
      caller's non-wallet accounts (e.g. GCash to a credit card payment, or back
      to a bank). Each fee is counted once, and a transfer's amount is otherwise
      not an expense, so a card purchase of 1,000 paid from a wallet topped up for
      it is 1,000, not 2,000;
    - debits from a wallet are not in the expense total but are shown under their
      category, and fees on transfers funded from a wallet (already expensed at
      top-up) are shown in category detail but not in the total;
    - income received into a wallet (a credit on a wallet account) is income and
      also an implicit top-up: it is added to the expense total and to
      "Unallocated wallet spend", so spending it from the wallet is categorised
      without being counted twice, and moving it on to a non-wallet account nets
      it back to zero through "Returned from wallets" (5,000 into GCash then moved
      to the bank: income 5,000, expense 0, net 5,000);
    - an "Unallocated wallet spend" row holds top-up amounts not yet accounted
      for by wallet debits and wallet-funded fees. Returned money is not wallet
      spend, so it never reduces this row; it is shown on its own, negative,
      "Returned from wallets" row instead. Together they keep the expense column
      of ``category_breakdown`` summing to ``total_expenses``;
    - a transfer between two wallets moves no expense, and money leaving a
      wallet for an account outside the caller's scope stays wallet spend.

    Transfer fees are shown on a "Transfer fees" row: a transfer's own category
    (e.g. a savings contribution) describes the amount moved, not spending.
    A loan payment is a transfer into the loan whose amount is principal (moving
    your own money against a debt, so not an expense) and whose fee is interest;
    for a destination in ``loan_names`` ({account id: name}) that fee is shown on
    an "Interest: <loan name>" row instead, counted exactly as any other fee.
    Income is every credit. Rows without a category are grouped as "Uncategorized".

    The breakdown is keyed by name, as it always has been (two categories with
    one name already share a row). A synthetic row ("Uncategorized", "Transfer
    fees", "Interest: <loan name>", "Unallocated wallet spend", "Returned from
    wallets") whose name a user category also uses is added into that row,
    never written over it, so no amount is lost and the expense column still
    sums to ``total_expenses``.
    """
    zero = Decimal("0")
    loan_names = loan_names or {}
    total_income = zero
    total_expenses = zero
    unallocated_wallet = zero
    returned = zero
    breakdown: dict = {}

    def row(name: str) -> dict:
        return breakdown.setdefault(name, {"income": zero, "expenses": zero})

    def category(category_id: Optional[int]) -> str:
        return category_names.get(category_id, UNCATEGORIZED) if category_id else UNCATEGORIZED

    for t in transactions:
        amount = _D(t.amount)
        if t.transaction_type == TransactionType.CREDIT:
            total_income += amount
            row(category(t.category_id))["income"] += amount
            if t.account_id in wallet_ids:
                # Income received into a wallet is also an implicit top-up.
                total_expenses += amount
                unallocated_wallet += amount
        elif t.transaction_type == TransactionType.DEBIT:
            row(category(t.category_id))["expenses"] += amount
            if t.account_id in wallet_ids:
                unallocated_wallet -= amount
            else:
                total_expenses += amount
        elif t.transaction_type == TransactionType.TRANSFER:
            source = t.transfer_from_account_id or t.account_id
            if source not in scope_ids:
                continue  # inbound from outside the caller's scope
            fee = _D(t.transfer_fee)
            destination = t.transfer_to_account_id
            from_wallet = source in wallet_ids
            to_wallet = destination in wallet_ids
            if fee:
                fee_row = (f"{LOAN_INTEREST_PREFIX}{loan_names[destination]}"
                           if destination in loan_names else TRANSFER_FEES)
                row(fee_row)["expenses"] += fee
            if from_wallet:
                unallocated_wallet -= fee
                if destination in scope_ids and not to_wallet:
                    total_expenses -= amount
                    returned += amount
            elif to_wallet:
                total_expenses += amount + fee
                unallocated_wallet += amount
            else:
                total_expenses += fee

    if unallocated_wallet:
        row(UNALLOCATED_WALLET_SPEND)["expenses"] += unallocated_wallet
    if returned:
        row(RETURNED_FROM_WALLETS)["expenses"] -= returned

    return {
        "total_income": total_income,
        "total_expenses": total_expenses,
        "category_breakdown": breakdown,
    }


@router.get("/summary/period")
def get_transaction_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    start_date: datetime = Query(..., description="Start date for summary"),
    end_date: datetime = Query(..., description="End date for summary"),
    account_id: Optional[int] = Query(None, description="Filter by account ID")
):
    """Get transaction summary for a specific period"""
    query = db.query(Transaction).filter(
        Transaction.transaction_date >= start_date,
        Transaction.transaction_date <= end_date,
    )
    # The caller's accounts in this scope (inactive ones included: this is history).
    scope_ids = {
        a.id for a in db.query(Account.id).filter(
            scope_criterion(Account, current_user.id, active_entity.id if active_entity else None)
        ).all()
    }
    touches_scope = or_(
        Transaction.account_id.in_(scope_ids),
        Transaction.transfer_from_account_id.in_(scope_ids),
        Transaction.transfer_to_account_id.in_(scope_ids)
    )
    if active_entity is not None:
        # The entity's own rows, plus transfers into or out of its accounts however
        # the row is tagged (e.g. a top-up from this entity's bank into another
        # entity's wallet, recorded under the other entity). summarize_period's
        # source-scope guard decides what such a transfer counts for.
        query = query.filter(or_(
            Transaction.entity_id == active_entity.id,
            and_(Transaction.transaction_type == TransactionType.TRANSFER, touches_scope),
        ))
    else:
        query = query.filter(touches_scope)
    
    if account_id:
        query = query.filter(Transaction.account_id == account_id)
    
    transactions = [t for t in query.all() if t.is_posted]

    account_ids = {
        acc_id
        for t in transactions
        for acc_id in (t.account_id, t.transfer_from_account_id, t.transfer_to_account_id)
        if acc_id is not None
    }
    referenced = db.query(Account).filter(Account.id.in_(account_ids)).all() if account_ids else []
    wallet_ids = {a.id for a in referenced if is_spending_wallet(a)}
    # Loans the caller can see get their own interest row (others stay "Transfer fees").
    loan_names = {
        a.id: a.name for a in referenced
        if a.account_type == AccountType.LOAN and can_access_record(db, current_user, a)
    }
    category_ids = {t.category_id for t in transactions if t.category_id}
    category_names = {
        c.id: c.name for c in db.query(Category).filter(Category.id.in_(category_ids)).all()
    } if category_ids else {}

    summary = summarize_period(transactions, wallet_ids, category_names, scope_ids, loan_names)
    total_income = summary["total_income"]
    total_expenses = summary["total_expenses"]
    net_flow = total_income - total_expenses
    category_summary = summary["category_breakdown"]

    return {
        "period": {
            "start_date": start_date,
            "end_date": end_date
        },
        "summary": {
            "total_income": total_income,
            "total_expenses": total_expenses,
            "net_flow": net_flow,
            "transaction_count": len(transactions)
        },
        "category_breakdown": category_summary
    }

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from typing import Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.entity_context import (
    can_access_record,
    get_accessible_or_404,
    get_active_entity,
    scope_criterion,
    validate_entity_ownership,
)
from app.models.account import Account, AccountType
from app.models.entity import Entity
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.account import AccountCreate, AccountResponse, AccountUpdate, AccountListResponse
from app.schemas.loan import LoanPaymentCreate, LoanPrepaymentCreate
from app.schemas.transaction import TransactionResponse
from app.services import loans as loan_svc
from app.core.time import naive_utc_now, utc_now
from datetime import datetime, timezone
from decimal import Decimal

router = APIRouter()


def _funding_account(
    db: Session, current_user: User, target_id: int, field: str, account_id: Optional[int] = None
) -> Account:
    """The account ``field`` names, if the caller may use it to fund a payment.

    Access is checked first (404), so the type rules never describe an account
    the caller cannot see. A funding account holds projection cash: not the
    paying account itself, a credit card (owed, not held), a spending wallet
    (already spent at top-up) or a loan (owed, not held).
    """
    if account_id is not None and target_id == account_id:
        raise HTTPException(status_code=400, detail=f"{field} cannot be the account itself")

    target = db.query(Account).filter(Account.id == target_id).first()
    if not target or not can_access_record(db, current_user, target):
        raise HTTPException(status_code=404, detail=f"{field} account not found")
    if target.account_type == AccountType.CREDIT:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be a funding account, not a credit card",
        )
    if target.account_type == AccountType.LOAN:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be a funding account, not a loan",
        )
    if target.is_spending_wallet:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be a funding account, not a spending wallet",
        )
    return target


def _validate_payment_routing(db: Session, current_user: User, data: dict, account_id: Optional[int] = None) -> None:
    """Reject payment routing that points at accounts the caller can't use.

    Covers a card's statement payment / overflow account and a loan's payment
    account. Without this, a caller could route a payment at an arbitrary account
    id and read that account's name back out of the timeline's
    ``account_shortfalls``. Also rejects self-routing, which would make an account
    fund its own payment.
    """
    for field in ("payment_account_id", "payment_overflow_account_id"):
        target_id = data.get(field)
        if target_id is None:
            continue
        _funding_account(db, current_user, target_id, field, account_id)


def _validate_spending_wallet(db: Session, data: dict, account: Optional[Account] = None) -> None:
    """Reject a spending-wallet flag that would leave a wallet funding something.

    A wallet is not projection cash, so it cannot be a credit card (whose balance is
    owed, not held), nor a funding account other routing draws on: a card's
    statement payment or overflow account, or a budget entry's overflow account.
    """
    from app.models.budget_entry import BudgetEntry

    is_wallet = data.get("is_spending_wallet", account.is_spending_wallet if account else False)
    if not is_wallet:
        return
    account_type = data.get("account_type", account.account_type if account else None)
    if account_type == AccountType.CREDIT:
        raise HTTPException(status_code=400, detail="A credit card cannot be a spending wallet")
    if account_type == AccountType.LOAN:
        raise HTTPException(status_code=400, detail="A loan cannot be a spending wallet")
    if account is None or account.is_spending_wallet:
        return
    routed = db.query(Account.id).filter(
        or_(Account.payment_account_id == account.id,
            Account.payment_overflow_account_id == account.id),
    ).first()
    overflow = db.query(BudgetEntry.id).filter(BudgetEntry.overflow_account_id == account.id).first()
    if routed or overflow:
        raise HTTPException(
            status_code=400,
            detail="This account funds a card payment or overflow routing; "
                   "remove that routing before marking it a spending wallet",
        )


LOAN_FIELDS = (
    "loan_kind", "loan_annual_rate", "loan_term_months", "loan_payment_amount",
    "loan_first_payment_date", "loan_amortization", "loan_payments_made_offset",
)


def _validate_loan(db: Session, data: dict, account: Optional[Account] = None) -> None:
    """Check loan terms against the account's resulting type; default the amortisation.

    A loan needs a ``loan_kind``; its amortisation defaults by kind (home loans
    shorten the term on prepayment, others follow the bank's fixed schedule).
    Loan terms are rejected on any other account type. An account that routing
    draws on (a card's statement payment or overflow, a loan's payment account,
    a budget entry's account or overflow) cannot become a loan: a loan holds no
    cash to fund them.
    """
    from app.models.budget_entry import BudgetEntry

    def resolved(field):
        if field in data:
            return data[field]
        return getattr(account, field) if account is not None else None

    account_type = resolved("account_type")
    if account_type != AccountType.LOAN:
        if any(resolved(field) is not None for field in LOAN_FIELDS):
            raise HTTPException(status_code=400, detail="Loan terms apply only to loan accounts")
        return

    kind = resolved("loan_kind")
    if kind is None:
        raise HTTPException(
            status_code=400,
            detail="A loan account needs a loan_kind (personal, auto or home)",
        )
    if resolved("loan_amortization") is None:
        data["loan_amortization"] = loan_svc.default_amortization(kind)

    if account is None or account.account_type == AccountType.LOAN:
        return
    routed = db.query(Account.id).filter(
        or_(Account.payment_account_id == account.id,
            Account.payment_overflow_account_id == account.id),
    ).first()
    entry = db.query(BudgetEntry.id).filter(
        or_(BudgetEntry.account_id == account.id,
            BudgetEntry.overflow_account_id == account.id),
    ).first()
    if routed or entry:
        raise HTTPException(
            status_code=400,
            detail="This account funds a payment, budget entry or overflow routing; "
                   "remove that routing before making it a loan",
        )


@router.get("/", response_model=AccountListResponse)
def get_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    account_type: Optional[str] = Query(None, description="Filter by account type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    limit: int = Query(10, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Get all accounts with optional filtering"""
    query = db.query(Account).filter(
        scope_criterion(Account, current_user.id, active_entity.id if active_entity else None)
    )

    if account_type:
        # Convert string to enum
        try:
            account_type_enum = AccountType(account_type.lower())
            query = query.filter(Account.account_type == account_type_enum)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid account type: {account_type}")
    
    if is_active is not None:
        query = query.filter(Account.is_active == is_active)
    
    total = query.count()
    accounts = (
        query.order_by(Account.created_at.desc(), Account.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    has_more = offset + len(accounts) < total
    return {"items": accounts, "total": total, "has_more": has_more}

@router.post("/", response_model=AccountResponse)
def create_account(
    account: AccountCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """Create a new account"""
    account_data = account.dict()
    if account_data.get("entity_id") is None and active_entity is not None:
        account_data["entity_id"] = active_entity.id
    else:
        validate_entity_ownership(db, current_user, account_data.get("entity_id"))

    _validate_payment_routing(db, current_user, account_data)
    _validate_spending_wallet(db, account_data)
    _validate_loan(db, account_data)

    db_account = Account(**account_data, user_id=current_user.id)
    db.add(db_account)
    db.commit()
    db.refresh(db_account)
    return db_account

@router.get("/{account_id}", response_model=AccountResponse)
def get_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get a specific account by ID"""
    return get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

@router.put("/{account_id}", response_model=AccountResponse)
def update_account(account_id: int, account_update: AccountUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Update an existing account"""
    db_account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

    update_data = account_update.dict(exclude_unset=True)
    if "entity_id" in update_data:
        validate_entity_ownership(db, current_user, update_data["entity_id"])
    _validate_payment_routing(db, current_user, update_data, account_id=account_id)
    _validate_spending_wallet(db, update_data, db_account)
    _validate_loan(db, update_data, db_account)
    for field, value in update_data.items():
        setattr(db_account, field, value)

    db_account.updated_at = utc_now()
    db.commit()
    db.refresh(db_account)
    return db_account

@router.delete("/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Soft delete an account (mark as inactive)"""
    db_account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

    db_account.is_active = False
    db_account.updated_at = utc_now()
    db.commit()
    return {"message": "Account deleted successfully"}

@router.get("/{account_id}/balance")
def get_account_balance(account_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_active_user)):
    """Get current balance and balance history for an account"""
    account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")

    # Calculate running balance from transactions
    from app.models.transaction import Transaction, TransactionType
    
    
    transactions = db.query(Transaction).filter(
        or_(
            Transaction.account_id == account_id,
            Transaction.transfer_from_account_id == account_id,
            Transaction.transfer_to_account_id == account_id
        )
    ).order_by(Transaction.transaction_date).all()
    
    balance_history = []
    running_balance = 0.0
    
    for transaction in transactions:
        if not transaction.is_posted:
            continue

        if transaction.transaction_type == TransactionType.CREDIT and transaction.account_id == account_id:
            running_balance += float(transaction.amount)
        elif transaction.transaction_type == TransactionType.DEBIT and transaction.account_id == account_id:
            running_balance -= float(transaction.amount)
        elif transaction.transaction_type == TransactionType.TRANSFER:
            if transaction.transfer_from_account_id == account_id:
                running_balance -= float(transaction.amount) + float(transaction.transfer_fee or 0.0)
            elif transaction.transfer_to_account_id == account_id:
                running_balance += float(transaction.amount)
            else:
                continue
        else:
            continue
        
        balance_history.append({
            "date": transaction.transaction_date,
            "balance": running_balance,
            "transaction_id": transaction.id
        })
    
    return {
        "account_id": account_id,
        "current_balance": account.balance,
        "calculated_balance": running_balance,
        "balance_history": balance_history
    }


# --- Loans -------------------------------------------------------------------

def _loan_or_404(db: Session, current_user: User, account_id: int) -> Account:
    account = get_accessible_or_404(db, Account, account_id, current_user, "Account not found")
    if account.account_type != AccountType.LOAN:
        raise HTTPException(status_code=400, detail="Account is not a loan")
    return account


def _loan_funding(db: Session, current_user: User, loan: Account,
                  from_account_id: Optional[int]) -> Account:
    """The account paying the loan: the request's, else the loan's payment account."""
    target_id = from_account_id or loan.payment_account_id
    if target_id is None:
        raise HTTPException(
            status_code=400,
            detail="No funding account: pass from_account_id or set the loan's payment_account_id",
        )
    return _funding_account(db, current_user, target_id, "from_account_id", loan.id)


def _lock(db: Session, *accounts: Account) -> None:
    """``SELECT ... FOR UPDATE`` each account, in ascending id order, refreshing it.

    Owed amounts, splits and balances are then computed from rows no concurrent
    payment can change until this one commits. A fixed lock order keeps two
    payments over the same pair of accounts from deadlocking.
    """
    for account in sorted(accounts, key=lambda a: a.id):
        (db.query(Account).filter(Account.id == account.id)
         .with_for_update().populate_existing().one())


def _when(value: Optional[datetime]) -> datetime:
    """Naive UTC, as transaction_date is stored."""
    if value is None:
        return naive_utc_now()
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _cents(value: Optional[Decimal]) -> Optional[Decimal]:
    """The normalised money value (whole cents) used for every check and write."""
    try:
        return loan_svc.cents(value)
    except loan_svc.LoanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _record(db: Session, current_user: User, loan: Account, funding: Account,
            principal: Decimal, interest: Decimal, kind: str, body) -> Transaction:
    try:
        txn = loan_svc.record_payment(
            db, user_id=current_user.id, loan=loan, funding=funding,
            principal=principal, interest=interest, kind=kind,
            when=_when(body.transaction_date), is_posted=body.is_posted,
            description=body.description,
        )
    except loan_svc.LoanError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    db.refresh(txn)
    return txn


@router.post("/{account_id}/loan-payment", response_model=TransactionResponse)
def record_loan_payment(
    account_id: int,
    payment: LoanPaymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Record a scheduled payment: one transfer, principal as amount, interest as fee.

    The bank's figures (principal / interest) override the proposed split.
    """
    loan = _loan_or_404(db, current_user, account_id)
    funding = _loan_funding(db, current_user, loan, payment.from_account_id)
    _lock(db, loan, funding)
    total, principal, interest = (
        _cents(payment.amount), _cents(payment.principal), _cents(payment.interest))
    if None not in (total, principal, interest) and principal + interest != total:
        raise HTTPException(status_code=400, detail="principal + interest must equal amount")
    try:
        principal, interest = loan_svc.propose_split(
            loan, total=total, principal=principal, interest=interest)
    except loan_svc.LoanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _record(db, current_user, loan, funding, principal, interest, loan_svc.SCHEDULED, payment)


@router.post("/{account_id}/loan-prepayment", response_model=TransactionResponse)
def record_loan_prepayment(
    account_id: int,
    prepayment: LoanPrepaymentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Record extra principal (no interest). Refused on a ``fixed`` loan."""
    loan = _loan_or_404(db, current_user, account_id)
    if loan_svc.amortization_of(loan) == loan_svc.FIXED:
        raise HTTPException(
            status_code=400,
            detail="Prepayment is not available on a fixed loan (its schedule is the bank's)",
        )
    funding = _loan_funding(db, current_user, loan, prepayment.from_account_id)
    _lock(db, loan, funding)
    if loan_svc.amortization_of(loan) == loan_svc.FIXED:  # re-read under the lock
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Prepayment is not available on a fixed loan (its schedule is the bank's)",
        )
    return _record(db, current_user, loan, funding, _cents(prepayment.amount), Decimal("0"),
                   loan_svc.PREPAYMENT, prepayment)


@router.get("/{account_id}/loan-schedule")
def get_loan_schedule(
    account_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """The loan's owed amount, payments made / left, next due date and upcoming rows."""
    loan = _loan_or_404(db, current_user, account_id)
    return loan_svc.build_schedule(db, loan)

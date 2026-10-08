"""Loan accounts: payment splits, recorded payments and the schedule (computed on read).

A loan's balance is negative while money is owed (owed = -balance). A payment is
one TRANSFER from a funding account into the loan: ``amount`` is principal and
``transfer_fee`` is interest, so the ordinary transfer arithmetic takes
principal + interest from the funding account and reduces the owed amount by the
principal. ``loan_payment_kind`` marks it ``scheduled`` or ``prepayment``.

Two amortisation modes:

- ``fixed``: the bank's schedule. Payments left = ``loan_term_months`` minus the
  scheduled payments made (``loan_payments_made_offset`` + posted scheduled
  payments recorded since ``loan_first_payment_date``). Each payment's split is
  the bank's figure, so upcoming rows carry no split. Prepayments are refused.
- ``reduce_term``: a prepayment shortens the term. Upcoming rows are an
  amortisation preview from the owed amount at the loan's rate and payment.

The next due date is ``loan_first_payment_date`` stepped one month per scheduled
payment made, in both modes.
"""
from calendar import monthrange
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.transaction import Transaction, TransactionType

SCHEDULED = "scheduled"
PREPAYMENT = "prepayment"
FIXED = "fixed"
REDUCE_TERM = "reduce_term"

_CENTS = Decimal("0.01")
_ZERO = Decimal("0")
# Upper bound on preview rows (50 years of monthly payments).
_MAX_ROWS = 600


class LoanError(ValueError):
    """A loan request that cannot be honoured (reported as a 400)."""


def _money(value) -> Decimal:
    return Decimal(str(value)).quantize(_CENTS, rounding=ROUND_HALF_UP)


def default_amortization(loan_kind: Optional[str]) -> str:
    """Home loans shorten their term on prepayment by default; others follow the bank."""
    return REDUCE_TERM if loan_kind == "home" else FIXED


def amortization_of(loan) -> str:
    return loan.loan_amortization or default_amortization(loan.loan_kind)


def owed(loan) -> Decimal:
    """What is still owed: the negated balance, never below zero."""
    return max(-_money(loan.balance or 0), _ZERO)


def _monthly_rate(annual_rate) -> Decimal:
    return Decimal(str(annual_rate or 0)) / Decimal("1200")


def due_date(first: date, n: int) -> date:
    """The ``n``-th monthly step after ``first``, clamped to the month's last day."""
    index = first.month - 1 + n
    year, month = first.year + index // 12, index % 12 + 1
    return date(year, month, min(first.day, monthrange(year, month)[1]))


def propose_split(loan, total: Optional[Decimal] = None, principal: Optional[Decimal] = None,
                  interest: Optional[Decimal] = None) -> Tuple[Decimal, Decimal]:
    """``(principal, interest)`` for a scheduled payment.

    The bank's own figures win: both given are used as is; one given with the
    total (``total``, else the loan's payment amount) leaves the other as the
    difference. Otherwise interest is a month at the loan rate on the owed
    amount, and principal the rest of the payment, capped at what is owed.
    """
    if principal is not None and interest is not None:
        return _money(principal), _money(interest)
    payment = total if total is not None else loan.loan_payment_amount
    if payment is None:
        raise LoanError("Give the payment amount (or principal and interest): "
                        "the loan has no payment amount")
    payment = _money(payment)
    if principal is not None:
        principal = _money(principal)
        return principal, payment - principal
    if interest is not None:
        interest = _money(interest)
        return payment - interest, interest
    interest = _money(owed(loan) * _monthly_rate(loan.loan_annual_rate))
    return min(payment - interest, owed(loan)), interest


def amortize(balance: Decimal, annual_rate, payment: Decimal, first_due: date) -> Optional[List[dict]]:
    """Monthly rows paying ``balance`` down at ``payment``; None if it never repays."""
    rate = _monthly_rate(annual_rate)
    payment = _money(payment)
    remaining = _money(balance)
    rows: List[dict] = []
    while remaining > 0:
        interest = _money(remaining * rate)
        principal = min(payment - interest, remaining)
        if principal <= 0 or len(rows) >= _MAX_ROWS:
            return None
        remaining -= principal
        rows.append({
            "number": len(rows) + 1,
            "due_date": due_date(first_due, len(rows)),
            "payment": principal + interest,
            "principal": principal,
            "interest": interest,
            "balance_after": remaining,
        })
    return rows


def _payments_into(db: Session, loan) -> List[Transaction]:
    """Posted transfers into the loan, oldest first."""
    return (
        db.query(Transaction)
        .filter(
            Transaction.transaction_type == TransactionType.TRANSFER,
            Transaction.transfer_to_account_id == loan.id,
            Transaction.is_posted.is_(True),
        )
        .order_by(Transaction.transaction_date, Transaction.id)
        .all()
    )


def payments_made(loan, payments: List[Transaction]) -> int:
    """Scheduled payments made: the offset plus posted ones since the first payment date."""
    first = loan.loan_first_payment_date
    recorded = sum(
        1 for t in payments
        if t.loan_payment_kind == SCHEDULED
        and (first is None or t.transaction_date.date() >= first)
    )
    return (loan.loan_payments_made_offset or 0) + recorded


def build_schedule(db: Session, loan: Account) -> dict:
    """The loan's state and upcoming payments, computed from its terms and recorded payments."""
    payments = _payments_into(db, loan)
    made = payments_made(loan, payments)
    mode = amortization_of(loan)
    first = loan.loan_first_payment_date
    next_due = due_date(first, made) if first else None
    balance = owed(loan)

    proposed = None
    if loan.loan_payment_amount is not None and balance > 0:
        principal, interest = propose_split(loan)
        proposed = {"principal": float(principal), "interest": float(interest)}

    upcoming: List[dict] = []
    payments_left: Optional[int] = None
    if mode == REDUCE_TERM and loan.loan_payment_amount is not None and next_due:
        rows = amortize(balance, loan.loan_annual_rate, loan.loan_payment_amount, next_due)
        if rows is not None:
            upcoming = [{**r, "number": made + r["number"]} for r in rows]
            payments_left = len(rows)
    elif loan.loan_term_months is not None:
        payments_left = max(loan.loan_term_months - made, 0)
        if next_due:
            payment = (float(loan.loan_payment_amount)
                       if loan.loan_payment_amount is not None else None)
            upcoming = [{
                "number": made + i + 1,
                "due_date": due_date(first, made + i),
                "payment": payment,
                "principal": None,
                "interest": None,
                "balance_after": None,
            } for i in range(payments_left)]

    def money(x):
        return float(x) if isinstance(x, Decimal) else x

    return {
        "account_id": loan.id,
        "name": loan.name,
        "loan_kind": loan.loan_kind,
        "amortization": mode,
        "owed": float(balance),
        "annual_rate": (float(loan.loan_annual_rate)
                        if loan.loan_annual_rate is not None else None),
        "payment_amount": (float(_money(loan.loan_payment_amount))
                           if loan.loan_payment_amount is not None else None),
        "term_months": loan.loan_term_months,
        "first_payment_date": first,
        "payments_made": made,
        "payments_left": payments_left,
        "next_due_date": next_due,
        "proposed_split": proposed,
        "payments": [{
            "transaction_id": t.id,
            "date": t.transaction_date,
            "kind": t.loan_payment_kind,
            "principal": float(_money(t.amount)),
            "interest": float(_money(t.transfer_fee or 0)),
        } for t in payments],
        "upcoming": [{k: money(v) for k, v in row.items()} for row in upcoming],
    }


def record_payment(db: Session, *, user_id: int, loan: Account, funding: Account,
                   principal: Decimal, interest: Decimal, kind: str,
                   when: datetime, is_posted: bool, description: Optional[str]) -> Transaction:
    """Add the transfer funding -> loan and apply it to both balances (not committed)."""
    if principal < 0 or interest < 0:
        raise LoanError("Principal and interest cannot be negative")
    if principal + interest <= 0:
        raise LoanError("A loan payment must move some money")
    if principal > owed(loan):
        raise LoanError("Principal exceeds what is owed on the loan")

    txn = Transaction(
        user_id=user_id,
        entity_id=loan.entity_id,
        account_id=funding.id,
        transfer_from_account_id=funding.id,
        transfer_to_account_id=loan.id,
        transaction_type=TransactionType.TRANSFER,
        amount=principal,
        transfer_fee=interest,
        currency=loan.currency,
        description=description or (
            f"Loan payment: {loan.name}" if kind == SCHEDULED else f"Extra principal: {loan.name}"
        ),
        transaction_date=when,
        is_posted=is_posted,
        is_recurring=False,
        loan_payment_kind=kind,
    )
    db.add(txn)
    if is_posted:
        funding.balance = _money(funding.balance) - (principal + interest)
        loan.balance = _money(loan.balance) + principal
    return txn

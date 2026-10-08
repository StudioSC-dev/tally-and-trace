"""Loan accounts: payment splits, recorded payments and the schedule (computed on read).

A loan's balance is negative while money is owed (owed = -balance). A payment is
one TRANSFER from a funding account into the loan: ``amount`` is principal and
``transfer_fee`` is interest, so the ordinary transfer arithmetic takes
principal + interest from the funding account and reduces the owed amount by the
principal. ``loan_payment_kind`` marks it ``scheduled`` or ``prepayment``.

Two amortisation modes:

- ``fixed``: the bank's schedule. Payments left = ``loan_term_months`` minus the
  scheduled payments made (``loan_payments_made_offset`` + every posted
  scheduled payment into the loan, whatever its date). Each payment's split is
  the bank's figure, so upcoming rows carry no split. Prepayments are refused.
- ``reduce_term``: a prepayment shortens the term. Upcoming rows are an
  amortisation preview from the owed amount at the loan's rate and payment.

The next due date is ``loan_first_payment_date`` stepped one month per scheduled
payment made, in both modes.

Projection (``build_loan_payables``): each due date from the next one on, while
payments are left, is a payable on the paying account (``payment_account_id``)
of ``loan_payment_amount``, or for ``reduce_term`` of that due date's
amortisation-preview payment (so the last one is only what is left). A loan
with no paying account, no payment amount, no first payment date or nothing
owed has none. Payments left come from the
amortisation preview for ``reduce_term`` (``loan_term_months`` when the loan
never repays) and from ``loan_term_months`` minus the payments made for
``fixed``; a fixed loan with no term is open-ended while money is owed.

Matching payments to due dates: a POSTED scheduled payment is already counted in
``payments_made``, so it moved ``next_due_date`` past its date and that date is no
longer projected. A planned payment covers the payables instead: an UNPOSTED
transfer into the loan that is not a prepayment (a planned or partial scheduled
payment, a plain transfer), whatever its date or entity, and each projected
occurrence of a recurring transfer entry into the loan. It is itself a cash leg
on its source account, so its cash (amount + interest fee) is consumed once and
only the covered part of a payable is removed. Prepayments never cover one.

Each payment belongs to its OWN due date (``own_due_index``): the due date
nearest its calendar date, a tie going to the earlier one, and the first due
date for a payment made before it. So a payment a few days early or late covers
the due date it was meant for. It pays its own due date first, and any excess
spills forward to the following due dates, never back to an earlier one; a
payment whose own due date is already settled spills to the next one owed.
Because a payment never reaches a due date earlier than its own, and is at most
half a month past it, a payable inside a window is the same for every window
with the same start: the planned transactions are loaded whatever their date,
and recurring occurrences are projected ``COVER_HORIZON`` past the window end.
"""
from calendar import monthrange
from datetime import date, datetime, timedelta
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
# How far past a window's end recurring payments are projected to find covers:
# a payment belongs to its nearest due date, so it is never more than half a
# month after the due date it covers.
COVER_HORIZON = timedelta(days=31)


class LoanError(ValueError):
    """A loan request that cannot be honoured (reported as a 400)."""


def _money(value) -> Decimal:
    return Decimal(str(value)).quantize(_CENTS, rounding=ROUND_HALF_UP)


def cents(value) -> Optional[Decimal]:
    """``value`` as a Decimal of whole cents; refused if non-finite or finer than a cent.

    None passes through. Every check, the persisted row and the balance
    arithmetic use this one normalised value.
    """
    if value is None:
        return None
    amount = Decimal(str(value))
    if not amount.is_finite():
        raise LoanError("Money values must be finite numbers")
    quantized = amount.quantize(_CENTS)
    if quantized != amount:
        raise LoanError("Money values can have at most 2 decimal places")
    return quantized


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


def own_due_index(first: date, day: date) -> int:
    """The due date a payment dated ``day`` belongs to, as a step from ``first``.

    The nearest due date, a tie going to the earlier one; ``first`` itself for a
    payment made on or before it.
    """
    if day <= first:
        return 0
    k = (day.year - first.year) * 12 + day.month - first.month
    if due_date(first, k) > day:
        k -= 1
    before, after = due_date(first, k), due_date(first, k + 1)
    return k + 1 if (after - day) < (day - before) else k


def allocate_to_due_dates(first: date, dues: List[Tuple[int, Decimal]],
                          payments: List[Tuple[date, Decimal]]) -> List[Decimal]:
    """What each due date still owes after ``payments``.

    ``dues`` are ``(step from first, amount owed)`` in step order; ``payments``
    ``(date, cash)``. Each payment is consumed once: from its own due date
    (``own_due_index``), or the first due date in ``dues`` after it when that one
    is not listed, forward only. Cash left after the last due date pays nothing.
    """
    pending = sorted((own_due_index(first, day), cash) for day, cash in payments)
    remaining: List[Decimal] = []
    carry, j = _ZERO, 0
    for index, amount in dues:
        while j < len(pending) and pending[j][0] <= index:
            carry += pending[j][1]
            j += 1
        paid = min(carry, amount)
        carry -= paid
        remaining.append(amount - paid)
    return remaining


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
    """Scheduled payments made: the offset plus every posted scheduled payment into the loan.

    Not filtered by date: a payment made before its due date (an early
    auto-debit, or a UTC timestamp that is the next day in Manila) still counts.
    """
    recorded = sum(1 for t in payments if t.loan_payment_kind == SCHEDULED)
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


def check_edited_payment(loan, *, old_principal, old_posted: bool, posted: bool,
                         principal, interest) -> Tuple[Decimal, Decimal]:
    """Re-validate an edited loan payment against the loan with its old effect reversed.

    ``(principal, interest)`` in whole cents, once each is non-negative, together
    they move some money, and (when the edited payment is ``posted``) the
    principal fits what is owed before this payment.
    """
    if principal is None:
        raise LoanError("A loan payment needs an amount (its principal)")
    principal, interest = cents(principal), cents(interest or 0)
    if principal < 0 or interest < 0:
        raise LoanError("Principal and interest cannot be negative")
    if principal + interest <= 0:
        raise LoanError("A loan payment must move some money")
    if not posted:
        return principal, interest
    balance = _money(loan.balance or 0) - (_money(old_principal) if old_posted else _ZERO)
    if principal > max(-balance, _ZERO):
        raise LoanError("Principal exceeds what is owed on the loan")
    return principal, interest


def check_currency(loan, funding) -> None:
    """A loan is paid only from an account in its own currency."""
    if funding.currency != loan.currency:
        raise LoanError("The funding account's currency must match the loan's currency")


def record_payment(db: Session, *, user_id: int, loan: Account, funding: Account,
                   principal: Decimal, interest: Decimal, kind: str,
                   when: datetime, is_posted: bool, description: Optional[str]) -> Transaction:
    """Add the transfer funding -> loan and apply it to both balances (not committed)."""
    principal, interest = cents(principal), cents(interest)
    check_currency(loan, funding)
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


def due_dates(db: Session, loan: Account, end: datetime) -> List[Tuple[int, date, Decimal]]:
    """``(step, due date, payment)`` of the loan's remaining scheduled payments before ``end``.

    ``step`` counts monthly steps from the first payment date.

    A ``reduce_term`` loan's payments are its amortisation rows (the last one is
    smaller); otherwise each is ``loan_payment_amount``.
    """
    first = loan.loan_first_payment_date
    if first is None or owed(loan) <= 0 or loan.loan_payment_amount is None:
        return []
    made = payments_made(loan, _payments_into(db, loan))
    next_due = due_date(first, made)
    payment = _money(loan.loan_payment_amount)
    amounts: Optional[List[Decimal]] = None
    if amortization_of(loan) == REDUCE_TERM:
        rows = amortize(owed(loan), loan.loan_annual_rate, payment, next_due)
        if rows is not None:
            amounts = [r["payment"] for r in rows]
    if amounts is None and loan.loan_term_months is not None:
        amounts = [payment] * max(loan.loan_term_months - made, 0)

    dates: List[Tuple[int, date, Decimal]] = []
    while (amounts is None or len(dates) < len(amounts)) and len(dates) < _MAX_ROWS:
        step = made + len(dates)
        due = due_date(first, step)
        if datetime(due.year, due.month, due.day) >= end:
            break
        dates.append((step, due, payment if amounts is None else amounts[len(dates)]))
    return dates


def planned_covers(db: Session, loan: Account) -> List[Tuple[date, Decimal]]:
    """``(date, cash)`` of every unposted non-prepayment transfer into the loan.

    Loaded by the loan alone, whatever the row's date or entity, so a payable
    does not depend on the window, and a payment stored under another entity
    still covers this loan's due date.
    """
    rows = (
        db.query(Transaction)
        .filter(
            Transaction.transaction_type == TransactionType.TRANSFER,
            Transaction.transfer_to_account_id == loan.id,
            Transaction.is_posted.is_(False),
        )
        .all()
    )
    return [(t.transaction_date.date(), _money(t.amount) + _money(t.transfer_fee or 0))
            for t in rows if t.loan_payment_kind != PREPAYMENT]


def build_loan_payables(db: Session, loans: List[Account], start: datetime, end: datetime,
                        projected_by_loan: dict) -> List[dict]:
    """Dated payable events for the loans' due dates before ``end``.

    A due date owes its payment less what the planned payments cover (see the
    module docstring): the loan's unposted non-prepayment transfers
    (``planned_covers``) and ``projected_by_loan``, ``{loan_id: [(date, cash)]}``,
    the recurring transfer occurrences into each loan up to ``end`` plus
    ``COVER_HORIZON``. A due date before ``start`` is overdue: emitted on
    ``start`` with ``overdue`` True and its due date as ``original_date``.
    """
    events: List[dict] = []
    for loan in loans:
        if loan.payment_account_id is None or loan.loan_payment_amount is None:
            continue
        dates = due_dates(db, loan, end)
        if not dates:
            continue
        covers = planned_covers(db, loan) + list(projected_by_loan.get(loan.id, []))
        dues = allocate_to_due_dates(loan.loan_first_payment_date,
                                     [(step, amount) for step, _, amount in dates], covers)
        for (_, due, _), remaining in zip(dates, dues):
            if remaining <= 0:
                continue
            when = datetime(due.year, due.month, due.day)
            overdue = {"overdue": True, "original_date": when} if when < start else {}
            events.append({
                "date": start if overdue else when,
                "name": f"{loan.name} payment",
                "amount": -remaining,
                "type": "expense",
                "source": "loan",
                "source_id": loan.id,
                "funding_account_id": loan.payment_account_id,
                "overflow_account_id": None,
                "loan_due_date": due,
                **overdue,
            })
    return events

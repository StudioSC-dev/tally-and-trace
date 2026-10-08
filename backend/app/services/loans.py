"""Loan accounts: payment splits, recorded payments and the schedule (computed on read).

A loan's balance is negative while money is owed (owed = -balance). A payment is
one TRANSFER from a funding account into the loan: ``amount`` is principal and
``transfer_fee`` is interest, so the ordinary transfer arithmetic takes
principal + interest from the funding account and reduces the owed amount by the
principal. ``loan_payment_kind`` marks it ``scheduled`` or ``prepayment``.

Two amortisation modes:

- ``fixed``: the bank's schedule. Payments left = ``loan_term_months`` minus the
  payments made. Each payment's split is the bank's figure, so upcoming rows
  carry no split. Prepayments are refused.
- ``reduce_term``: a prepayment shortens the term. Upcoming rows are an
  amortisation preview from the owed amount at the loan's rate and payment.

Payments made (``settle_posted``) are counted by amount: the due dates from
``loan_payments_made_offset`` on (the offset counts the due dates fully paid
before the loan was tracked here) each owe ``loan_payment_amount``, and the
posted scheduled payments pay them with their cash (principal + interest),
each its own due date first (see below). A due date is made once fully paid;
a part payment leaves the rest of that due date owed, so it stays the next due
date (overdue once past) until it is paid in full. Payments made = the offset +
the due dates made; the next due date is the earliest one not made.

Projection (``build_loan_payables``): each due date not yet made, while
payments are left, is a payable on the paying account (``payment_account_id``)
of what it still owes: ``loan_payment_amount`` (less any part payment), or for
``reduce_term`` that due date's amortisation-preview payment (so the last one
is only what is left). A loan with no paying account, no payment amount, no
first payment date or nothing owed has none. Payments left come from the
amortisation preview for ``reduce_term`` and from ``loan_term_months`` minus the
payments made for ``fixed``; a ``reduce_term`` loan that never repays at its
payment falls back to ``loan_term_months`` in the schedule and the projection
alike, and a loan with no term to fall back on is open-ended while money is
owed (no ``payments_left``).

Matching payments to due dates: a POSTED scheduled payment settles due dates as
above, so a settled date is no longer projected. A planned payment covers the
payables instead: an UNPOSTED
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


def settle_posted(loan, payments: List[Transaction]) -> dict:
    """Which due dates the posted scheduled payments settle, by amount.

    The due dates are the steps from ``loan_payments_made_offset`` on (earlier
    ones were paid before the loan was tracked here), up to the term for a
    ``fixed`` loan. Each owes ``loan_payment_amount``; every posted scheduled
    payment pays its own due date with its cash (principal + interest) and
    spills any excess forward (``allocate_to_due_dates``). A due date counts as
    made once fully paid; one only partly paid keeps the rest owed. Once nothing
    is owed on the loan, a due date that received any payment counts as made
    (the last payment can be smaller than the others).

    Returns ``made`` (the offset plus the due dates made), ``open`` (``(step,
    still owed)`` of every due date not made, in order) and ``next_due``. A loan
    without a payment amount cannot be settled by amount: each posted scheduled
    payment then counts as one payment made, oldest due date first, and
    ``open`` lists the steps after them with nothing known owed (``None``).
    """
    offset = loan.loan_payments_made_offset or 0
    first = loan.loan_first_payment_date
    scheduled = [t for t in payments if t.loan_payment_kind == SCHEDULED]
    term = loan.loan_term_months
    fixed_term = term if amortization_of(loan) == FIXED and term is not None else None
    limit = max(fixed_term, offset) if fixed_term is not None else offset + _MAX_ROWS

    if first is None or loan.loan_payment_amount is None:
        made = offset + len(scheduled)
        steps = range(made, max(term, made) if term is not None else made + _MAX_ROWS)
        return {"made": made, "open": [(step, None) for step in steps],
                "next_due": due_date(first, made) if first else None}

    payment = _money(loan.loan_payment_amount)
    dues = [(step, payment) for step in range(offset, limit)]
    remaining = allocate_to_due_dates(first, dues, [
        (t.transaction_date.date(), _money(t.amount) + _money(t.transfer_fee or 0))
        for t in scheduled])
    paid_off = owed(loan) <= 0
    open_ = [(step, left) for (step, _), left in zip(dues, remaining)
             if left > 0 and not (paid_off and left < payment)]
    made = offset + len(dues) - len(open_)
    next_due = due_date(first, open_[0][0] if open_ else made)
    return {"made": made, "open": open_, "next_due": next_due}


def _reduce_term_rows(balance: Decimal, annual_rate, payment: Decimal,
                      paid: Decimal) -> Optional[List[dict]]:
    """The amortisation preview from ``balance``, given ``paid`` already toward the next payment.

    Without a part payment it is ``amortize``. With one, the next payment is only
    what is left of it: the month's interest less what was paid (interest is paid
    first), and principal for the rest of the payment; the preview carries on from
    the balance after it. Due dates are filled in by the caller.
    """
    if paid <= 0:
        return amortize(balance, annual_rate, payment, date.min)
    interest = max(_money(balance * _monthly_rate(annual_rate)) - paid, _ZERO)
    principal = min(max(payment - paid - interest, _ZERO), balance)
    rest = amortize(balance - principal, annual_rate, payment, date.min)
    if rest is None:
        return None
    return [{"payment": principal + interest, "principal": principal, "interest": interest,
             "balance_after": balance - principal}, *rest]


def scheduled_dues(loan, state: dict) -> Optional[List[dict]]:
    """The loan's remaining due dates and what each still owes; None when open-ended.

    Each row is ``{number, step, due_date, payment, principal, interest,
    balance_after}`` over the due dates ``settle_posted`` left open. A
    ``reduce_term`` loan with a payment amount takes its amounts from the
    amortisation preview of the owed amount (``_reduce_term_rows``), so the last
    payment is only what is left. Otherwise, and for a ``reduce_term`` loan that
    never repays at its payment, each due date owes what ``settle_posted`` left of
    it (no split), up to ``loan_term_months``; with no term the loan is
    open-ended (None), and its due dates run on while money is owed.
    """
    first = loan.loan_first_payment_date
    if first is None:
        return []
    open_ = state["open"]

    def row(step, payment, principal=None, interest=None, balance_after=None):
        return {"number": step + 1, "step": step, "due_date": due_date(first, step),
                "payment": payment, "principal": principal, "interest": interest,
                "balance_after": balance_after}

    if amortization_of(loan) == REDUCE_TERM and loan.loan_payment_amount is not None:
        payment = _money(loan.loan_payment_amount)
        paid = payment - open_[0][1] if open_ else _ZERO
        rows = _reduce_term_rows(owed(loan), loan.loan_annual_rate, payment, paid)
        if rows is not None and len(rows) <= len(open_):
            return [row(open_[i][0], r["payment"], r["principal"], r["interest"],
                        r["balance_after"]) for i, r in enumerate(rows)]
    if loan.loan_term_months is None:
        return None
    return [row(step, left) for step, left in open_ if step < loan.loan_term_months]


def build_schedule(db: Session, loan: Account) -> dict:
    """The loan's state and upcoming payments, computed from its terms and recorded payments.

    ``payments_made`` / ``next_due_date`` come from ``settle_posted`` and the
    upcoming rows from ``scheduled_dues``; ``payments_left`` is the number of
    upcoming rows, or None for an open-ended loan (no term, and for
    ``reduce_term`` one that never repays at its payment).
    """
    payments = _payments_into(db, loan)
    state = settle_posted(loan, payments)
    mode = amortization_of(loan)
    first = loan.loan_first_payment_date
    balance = owed(loan)

    proposed = None
    if loan.loan_payment_amount is not None and balance > 0:
        principal, interest = propose_split(loan)
        proposed = {"principal": float(principal), "interest": float(interest)}

    dues = scheduled_dues(loan, state)
    payments_left = len(dues) if dues is not None else None
    upcoming = [{k: v for k, v in r.items() if k != "step"} for r in dues or []]

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
        "payments_made": state["made"],
        "payments_left": payments_left,
        "next_due_date": state["next_due"],
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
    """``(step, due date, still owed)`` of the loan's open due dates before ``end``.

    ``step`` counts monthly steps from the first payment date. What each owes
    comes from ``scheduled_dues``; an open-ended loan's due dates each owe what
    ``settle_posted`` left of them. Empty while nothing is owed, or without a
    first payment date or payment amount.
    """
    first = loan.loan_first_payment_date
    if first is None or owed(loan) <= 0 or loan.loan_payment_amount is None:
        return []
    state = settle_posted(loan, _payments_into(db, loan))
    dues = scheduled_dues(loan, state)
    rows = ([(r["step"], r["due_date"], r["payment"]) for r in dues] if dues is not None
            else [(step, due_date(first, step), left) for step, left in state["open"]])
    return [r for r in rows if datetime(r[1].year, r[1].month, r[1].day) < end]


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

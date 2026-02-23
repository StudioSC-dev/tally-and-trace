"""
Cash-flow projection engine for Tally & Trace.

Given a set of accounts, budget entries (recurring income/expenses), and
unposted transactions, this service generates a forward-looking timeline.
"""

from __future__ import annotations

import math
from calendar import monthrange
from datetime import datetime, timedelta, date
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.budget_entry import BudgetEntry, BudgetEntryType
from app.models.transaction import Transaction
from app.models.transaction import RecurrenceFrequency


# ---------------------------------------------------------------------------
# Period helpers
# ---------------------------------------------------------------------------

def _add_months(dt: datetime, months: int) -> datetime:
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    day = min(dt.day, monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _next_occurrence(current: datetime, cadence: RecurrenceFrequency) -> datetime:
    if cadence == RecurrenceFrequency.MONTHLY:
        return _add_months(current, 1)
    if cadence == RecurrenceFrequency.QUARTERLY:
        return _add_months(current, 3)
    if cadence == RecurrenceFrequency.SEMI_ANNUAL:
        return _add_months(current, 6)
    if cadence == RecurrenceFrequency.ANNUAL:
        return _add_months(current, 12)
    return _add_months(current, 1)


def _monthly_equivalent(amount: float, cadence: RecurrenceFrequency) -> float:
    """Normalize any cadence to a monthly amount."""
    divisors = {
        RecurrenceFrequency.MONTHLY: 1,
        RecurrenceFrequency.QUARTERLY: 3,
        RecurrenceFrequency.SEMI_ANNUAL: 6,
        RecurrenceFrequency.ANNUAL: 12,
    }
    return amount / divisors.get(cadence, 1)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_account_balances(db: Session, user_id: int, entity_id: Optional[int] = None):
    """Return all active accounts for the user (optionally scoped to entity)."""
    query = db.query(Account).filter(
        Account.user_id == user_id,
        Account.is_active == True,
    )
    if entity_id is not None:
        query = query.filter(Account.entity_id == entity_id)
    return query.all()


def project_cashflow(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    months: int = 6,
    reference: Optional[datetime] = None,
) -> List[dict]:
    """
    Generate a month-by-month cash-flow projection.

    Returns a list of dicts with keys:
      period_label, period_start, period_end,
      opening_balance, income, expenses, unposted_expenses,
      net, closing_balance
    """
    now = reference or datetime.utcnow()
    # Start of current month
    period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    accounts = get_account_balances(db, user_id, entity_id)
    opening = sum(a.balance for a in accounts)

    # Active budget entries for the entity/user
    be_query = db.query(BudgetEntry).filter(
        BudgetEntry.user_id == user_id,
        BudgetEntry.is_active == True,
    )
    if entity_id is not None:
        be_query = be_query.filter(BudgetEntry.entity_id == entity_id)
    budget_entries = be_query.all()

    # Unposted transactions (confirmed upcoming expenses)
    txn_query = db.query(Transaction).filter(
        Transaction.user_id == user_id,
        Transaction.is_posted == False,
    )
    if entity_id is not None:
        txn_query = txn_query.filter(Transaction.entity_id == entity_id)
    unposted_txns = txn_query.all()

    timeline = []
    for _ in range(months):
        period_end = _add_months(period_start, 1)

        income: float = 0.0
        expenses: float = 0.0

        for entry in budget_entries:
            # Walk occurrences within the period
            occ = entry.next_occurrence.replace(tzinfo=None) if entry.next_occurrence.tzinfo else entry.next_occurrence
            # If the first occurrence already passed use it as starting point
            while occ < period_start:
                occ = _next_occurrence(occ, entry.cadence)

            while period_start <= occ < period_end:
                if entry.entry_type == BudgetEntryType.INCOME:
                    income += entry.amount
                else:
                    expenses += entry.amount
                occ = _next_occurrence(occ, entry.cadence)

        # Unposted transactions within the period
        unposted_period: float = 0.0
        for txn in unposted_txns:
            txn_date = txn.transaction_date.replace(tzinfo=None) if txn.transaction_date.tzinfo else txn.transaction_date
            if period_start <= txn_date < period_end:
                from app.models.transaction import TransactionType
                if txn.transaction_type == TransactionType.DEBIT:
                    unposted_period += txn.amount
                elif txn.transaction_type == TransactionType.CREDIT:
                    unposted_period -= txn.amount

        net = income - expenses - unposted_period
        closing = opening + net

        timeline.append({
            "period_label": period_start.strftime("%B %Y"),
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "opening_balance": round(opening, 2),
            "income": round(income, 2),
            "expenses": round(expenses, 2),
            "unposted_expenses": round(unposted_period, 2),
            "net": round(net, 2),
            "closing_balance": round(closing, 2),
        })

        opening = closing
        period_start = period_end

    return timeline


def get_upcoming_items(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
    days: int = 30,
    reference: Optional[datetime] = None,
) -> List[dict]:
    """
    Return all scheduled income/expense occurrences and unposted transactions
    within the next N days, sorted by date.
    """
    now = reference or datetime.utcnow()
    cutoff = now + timedelta(days=days)

    items: List[dict] = []

    be_query = db.query(BudgetEntry).filter(
        BudgetEntry.user_id == user_id,
        BudgetEntry.is_active == True,
    )
    if entity_id is not None:
        be_query = be_query.filter(BudgetEntry.entity_id == entity_id)

    for entry in be_query.all():
        occ = entry.next_occurrence.replace(tzinfo=None) if entry.next_occurrence.tzinfo else entry.next_occurrence
        # Walk forward occurrences within the window
        counter = 0
        while occ <= cutoff and counter < 100:
            if occ >= now:
                items.append({
                    "name": entry.name,
                    "amount": entry.amount,
                    "due_date": occ.date().isoformat(),
                    "entry_type": entry.entry_type.value,
                    "source": "budget_entry",
                    "source_id": entry.id,
                })
            occ = _next_occurrence(occ, entry.cadence)
            counter += 1

    txn_query = db.query(Transaction).filter(
        Transaction.user_id == user_id,
        Transaction.is_posted == False,
        Transaction.transaction_date >= now,
        Transaction.transaction_date <= cutoff,
    )
    if entity_id is not None:
        txn_query = txn_query.filter(Transaction.entity_id == entity_id)

    for txn in txn_query.all():
        items.append({
            "name": txn.description or "Unposted transaction",
            "amount": txn.amount,
            "due_date": txn.transaction_date.date().isoformat(),
            "entry_type": txn.transaction_type.value,
            "source": "transaction",
            "source_id": txn.id,
        })

    items.sort(key=lambda x: x["due_date"])
    return items


def get_disposable_income(
    db: Session,
    user_id: int,
    entity_id: Optional[int] = None,
) -> dict:
    """
    Compute monthly net disposable income:
    total monthly income - total monthly expenses (normalised from each cadence).
    """
    be_query = db.query(BudgetEntry).filter(
        BudgetEntry.user_id == user_id,
        BudgetEntry.is_active == True,
    )
    if entity_id is not None:
        be_query = be_query.filter(BudgetEntry.entity_id == entity_id)

    monthly_income: float = 0.0
    monthly_expenses: float = 0.0

    for entry in be_query.all():
        monthly = _monthly_equivalent(entry.amount, entry.cadence)
        if entry.entry_type == BudgetEntryType.INCOME:
            monthly_income += monthly
        else:
            monthly_expenses += monthly

    disposable = monthly_income - monthly_expenses
    return {
        "monthly_income": round(monthly_income, 2),
        "monthly_expenses": round(monthly_expenses, 2),
        "monthly_disposable": round(disposable, 2),
    }

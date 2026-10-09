"""The per-user data export: an explicit schema, never raw ORM columns.

A user's export holds their own records, in full, and every record another
user created that touches an account they own, reduced to a limited field set
(see ``LIMITED_*``). Every field is named here, so a column added to a model
never reaches an export until it is added on purpose.

Owner form (STU-229): with no shares, records by others on the caller's
accounts exist only as legacy data.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Dict

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.access import (
    OWNER,
    account_role,
    owned_criterion,
    record_account_ids,
    touches_accounts,
)
from app.core.time import utc_now
from app.models.account import Account
from app.models.allocation import Allocation
from app.models.budget_entry import BudgetEntry
from app.models.category import Category
from app.models.transaction import Transaction
from app.models.user import User
from app.models.wishlist_item import WishlistItem

EXPORT_VERSION = 1

USER_FIELDS = ("email", "first_name", "last_name", "default_currency", "created_at")

ACCOUNT_FIELDS = (
    "id", "name", "account_type", "balance", "currency", "description", "credit_limit",
    "due_date", "billing_cycle_start", "days_until_due_date", "payment_account_id",
    "payment_overflow_account_id", "is_spending_wallet", "loan_kind", "loan_annual_rate",
    "loan_term_months", "loan_payment_amount", "loan_first_payment_date", "loan_amortization",
    "loan_payments_made_offset", "is_active", "created_at", "updated_at",
)

TRANSACTION_FIELDS = (
    "id", "account_id", "category_id", "allocation_id", "budget_entry_id", "amount", "currency",
    "projected_amount", "projected_currency", "original_amount", "original_currency",
    "exchange_rate", "transfer_fee", "description", "transaction_type", "is_posted",
    "transfer_from_account_id", "transfer_to_account_id", "loan_payment_kind",
    "transaction_date", "posting_date", "receipt_url", "invoice_url", "is_reconciled",
    "is_recurring", "recurrence_frequency", "created_at", "updated_at",
)

BUDGET_ENTRY_FIELDS = (
    "id", "entry_type", "name", "description", "amount", "currency", "cadence",
    "next_occurrence", "lead_time_days", "semi_monthly_day_1", "semi_monthly_day_2",
    "end_mode", "end_date", "max_occurrences", "occurrences_paid_offset", "account_id",
    "overflow_account_id", "transfer_to_account_id", "category_id", "allocation_id",
    "is_autopay", "is_active", "created_at", "updated_at",
)

CATEGORY_FIELDS = (
    "id", "name", "description", "color", "is_expense", "kind", "is_active",
    "created_at", "updated_at",
)

ALLOCATION_FIELDS = (
    "id", "account_id", "name", "allocation_type", "description", "target_amount",
    "current_amount", "monthly_target", "currency", "configuration", "period_frequency",
    "period_start", "period_end", "target_date", "is_active", "created_at", "updated_at",
)

WISHLIST_FIELDS = (
    "id", "name", "estimated_cost", "currency", "priority", "category_id", "url", "notes",
    "target_date", "is_purchased", "purchased_at", "created_at", "updated_at",
)

# Records another user created on the caller's accounts: amounts, dates and the
# caller's own accounts only. No description, category, allocation, recurring
# entry, receipt or invoice, and no account of anyone else's.
LIMITED_TRANSACTION_FIELDS = (
    "id", "transaction_date", "amount", "transfer_fee", "currency", "transaction_type",
    "is_posted", "account_id", "transfer_from_account_id", "transfer_to_account_id",
)

LIMITED_BUDGET_ENTRY_FIELDS = (
    "id", "entry_type", "amount", "currency", "cadence", "next_occurrence", "end_date",
    "is_active", "account_id", "transfer_to_account_id", "overflow_account_id",
)

ACCOUNT_REF_FIELDS = {
    "account_id", "transfer_from_account_id", "transfer_to_account_id", "overflow_account_id",
}

TABLES = (
    "accounts", "transactions", "budget_entries", "categories", "allocations",
    "wishlist_items", "others_transactions", "others_budget_entries",
)


def _value(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, Enum):
        return v.value
    return v


def _row(record, fields) -> dict:
    return {f: _value(getattr(record, f)) for f in fields}


def _limited(record, fields, owned_ids) -> dict:
    """A record by another user, with only the caller's own accounts named."""
    row = _row(record, fields)
    for f in ACCOUNT_REF_FIELDS & set(fields):
        if row[f] is not None and row[f] not in owned_ids:
            row[f] = None
    touched = set(record_account_ids(record))
    if "transfer_fee" in row and not touched <= owned_ids:
        # The counterpart is not the caller's (it may be a loan they cannot see):
        # report the whole payment, with no split that would show interest.
        row["amount"] = str(Decimal(row["amount"] or 0) + Decimal(row["transfer_fee"] or 0))
        row["transfer_fee"] = None
    return row


def build_export(db: Session, user: User) -> Dict[str, object]:
    """The caller's export, as plain JSON-ready data (see the module docstring)."""
    owned = db.query(Account).filter(owned_criterion(Account, user)).order_by(Account.id).all()
    owned_ids = {a.id for a in owned if account_role(user, a) == OWNER}

    def own(model):
        return db.query(model).filter(owned_criterion(model, user)).order_by(model.id).all()

    def others(model):
        if not owned_ids:
            return []
        return db.query(model).filter(and_(
            model.user_id != user.id, touches_accounts(model, owned_ids),
        )).order_by(model.id).all()

    return {
        "export_version": EXPORT_VERSION,
        "exported_at": utc_now().isoformat(),
        "user": _row(user, USER_FIELDS),
        "accounts": [_row(a, ACCOUNT_FIELDS) for a in owned],
        "transactions": [_row(t, TRANSACTION_FIELDS) for t in own(Transaction)],
        "budget_entries": [_row(e, BUDGET_ENTRY_FIELDS) for e in own(BudgetEntry)],
        "categories": [_row(c, CATEGORY_FIELDS) for c in own(Category)],
        "allocations": [_row(a, ALLOCATION_FIELDS) for a in own(Allocation)],
        "wishlist_items": [_row(w, WISHLIST_FIELDS) for w in own(WishlistItem)],
        "others_transactions": [
            _limited(t, LIMITED_TRANSACTION_FIELDS, owned_ids) for t in others(Transaction)],
        "others_budget_entries": [
            _limited(e, LIMITED_BUDGET_ENTRY_FIELDS, owned_ids) for e in others(BudgetEntry)],
    }


TABLE_FIELDS: Dict[str, tuple] = {
    "accounts": ACCOUNT_FIELDS,
    "transactions": TRANSACTION_FIELDS,
    "budget_entries": BUDGET_ENTRY_FIELDS,
    "categories": CATEGORY_FIELDS,
    "allocations": ALLOCATION_FIELDS,
    "wishlist_items": WISHLIST_FIELDS,
    "others_transactions": LIMITED_TRANSACTION_FIELDS,
    "others_budget_entries": LIMITED_BUDGET_ENTRY_FIELDS,
}

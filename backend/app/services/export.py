"""The per-user data export: an explicit schema, never raw ORM columns.

A user's export holds their own records in full, and a limited view of every
other record they can read (see ``LIMITED_*``). Every field is named here, so a
column added to a model never reaches an export until it is added on purpose.

Version 2 (STU-232, shared accounts):

- ``accounts``: the accounts the caller owns, in full. ``shared_accounts``: the
  accounts shared with them, as a reference (id, name, type, currency, their
  role and the owner's display name), nothing an owner keeps to managers.
- ``transactions`` / ``budget_entries``: the caller's own records whose view is
  ``full`` (they can view every account the record touches).
- ``others_transactions`` / ``others_budget_entries``: every other record the
  caller can read, through the Limited models (``app/core/redaction.py``):
  another user's records on accounts the caller holds a role on, and the
  caller's own records that touch an account they can no longer view (after a
  revocation). Accounts are references; a hidden one is neutral, and a payment
  into a hidden loan or card shows no interest.

Tags (STU-231): the caller's own tags, and the links from those tags to the
caller's own accounts and the records in ``transactions`` and
``budget_entries``. Another user's tags, and links to records not in the
export, are never included.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Dict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.access import (
    OWNER,
    account_role,
    owned_criterion,
    readable_criterion,
    viewable_account_ids,
    viewable_accounts,
)
from app.core.redaction import FULL, Redactor, display_name
from app.core.time import utc_now
from app.models.account import Account
from app.models.allocation import Allocation
from app.models.budget_entry import BudgetEntry
from app.models.category import Category
from app.models.tag import Tag, account_tags, budget_entry_tags, transaction_tags
from app.models.transaction import Transaction
from app.models.user import User
from app.models.wishlist_item import WishlistItem

EXPORT_VERSION = 2

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

TAG_FIELDS = ("id", "name", "color", "is_system", "created_at")

ACCOUNT_TAG_FIELDS = ("tag_id", "account_id")
TRANSACTION_TAG_FIELDS = ("tag_id", "transaction_id")
BUDGET_ENTRY_TAG_FIELDS = ("tag_id", "budget_entry_id")

SHARED_ACCOUNT_FIELDS = ("id", "name", "account_type", "currency", "my_role", "owner_name")

# Records the caller can read but not in full: the Limited models' fields, minus
# the per-response ``view``, ``permissions`` and ``tags``. ``account`` and
# ``counterpart`` are references ({id, name}, or {id: null, name} when hidden).
LIMITED_TRANSACTION_FIELDS = (
    "id", "date", "display_description", "amount", "transfer_fee", "currency",
    "transaction_type", "is_posted", "category_name", "created_by", "account", "counterpart",
)

LIMITED_BUDGET_ENTRY_FIELDS = (
    "id", "display_name", "amount", "currency", "entry_type", "cadence", "next_occurrence",
    "end_date", "category_name", "created_by", "account", "counterpart",
)

TABLES = (
    "accounts", "shared_accounts", "transactions", "budget_entries", "categories", "allocations",
    "wishlist_items", "others_transactions", "others_budget_entries", "tags",
    "account_tags", "transaction_tags", "budget_entry_tags",
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


def _pick(body: dict, fields) -> dict:
    return {f: _value(body.get(f)) for f in fields}


def _own_links(db: Session, user: User, table, fields, record_ids) -> list:
    """Links from the caller's own tags to the given records (their own)."""
    if not record_ids:
        return []
    tag_col, record_col = (table.c[f] for f in fields)
    rows = db.execute(
        select(tag_col, record_col)
        .join(Tag, Tag.id == tag_col)
        .where(Tag.user_id == user.id, record_col.in_(record_ids))
        .order_by(record_col, tag_col)
    ).all()
    return [dict(zip(fields, row)) for row in rows]


def build_export(db: Session, user: User) -> Dict[str, object]:
    """The caller's export, as plain JSON-ready data (see the module docstring)."""
    owned = db.query(Account).filter(owned_criterion(Account, user)).order_by(Account.id).all()
    owned = [a for a in owned if account_role(user, a) == OWNER]
    shared = [a for a in viewable_accounts(db, user).order_by(Account.id).all()
              if account_role(user, a) != OWNER]
    scope_ids = viewable_account_ids(db, user)
    redactor = Redactor(db, user)

    def own(model):
        return db.query(model).filter(owned_criterion(model, user)).order_by(model.id).all()

    def split(model):
        """(own records in full, every other readable record) for ``model``."""
        rows = (db.query(model).filter(readable_criterion(model, user, scope_ids))
                .order_by(model.id).all())
        redactor.prepare(rows)
        full = [r for r in rows if r.user_id == user.id and redactor.view(r) == FULL]
        full_ids = {r.id for r in full}
        return full, [r for r in rows if r.id not in full_ids]

    transactions, others_transactions = split(Transaction)
    entries, others_entries = split(BudgetEntry)
    tags = db.query(Tag).filter(Tag.user_id == user.id).order_by(Tag.id).all()

    return {
        "export_version": EXPORT_VERSION,
        "exported_at": utc_now().isoformat(),
        "user": _row(user, USER_FIELDS),
        "accounts": [_row(a, ACCOUNT_FIELDS) for a in owned],
        "shared_accounts": [
            {"id": a.id, "name": a.name, "account_type": _value(a.account_type),
             "currency": _value(a.currency), "my_role": account_role(user, a),
             "owner_name": display_name(a.user)} for a in shared],
        "transactions": [_row(t, TRANSACTION_FIELDS) for t in transactions],
        "budget_entries": [_row(e, BUDGET_ENTRY_FIELDS) for e in entries],
        "categories": [_row(c, CATEGORY_FIELDS) for c in own(Category)],
        "allocations": [_row(a, ALLOCATION_FIELDS) for a in own(Allocation)],
        "wishlist_items": [_row(w, WISHLIST_FIELDS) for w in own(WishlistItem)],
        "others_transactions": [
            _pick(redactor.limited_transaction(t), LIMITED_TRANSACTION_FIELDS)
            for t in others_transactions],
        "others_budget_entries": [
            _pick(redactor.limited_entry(e), LIMITED_BUDGET_ENTRY_FIELDS)
            for e in others_entries],
        "tags": [_row(t, TAG_FIELDS) for t in tags],
        "account_tags": _own_links(
            db, user, account_tags, ACCOUNT_TAG_FIELDS, [a.id for a in owned]),
        "transaction_tags": _own_links(
            db, user, transaction_tags, TRANSACTION_TAG_FIELDS, [t.id for t in transactions]),
        "budget_entry_tags": _own_links(
            db, user, budget_entry_tags, BUDGET_ENTRY_TAG_FIELDS, [e.id for e in entries]),
    }


TABLE_FIELDS: Dict[str, tuple] = {
    "accounts": ACCOUNT_FIELDS,
    "shared_accounts": SHARED_ACCOUNT_FIELDS,
    "transactions": TRANSACTION_FIELDS,
    "budget_entries": BUDGET_ENTRY_FIELDS,
    "categories": CATEGORY_FIELDS,
    "allocations": ALLOCATION_FIELDS,
    "wishlist_items": WISHLIST_FIELDS,
    "others_transactions": LIMITED_TRANSACTION_FIELDS,
    "others_budget_entries": LIMITED_BUDGET_ENTRY_FIELDS,
    "tags": TAG_FIELDS,
    "account_tags": ACCOUNT_TAG_FIELDS,
    "transaction_tags": TRANSACTION_TAG_FIELDS,
    "budget_entry_tags": BUDGET_ENTRY_TAG_FIELDS,
}

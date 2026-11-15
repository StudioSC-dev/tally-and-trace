"""Description suggestions for the Add Transaction form (STU-626).

``GET /transactions/description-suggestions?q=`` lists the distinct descriptions
the caller has used that start with ``q`` (case-insensitive), most recent first,
up to ``LIMIT``, each with the values of the latest transaction carrying it: its
type, account, category, tags and, for a transfer, its from and to accounts. The
form fills its untouched fields from them; the amount is never suggested.

**Only rows the caller sees in full.** A row counts when the caller would be
shown it ``full`` or ``shared_full`` (``full_view_criterion``, the SQL form of
``Redactor.view``) over the request context's access map: a row shown limited
(a viewer's or a Household member's view) never supplies a description or a
value, so a description hidden behind a neutral label is never suggested.

**Only references the caller can still use.** An account comes back only when
the caller may add transactions to it and it is active (the form's account
pickers); a category only when it is the caller's own and active; a tag only
when it is the caller's own (the only tags one may tag with). Anything else comes
back as null, or is left out of ``tag_ids``.

**One SQL statement.** Visibility comes from the request's ``AccessMap`` (read
once per request by the context), and the read itself is one statement: the
latest matching row per description (a window over the matching rows), its
usable category and its own tags (a correlated array), ordered and limited in
the database.
"""
from __future__ import annotations

from typing import List

from sqlalchemy import and_, func, select
from sqlalchemy.dialects.postgresql import aggregate_order_by

from app.core.access import EDIT_ROLES, VIEW_ROLES
from app.core.context import RequestContext
from app.core.redaction import full_view_criterion
from app.models.category import Category
from app.models.tag import Tag, transaction_tags
from app.models.transaction import Transaction, TransactionType

LIMIT = 8
MAX_QUERY_LENGTH = 255


def _like_prefix(text: str) -> str:
    """``text`` as a LIKE prefix pattern, its wildcards escaped (escape char ``\\``)."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}%"


def suggestions(ctx: RequestContext, q: str) -> List[dict]:
    """The suggestions for ``q`` (module docstring). A blank ``q`` reads nothing."""
    prefix = q.strip().lower()
    if not prefix:
        return []
    uid = ctx.uid
    access = ctx.access
    viewable = access.ids(VIEW_ROLES)
    editable = access.ids(EDIT_ROLES)
    usable_accounts = access.ids(EDIT_ROLES, active_only=True)

    key = func.lower(Transaction.description)
    latest = (
        select(
            Transaction.id.label("id"),
            Transaction.description.label("description"),
            Transaction.transaction_type.label("transaction_type"),
            Transaction.account_id.label("account_id"),
            Transaction.category_id.label("category_id"),
            Transaction.transfer_from_account_id.label("transfer_from_account_id"),
            Transaction.transfer_to_account_id.label("transfer_to_account_id"),
            Transaction.transaction_date.label("transaction_date"),
            func.row_number().over(
                partition_by=key,
                order_by=(Transaction.transaction_date.desc(), Transaction.id.desc()),
            ).label("rank"),
        )
        .where(
            full_view_criterion(Transaction, uid, viewable, editable),
            Transaction.description.isnot(None),
            func.length(func.trim(Transaction.description)) > 0,
            key.like(_like_prefix(prefix), escape="\\"),
        )
        .subquery("latest")
    )
    own_tags = (
        select(func.array_agg(aggregate_order_by(transaction_tags.c.tag_id,
                                                 transaction_tags.c.tag_id)))
        .select_from(transaction_tags.join(Tag, Tag.id == transaction_tags.c.tag_id))
        .where(transaction_tags.c.transaction_id == latest.c.id, Tag.user_id == uid)
        .correlate(latest)
        .scalar_subquery()
    )
    statement = (
        select(latest.c.description, latest.c.transaction_type, latest.c.account_id,
               Category.id.label("category_id"), latest.c.transfer_from_account_id,
               latest.c.transfer_to_account_id, own_tags.label("tag_ids"))
        .select_from(latest.outerjoin(Category, and_(
            Category.id == latest.c.category_id, Category.user_id == uid,
            Category.is_active.is_(True))))
        .where(latest.c.rank == 1)
        .order_by(latest.c.transaction_date.desc(), latest.c.id.desc())
        .limit(LIMIT)
    )

    def usable(account_id):
        return account_id if account_id in usable_accounts else None

    items = []
    for row in ctx.db.execute(statement):
        transfer = row.transaction_type == TransactionType.TRANSFER
        items.append({
            "description": row.description,
            "transaction_type": row.transaction_type,
            "account_id": usable(row.account_id),
            "category_id": row.category_id,
            "tag_ids": list(row.tag_ids or []),
            "transfer_from_account_id": usable(row.transfer_from_account_id) if transfer else None,
            "transfer_to_account_id": usable(row.transfer_to_account_id) if transfer else None,
        })
    return items

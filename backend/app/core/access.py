"""Who may see and change what: one function, computed from accounts.

Every router and service resolves access through this module. The rule has a
single root, ``account_role(user, account)``:

- ``owner`` when the account is the user's (``account.user_id``);
- ``none`` otherwise.

Account shares add ``admin``, ``editor`` and ``viewer`` later; nothing outside
this module should compare ``user_id`` columns to decide access to an account.

Records that touch accounts (transactions and recurring entries) follow from it:

- **Read:** the caller created the record, or holds a direct role (``owner``,
  ``admin``, ``editor`` or ``viewer``) on any account it touches.
- **Write:** the caller holds an edit role (``owner``, ``admin`` or ``editor``)
  on every account the record touches, before and after the change, and the
  record's creator still holds one on every account it touches afterwards.
- A record that touches no account (a recurring entry with no account) is the
  creator's alone, for reading and writing.

Categories, allocations and wishlist items are never shared: only their owner
reaches them. Every account a record references must be one its owner and
the caller may change; see ``require_account``. Every other record it
references (category, allocation, recurring entry, and the ids in an
allocation's configuration) must belong to the caller and to the record's
owner: the same-owner rule, see ``require_owned_ref``.

With no shares, the creator and the owner of the accounts a record touches are
the same user, so all of this reduces to "your own records only".

Failures are 404, never 403: a 403 would confirm the id exists to someone with
no right to know that.
"""

from typing import Iterable, Optional, Set, Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction, TransactionType

OWNER = "owner"
NONE = "none"

# Roles held on the account itself or through a direct share.
DIRECT_ROLES = frozenset({OWNER, "admin", "editor", "viewer"})
# Roles that may add, change or remove records on the account.
EDIT_ROLES = frozenset({OWNER, "admin", "editor"})
# Roles that may change the account's settings and routing.
MANAGE_ROLES = frozenset({OWNER, "admin"})
# Deleting or deactivating an account is its owner's alone.
OWNER_ROLES = frozenset({OWNER})

# The accounts each kind of record touches. Recurring entries have no
# transfer_from_account_id: their source is account_id.
TOUCHED_COLUMNS = {
    Transaction: ("account_id", "transfer_from_account_id", "transfer_to_account_id"),
    BudgetEntry: ("account_id", "transfer_to_account_id", "overflow_account_id"),
}
# Columns that count only on a transfer. A debit or credit touches its
# account_id alone: any transfer_* value it carries (a stale one left by an
# edit from a transfer, or one a client sent) names no account it moves money
# on, so it grants no one access to it.
TRANSFER_ONLY_COLUMNS = {
    Transaction: frozenset({"transfer_from_account_id", "transfer_to_account_id"}),
    BudgetEntry: frozenset(),
}


def _counts(record, column: str) -> bool:
    """Whether ``column`` names an account ``record`` touches."""
    if column not in TRANSFER_ONLY_COLUMNS[type(record)]:
        return True
    return record.transaction_type == TransactionType.TRANSFER


def _uid(user) -> Optional[int]:
    """A user's id, from a ``User`` or a bare id."""
    return getattr(user, "id", user)


def account_role(user, account) -> str:
    """The caller's role on ``account``: ``owner`` or ``none``."""
    if user is None or account is None:
        return NONE
    if account.user_id == _uid(user):
        return OWNER
    return NONE


def can_view_account(user, account) -> bool:
    return account_role(user, account) in DIRECT_ROLES


def can_edit_account(user, account) -> bool:
    return account_role(user, account) in EDIT_ROLES


def viewable_accounts(db: Session, user, *, active_only: bool = False):
    """Query for the accounts the caller holds any role on."""
    query = db.query(Account).filter(Account.user_id == _uid(user))
    if active_only:
        query = query.filter(Account.is_active.is_(True))
    return query


def viewable_account_ids(db: Session, user, *, active_only: bool = False) -> Set[int]:
    query = db.query(Account.id).filter(Account.user_id == _uid(user))
    if active_only:
        query = query.filter(Account.is_active.is_(True))
    return {row[0] for row in query.all()}


def record_account_ids(record) -> Tuple[int, ...]:
    """The distinct accounts a transaction or recurring entry touches."""
    columns = TOUCHED_COLUMNS[type(record)]
    ids = []
    for column in columns:
        if not _counts(record, column):
            continue
        value = getattr(record, column)
        if value is not None and value not in ids:
            ids.append(value)
    return tuple(ids)


def touches_accounts(model, account_ids: Iterable[int]):
    """Criterion: the record touches any of ``account_ids``."""
    ids = list(account_ids)
    criteria = []
    for column in TOUCHED_COLUMNS[model]:
        criterion = getattr(model, column).in_(ids)
        if column in TRANSFER_ONLY_COLUMNS[model]:
            criterion = and_(model.transaction_type == TransactionType.TRANSFER, criterion)
        criteria.append(criterion)
    return or_(*criteria)


def readable_criterion(model, user, scope_ids: Iterable[int]):
    """Criterion for the transactions or recurring entries the caller may read.

    ``scope_ids`` are accounts the caller holds a direct role on (see
    ``viewable_account_ids``): a record is readable when the caller created it
    or it touches one of them.
    """
    return or_(model.user_id == _uid(user), touches_accounts(model, scope_ids))


def _accounts(db: Session, ids: Iterable[int]) -> dict:
    ids = list(ids)
    if not ids:
        return {}
    return {a.id: a for a in db.query(Account).filter(Account.id.in_(ids)).all()}


def can_read_record(db: Session, user, record) -> bool:
    """Read rule for a transaction or recurring entry (see the module docstring)."""
    if record.user_id == _uid(user):
        return True
    accounts = _accounts(db, record_account_ids(record))
    return any(account_role(user, a) in DIRECT_ROLES for a in accounts.values())


def can_write_record(db: Session, user, record) -> bool:
    """Write rule for a transaction or recurring entry, on its current accounts.

    The caller needs an edit role on every account the record touches; a record
    touching no account is its creator's alone. Accounts the record moves to are
    checked separately (``require_account``), as is the creator keeping access.
    """
    ids = record_account_ids(record)
    if not ids:
        return record.user_id == _uid(user)
    accounts = _accounts(db, ids)
    if len(accounts) != len(ids):
        return False
    return all(account_role(user, a) in EDIT_ROLES for a in accounts.values())


def get_account_or_404(db: Session, user, account_id: int, detail: str = "Account not found",
                       *, roles=DIRECT_ROLES) -> Account:
    """The account, 404ing unless the caller holds one of ``roles`` on it."""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account or account_role(user, account) not in roles:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return account


def require_account(db: Session, user, account_id: Optional[int], detail: str,
                    *, owner=None) -> Optional[Account]:
    """The account a record will touch, 404ing unless both may use it.

    The caller needs an edit role on it, and so does the record's owner
    (``owner``, default the caller): a record never lands on an account its
    owner could not change. A None id is skipped.
    """
    if account_id is None:
        return None
    account = db.query(Account).filter(Account.id == account_id).first()
    if (not account or not can_edit_account(user, account)
            or (owner is not None and not can_edit_account(owner, account))):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return account


def get_record_or_404(db: Session, model, record_id: int, user, detail: str = "Not found",
                      *, write: bool = False):
    """A transaction or recurring entry the caller may read (or write, with ``write``)."""
    record = db.query(model).filter(model.id == record_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    allowed = can_write_record(db, user, record) if write else can_read_record(db, user, record)
    if not allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def get_owned_or_404(db: Session, model, record_id: int, user, detail: str = "Not found"):
    """A record that is never shared (category, allocation, wishlist item): owner only."""
    record = db.query(model).filter(model.id == record_id).first()
    if not record or record.user_id != _uid(user):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def require_owned_ref(db: Session, model, ref_id: Optional[int], detail: str, *owners):
    """A never-shared record another record references, 404ing unless it is every owner's.

    The same-owner rule: a category, allocation or recurring entry referenced by
    a record must belong to the caller and to the referencing record's owner
    (pass both; None is skipped). A None id is skipped.
    """
    if ref_id is None:
        return None
    record = db.query(model).filter(model.id == ref_id).first()
    if not record or any(record.user_id != _uid(o) for o in owners if o is not None):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return record


def owned_criterion(model, user):
    """Criterion for the never-shared records the caller owns."""
    return model.user_id == _uid(user)


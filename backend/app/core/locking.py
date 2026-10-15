"""Locks for ledger writes, taken in one global order (STU-226, STU-222).

Every write path takes the locks it needs in this order, skipping the ones it
does not need, so no two paths can wait on each other in a cycle:

0. the owner's budget lock (``lock_owner_budgets``), always first;
1. the recurring entry being edited, deleted or materialised (``lock_entry``);
2. the transaction row being edited or deleted (``lock_transaction``), or an
   entry's linked rows, which its delete nullifies;
3. accounts, in ascending id (``lock_accounts``);
4. budget allocations, in ascending id.

Callers reach these through the module (``locking.lock_owner_budgets(...)``),
never by importing the names, so one patch of the module reaches every caller.

Rows are locked ``FOR NO KEY UPDATE``: it conflicts with every other writer of
the row but not with the ``FOR KEY SHARE`` lock Postgres takes on a row when an
insert or a foreign-key update references it. Nothing here changes a key
column, so that is enough, and a plain ``FOR UPDATE`` would deadlock against
those foreign-key checks. Only a delete takes ``FOR UPDATE``, which the DELETE
needs anyway.
"""
from typing import Dict, Iterable, Optional

import sqlalchemy as sa
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from sqlalchemy.orm.util import identity_key

from app.models.account import Account
from app.models.budget_entry import BudgetEntry
from app.models.transaction import Transaction

# Namespace of the owner budget lock's two-int advisory key. The seed's
# single-bigint key (app/core/seed.py) lives in a different key space.
OWNER_BUDGET_LOCK_NS = 226

# Column attributes only: refreshing these never re-runs the account's
# ``lazy="selectin"`` collections (transactions, shares, tag links).
ACCOUNT_COLUMNS = [a.key for a in sa.inspect(Account).column_attrs]


def lock_owner_budgets(db: Session, owner_id: int) -> None:
    """Serialise one owner's budget membership and ledger writes (STU-222).

    A transaction-scoped advisory lock, re-entrant within the transaction and
    released at commit or rollback. Transaction writes and budget configuration
    writes for the owner take it first, so a write never discovers the budgets a
    row counts toward from a configuration another write is about to change, nor
    sums rows another write is about to add. Postgres only.
    """
    if db.get_bind().dialect.name != "postgresql":
        return
    db.execute(text("SELECT pg_advisory_xact_lock(:ns, :owner_id)"),
               {"ns": OWNER_BUDGET_LOCK_NS, "owner_id": owner_id})


def lock_accounts(db: Session, ids: Iterable[Optional[int]]) -> Dict[int, Account]:
    """Lock each account ``FOR NO KEY UPDATE`` in ascending id and return it refreshed.

    Pending changes in the session (balances from earlier writes in the same
    change) are flushed first, so the refresh cannot discard them. An account
    already in the session is refreshed in place, its columns only; any other is
    loaded. Missing ids are skipped: the caller's own checks report them.
    """
    db.flush()
    locked: Dict[int, Account] = {}
    for account_id in sorted({i for i in ids if i}):
        found = db.execute(
            select(Account.id).where(Account.id == account_id).with_for_update(key_share=True)
        ).scalar_one_or_none()
        if found is None:
            continue
        account = db.identity_map.get(identity_key(Account, account_id))
        if account is not None:
            db.refresh(account, attribute_names=ACCOUNT_COLUMNS)
        else:
            account = db.get(Account, account_id)
        locked[account_id] = account
    return locked


def lock_entry(db: Session, entry_id: int, *, for_delete: bool = False) -> Optional[BudgetEntry]:
    """The recurring entry, locked and refreshed, or None once it is gone.

    ``FOR NO KEY UPDATE`` for an edit, ``FOR UPDATE`` for a delete.
    """
    return (db.query(BudgetEntry).filter(BudgetEntry.id == entry_id)
            .with_for_update(key_share=not for_delete).populate_existing().one_or_none())


def lock_transaction(db: Session, txn_id: int, *, for_delete: bool = False) -> Optional[Transaction]:
    """The transaction row, locked and refreshed, or None once it is gone.

    ``FOR NO KEY UPDATE`` for an edit, ``FOR UPDATE`` for a delete.
    """
    return (db.query(Transaction).filter(Transaction.id == txn_id)
            .with_for_update(key_share=not for_delete).populate_existing().one_or_none())

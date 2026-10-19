"""``apply_transaction_update`` is the PUT body without its commit. Skips without a database.

The caller holds the owner budget lock and then the row lock; the helper takes the
account locks and then the allocation locks, applies the edit and flushes, and
leaves the commit (or the rollback) to the caller.
"""
from decimal import Decimal

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

WHEN = "2026-10-05T12:00:00"


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _txn(client, who, txn_id) -> dict:
    r = client.get(f"{API}/transactions/{txn_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _pending_debit(client, who, balance=50_000, amount=1_000):
    checking = sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": balance})["id"]
    txn = sw_post(client, who, "/transactions/", {
        "account_id": checking, "amount": amount, "transaction_type": "debit",
        "description": "helper probe", "transaction_date": WHEN, "is_posted": False})["id"]
    return checking, txn


def _apply_post(session, user_id, txn_id):
    """Take the caller's locks, then post the row through the helper; no commit."""
    from app.core import locking
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.routers.transactions import apply_transaction_update
    from app.schemas.transaction import TransactionUpdate

    owner_id = session.get(Transaction, txn_id).user_id
    locking.lock_owner_budgets(session, owner_id)
    txn = locking.lock_transaction(session, txn_id)
    assert txn is not None
    return apply_transaction_update(session, session.get(User, user_id), txn,
                                    TransactionUpdate(is_posted=True))


def test_apply_transaction_update_posts_a_pending_row_once_without_committing(
        sw_client, sw_db, sw_people):
    client = sw_client
    me = sw_people()
    checking, txn_id = _pending_debit(client, me)

    applied = _apply_post(sw_db, me["id"], txn_id)
    assert applied.id == txn_id and applied.is_posted
    sw_db.rollback()

    # Nothing was committed: the row is still pending and the balance untouched.
    assert _txn(client, me, txn_id)["is_posted"] is False
    assert _balance(client, me, checking) == Decimal("50000.00")

    _apply_post(sw_db, me["id"], txn_id)
    sw_db.commit()

    assert _txn(client, me, txn_id)["is_posted"] is True
    assert _balance(client, me, checking) == Decimal("49000.00")


def test_apply_transaction_update_locks_the_rows_accounts(sw_client, sw_db, sw_people,
                                                          monkeypatch):
    from app.core import locking
    from app.routers import transactions as router

    client = sw_client
    me = sw_people()
    checking, txn_id = _pending_debit(client, me)

    calls = []
    real_lock_accounts = locking.lock_accounts
    real_lock_allocations = router._lock_allocations

    def spy_lock_accounts(db, ids, *args, **kwargs):
        ids = list(ids)
        calls.append(("lock_accounts", [i for i in ids if i is not None]))
        return real_lock_accounts(db, ids, *args, **kwargs)

    def spy_lock_allocations(db, allocations, *args, **kwargs):
        calls.append(("_lock_allocations", None))
        return real_lock_allocations(db, allocations, *args, **kwargs)

    # The spies wrap only the helper's own calls: the caller's locks come first.
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.schemas.transaction import TransactionUpdate

    locking.lock_owner_budgets(sw_db, me["id"])
    txn = locking.lock_transaction(sw_db, txn_id)
    assert txn is not None
    monkeypatch.setattr(locking, "lock_accounts", spy_lock_accounts)
    monkeypatch.setattr(router, "_lock_allocations", spy_lock_allocations)
    try:
        router.apply_transaction_update(sw_db, sw_db.get(User, me["id"]), txn,
                                        TransactionUpdate(is_posted=True))
    finally:
        sw_db.rollback()

    assert [name for name, _ in calls] == ["lock_accounts", "_lock_allocations"]
    assert set(calls[0][1]) == {checking}
    assert sw_db.get(Transaction, txn_id).is_posted is False

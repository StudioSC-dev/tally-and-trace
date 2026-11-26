"""An allocation update tolerates the row vanishing before its lock (STU-311). Skips without a database.

``apply_allocation_update`` is reached after an ownership check; a row deleted between
that check and the row lock is a 404, not a 500.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _allocation(client, who) -> tuple:
    account = sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 10_000})["id"]
    allocation = sw_post(client, who, "/allocations/", {
        "account_id": account, "name": "Goal", "allocation_type": "goal",
        "target_amount": 1_000})["id"]
    return account, allocation


def _delete_row(allocation_id):
    """Hard-delete the row in its own committed session."""
    from sqlalchemy import text

    from app.core.database import SessionLocal

    other = SessionLocal()
    try:
        other.execute(text("DELETE FROM allocations WHERE id = :id"), {"id": allocation_id})
        other.commit()
    finally:
        other.close()


def test_update_vanished_allocation_404(sw_client, sw_people, monkeypatch):
    """Deleted after the ownership check, before the lock: 404 (it was a 500)."""
    from app.core import locking

    client = sw_client
    me = sw_people()
    _, allocation = _allocation(client, me)
    real = locking.lock_owner_budgets

    def vanish_then_lock(db, owner_id):
        real(db, owner_id)
        _delete_row(allocation)

    monkeypatch.setattr(locking, "lock_owner_budgets", vanish_then_lock)
    r = client.put(f"{API}/allocations/{allocation}", json={"name": "Renamed"},
                   headers=me["headers"])

    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "Allocation not found"


def test_existing_allocation_update_unchanged(sw_client, sw_people):
    client = sw_client
    me = sw_people()
    _, allocation = _allocation(client, me)

    r = client.put(f"{API}/allocations/{allocation}", json={"name": "Renamed"},
                   headers=me["headers"])

    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed"
    assert client.get(f"{API}/allocations/{allocation}",
                      headers=me["headers"]).json()["name"] == "Renamed"


def test_allocation_ownership_rejection_unchanged(sw_client, sw_people):
    client = sw_client
    me, other = sw_people(), sw_people()
    _, allocation = _allocation(client, me)
    other_account, _ = _allocation(client, other)

    r = client.put(f"{API}/allocations/{allocation}", json={"name": "Stolen"},
                   headers=other["headers"])
    assert r.status_code == 404, r.text

    r = client.put(f"{API}/allocations/{allocation}", json={"account_id": other_account},
                   headers=me["headers"])
    assert r.status_code == 404, r.text
    assert client.get(f"{API}/allocations/{allocation}",
                      headers=me["headers"]).json()["name"] == "Goal"


def test_allocation_update_lock_order_unchanged(sw_client, sw_people, monkeypatch):
    """The owner's budget lock first, then the allocation row lock."""
    from app.core import locking
    from app.routers import allocations as router

    client = sw_client
    me = sw_people()
    _, allocation = _allocation(client, me)
    calls = []
    real_owner, real_rows = locking.lock_owner_budgets, router._lock_allocations

    def spy_owner(db, owner_id):
        calls.append("lock_owner_budgets")
        return real_owner(db, owner_id)

    def spy_rows(db, allocations):
        calls.append("_lock_allocations")
        return real_rows(db, allocations)

    monkeypatch.setattr(locking, "lock_owner_budgets", spy_owner)
    monkeypatch.setattr(router, "_lock_allocations", spy_rows)
    r = client.put(f"{API}/allocations/{allocation}", json={"name": "Renamed"},
                   headers=me["headers"])

    assert r.status_code == 200, r.text
    # The route takes the owner lock before its first read and the helper takes it again
    # (re-entrant); the row lock comes after every owner lock (STU-786).
    assert calls[0] == "lock_owner_budgets"
    assert calls.count("_lock_allocations") == 1
    assert calls.index("_lock_allocations") == len(calls) - 1

"""Integration tests: updates that change entity_id must check entity membership (STU-218).

Create handlers call validate_entity_ownership; the update handlers must too, or a
user can move their own record into an entity they do not belong to. Per resource:

  * moving an own record into a non-member entity -> 403 and the stored row is unchanged
  * moving it into an entity the user belongs to -> 200 and the row moves
  * an update that omits entity_id leaves entity_id untouched

Skips without a database.
"""
import os
import secrets
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, text


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_reachable(), reason="no database available")

API = "/api/v1"
NOW = datetime(2026, 1, 15, tzinfo=timezone.utc).isoformat()


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _make_user(db):
    from app.core.auth import get_password_hash
    from app.models.user import User

    email = f"upd-ent-{secrets.token_hex(6)}@example.com"
    user = User(
        email=email,
        password_hash=get_password_hash("Password123!"),
        first_name="Upd",
        last_name="Probe",
        is_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user, email


def _make_entity(db, *members):
    from app.models.entity import Entity, EntityMembership, EntityType, MemberRole

    entity = Entity(name=f"Ent {secrets.token_hex(3)}", entity_type=EntityType.BUSINESS)
    db.add(entity)
    db.commit()
    db.refresh(entity)
    for user in members:
        db.add(EntityMembership(entity_id=entity.id, user_id=user.id, role=MemberRole.OWNER))
    db.commit()
    return entity.id


@pytest.fixture
def world(client, db):
    """A user, an entity they belong to, and an entity only someone else belongs to."""
    user, email = _make_user(db)
    other, _ = _make_user(db)
    member_entity = _make_entity(db, user)
    foreign_entity = _make_entity(db, other)
    r = client.post(f"{API}/auth/login", json={"email": email, "password": "Password123!"})
    assert r.status_code == 200, r.text
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    return {
        "headers": headers,
        "member_entity": member_entity,
        "foreign_entity": foreign_entity,
    }


def _post(client, world, path, body):
    r = client.post(f"{API}{path}", json=body, headers=world["headers"])
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _account(client, world):
    return _post(client, world, "/accounts/", {
        "name": f"Acct {secrets.token_hex(3)}", "account_type": "checking", "balance": 100.0,
    })


def _make_account(client, world):
    return _account(client, world), {"name": "Renamed"}


def _make_transaction(client, world):
    return _post(client, world, "/transactions/", {
        "account_id": _account(client, world), "amount": 10.0, "transaction_type": "debit",
        "transaction_date": NOW, "description": "probe",
    }), {"description": "edited"}


def _make_category(client, world):
    return _post(client, world, "/categories/", {
        "name": f"Cat {secrets.token_hex(3)}",
    }), {"description": "edited"}


def _make_allocation(client, world):
    return _post(client, world, "/allocations/", {
        "account_id": _account(client, world), "name": f"Alloc {secrets.token_hex(3)}",
        "allocation_type": "savings", "target_amount": 100.0,
    }), {"description": "edited"}


def _make_budget_entry(client, world):
    return _post(client, world, "/budget-entries/", {
        "name": f"Entry {secrets.token_hex(3)}", "entry_type": "expense", "amount": 10.0,
        "next_occurrence": NOW,
    }), {"description": "edited"}


def _make_wishlist(client, world):
    return _post(client, world, "/wishlist/", {
        "name": f"Wish {secrets.token_hex(3)}", "estimated_cost": 50.0,
    }), {"notes": "edited"}


def _models():
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.wishlist_item import WishlistItem

    return {
        "accounts": Account, "transactions": Transaction, "categories": Category,
        "allocations": Allocation, "budget-entries": BudgetEntry, "wishlist": WishlistItem,
    }


RESOURCES = [
    ("accounts", _make_account),
    ("transactions", _make_transaction),
    ("categories", _make_category),
    ("allocations", _make_allocation),
    ("budget-entries", _make_budget_entry),
    ("wishlist", _make_wishlist),
]
IDS = [name for name, _ in RESOURCES]


def _stored_entity_id(db, resource, record_id):
    db.expire_all()
    return db.query(_models()[resource]).filter_by(id=record_id).one().entity_id


def _put(client, world, resource, record_id, body):
    return client.put(f"{API}/{resource}/{record_id}", json=body, headers=world["headers"])


@pytest.mark.parametrize("resource,factory", RESOURCES, ids=IDS)
def test_move_into_non_member_entity_is_rejected(client, db, world, resource, factory):
    record_id, _ = factory(client, world)
    assert _stored_entity_id(db, resource, record_id) is None

    r = _put(client, world, resource, record_id, {"entity_id": world["foreign_entity"]})

    assert r.status_code == 403, r.text
    assert _stored_entity_id(db, resource, record_id) is None


@pytest.mark.parametrize("resource,factory", RESOURCES, ids=IDS)
def test_move_into_member_entity_succeeds(client, db, world, resource, factory):
    record_id, _ = factory(client, world)

    r = _put(client, world, resource, record_id, {"entity_id": world["member_entity"]})

    assert r.status_code == 200, r.text
    assert _stored_entity_id(db, resource, record_id) == world["member_entity"]


@pytest.mark.parametrize("resource,factory", RESOURCES, ids=IDS)
def test_update_without_entity_id_leaves_it_unchanged(client, db, world, resource, factory):
    record_id, harmless = factory(client, world)
    r = _put(client, world, resource, record_id, {"entity_id": world["member_entity"]})
    assert r.status_code == 200, r.text

    r = _put(client, world, resource, record_id, harmless)

    assert r.status_code == 200, r.text
    assert _stored_entity_id(db, resource, record_id) == world["member_entity"]


def test_rename_in_non_member_entity_does_not_leak_name_conflicts(client, db, world):
    """A category already stored in a foreign entity must not answer duplicate-name probes."""
    from app.models.category import Category

    record_id, _ = _make_category(client, world)
    taken = f"Taken {secrets.token_hex(3)}"
    own = db.query(Category).filter_by(id=record_id).one()
    other_owner_id = own.user_id
    own.entity_id = world["foreign_entity"]
    db.add(Category(user_id=other_owner_id, entity_id=world["foreign_entity"], name=taken))
    db.commit()

    r = _put(client, world, "categories", record_id, {"name": taken})

    assert r.status_code == 403, r.text
    assert "already exists" not in r.text

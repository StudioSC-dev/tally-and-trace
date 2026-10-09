"""Integration tests: updates can only touch the caller's own records (STU-218).

STU-218 made update handlers check entity membership when ``entity_id`` changed.
Entities are gone (STU-229), so per resource:

  * an ``entity_id`` in an update body is ignored: 200, and the stored column
    (kept in the database until the expand/contract drop) stays NULL
  * another user's update gets 404 and the stored row is unchanged
  * the owner's own update succeeds

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


def _login(client, email):
    r = client.post(f"{API}/auth/login", json={"email": email, "password": "Password123!"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def world(client, db):
    """A user and another user, both logged in; everything they made is removed."""
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    user, email = _make_user(db)
    other, other_email = _make_user(db)
    yield {"headers": _login(client, email), "other_headers": _login(client, other_email),
           "user_id": user.id, "other_id": other.id}

    db.rollback()
    ids = [user.id, other.id]
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation, Category, Account):
        db.query(model).filter(model.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
    db.commit()


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


TABLES = {
    "accounts": "accounts", "transactions": "transactions", "categories": "categories",
    "allocations": "allocations", "budget-entries": "budget_entries",
    "wishlist": "wishlist_items",
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


def _stored(db, resource, record_id):
    """The raw stored row, read past the ORM (which no longer maps entity_id)."""
    db.rollback()
    row = db.execute(text(f"SELECT * FROM {TABLES[resource]} WHERE id = :id"),
                     {"id": record_id}).mappings().one()
    return dict(row)


def _put(client, headers, resource, record_id, body):
    return client.put(f"{API}/{resource}/{record_id}", json=body, headers=headers)


@pytest.mark.parametrize("resource,factory", RESOURCES, ids=IDS)
def test_an_entity_id_in_an_update_is_ignored(client, db, world, resource, factory):
    record_id, harmless = factory(client, world)

    r = _put(client, world["headers"], resource, record_id, {**harmless, "entity_id": 1})

    assert r.status_code == 200, r.text
    assert "entity_id" not in r.json()
    assert _stored(db, resource, record_id)["entity_id"] is None


@pytest.mark.parametrize("resource,factory", RESOURCES, ids=IDS)
def test_another_users_update_is_rejected(client, db, world, resource, factory):
    record_id, harmless = factory(client, world)
    before = _stored(db, resource, record_id)

    r = _put(client, world["other_headers"], resource, record_id, harmless)

    assert r.status_code == 404, r.text
    assert _stored(db, resource, record_id) == before


@pytest.mark.parametrize("resource,factory", RESOURCES, ids=IDS)
def test_the_owners_update_succeeds(client, db, world, resource, factory):
    record_id, harmless = factory(client, world)

    r = _put(client, world["headers"], resource, record_id, harmless)

    assert r.status_code == 200, r.text
    field, value = next(iter(harmless.items()))
    assert _stored(db, resource, record_id)[field] == value


def test_another_users_category_names_do_not_answer_rename_probes(client, db, world):
    """A name taken only by someone else's category neither blocks nor reveals anything."""
    from app.models.category import Category

    record_id, _ = _make_category(client, world)
    taken = f"Taken {secrets.token_hex(3)}"
    db.add(Category(user_id=world["other_id"], name=taken))
    db.commit()

    r = _put(client, world["headers"], "categories", record_id, {"name": taken})

    assert r.status_code == 200, r.text

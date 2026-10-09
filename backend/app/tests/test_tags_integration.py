"""Tags: CRUD on the caller's own tags and the Household system tag (STU-231).

A tag is its owner's alone: another user's tag id gets the same 404 as an
unknown one. Every user has one Household system tag, created at
registration, which can be recoloured but not renamed or deleted. Names are
unique per user, ignoring case. Everything goes through the HTTP layer, on
throwaway users. Skips without a database.
"""
import os
import secrets

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
PASSWORD = "Password123!"
WHEN = "2026-10-05T00:00:00"


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


def _cleanup(db, users):
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    db.rollback()
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation, Category):
        db.query(model).filter(model.user_id.in_(users)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(users)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)  # tags cascade
    db.commit()


@pytest.fixture
def people(client, db):
    """Factory for throwaway users registered through the API, then logged in."""
    from app.models.user import User
    from app.routers import auth

    users = []

    def make():
        email = f"tags-{secrets.token_hex(6)}@example.com"
        original = auth._send_verification_email
        auth._send_verification_email = lambda *_a: True  # never send real mail
        try:
            r = client.post(f"{API}/auth/register", json={
                "email": email, "password": PASSWORD, "first_name": "Tag", "last_name": "Probe"})
        finally:
            auth._send_verification_email = original
        assert r.status_code == 200, r.text
        uid = r.json()["id"]
        users.append(uid)
        db.query(User).filter(User.id == uid).update({"is_verified": True})
        db.commit()
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": uid, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    yield make
    _cleanup(db, users)


def _post(client, who, path, body, expected=(200, 201)):
    r = client.post(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code in expected, r.text
    return r.json()


def _tags(client, who):
    r = client.get(f"{API}/tags/", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _household(client, who):
    (tag,) = [t for t in _tags(client, who) if t["is_system"]]
    return tag


# --- Household system tag ------------------------------------------------------

def test_registration_creates_exactly_one_household_system_tag(client, db, people):
    from app.models.tag import Tag

    owner = people()
    tags = _tags(client, owner)
    assert [(t["name"], t["is_system"]) for t in tags] == [("Household", True)]
    assert db.query(Tag).filter(Tag.user_id == owner["id"]).count() == 1


def test_the_system_tag_cannot_be_renamed_or_deleted(client, people):
    owner = people()
    household = _household(client, owner)
    for name in ("Home", "household"):
        r = client.put(f"{API}/tags/{household['id']}", headers=owner["headers"],
                       json={"name": name})
        assert r.status_code == 400, r.text
        assert "can't be renamed or deleted" in r.json()["detail"]
    r = client.delete(f"{API}/tags/{household['id']}", headers=owner["headers"])
    assert r.status_code == 400, r.text
    assert "can't be renamed or deleted" in r.json()["detail"]
    assert _household(client, owner)["name"] == "Household"


def test_the_system_tag_can_be_recoloured_and_resubmitted_unchanged(client, people):
    owner = people()
    household = _household(client, owner)
    r = client.put(f"{API}/tags/{household['id']}", headers=owner["headers"],
                   json={"name": "Household", "color": "#16A34A"})
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["color"], r.json()["is_system"]) == (
        "Household", "#16A34A", True)


def test_a_second_system_tag_is_refused_by_the_database(db, people):
    from sqlalchemy.exc import IntegrityError

    from app.models.tag import Tag

    owner = people()
    db.add(Tag(user_id=owner["id"], name="Another system", is_system=True))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


# --- CRUD ------------------------------------------------------------------------

def test_create_list_rename_recolour_and_delete_a_tag(client, people):
    owner = people()
    created = _post(client, owner, "/tags/", {"name": "  Business  ", "color": "#2563EB"})
    assert (created["name"], created["color"], created["is_system"]) == (
        "Business", "#2563EB", False)
    assert [t["name"] for t in _tags(client, owner)] == ["Household", "Business"]

    r = client.put(f"{API}/tags/{created['id']}", headers=owner["headers"],
                   json={"name": "Studio", "color": "#DC2626"})
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["color"]) == ("Studio", "#DC2626")
    assert client.get(f"{API}/tags/{created['id']}",
                      headers=owner["headers"]).json()["name"] == "Studio"

    r = client.delete(f"{API}/tags/{created['id']}", headers=owner["headers"])
    assert r.status_code == 204, r.text
    assert [t["name"] for t in _tags(client, owner)] == ["Household"]
    assert client.get(f"{API}/tags/{created['id']}",
                      headers=owner["headers"]).status_code == 404


def test_names_are_unique_per_user_ignoring_case(client, people):
    owner, other = people(), people()
    first = _post(client, owner, "/tags/", {"name": "Business"})
    for name in ("business", "BUSINESS", " Business ", "household"):
        r = client.post(f"{API}/tags/", headers=owner["headers"], json={"name": name})
        assert r.status_code == 400, (name, r.text)
        assert r.json()["detail"] == "Tag with this name already exists"
    second = _post(client, owner, "/tags/", {"name": "Travel"})
    r = client.put(f"{API}/tags/{second['id']}", headers=owner["headers"],
                   json={"name": "BUSINESS"})
    assert r.status_code == 400, r.text
    # Renaming a tag to a new case of its own name is allowed.
    r = client.put(f"{API}/tags/{first['id']}", headers=owner["headers"],
                   json={"name": "BUSINESS"})
    assert r.status_code == 200, r.text
    # Another user may use the same name.
    _post(client, other, "/tags/", {"name": "Business"})


@pytest.mark.parametrize("body", [
    {"name": ""}, {"name": "   "}, {"name": "x" * 51}, {"name": "Ok", "color": "blue"},
])
def test_invalid_tag_bodies_are_refused(client, people, body):
    owner = people()
    r = client.post(f"{API}/tags/", headers=owner["headers"], json=body)
    assert r.status_code == 422, r.text


def test_a_null_name_on_update_is_refused(client, people):
    owner = people()
    tag = _post(client, owner, "/tags/", {"name": "Business"})
    r = client.put(f"{API}/tags/{tag['id']}", headers=owner["headers"], json={"name": None})
    assert r.status_code == 422, r.text


def test_another_users_tag_is_404_like_an_unknown_id(client, people):
    owner, stranger = people(), people()
    tag = _post(client, owner, "/tags/", {"name": "Zq7Private"})
    household = _household(client, owner)
    unknown = 2_000_000_000
    for tid in (tag["id"], household["id"], unknown):
        for method, kw in (("get", {}), ("put", {"json": {"name": "Taken"}}), ("delete", {})):
            r = getattr(client, method)(f"{API}/tags/{tid}", headers=stranger["headers"], **kw)
            assert r.status_code == 404, (tid, method, r.text)
            assert r.json() == {"detail": "Tag not found"}
    assert "Zq7Private" not in str(_tags(client, stranger))
    assert [t["name"] for t in _tags(client, owner)] == ["Household", "Zq7Private"]


def test_deleting_a_user_deletes_their_tags(db, people):
    from app.models.tag import Tag
    from app.models.user import User

    owner = people()
    assert db.query(Tag).filter(Tag.user_id == owner["id"]).count() == 1
    db.query(User).filter(User.id == owner["id"]).delete(synchronize_session=False)
    db.commit()
    assert db.query(Tag).filter(Tag.user_id == owner["id"]).count() == 0

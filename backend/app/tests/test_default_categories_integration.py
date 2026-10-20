"""Default categories: registration creates the set in its own transaction (STU-317).

Everything goes through the HTTP layer on throwaway users. Skips without a database.
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


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def no_real_mail(monkeypatch):
    from app.routers import auth

    monkeypatch.setattr(auth, "_send_verification_email", lambda *_a: True)  # never send real mail


@pytest.fixture
def db():
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def created(db):
    """User ids to delete after the test, with their categories and tags first."""
    ids = []
    yield ids
    from app.models.category import Category
    from app.models.user import User

    db.rollback()
    db.query(Category).filter(Category.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)  # tags cascade
    db.commit()


def _register(client, created):
    r = client.post(f"{API}/auth/register", json={
        "email": f"cats-{secrets.token_hex(6)}@example.com", "password": PASSWORD,
        "first_name": "Cat", "last_name": "Probe"})
    assert r.status_code == 200, r.text
    created.append(r.json()["id"])
    return r.json()["id"]


def _categories(db, user_id):
    from app.models.category import Category

    db.expire_all()
    return db.query(Category).filter(Category.user_id == user_id).all()


def test_registration_creates_exactly_the_defaults(client, db, created):
    from app.core.categories import DEFAULT_CATEGORIES

    rows = _categories(db, _register(client, created))
    assert sorted(c.name for c in rows) == sorted(d["name"] for d in DEFAULT_CATEGORIES)
    by_name = {c.name: c for c in rows}
    for d in DEFAULT_CATEGORIES:
        c = by_name[d["name"]]
        assert c.kind.value == d["kind"]
        assert c.is_expense == (d["kind"] == "expense")
        assert c.is_active is True
        assert (c.color, c.description) == (d["color"], d["description"])


def test_registration_gives_the_gifts_given_expense_beside_the_gifts_income(client, db, created):
    rows = _categories(db, _register(client, created))
    given = [c for c in rows if c.name == "Gifts & Donations"]
    assert [(c.kind.value, c.is_expense, c.is_active) for c in given] == [("expense", True, True)]
    assert (given[0].description, given[0].color) == ("Gifts and donations given", "#E599F7")
    assert [c.kind.value for c in rows if c.name == "Gifts"] == ["income"]


def test_ensure_default_categories_is_idempotent(client, db, created):
    from app.core.categories import ensure_default_categories
    from app.models.user import User

    uid = _register(client, created)
    assert ensure_default_categories(db, db.get(User, uid)) == 0
    db.commit()
    assert len(_categories(db, uid)) == 23


def test_an_existing_category_named_like_a_default_is_kept(client, db, created):
    from app.core.categories import ensure_default_categories
    from app.models.category import Category, CategoryKind
    from app.models.user import User

    uid = _register(client, created)
    db.query(Category).filter(Category.user_id == uid, Category.name == "Travel").delete()
    db.add(Category(user_id=uid, name="Travel", kind=CategoryKind.EXPENSE, is_active=False))
    db.query(Category).filter(Category.user_id == uid, Category.name == "Fitness").delete()
    db.commit()
    assert ensure_default_categories(db, db.get(User, uid)) == 1
    db.commit()
    names = [c.name for c in _categories(db, uid)]
    assert len(names) == 23 and len(set(names)) == 23


def test_a_same_name_category_of_another_kind_does_not_hide_the_default(client, db, created):
    from app.core.categories import ensure_default_categories
    from app.models.category import Category, CategoryKind
    from app.models.user import User

    uid = _register(client, created)
    db.query(Category).filter(Category.user_id == uid, Category.name == "Travel").delete()
    db.add(Category(user_id=uid, name="Travel", kind=CategoryKind.INCOME, is_expense=False))
    db.commit()
    assert ensure_default_categories(db, db.get(User, uid)) == 1
    db.commit()
    travel = sorted(c.kind.value for c in _categories(db, uid) if c.name == "Travel")
    assert travel == ["expense", "income"]


def test_a_failure_creating_the_defaults_creates_no_user(db, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.models.category import Category
    from app.models.tag import Tag
    from app.models.user import User

    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("app.routers.auth.ensure_default_categories", boom)
    email = f"cats-{secrets.token_hex(6)}@example.com"
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            r = c.post(f"{API}/auth/register", json={
                "email": email, "password": PASSWORD, "first_name": "No", "last_name": "User"})
        assert r.status_code == 500
        db.expire_all()
        assert db.query(User).filter(User.email == email).count() == 0
        assert db.query(Tag).join(User, User.id == Tag.user_id).filter(
            User.email == email).count() == 0
        assert db.query(Category).join(User, User.id == Category.user_id).filter(
            User.email == email).count() == 0
    finally:
        # If the guarantee ever breaks, don't leak a committed user.
        db.rollback()
        leaked = [u.id for u in db.query(User.id).filter(User.email == email)]
        if leaked:
            db.query(Category).filter(Category.user_id.in_(leaked)).delete(
                synchronize_session=False)
            db.query(User).filter(User.id.in_(leaked)).delete(synchronize_session=False)  # tags cascade
            db.commit()

"""Integration tests: forecast endpoints must verify entity membership (STU-216). Skips without a database.

Every /forecast handler resolves the entity through ``get_active_entity``. Without
that, a caller could pass any ``entity_id`` and read another entity's projections.
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
ENDPOINTS = ["/forecast/cashflow", "/forecast/upcoming", "/forecast/timeline", "/forecast/disposable"]
DATA_KEYS = {"periods", "items", "timeline", "monthly_income", "net_disposable"}


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

    email = f"fc-{secrets.token_hex(6)}@example.com"
    user = User(
        email=email,
        password_hash=get_password_hash("Password123!"),
        first_name="Forecast",
        last_name="Probe",
        is_verified=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user, email


def _token(client, email):
    r = client.post(f"{API}/auth/login", json={"email": email, "password": "Password123!"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def world(db):
    """An entity with one member, plus a stranger who is not a member."""
    from app.models.entity import Entity, EntityMembership, EntityType, MemberRole
    from app.models.user import User

    member, member_email = _make_user(db)
    stranger, stranger_email = _make_user(db)

    entity = Entity(name=f"Biz {secrets.token_hex(3)}", entity_type=EntityType.BUSINESS)
    db.add(entity)
    db.commit()
    db.refresh(entity)
    db.add(EntityMembership(entity_id=entity.id, user_id=member.id, role=MemberRole.OWNER))
    db.commit()

    yield {"entity_id": entity.id, "member_email": member_email, "stranger_email": stranger_email}

    db.query(EntityMembership).filter(EntityMembership.entity_id == entity.id).delete()
    db.query(Entity).filter(Entity.id == entity.id).delete()
    for uid in (member.id, stranger.id):
        db.query(User).filter(User.id == uid).delete()
    db.commit()


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("path", ENDPOINTS)
def test_non_member_query_param_is_rejected(client, world, path):
    token = _token(client, world["stranger_email"])
    r = client.get(f"{API}{path}", headers=_auth(token), params={"entity_id": world["entity_id"]})
    assert r.status_code in (403, 404), r.text
    assert not (DATA_KEYS & set(r.json())), r.text


@pytest.mark.parametrize("path", ENDPOINTS)
def test_non_member_header_is_rejected(client, world, path):
    token = _token(client, world["stranger_email"])
    headers = {**_auth(token), "X-Entity-Id": str(world["entity_id"])}
    r = client.get(f"{API}{path}", headers=headers)
    assert r.status_code in (403, 404), r.text
    assert not (DATA_KEYS & set(r.json())), r.text


@pytest.mark.parametrize("path", ENDPOINTS)
def test_member_gets_200(client, world, path):
    token = _token(client, world["member_email"])
    r = client.get(f"{API}{path}", headers=_auth(token), params={"entity_id": world["entity_id"]})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("path", ENDPOINTS)
def test_no_entity_gets_200(client, world, path):
    token = _token(client, world["stranger_email"])
    r = client.get(f"{API}{path}", headers=_auth(token))
    assert r.status_code == 200, r.text

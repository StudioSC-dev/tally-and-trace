"""Integration tests for entity-membership shared visibility. Skips without a database.

The rule under test (see entity_context.scope_criterion / can_access_record):

  * Two members of the same entity see each other's records in that entity.
  * A non-member gets 404 (not 403 -- a 403 would confirm the id exists).
  * Records with no entity_id (personal / pre-entity data) stay owner-only, even
    with an entity header set.

Everything goes through the HTTP layer with the X-Entity-Id header, because that
is where the resolve-then-scope path actually runs.
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


def _make_user(db, verified=True):
    from app.core.auth import get_password_hash
    from app.models.user import User

    email = f"share-{secrets.token_hex(6)}@example.com"
    user = User(
        email=email,
        password_hash=get_password_hash("Password123!"),
        first_name="Share",
        last_name="Probe",
        is_verified=verified,
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
def shared_entity(db):
    """A business entity with two members (owner + member) and one stranger.

    Yields the two logins, the stranger login, the entity id, and an account the
    owner created *inside* the entity.
    """
    from app.models.account import Account, AccountType
    from app.models.entity import Entity, EntityMembership, EntityType, MemberRole

    owner, owner_email = _make_user(db)
    member, member_email = _make_user(db)
    stranger, stranger_email = _make_user(db)

    entity = Entity(name=f"Biz {secrets.token_hex(3)}", entity_type=EntityType.BUSINESS)
    db.add(entity)
    db.commit()
    db.refresh(entity)

    db.add_all([
        EntityMembership(entity_id=entity.id, user_id=owner.id, role=MemberRole.OWNER),
        EntityMembership(entity_id=entity.id, user_id=member.id, role=MemberRole.MEMBER),
    ])
    db.commit()

    # An account the OWNER created inside the shared entity.
    from decimal import Decimal
    acct = Account(
        user_id=owner.id, entity_id=entity.id, name="Shared Biz Checking",
        account_type=AccountType.CHECKING, balance=Decimal("1000.00"),
    )
    db.add(acct)
    db.commit()
    db.refresh(acct)

    ids = {
        "entity_id": entity.id,
        "owner_email": owner_email,
        "member_email": member_email,
        "stranger_email": stranger_email,
        "account_id": acct.id,
        "owner_id": owner.id,
        "member_id": member.id,
        "stranger_id": stranger.id,
    }
    yield ids

    db.query(Account).filter(Account.user_id.in_([owner.id, member.id, stranger.id])).delete()
    db.query(EntityMembership).filter(EntityMembership.entity_id == entity.id).delete()
    db.query(Entity).filter(Entity.id == entity.id).delete()
    for uid in (owner.id, member.id, stranger.id):
        from app.models.user import User
        db.query(User).filter(User.id == uid).delete()
    db.commit()


def _headers(token, entity_id=None):
    h = {"Authorization": f"Bearer {token}"}
    if entity_id is not None:
        h["X-Entity-Id"] = str(entity_id)
    return h


def test_co_member_sees_owners_account_in_shared_entity(client, shared_entity):
    member_token = _token(client, shared_entity["member_email"])
    r = client.get(
        f"{API}/accounts/",
        headers=_headers(member_token, shared_entity["entity_id"]),
        params={"limit": 1000},
    )
    assert r.status_code == 200, r.text
    names = [a["name"] for a in r.json()["items"]]
    assert "Shared Biz Checking" in names


def test_co_member_can_fetch_the_record_directly(client, shared_entity):
    member_token = _token(client, shared_entity["member_email"])
    r = client.get(
        f"{API}/accounts/{shared_entity['account_id']}",
        headers=_headers(member_token, shared_entity["entity_id"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Shared Biz Checking"


def test_non_member_is_denied_the_entity_header(client, shared_entity):
    """A stranger supplying the entity id is rejected at resolution (403)."""
    stranger_token = _token(client, shared_entity["stranger_email"])
    r = client.get(
        f"{API}/accounts/",
        headers=_headers(stranger_token, shared_entity["entity_id"]),
        params={"limit": 1000},
    )
    assert r.status_code == 403, r.text


def test_non_member_cannot_fetch_the_record_even_without_the_header(client, shared_entity):
    """404, not 403: don't confirm the id exists to someone with no access."""
    stranger_token = _token(client, shared_entity["stranger_email"])
    r = client.get(
        f"{API}/accounts/{shared_entity['account_id']}",
        headers=_headers(stranger_token),
    )
    assert r.status_code == 404, r.text


def test_personal_record_stays_private_to_its_owner(client, db, shared_entity):
    """A null-entity account is never visible to a co-member, even in entity context."""
    from decimal import Decimal
    from app.models.account import Account, AccountType
    from app.models.user import User

    owner = db.query(User).filter(User.id == shared_entity["owner_id"]).first()
    personal = Account(
        user_id=owner.id, entity_id=None, name="Owner Personal Wallet",
        account_type=AccountType.CASH, balance=Decimal("50.00"),
    )
    db.add(personal)
    db.commit()

    member_token = _token(client, shared_entity["member_email"])
    # Even with the entity header, a null-entity record must not appear.
    listing = client.get(
        f"{API}/accounts/",
        headers=_headers(member_token, shared_entity["entity_id"]),
        params={"limit": 1000},
    ).json()["items"]
    assert "Owner Personal Wallet" not in [a["name"] for a in listing]

    direct = client.get(
        f"{API}/accounts/{personal.id}",
        headers=_headers(member_token, shared_entity["entity_id"]),
    )
    assert direct.status_code == 404, direct.text


def test_member_created_record_is_visible_to_the_owner(client, db, shared_entity):
    """Sharing is symmetric: a record the MEMBER creates is visible to the owner."""
    member_token = _token(client, shared_entity["member_email"])
    created = client.post(
        f"{API}/accounts/",
        headers=_headers(member_token, shared_entity["entity_id"]),
        json={"name": "Member Added Account", "account_type": "savings", "balance": 10},
    )
    assert created.status_code == 200, created.text

    owner_token = _token(client, shared_entity["owner_email"])
    listing = client.get(
        f"{API}/accounts/",
        headers=_headers(owner_token, shared_entity["entity_id"]),
        params={"limit": 1000},
    ).json()["items"]
    assert "Member Added Account" in [a["name"] for a in listing]

"""Integration tests for the email-token (verify/reset) expiry paths. Skips without a database.

These paths had **no coverage at all** until Session 14, which is how the bug they
now pin went unnoticed: ``email_tokens.expires_at`` is ``TIMESTAMP WITH TIME ZONE``,
so psycopg2 returns it timezone-AWARE, and the old code compared it against a naive
``datetime.utcnow()``. That raises ``TypeError: can't compare offset-naive and
offset-aware datetimes`` -> a 500 on every call to /auth/verify-email and
/auth/reset-password. Since login requires ``is_verified``, no newly registered user
could ever log in.

The assertions below deliberately go through the HTTP layer: the bug was invisible
at the unit level and only bites once a real timestamptz round-trips through psycopg2.
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


@pytest.fixture
def unverified_user(db):
    """A freshly registered, unverified user; cleaned up afterwards."""
    from app.core.auth import get_password_hash
    from app.models.email_token import EmailToken
    from app.models.user import User

    email = f"tz-probe-{secrets.token_hex(6)}@example.com"
    user = User(
        email=email,
        password_hash=get_password_hash("password123"),
        first_name="TZ",
        last_name="Probe",
        is_verified=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    yield user

    db.query(EmailToken).filter(EmailToken.user_id == user.id).delete()
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


def _issue_token(db, user, token_type, hours):
    """Mint an email token expiring `hours` from now (negative = already expired)."""
    from datetime import timedelta

    from app.core.time import utc_now
    from app.models.email_token import EmailToken

    value = secrets.token_urlsafe(32)
    db.add(
        EmailToken(
            user_id=user.id,
            token=value,
            token_type=token_type,
            expires_at=utc_now() + timedelta(hours=hours),
        )
    )
    db.commit()
    return value


def test_verify_email_accepts_a_valid_token(client, db, unverified_user):
    """The regression: this returned 500 (TypeError), not 200."""
    from app.models.email_token import EmailTokenType
    from app.models.user import User

    token = _issue_token(db, unverified_user, EmailTokenType.VERIFY_EMAIL, hours=48)

    resp = client.post(f"{API}/auth/verify-email", json={"token": token})
    assert resp.status_code == 200, resp.text

    db.expire_all()
    assert db.query(User).filter(User.id == unverified_user.id).first().is_verified is True


def test_verify_email_rejects_an_expired_token(client, db, unverified_user):
    """Expiry must still be enforced -- 400, and never a 500."""
    from app.models.email_token import EmailTokenType

    token = _issue_token(db, unverified_user, EmailTokenType.VERIFY_EMAIL, hours=-1)

    resp = client.post(f"{API}/auth/verify-email", json={"token": token})
    assert resp.status_code == 400, resp.text
    assert "expired" in resp.text.lower()


def test_registered_user_can_verify_then_log_in(client, db, unverified_user):
    """End-to-end proof of the user-visible impact: login requires is_verified."""
    from app.models.email_token import EmailTokenType

    creds = {"email": unverified_user.email, "password": "password123"}
    assert client.post(f"{API}/auth/login", json=creds).status_code == 400  # not verified yet

    token = _issue_token(db, unverified_user, EmailTokenType.VERIFY_EMAIL, hours=48)
    assert client.post(f"{API}/auth/verify-email", json={"token": token}).status_code == 200

    login = client.post(f"{API}/auth/login", json=creds)
    assert login.status_code == 200, login.text
    assert login.json()["access_token"]


def test_password_reset_accepts_a_valid_token(client, db, unverified_user):
    """The same TypeError sat on the reset path."""
    from app.core.auth import verify_password
    from app.models.email_token import EmailTokenType
    from app.models.user import User

    token = _issue_token(db, unverified_user, EmailTokenType.RESET_PASSWORD, hours=4)

    resp = client.post(
        f"{API}/auth/reset-password",
        json={"token": token, "new_password": "BrandNewPassword456!"},
    )
    assert resp.status_code == 200, resp.text

    db.expire_all()
    user = db.query(User).filter(User.id == unverified_user.id).first()
    assert verify_password("BrandNewPassword456!", user.password_hash)


def test_password_reset_rejects_an_expired_token(client, db, unverified_user):
    from app.models.email_token import EmailTokenType

    token = _issue_token(db, unverified_user, EmailTokenType.RESET_PASSWORD, hours=-1)

    resp = client.post(
        f"{API}/auth/reset-password",
        json={"token": token, "new_password": "BrandNewPassword456!"},
    )
    assert resp.status_code == 400, resp.text

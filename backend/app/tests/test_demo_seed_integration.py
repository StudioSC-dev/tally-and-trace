"""The demo seed is replaced by shape version, and only for the demo user (STU-229).

On startup ``seed_database`` compares the one-row ``demo_state`` table with
``DEMO_SHAPE_VERSION``: a missing row or another version replaces the demo
user's data; otherwise nothing changes and every id stays the same. Only the
user with the fixed demo email is touched, and a failure logs at error level
and leaves the database as it was. Skips without a database.
"""
import json
import logging
import os
import secrets
from decimal import Decimal

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

    with TestClient(app) as c:  # the lifespan runs the seed
        yield c


@pytest.fixture
def db(client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def seed(monkeypatch):
    """The seed module; any shape bump is undone and the demo restored afterwards."""
    from app.core import seed as module

    yield module
    monkeypatch.undo()
    module.seed_database()


def _snapshot(db):
    """The demo user's id, state row and the ids of everything it owns."""
    from app.core.seed import DEMO_EMAIL
    from app.models import Account, Allocation, BudgetEntry, Category, Transaction, User
    from app.models.demo_state import DemoState

    db.expire_all()
    user = db.query(User).filter(User.email == DEMO_EMAIL).one()
    state = db.get(DemoState, 1)
    owned = {
        model.__tablename__: sorted(
            r.id for r in db.query(model).filter(model.user_id == user.id))
        for model in (Account, Category, Allocation, BudgetEntry, Transaction)
    }
    return {
        "user": user.id,
        "state": (state.shape_version, state.seeded_at) if state else None,
        "owned": owned,
    }


def _seed_counts():
    from app.core.seed import _SEED_FILE

    with open(_SEED_FILE) as f:
        data = json.load(f)
    return {
        "accounts": len(data["accounts"]), "categories": len(data["categories"]),
        "allocations": len(data["allocations"]),
        "budget_entries": len(data.get("budget_entries", [])),
        "transactions": len(data["transactions"]),
    }


def _demo_account(db, user_id):
    from app.models import Account

    return db.query(Account).filter(Account.user_id == user_id).order_by(Account.id).first()


def test_startup_seeds_the_current_shape_and_the_demo_can_log_in(client, db, seed):
    from app.core.seed import DEMO_EMAIL, DEMO_PASSWORD, DEMO_SHAPE_VERSION

    snap = _snapshot(db)
    assert snap["state"][0] == DEMO_SHAPE_VERSION
    assert snap["owned"]["accounts"]  # other tests may add to the demo, so no exact counts
    r = client.post(f"{API}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text


def test_a_repeated_startup_changes_nothing(db, seed):
    before = _snapshot(db)
    seed.seed_database()
    seed.seed_database()
    assert _snapshot(db) == before


def test_visitor_edits_survive_a_startup_with_the_same_shape(db, seed):
    account = _demo_account(db, _snapshot(db)["user"])
    account.name = "Edited by a visitor"
    db.commit()
    seed.seed_database()
    db.expire_all()
    assert _demo_account(db, account.user_id).name == "Edited by a visitor"


def test_a_shape_bump_replaces_the_demo_data(db, seed, monkeypatch):
    before = _snapshot(db)
    account = _demo_account(db, before["user"])
    account.name = "Edited by a visitor"
    db.commit()

    monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
    seed.seed_database()

    after = _snapshot(db)
    assert after["user"] == before["user"]  # the user row is kept
    assert after["state"][0] == before["state"][0] + 1
    assert {table: len(ids) for table, ids in after["owned"].items()} == _seed_counts()
    for table, ids in before["owned"].items():
        assert not set(ids) & set(after["owned"][table]), table
    assert "Edited by a visitor" not in [
        a.name for a in db.query(type(account)).filter(type(account).user_id == after["user"])]


def test_a_missing_state_row_replaces_the_demo_data(db, seed):
    from app.models.demo_state import DemoState

    before = _snapshot(db)
    db.query(DemoState).delete()
    db.commit()

    seed.seed_database()

    after = _snapshot(db)
    assert after["state"][0] == seed.DEMO_SHAPE_VERSION
    assert after["user"] == before["user"]
    assert not set(before["owned"]["accounts"]) & set(after["owned"]["accounts"])
    assert {table: len(ids) for table, ids in after["owned"].items()} == _seed_counts()


def test_a_reseed_never_touches_another_user(db, seed, monkeypatch):
    from app.core.auth import get_password_hash
    from app.models import Account, User
    from app.models.account import AccountType

    other = User(email=f"not-demo-{secrets.token_hex(6)}@example.com",
                 password_hash=get_password_hash("Password123!"),
                 first_name="Not", last_name="Demo", is_verified=True)
    db.add(other)
    db.commit()
    bank = Account(user_id=other.id, name="Mine", account_type=AccountType.CHECKING,
                   balance=Decimal("10.00"))
    db.add(bank)
    db.commit()
    try:
        monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
        seed.seed_database()
        db.expire_all()
        assert [(a.id, a.name) for a in db.query(Account).filter(Account.user_id == other.id)] == [
            (bank.id, "Mine")]
        assert db.get(User, other.id).email == other.email
    finally:
        db.rollback()
        db.query(Account).filter(Account.user_id == other.id).delete()
        db.query(User).filter(User.id == other.id).delete()
        db.commit()


def test_a_failed_reseed_logs_an_error_and_changes_nothing(db, seed, monkeypatch, caplog):
    before = _snapshot(db)

    def boom(*_args):
        raise RuntimeError("seed data is broken")

    monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
    monkeypatch.setattr(seed, "_load_seed_data", boom)
    with caplog.at_level(logging.ERROR, logger="app.core.seed"):
        seed.seed_database()  # never raises: startup must go on

    errors = [r for r in caplog.records if r.name == "app.core.seed" and r.levelno == logging.ERROR]
    assert errors and "seed data is broken" in (errors[0].exc_text or str(errors[0].exc_info))
    assert _snapshot(db) == before


def test_concurrent_startups_seed_once(db, seed, monkeypatch, caplog):
    """Two workers starting together after a shape bump: one reseeds, the other waits
    on the advisory lock and then finds the demo current."""
    import threading
    import time

    from app.core.database import engine

    monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
    caplog.set_level(logging.INFO, logger=seed.logger.name)
    workers = [threading.Thread(target=seed.seed_database) for _ in range(2)]
    with engine.connect() as holder:
        # Hold the seed lock so both workers are queued on it before either runs.
        holder.execute(text("SELECT pg_advisory_lock(:k)"), {"k": seed._LOCK_KEY})
        for w in workers:
            w.start()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            waiting = holder.execute(text(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
                " AND objid = :k AND database = (SELECT oid FROM pg_database"
                " WHERE datname = current_database())"), {"k": seed._LOCK_KEY}).scalar()
            if waiting >= 2:
                break
            time.sleep(0.05)
        assert waiting >= 2, "both workers should be waiting on the seed lock"
        holder.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": seed._LOCK_KEY})
        holder.commit()
    for w in workers:
        w.join(timeout=60)
        assert not w.is_alive()

    messages = [r.getMessage() for r in caplog.records]
    assert sum("replaced the demo user's data" in m for m in messages) == 1, messages
    assert sum("nothing to do" in m for m in messages) == 1, messages
    after = _snapshot(db)
    assert after["state"][0] == seed.DEMO_SHAPE_VERSION
    assert {table: len(ids) for table, ids in after["owned"].items()} == _seed_counts()

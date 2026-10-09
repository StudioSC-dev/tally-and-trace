"""The demo seed is replaced by shape version, and only for the demo user (STU-229).

On startup ``seed_database`` compares the one-row ``demo_state`` table with
``DEMO_SHAPE_VERSION``: a missing row or another version replaces the demo
user's data; otherwise nothing changes and every id stays the same. Only the
user with the fixed demo email is touched, and a failure logs at error level
and leaves the database as it was. Shape 2 (STU-231) tags the demo: Household
and Business on the records the seed file names. Shape 3 (STU-232) adds the
Demo Partner, the owner's Joint Account shared with them as editor, household
bills on the joint account and the owner's card, and the partner's deposit.
Skips without a database.
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
    """The demo user's id, state row and the ids of everything it owns, tag links included."""
    from app.core.seed import DEMO_EMAIL
    from app.core.tags import LINKS
    from app.models import Account, Allocation, BudgetEntry, Category, Tag, Transaction, User
    from app.models.demo_state import DemoState

    db.expire_all()
    user = db.query(User).filter(User.email == DEMO_EMAIL).one()
    state = db.get(DemoState, 1)
    owned = {
        model.__tablename__: sorted(
            r.id for r in db.query(model).filter(model.user_id == user.id))
        for model in (Account, Category, Allocation, BudgetEntry, Transaction)
    }
    tags = {t.name: t.id for t in db.query(Tag).filter(Tag.user_id == user.id)}
    links = {
        table.name: sorted(tuple(row) for row in db.execute(
            table.select().where(table.c.tag_id.in_(list(tags.values())))))
        for table, _column in LINKS.values()
    }
    return {
        "user": user.id,
        "state": (state.shape_version, state.seeded_at) if state else None,
        "owned": owned,
        "tags": tags,
        "links": links,
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


def _seed_tag_names():
    """The demo user's tags after a reseed: the Household system tag and the seed's."""
    from app.core.seed import _SEED_FILE

    with open(_SEED_FILE) as f:
        data = json.load(f)
    return {"Household", *(t["name"] for t in data.get("tags", []))}


def _seed_link_counts():
    """How many records the seed file tags, per link table."""
    from app.core.seed import _SEED_FILE

    with open(_SEED_FILE) as f:
        data = json.load(f)
    return {
        link: sum(len(r.get("tags", [])) for r in data.get(key, []))
        for link, key in (("account_tags", "accounts"), ("budget_entry_tags", "budget_entries"),
                          ("transaction_tags", "transactions"))
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
    assert set(after["tags"]) == _seed_tag_names()
    assert {link: len(rows) for link, rows in after["links"].items()} == _seed_link_counts()
    assert after["tags"]["Household"] == before["tags"]["Household"]  # kept, like the user
    for name in set(before["tags"]) - {"Household"}:
        assert before["tags"][name] not in after["tags"].values(), name
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
    assert set(after["tags"]) == _seed_tag_names()
    assert {link: len(rows) for link, rows in after["links"].items()} == _seed_link_counts()


def test_shape_2_tags_the_demo_records_the_seed_names(client, db, seed):
    from app.core.seed import DEMO_EMAIL, DEMO_PASSWORD, DEMO_SHAPE_VERSION

    assert DEMO_SHAPE_VERSION == 3  # shape 3 (STU-232) keeps shape 2's tags
    seed.seed_database()
    r = client.post(f"{API}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    tags = {t["name"]: t for t in client.get(f"{API}/tags/", headers=headers).json()}
    assert (tags["Household"]["is_system"], tags["Business"]["is_system"]) == (True, False)

    def tagged(path, field, name):
        rows = client.get(f"{API}{path}", headers=headers, params={"limit": 100}).json()["items"]
        return sorted(r[field] for r in rows if name in [t["name"] for t in r["tags"]])

    assert tagged("/transactions/", "description", "Business") == [
        "Gas station fill-up", "Online purchase - Amazon"]
    assert tagged("/transactions/", "description", "Household") == [
        "Grocery shopping at Whole Foods", "Household groceries",
        "Projected September electric bill", "Water bill"]
    assert tagged("/budget-entries/", "name", "Household") == [
        "Electric Bill", "Internet", "Rent"]
    assert tagged("/accounts/", "name", "Household") == ["Cash Wallet", "Joint Account"]
    # The Cash Wallet's Household tag reaches the cash it receives.
    household = client.get(f"{API}/transactions/", headers=headers,
                           params={"tag": tags["Household"]["id"], "limit": 100}).json()
    assert "ATM withdrawal for weekend cash" in [t["description"] for t in household["items"]]


def test_the_demo_user_has_its_household_tag_and_a_reseed_drops_visitor_tags(
        client, db, seed, monkeypatch):
    from app.core.seed import DEMO_EMAIL, DEMO_PASSWORD

    r = client.post(f"{API}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    tags = client.get(f"{API}/tags/", headers=headers).json()
    assert [t["name"] for t in tags if t["is_system"]] == ["Household"]
    r = client.post(f"{API}/tags/", headers=headers, json={"name": "Added by a visitor"})
    assert r.status_code == 201, r.text
    before = _snapshot(db)

    monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
    seed.seed_database()

    after = _snapshot(db)
    assert "Added by a visitor" not in after["tags"]
    assert after["tags"]["Household"] == before["tags"]["Household"]
    assert set(after["tags"]) == _seed_tag_names()


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


# --- Shape 3: the Demo Partner (STU-232) -----------------------------------------------

def _login(client, email):
    from app.core.seed import DEMO_PASSWORD

    r = client.post(f"{API}/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _partner_snapshot(db):
    """The Demo Partner's id, accounts, transactions and the shares they hold."""
    from app.core.seed import DEMO_PARTNER_EMAIL
    from app.models import Account, Transaction, User
    from app.models.account_share import AccountShare

    db.expire_all()
    partner = db.query(User).filter(User.email == DEMO_PARTNER_EMAIL).one()
    return {
        "user": partner.id,
        "accounts": sorted(a.id for a in db.query(Account).filter(Account.user_id == partner.id)),
        "transactions": sorted(
            t.id for t in db.query(Transaction).filter(Transaction.user_id == partner.id)),
        "shares": sorted((s.id, s.account_id, s.role) for s in db.query(AccountShare).filter(
            AccountShare.user_id == partner.id)),
    }


def test_shape_3_shares_the_joint_account_with_the_demo_partner(client, db, seed):
    from app.core.seed import DEMO_EMAIL, DEMO_PARTNER_EMAIL

    seed.seed_database()
    owner, partner = _login(client, DEMO_EMAIL), _login(client, DEMO_PARTNER_EMAIL)
    accounts = {a["name"]: a for a in client.get(
        f"{API}/accounts/", headers=partner, params={"limit": 100}).json()["items"]}
    assert set(accounts) == {"Partner Checking", "Joint Account"}
    joint = accounts["Joint Account"]
    assert (joint["my_role"], joint["owner_name"]) == ("editor", "Demo U.")
    assert joint["permissions"] == {"can_edit_settings": False, "can_manage_shares": False,
                                    "can_add_transactions": True}
    assert accounts["Partner Checking"]["my_role"] == "owner"

    def rows(headers, path):
        return client.get(f"{API}{path}", headers=headers, params={"limit": 100}).json()["items"]

    mine = {t.get("description") or t.get("display_description"): t
            for t in rows(partner, "/transactions/")}
    deposit = mine["Deposit to the joint account"]
    assert (deposit["view"], deposit["amount"]) == ("full", 1500.0)
    assert deposit["transfer_to_account_id"] == joint["id"]
    assert mine["Water bill"]["view"] == "shared_full"
    assert "Household groceries" not in mine  # on the owner's private card
    assert "Rent" in [e.get("name") for e in rows(partner, "/budget-entries/")]
    assert "Internet" not in [e.get("name") or e.get("display_name")
                              for e in rows(partner, "/budget-entries/")]
    # The owner sees the deposit limited: the partner's account is not shared with them.
    theirs = {t["id"]: t for t in rows(owner, "/transactions/")}
    seen = theirs[deposit["id"]]
    assert (seen["view"], seen["display_description"], seen["created_by"]) == (
        "limited", "Transfer", "Demo P.")
    assert seen["account"] == {"id": None, "name": "Other account"}
    assert seen["counterpart"] == {"id": joint["id"], "name": "Joint Account"}


def test_the_demo_partner_logs_in_and_cannot_share(client, db, seed):
    from app.core.seed import DEMO_PARTNER_EMAIL

    partner = _login(client, DEMO_PARTNER_EMAIL)
    me = client.get(f"{API}/auth/me", headers=partner).json()
    assert (me["first_name"], me["last_name"]) == ("Demo", "Partner")
    for path in ("/users/lookup?email=demo@example.com", "/shares/received"):
        assert client.get(f"{API}{path}", headers=partner).status_code == 403, path


def test_a_repeated_startup_keeps_the_demo_partner_as_it_is(db, seed):
    before = (_snapshot(db), _partner_snapshot(db))
    seed.seed_database()
    seed.seed_database()
    assert (_snapshot(db), _partner_snapshot(db)) == before
    assert before[1]["accounts"] and before[1]["transactions"] and before[1]["shares"]


def test_a_shape_bump_replaces_the_demo_partners_data(db, seed, monkeypatch):
    before, owner_before = _partner_snapshot(db), _snapshot(db)
    monkeypatch.setattr(seed, "DEMO_SHAPE_VERSION", seed.DEMO_SHAPE_VERSION + 1)
    seed.seed_database()
    after, owner_after = _partner_snapshot(db), _snapshot(db)
    assert after["user"] == before["user"]
    assert len(after["accounts"]) == len(before["accounts"]) == 1
    assert not set(after["accounts"]) & set(before["accounts"])
    assert not set(after["transactions"]) & set(before["transactions"])
    assert len(after["transactions"]) == 1
    [(_, account_id, role)] = after["shares"]
    assert role == "editor" and account_id in owner_after["owned"]["accounts"]
    assert account_id not in owner_before["owned"]["accounts"]


def test_a_missing_state_row_replaces_the_demo_partners_data(db, seed):
    from app.models.demo_state import DemoState

    before = _partner_snapshot(db)
    db.query(DemoState).delete()
    db.commit()
    seed.seed_database()
    after = _partner_snapshot(db)
    assert after["user"] == before["user"]
    assert not set(after["accounts"]) & set(before["accounts"])
    assert len(after["shares"]) == 1


def test_a_missing_demo_partner_is_recreated(client, db, seed):
    from app.core.seed import DEMO_PARTNER_EMAIL
    from app.models import User
    from app.models.account_share import AccountShare

    partner = _partner_snapshot(db)
    seed._delete_demo_data(db, [db.get(User, partner["user"])])
    db.query(AccountShare).filter(AccountShare.user_id == partner["user"]).delete()
    db.query(User).filter(User.id == partner["user"]).delete()
    db.commit()
    seed.seed_database()
    after = _partner_snapshot(db)
    assert after["user"] != partner["user"] and len(after["shares"]) == 1
    _login(client, DEMO_PARTNER_EMAIL)

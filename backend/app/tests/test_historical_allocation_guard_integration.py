"""Historical transactions must not disturb the active budget period. Skips without a database.

A budget allocation tracks a single active period (``period_start`` .. ``period_end``)
and ``current_amount`` is what has been spent inside it. Loading or editing rows dated
before ``period_start`` (e.g. September rows imported while October is active) must
leave the period dates and the spent total alone; only deltas dated inside the active
period count.
"""
import os
from datetime import datetime
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

OCT_START = datetime(2026, 10, 1)
NOV_START = datetime(2026, 11, 1)
SEPT_DAY = datetime(2026, 9, 15, 12, 0)
OCT_DAY = datetime(2026, 10, 5, 12, 0)
OCT_SPENT = Decimal("500.00")


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


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def october(client, db):
    """Two October budgets with spending: one linked explicitly, one by category auto-match."""
    from app.models.allocation import Allocation, AllocationType, BudgetPeriodFrequency
    from app.models.category import Category
    from app.models.user import User

    headers = _auth(client)
    user = db.query(User).filter(User.email == "demo@example.com").one()
    accounts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()["items"]
    funding = next(a for a in accounts if a["account_type"] != "credit")

    category = Category(user_id=user.id, name="Historical guard groceries")
    db.add(category)
    db.flush()

    def _budget(name, config):
        allocation = Allocation(
            user_id=user.id,
            account_id=funding["id"],
            name=name,
            allocation_type=AllocationType.BUDGET,
            current_amount=OCT_SPENT,
            target_amount=Decimal("5000.00"),
            period_frequency=BudgetPeriodFrequency.MONTHLY,
            period_start=OCT_START,
            period_end=NOV_START,
            configuration=config,
        )
        db.add(allocation)
        return allocation

    explicit = _budget("Historical guard explicit", None)
    matched = _budget("Historical guard matched", {"category_ids": [category.id]})
    db.commit()

    ctx = {
        "headers": headers,
        "account_id": funding["id"],
        "category_id": category.id,
        "explicit_id": explicit.id,
        "matched_id": matched.id,
        "txn_ids": [],
    }
    yield ctx

    for txn_id in ctx["txn_ids"]:
        client.delete(f"{API}/transactions/{txn_id}", headers=headers)
    db.query(Allocation).filter(Allocation.id.in_([explicit.id, matched.id])).delete(synchronize_session=False)
    db.query(Category).filter(Category.id == category.id).delete(synchronize_session=False)
    db.commit()


def _charge(client, ctx, when, amount=120.0):
    resp = client.post(
        f"{API}/transactions/",
        json={
            "account_id": ctx["account_id"],
            "category_id": ctx["category_id"],
            "allocation_id": ctx["explicit_id"],
            "amount": amount,
            "transaction_type": "debit",
            "description": "historical guard charge",
            "transaction_date": when.isoformat(),
        },
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    txn_id = resp.json()["id"]
    ctx["txn_ids"].append(txn_id)
    return txn_id


def _state(db, ctx):
    from app.models.allocation import Allocation

    db.expire_all()
    rows = db.query(Allocation).filter(Allocation.id.in_([ctx["explicit_id"], ctx["matched_id"]])).all()
    return {r.id: (r.period_start, r.period_end, Decimal(r.current_amount)) for r in rows}


def _assert_october(db, ctx, spent):
    expected = (OCT_START, NOV_START, spent)
    state = _state(db, ctx)
    assert state[ctx["explicit_id"]] == expected
    assert state[ctx["matched_id"]] == expected


def test_creating_a_september_charge_leaves_october_alone(client, db, october):
    _charge(client, october, SEPT_DAY)
    _assert_october(db, october, OCT_SPENT)


def test_editing_a_september_charge_leaves_october_alone(client, db, october):
    txn_id = _charge(client, october, SEPT_DAY)
    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"amount": 340.0, "transaction_date": datetime(2026, 9, 20, 12, 0).isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT)


def test_deleting_a_september_charge_leaves_october_alone(client, db, october):
    txn_id = _charge(client, october, SEPT_DAY)
    resp = client.delete(f"{API}/transactions/{txn_id}", headers=october["headers"])
    assert resp.status_code == 200, resp.text
    october["txn_ids"].remove(txn_id)
    _assert_october(db, october, OCT_SPENT)


def test_moving_a_september_charge_into_october_adds_it(client, db, october):
    """Into the active period: nothing to reverse (it never counted), the new delta counts."""
    txn_id = _charge(client, october, SEPT_DAY)
    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"transaction_date": OCT_DAY.isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT + Decimal("120.00"))


def test_moving_an_october_charge_into_september_removes_it(client, db, october):
    """Out of the active period: the October delta is reversed, the September one is excluded."""
    txn_id = _charge(client, october, OCT_DAY)
    _assert_october(db, october, OCT_SPENT + Decimal("120.00"))
    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"transaction_date": SEPT_DAY.isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT)


def test_october_charges_still_count(client, db, october):
    """Control: in-period create/delete keep working."""
    txn_id = _charge(client, october, OCT_DAY, amount=80.0)
    _assert_october(db, october, OCT_SPENT + Decimal("80.00"))
    resp = client.delete(f"{API}/transactions/{txn_id}", headers=october["headers"])
    assert resp.status_code == 200, resp.text
    october["txn_ids"].remove(txn_id)
    _assert_october(db, october, OCT_SPENT)


NOV_DAY = datetime(2026, 11, 10, 12, 0)
DEC_START = datetime(2026, 12, 1)


@pytest.fixture
def now_is(monkeypatch):
    """Pin the clock the period helpers compare against (naive UTC)."""
    import app.routers.transactions as transactions_module

    def _set(value):
        monkeypatch.setattr(transactions_module, "naive_utc_now", lambda: value)

    _set(datetime(2026, 10, 7, 9, 0))
    return _set


def test_a_november_charge_while_october_is_current_leaves_october_alone(client, db, october, now_is):
    """Future-dated rows are out of period: no roll-forward, no reset, no delta."""
    txn_id = _charge(client, october, NOV_DAY)
    _assert_october(db, october, OCT_SPENT)

    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"amount": 340.0, "transaction_date": datetime(2026, 11, 12, 12, 0).isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT)

    resp = client.delete(f"{API}/transactions/{txn_id}", headers=october["headers"])
    assert resp.status_code == 200, resp.text
    october["txn_ids"].remove(txn_id)
    _assert_october(db, october, OCT_SPENT)


def test_october_charges_still_count_after_a_november_row(client, db, october, now_is):
    _charge(client, october, NOV_DAY)
    _charge(client, october, OCT_DAY, amount=80.0)
    _assert_october(db, october, OCT_SPENT + Decimal("80.00"))


def test_a_november_charge_rolls_the_period_once_november_is_current(client, db, october, now_is):
    now_is(datetime(2026, 11, 3, 9, 0))
    _charge(client, october, NOV_DAY)
    state = _state(db, october)
    expected = (NOV_START, DEC_START, Decimal("120.00"))
    assert state[october["explicit_id"]] == expected
    assert state[october["matched_id"]] == expected

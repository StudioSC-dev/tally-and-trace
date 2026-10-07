"""Integration tests for installment "n of m" progress. Skips without a database.

`m` is `max_occurrences`; `n` is derived from the transactions materialisation links
back to the entry, because the elapsed count is never stored (see
`_attach_occurrence_counts`).
"""
import os
from datetime import datetime, timedelta

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


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def installment(client, db):
    """A 6-payment installment, the 'bellroy 4:6' shape from the real budget."""
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    headers = _auth(client)

    # Materialisation posts a real transaction, so the entry needs an account.
    accounts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()["items"]
    funding = next(a for a in accounts if a["account_type"] != "credit")

    payload = {
        "entry_type": "expense",
        "name": "Bellroy installment",
        "amount": 1500.00,
        "cadence": "monthly",
        "next_occurrence": (datetime(2026, 8, 1)).isoformat(),
        "end_mode": "after_occurrences",
        "max_occurrences": 6,
        "account_id": funding["id"],
    }
    resp = client.post(f"{API}/budget-entries/", json=payload, headers=headers)
    assert resp.status_code in (200, 201), resp.text
    entry_id = resp.json()["id"]

    yield {"id": entry_id, "headers": headers}

    db.query(Transaction).filter(Transaction.budget_entry_id == entry_id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.id == entry_id).delete()
    db.commit()


def _fetch(client, headers, entry_id):
    resp = client.get(f"{API}/budget-entries/", headers=headers, params={"limit": 200})
    assert resp.status_code == 200, resp.text
    return next(e for e in resp.json()["items"] if e["id"] == entry_id)


def test_new_installment_starts_at_zero_paid(client, installment):
    entry = _fetch(client, installment["headers"], installment["id"])
    assert entry["max_occurrences"] == 6
    assert entry["occurrences_paid"] == 0


def test_materialising_advances_the_paid_count(client, installment):
    """'Mark paid' is what makes n move."""
    for expected in (1, 2, 3):
        resp = client.post(
            f"{API}/budget-entries/{installment['id']}/materialize",
            json={},
            headers=installment["headers"],
        )
        assert resp.status_code in (200, 201), resp.text
        entry = _fetch(client, installment["headers"], installment["id"])
        assert entry["occurrences_paid"] == expected, f"after {expected} materialisation(s)"


def test_fully_paid_installment_still_reports_its_progress(client, installment):
    """The boundary the old `if e.max_occurrences` guard got wrong.

    After the last payment, max_occurrences hits 0 (falsy) and the entry
    deactivates -- but occurrences_paid must still be 6, so the client can render
    "6 of 6" rather than falling back to "Indefinite".
    """
    for _ in range(6):
        resp = client.post(
            f"{API}/budget-entries/{installment['id']}/materialize",
            json={},
            headers=installment["headers"],
        )
        assert resp.status_code in (200, 201), resp.text

    # is_active defaults to filtering; ask for inactive too so we can see it.
    resp = client.get(
        f"{API}/budget-entries/",
        headers=installment["headers"],
        params={"limit": 200, "is_active": False},
    )
    assert resp.status_code == 200, resp.text
    entry = next(e for e in resp.json()["items"] if e["id"] == installment["id"])
    assert entry["max_occurrences"] == 0        # remaining
    assert entry["occurrences_paid"] == 6       # paid -> total = 0 + 6 = 6
    assert entry["is_active"] is False


def test_open_ended_entry_has_no_paid_count(client, db):
    """'n of m' is meaningless without an m."""
    from app.models.budget_entry import BudgetEntry

    headers = _auth(client)
    resp = client.post(
        f"{API}/budget-entries/",
        json={
            "entry_type": "expense",
            "name": "Rent (open ended)",
            "amount": 25000.00,
            "cadence": "monthly",
            "next_occurrence": (datetime.now() + timedelta(days=5)).isoformat(),
            "end_mode": "indefinite",
        },
        headers=headers,
    )
    assert resp.status_code in (200, 201), resp.text
    entry_id = resp.json()["id"]
    try:
        entry = _fetch(client, headers, entry_id)
        assert entry["max_occurrences"] is None
        assert entry["occurrences_paid"] is None
    finally:
        db.query(BudgetEntry).filter(BudgetEntry.id == entry_id).delete()
        db.commit()


def _create_installment(client, headers, *, offset, remaining, next_occurrence, name):
    accounts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()["items"]
    funding = next(a for a in accounts if a["account_type"] != "credit")
    resp = client.post(
        f"{API}/budget-entries/",
        json={
            "entry_type": "expense",
            "name": name,
            "amount": 1000.00,
            "cadence": "monthly",
            "next_occurrence": next_occurrence.isoformat(),
            "end_mode": "after_occurrences",
            "max_occurrences": remaining,
            "occurrences_paid_offset": offset,
            "account_id": funding["id"],
        },
        headers=headers,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def _cleanup(db, entry_id):
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    db.query(Transaction).filter(Transaction.budget_entry_id == entry_id).delete()
    db.query(BudgetEntry).filter(BudgetEntry.id == entry_id).delete()
    db.commit()


def test_offset_plus_one_materialisation_gives_five_of_six(client, db):
    headers = _auth(client)
    entry_id = _create_installment(
        client, headers, offset=4, remaining=2,
        next_occurrence=datetime(2026, 8, 1), name="Offset installment 4+1",
    )
    try:
        assert _fetch(client, headers, entry_id)["occurrences_paid"] == 4
        resp = client.post(f"{API}/budget-entries/{entry_id}/materialize", json={}, headers=headers)
        assert resp.status_code in (200, 201), resp.text
        entry = _fetch(client, headers, entry_id)
        assert entry["occurrences_paid"] == 5
        assert entry["max_occurrences"] == 1          # remaining -> total 5 + 1 = 6
        assert entry["occurrences_paid_offset"] == 4
        assert entry["is_active"] is True
    finally:
        _cleanup(db, entry_id)


def test_offset_installment_reaches_six_of_six_and_goes_inactive(client, db):
    headers = _auth(client)
    entry_id = _create_installment(
        client, headers, offset=5, remaining=1,
        next_occurrence=datetime(2026, 8, 1), name="Offset installment 5+1",
    )
    try:
        resp = client.post(f"{API}/budget-entries/{entry_id}/materialize", json={}, headers=headers)
        assert resp.status_code in (200, 201), resp.text
        resp = client.get(
            f"{API}/budget-entries/", headers=headers, params={"limit": 200, "is_active": False}
        )
        entry = next(e for e in resp.json()["items"] if e["id"] == entry_id)
        assert entry["occurrences_paid"] == 6
        assert entry["max_occurrences"] == 0
        assert entry["is_active"] is False
    finally:
        _cleanup(db, entry_id)


def test_offset_installment_projects_only_remaining_occurrences(client, db):
    """Imported charges carry no budget_entry_id, so projection must not re-emit them.

    Offset 4 of 6, next_occurrence already after the last imported line, 2 remaining:
    the timeline shows exactly those 2 future charges and nothing else for this entry.
    """
    headers = _auth(client)
    name = "Offset installment projection"
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=10)
    entry_id = _create_installment(
        client, headers, offset=4, remaining=2, next_occurrence=start, name=name,
    )
    try:
        r = client.get(f"{API}/forecast/timeline", headers=headers, params={"days": 365})
        assert r.status_code == 200, r.text
        mine = [e for e in r.json()["events"] if name in e.get("name", "")]
        assert len(mine) == 2, mine
        assert _fetch(client, headers, entry_id)["occurrences_paid"] == 4
    finally:
        _cleanup(db, entry_id)


def test_negative_offset_is_rejected(client):
    headers = _auth(client)
    resp = client.post(
        f"{API}/budget-entries/",
        json={
            "entry_type": "expense", "name": "Bad offset", "amount": 10,
            "cadence": "monthly", "next_occurrence": datetime(2026, 8, 1).isoformat(),
            "end_mode": "after_occurrences", "max_occurrences": 2,
            "occurrences_paid_offset": -1,
        },
        headers=headers,
    )
    assert resp.status_code == 422


def test_detail_create_and_update_return_installment_progress(client, db):
    """Every endpoint that returns an entry must carry occurrences_paid, not just the list."""
    headers = _auth(client)
    accounts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()["items"]
    funding = next(a for a in accounts if a["account_type"] != "credit")
    resp = client.post(
        f"{API}/budget-entries/",
        json={
            "entry_type": "expense", "name": "Progress everywhere", "amount": 1000.00,
            "cadence": "monthly", "next_occurrence": datetime(2026, 8, 1).isoformat(),
            "end_mode": "after_occurrences", "max_occurrences": 2,
            "occurrences_paid_offset": 4, "account_id": funding["id"],
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    entry_id = resp.json()["id"]
    try:
        assert resp.json()["occurrences_paid"] == 4
        detail = client.get(f"{API}/budget-entries/{entry_id}", headers=headers)
        assert detail.status_code == 200, detail.text
        assert detail.json()["occurrences_paid"] == 4
        updated = client.put(
            f"{API}/budget-entries/{entry_id}", json={"description": "touched"}, headers=headers
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["occurrences_paid"] == 4
        assert _fetch(client, headers, entry_id)["occurrences_paid"] == 4
    finally:
        _cleanup(db, entry_id)


def _post_installment(client, headers, *, remaining, active, name):
    return client.post(
        f"{API}/budget-entries/",
        json={
            "entry_type": "expense", "name": name, "amount": 1000.00,
            "cadence": "monthly",
            "next_occurrence": (datetime.now() + timedelta(days=10)).isoformat(),
            "end_mode": "after_occurrences", "max_occurrences": remaining,
            "occurrences_paid_offset": 6, "is_active": active,
        },
        headers=headers,
    )


def test_completed_installment_with_zero_remaining_can_be_created_inactive(client, db):
    headers = _auth(client)
    name = "Completed installment zero remaining"
    resp = _post_installment(client, headers, remaining=0, active=False, name=name)
    assert resp.status_code == 201, resp.text
    entry_id = resp.json()["id"]
    try:
        assert resp.json()["occurrences_paid"] == 6
        assert resp.json()["max_occurrences"] == 0
        r = client.get(f"{API}/forecast/timeline", headers=headers, params={"days": 365})
        assert r.status_code == 200, r.text
        assert not [e for e in r.json()["events"] if name in e.get("name", "")]
    finally:
        _cleanup(db, entry_id)


def test_zero_remaining_active_installment_is_rejected(client):
    headers = _auth(client)
    resp = _post_installment(client, headers, remaining=0, active=True, name="Active zero remaining")
    assert resp.status_code == 422, resp.text


def test_update_to_zero_remaining_requires_inactive(client, db):
    headers = _auth(client)
    entry_id = _create_installment(
        client, headers, offset=5, remaining=1,
        next_occurrence=datetime(2026, 8, 1), name="Update to zero remaining",
    )
    try:
        url = f"{API}/budget-entries/{entry_id}"
        assert client.put(url, json={"max_occurrences": 0}, headers=headers).status_code == 422
        resp = client.put(url, json={"max_occurrences": 0, "is_active": False}, headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["max_occurrences"] == 0
        assert resp.json()["occurrences_paid"] == 5
        # Reactivating a completed installment without giving it occurrences is rejected.
        assert client.put(url, json={"is_active": True}, headers=headers).status_code == 422
    finally:
        _cleanup(db, entry_id)


def test_null_is_active_cannot_bypass_zero_remaining_guard(client, db):
    headers = _auth(client)
    done_id = _post_installment(
        client, headers, remaining=0, active=False, name="Null is_active completed"
    ).json()["id"]
    open_id = _create_installment(
        client, headers, offset=5, remaining=1,
        next_occurrence=datetime(2026, 8, 1), name="Null is_active with zero remaining",
    )
    try:
        done_before = _fetch(client, headers, done_id)
        resp = client.put(f"{API}/budget-entries/{done_id}", json={"is_active": None}, headers=headers)
        assert resp.status_code == 422, resp.text
        assert _fetch(client, headers, done_id) == done_before

        open_before = _fetch(client, headers, open_id)
        resp = client.put(
            f"{API}/budget-entries/{open_id}",
            json={"max_occurrences": 0, "is_active": None},
            headers=headers,
        )
        assert resp.status_code == 422, resp.text
        assert _fetch(client, headers, open_id) == open_before
    finally:
        _cleanup(db, done_id)
        _cleanup(db, open_id)


def test_offset_updates(client, db):
    headers = _auth(client)
    entry_id = _create_installment(
        client, headers, offset=1, remaining=5,
        next_occurrence=datetime(2026, 8, 1), name="Offset update installment",
    )
    try:
        url = f"{API}/budget-entries/{entry_id}"
        resp = client.put(url, json={"occurrences_paid_offset": 3}, headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["occurrences_paid"] == 3
        assert client.put(url, json={"occurrences_paid_offset": None}, headers=headers).status_code == 422
        resp = client.put(url, json={"name": "x"}, headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["occurrences_paid_offset"] == 3
        assert resp.json()["occurrences_paid"] == 3
    finally:
        _cleanup(db, entry_id)

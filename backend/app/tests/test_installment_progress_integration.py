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

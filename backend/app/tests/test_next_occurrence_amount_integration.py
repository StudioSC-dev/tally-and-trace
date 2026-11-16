"""STU-660: a recurring entry's ``next_occurrence_amount``, the amount its next
occurrence bills (``final_amount`` on the last, else ``amount``), read-only.
Everything goes through the HTTP layer, on throwaway users. Skips without a database."""
import os
import secrets
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
PASSWORD = "Password123!"
WHEN = "2030-10-05T00:00:00"


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
def users(client, db):
    from app.core.auth import get_password_hash
    from app.core.tags import ensure_household_tag
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.user import User

    made, sides = [], {}
    for side in ("owner", "other"):
        email = f"noa-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Noa", last_name=side, is_verified=True)
        db.add(u)
        db.flush()
        ensure_household_tag(db, u)
        db.commit()
        db.refresh(u)
        made.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        r = client.post(f"{API}/accounts/", headers=h, json={
            "name": f"Noa {side} bank", "account_type": "checking", "balance": 10_000})
        assert r.status_code in (200, 201), r.text
        sides[side] = {"id": u.id, "headers": h, "bank": r.json()["id"]}
    yield sides
    db.rollback()
    db.query(BudgetEntry).filter(BudgetEntry.user_id.in_(made)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(made)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made)).delete(synchronize_session=False)
    db.commit()


def _make(client, who, **fields):
    body = {"name": "Noa plan", "entry_type": "expense", "amount": 100,
            "next_occurrence": WHEN, "account_id": who["bank"], **fields}
    r = client.post(f"{API}/budget-entries/", json=body, headers=who["headers"])
    assert r.status_code in (200, 201), r.text
    return r.json()


def _get(client, who, entry_id):
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _installment(count, **fields):
    return {"end_mode": "after_occurrences", "max_occurrences": count, "cadence": "monthly",
            **fields}


def test_next_occurrence_amount(client, db, users):
    owner = users["owner"]
    # More than one left: the next is not the last, so it bills ``amount``.
    early = _make(client, owner, **_installment(3, final_amount=133.34))
    assert early["next_occurrence_amount"] == 100
    # The last one left bills ``final_amount``.
    last = _make(client, owner, **_installment(1, final_amount=133.34))
    assert last["next_occurrence_amount"] == 133.34
    # ... also with payments already made before import.
    offset = _make(client, owner, **_installment(1, final_amount=133.34, occurrences_paid_offset=5))
    assert offset["next_occurrence_amount"] == 133.34
    offset_early = _make(client, owner, **_installment(2, final_amount=133.34,
                                                       occurrences_paid_offset=5))
    assert offset_early["next_occurrence_amount"] == 100
    # No final_amount: every occurrence is ``amount``; an open-ended entry too.
    assert _make(client, owner, **_installment(1))["next_occurrence_amount"] == 100
    assert _make(client, owner)["next_occurrence_amount"] == 100
    # Nothing left: a completed installment (0 remaining, inactive).
    done = _make(client, owner, **_installment(0, is_active=False, final_amount=133.34))
    assert done["next_occurrence_amount"] is None
    # An entry past its end date has no next occurrence either.
    ended = _make(client, owner, end_mode="on_date", end_date="2030-09-01T00:00:00")
    assert ended["next_occurrence_amount"] is None
    # The read paths agree: GET by id and the list.
    assert _get(client, owner, last["id"])["next_occurrence_amount"] == 133.34
    r = client.get(f"{API}/budget-entries/", headers=owner["headers"])
    assert r.status_code == 200, r.text
    listed = {e["id"]: e["next_occurrence_amount"] for e in r.json()["items"]}
    assert listed[last["id"]] == 133.34 and listed[early["id"]] == 100
    assert listed[done["id"]] is None


def test_next_occurrence_amount_follows_the_visibility_of_amount(client, db, users):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    owner, other = users["owner"], users["other"]
    mine = _make(client, owner, **_installment(1, final_amount=133.34))
    # Not shared with the other user: neither amount reaches them.
    r = client.get(f"{API}/budget-entries/{mine['id']}", headers=other["headers"])
    assert r.status_code in (403, 404)
    r = client.get(f"{API}/budget-entries/", headers=other["headers"])
    assert mine["id"] not in [e["id"] for e in r.json()["items"]]
    assert "133.34" not in r.text
    # Legacy: the other user's entry into the owner's bank is limited for the owner,
    # which shows ``amount`` and so shows ``next_occurrence_amount`` with it.
    legacy = BudgetEntry(
        user_id=other["id"], name="Noa allowance", entry_type=BudgetEntryType.EXPENSE,
        amount=Decimal("50"), cadence=RecurrenceFrequency.MONTHLY,
        next_occurrence=datetime(2030, 10, 7), account_id=other["bank"],
        transfer_to_account_id=owner["bank"], end_mode="after_occurrences",
        max_occurrences=1, final_amount=Decimal("55.55"))
    db.add(legacy)
    db.commit()
    body = _get(client, owner, legacy.id)
    assert body["view"] == "limited"
    assert (body["amount"], body["next_occurrence_amount"]) == (50, 55.55)
    assert "final_amount" not in body


def test_next_occurrence_amount_is_read_only(client, db, users):
    from app.models.budget_entry import BudgetEntry

    owner = users["owner"]
    h = owner["headers"]
    entry = _make(client, owner, **_installment(2, final_amount=133.34))
    eid = entry["id"]

    def stored():
        db.expire_all()
        e = db.get(BudgetEntry, eid)
        return (e.amount, e.final_amount, e.max_occurrences, e.next_occurrence,
                e.occurrences_paid_offset, e.updated_at)

    before = stored()
    for _ in range(2):
        assert _get(client, owner, eid)["next_occurrence_amount"] == 100
    client.get(f"{API}/budget-entries/", headers=h)
    assert stored() == before, "reading changed the stored entry"

    # A client-sent value is ignored (or rejected); the stored entry is unchanged.
    r = client.put(f"{API}/budget-entries/{eid}", json={"next_occurrence_amount": 999},
                   headers=h)
    assert r.status_code in (200, 400, 422), r.text
    assert stored()[:5] == before[:5]
    assert _get(client, owner, eid)["next_occurrence_amount"] == 100
    r = client.post(f"{API}/budget-entries/", headers=h, json={
        "name": "Noa sneaky", "entry_type": "expense", "amount": 10, "next_occurrence": WHEN,
        "account_id": owner["bank"], "next_occurrence_amount": 999})
    if r.status_code in (200, 201):
        assert r.json()["next_occurrence_amount"] == 10
    else:
        assert r.status_code in (400, 422)

    # The existing writes keep their behaviour, and the derived value follows them.
    r = client.put(f"{API}/budget-entries/{eid}", json={"amount": 120}, headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["amount"], r.json()["next_occurrence_amount"]) == (120, 120)
    r = client.put(f"{API}/budget-entries/{eid}", json={"max_occurrences": 1, "final_amount": 140},
                   headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["final_amount"], r.json()["next_occurrence_amount"]) == (140, 140)
    assert stored()[:3] == (Decimal("120.00"), Decimal("140.00"), 1)

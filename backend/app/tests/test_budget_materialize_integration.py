"""
Integration test for POST /budget-entries/{id}/materialize.

Skips when no database is reachable. Uses the seeded demo user: picks an active
budget entry that has an account, posts it, and asserts a linked transaction was
created, the account balance moved by the amount, and the schedule advanced.
"""
import os
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import sw_post


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


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _account_balance(client, headers, account_id):
    accts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    for a in items:
        if a["id"] == account_id:
            return a["balance"]
    return None


def test_materialize_posts_transaction_and_advances(client):
    h = _auth(client)

    entries = client.get(f"{API}/budget-entries/", headers=h, params={"is_active": True, "limit": 200}).json()["items"]
    accounts = client.get(f"{API}/accounts/", headers=h, params={"limit": 1000}).json()
    accounts = accounts["items"] if isinstance(accounts, dict) else accounts
    currency_of = {a["id"]: a["currency"] for a in accounts}
    # An entry in another currency than its account's needs the amount charged (F1).
    entry = next((e for e in entries if e.get("account_id")
                  and e["currency"] == currency_of.get(e["account_id"])), None)
    if entry is None:
        pytest.skip("no seeded budget entry with an account to post to")

    before_balance = _account_balance(client, h, entry["account_id"])
    before_next = entry["next_occurrence"]
    amount = entry["amount"]
    expect_type = "credit" if entry["entry_type"] == "income" else "debit"

    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=h, json={})
    assert r.status_code == 201, r.text
    txn = r.json()
    assert txn["budget_entry_id"] == entry["id"]
    assert txn["is_posted"] is True
    assert txn["is_recurring"] is True
    assert txn["transaction_type"] == expect_type
    assert txn["amount"] == pytest.approx(amount, abs=0.01)

    # Account balance moved by the amount in the right direction.
    after_balance = _account_balance(client, h, entry["account_id"])
    delta = after_balance - before_balance
    expected = amount if expect_type == "credit" else -amount
    assert delta == pytest.approx(expected, abs=0.01)

    # Schedule advanced (entry still active in these seeds).
    after = client.get(f"{API}/budget-entries/{entry['id']}", headers=h).json()
    assert after["next_occurrence"] != before_next


# --- STU-215: an installment's payment never passes its total -------------------
#
# These use throwaway users (``sw_people``), not the seeded demo user above.

PROBE_DEADLINE = 10  # seconds a probe waits for a worker to block
JOIN_TIMEOUT = 20


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


def _checking(client, who, balance=10_000):
    return sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": balance})["id"]


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _installment(client, who, account_id, remaining=3, active=True, **extra):
    body = {"name": "Phone installment", "entry_type": "expense", "amount": 1000,
            "cadence": "monthly", "next_occurrence": "2026-11-01T00:00:00",
            "account_id": account_id, "end_mode": "after_occurrences",
            "max_occurrences": remaining, "is_active": active}
    body.update(extra)
    return sw_post(client, who, "/budget-entries/", body)["id"]


def _open_ended(client, who, account_id, **extra):
    body = {"name": "Probe utilities", "entry_type": "expense", "amount": 100,
            "cadence": "monthly", "next_occurrence": "2026-11-01T00:00:00",
            "account_id": account_id}
    body.update(extra)
    return sw_post(client, who, "/budget-entries/", body)["id"]


def _entry_state(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _materialize(client, who, entry_id, **body):
    return client.post(f"{API}/budget-entries/{entry_id}/materialize",
                       json=body, headers=who["headers"])


def _linked_rows(engine, entry_id) -> int:
    with engine.connect() as c:
        return c.execute(text("SELECT count(*) FROM transactions WHERE budget_entry_id = :e"),
                         {"e": entry_id}).scalar()


def test_a_finished_installment_refuses_another_payment(sw_client, sw_people, engine):
    """Main posts a seventh row: 201 and the entry reads '1 of 1'."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=0, active=False)

    r = _materialize(client, me, entry)

    assert r.status_code == 409, r.text
    assert _linked_rows(engine, entry) == 0
    assert _balance(client, me, checking) == Decimal("10000.00")
    assert _entry_state(client, me, entry)["occurrences_paid"] == 0


def test_an_installment_payment_without_advancing_is_refused(sw_client, sw_people, engine):
    """Main posts the row without using up an occurrence, so n + m grows."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=3)

    r = _materialize(client, me, entry, advance=False)

    assert r.status_code == 400, r.text
    assert _linked_rows(engine, entry) == 0
    assert _entry_state(client, me, entry)["max_occurrences"] == 3
    assert _balance(client, me, checking) == Decimal("10000.00")


def test_the_last_payment_finishes_the_installment_and_a_second_is_refused(
        sw_client, sw_people, engine):
    """Main: the second call posts again."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=1)

    first = _materialize(client, me, entry)
    assert first.status_code == 201, first.text
    state = _entry_state(client, me, entry)
    assert (state["is_active"], state["max_occurrences"], state["occurrences_paid"]) == (False, 0, 1)

    second = _materialize(client, me, entry)

    assert second.status_code == 409, second.text
    assert _linked_rows(engine, entry) == 1
    assert _balance(client, me, checking) == Decimal("9000.00")


def test_a_default_payment_uses_one_occurrence_and_moves_the_schedule(sw_client, sw_people):
    """Guard: passes before and after."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = _installment(client, me, checking, remaining=3)

    r = _materialize(client, me, entry)

    assert r.status_code == 201, r.text
    state = _entry_state(client, me, entry)
    assert state["max_occurrences"] == 2
    assert state["occurrences_paid"] == 1
    assert state["is_active"] is True
    assert state["next_occurrence"].startswith("2026-12-01")

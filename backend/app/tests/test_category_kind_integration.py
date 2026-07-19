"""Integration tests for context-aware category kinds. Skips without a database.

Pins the "typed + account-aware" behaviour:

  1. `kind` and the legacy `is_expense` flag stay in sync (kind is the source of
     truth): transfer/income kinds are not expenses; expense kind is.
  2. When a client omits `kind`, it is derived from is_expense (backwards compat).
  3. Categories are filterable by kind.
  4. A transfer that carries a transfer-kind category still behaves as a pure
     money movement: balances move by the amount (net worth unchanged) and it is
     excluded from income/expense totals — a categorised transfer must never be
     double-counted as spending or income.
"""
import os
import uuid
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

    with TestClient(app) as c:
        yield c


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _new_category(client, headers, **body):
    body.setdefault("name", f"cat-{uuid.uuid4().hex[:8]}")
    r = client.post(f"{API}/categories/", headers=headers, json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


def _new_account(client, headers, balance, account_type="checking", currency="PHP"):
    r = client.post(f"{API}/accounts/", headers=headers, json={
        "name": f"acct-{uuid.uuid4().hex[:8]}",
        "account_type": account_type,
        "balance": balance,
        "currency": currency,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _balance(client, headers, account_id):
    accts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    return Decimal(str(next(a["balance"] for a in items if a["id"] == account_id)))


def test_transfer_kind_is_not_an_expense(client):
    h = _auth(client)
    cat = _new_category(client, h, kind="transfer")
    assert cat["kind"] == "transfer"
    assert cat["is_expense"] is False


def test_kind_derived_from_is_expense_when_omitted(client):
    h = _auth(client)
    expense = _new_category(client, h, is_expense=True)
    income = _new_category(client, h, is_expense=False)
    assert expense["kind"] == "expense"
    assert income["kind"] == "income"


def test_updating_kind_syncs_is_expense(client):
    h = _auth(client)
    cat = _new_category(client, h, is_expense=True)  # starts as expense
    r = client.put(f"{API}/categories/{cat['id']}", headers=h, json={"kind": "transfer"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "transfer"
    assert body["is_expense"] is False


def test_filter_categories_by_kind(client):
    h = _auth(client)
    cat = _new_category(client, h, kind="transfer")
    r = client.get(f"{API}/categories/", headers=h, params={"kind": "transfer", "is_active": True})
    assert r.status_code == 200, r.text
    ids = {c["id"] for c in r.json()}
    kinds = {c["kind"] for c in r.json()}
    assert cat["id"] in ids
    assert kinds == {"transfer"}


def test_categorised_transfer_moves_balances_and_stays_out_of_totals(client):
    h = _auth(client)
    checking = _new_account(client, h, 10000.00, account_type="checking")
    savings = _new_account(client, h, 2000.00, account_type="savings")
    contribution = _new_category(client, h, kind="transfer")

    before_checking = _balance(client, h, checking)
    before_savings = _balance(client, h, savings)

    # Isolated future window so only our transfer falls in the summary period.
    window = {"start_date": "2035-01-01T00:00:00", "end_date": "2035-01-31T23:59:59"}

    r = client.post(f"{API}/transactions/", headers=h, json={
        "account_id": checking,
        "transaction_type": "transfer",
        "transfer_from_account_id": checking,
        "transfer_to_account_id": savings,
        "amount": 1500.00,
        "transfer_fee": 25.00,
        "category_id": contribution["id"],
        "transaction_date": "2035-01-15T00:00:00",
        "is_posted": True,
        "description": "Monthly savings contribution",
    })
    assert r.status_code in (200, 201), r.text
    txn = r.json()
    # The category rides along on the transfer.
    assert txn["category_id"] == contribution["id"]

    # -from-fee / +to, exact in Decimal.
    assert _balance(client, h, checking) == before_checking - Decimal("1500.00") - Decimal("25.00")
    assert _balance(client, h, savings) == before_savings + Decimal("1500.00")

    # Excluded from income/expense: the contribution is not spending or income.
    summary = client.get(f"{API}/transactions/summary/period", headers=h, params=window).json()
    assert Decimal(str(summary["summary"]["total_income"])) == Decimal("0")
    assert Decimal(str(summary["summary"]["total_expenses"])) == Decimal("0")
    assert contribution["name"] not in summary["category_breakdown"]

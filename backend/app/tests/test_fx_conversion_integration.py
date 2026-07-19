"""Integration tests for multi-currency (FX) transactions. Skips without a database.

Important finding, and the reason these tests assert what they do: the backend does
NOT compute a conversion. `exchange_rate` / `original_amount` / `original_currency`
(and the `projected_*` pair) are stored as reference metadata; nothing server-side
derives `amount` from `original_amount * exchange_rate`. So the correctness
properties that actually matter — and that these tests pin — are:

  1. The account balance moves by `amount` (the account-currency figure), NOT by
     `original_amount` (the foreign figure). Getting this wrong would corrupt the
     balance by the exchange rate.
  2. The FX fields round-trip with full precision: exchange_rate at 6 dp
     (NUMERIC(15,6)), amounts at 2 dp (NUMERIC(15,2)).
  3. Client-supplied `amount` reconciles exactly (in Decimal) to
     `original_amount * exchange_rate` when the caller provides consistent values —
     i.e. storage precision is sufficient to represent that relationship exactly.

If the app ever grows real server-side conversion (compute/validate `amount` from
the rate), that is a feature with its own tests — flagged in HANDOVER, not assumed
here.
"""
import os
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


def _new_account(client, headers, balance, currency="PHP"):
    r = client.post(f"{API}/accounts/", headers=headers, json={
        "name": "FX Test", "account_type": "checking", "balance": balance, "currency": currency,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _balance(client, headers, account_id):
    accts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()
    items = accts["items"] if isinstance(accts, dict) else accts
    return next(a["balance"] for a in items if a["id"] == account_id)


def _post_txn(client, headers, body):
    r = client.post(f"{API}/transactions/", headers=headers, json={
        "transaction_date": "2026-08-01T00:00:00", "is_posted": True, **body,
    })
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_foreign_purchase_moves_balance_by_converted_amount_not_original(client):
    """USD purchase on a PHP account: the PHP balance drops by `amount`, not by the
    USD `original_amount`. This is the property that would silently corrupt a balance
    by the FX rate if it regressed."""
    h = _auth(client)
    aid = _new_account(client, h, 10000.00, currency="PHP")

    # Paid 100.00 USD at 56.50 -> 5650.00 PHP debited from the PHP account.
    _post_txn(client, h, {
        "account_id": aid,
        "amount": 5650.00, "currency": "PHP",
        "original_amount": 100.00, "original_currency": "USD",
        "exchange_rate": 56.50,
        "transaction_type": "debit",
    })

    # 10000.00 - 5650.00 = 4350.00  (NOT 10000 - 100 = 9900)
    assert _balance(client, h, aid) == pytest.approx(4350.00, abs=1e-9)


def test_fx_fields_round_trip_exactly(client):
    """exchange_rate keeps 6 decimals (NUMERIC(15,6)); amounts keep 2."""
    h = _auth(client)
    aid = _new_account(client, h, 0, currency="PHP")

    txn = _post_txn(client, h, {
        "account_id": aid,
        "amount": 218.42, "currency": "PHP",
        "original_amount": 12345.67, "original_currency": "JPY",
        "exchange_rate": 0.017692,   # 6 dp — would be lost in a float(4) column
        "transaction_type": "debit",
    })

    assert Decimal(str(txn["exchange_rate"])) == Decimal("0.017692")
    assert Decimal(str(txn["original_amount"])) == Decimal("12345.67")
    assert Decimal(str(txn["amount"])) == Decimal("218.42")
    assert txn["original_currency"] == "JPY"
    assert txn["currency"] == "PHP"


def test_amount_reconciles_to_rate_times_original_in_decimal(client):
    """With consistent inputs, the stored amount equals original * rate exactly in
    Decimal — proving the columns hold enough precision for the relationship."""
    h = _auth(client)
    aid = _new_account(client, h, 0, currency="PHP")

    original = Decimal("250.00")
    rate = Decimal("56.482300")
    amount = (original * rate).quantize(Decimal("0.01"))   # 14120.58 (rounded to cents)

    txn = _post_txn(client, h, {
        "account_id": aid,
        "amount": float(amount), "currency": "PHP",
        "original_amount": float(original), "original_currency": "USD",
        "exchange_rate": float(rate),
        "transaction_type": "debit",
    })

    stored = (Decimal(str(txn["original_amount"])) * Decimal(str(txn["exchange_rate"]))).quantize(Decimal("0.01"))
    assert stored == Decimal(str(txn["amount"])) == Decimal("14120.58")


def test_credit_foreign_income_credits_converted_amount(client):
    """Symmetric to the debit case: a foreign-currency credit adds `amount`."""
    h = _auth(client)
    aid = _new_account(client, h, 1000.00, currency="PHP")

    _post_txn(client, h, {
        "account_id": aid,
        "amount": 2825.00, "currency": "PHP",
        "original_amount": 50.00, "original_currency": "USD",
        "exchange_rate": 56.50,
        "transaction_type": "credit",
    })

    assert _balance(client, h, aid) == pytest.approx(3825.00, abs=1e-9)   # 1000 + 2825


def test_original_currency_defaults_when_omitted(client):
    """original_amount supplied without original_currency: the backend fills a
    deterministic default (the transaction currency) rather than leaving it null."""
    h = _auth(client)
    aid = _new_account(client, h, 0, currency="PHP")

    txn = _post_txn(client, h, {
        "account_id": aid,
        "amount": 500.00, "currency": "PHP",
        "original_amount": 500.00,   # no original_currency
        "transaction_type": "debit",
    })

    assert txn["original_currency"] == "PHP"   # defaulted to the txn currency

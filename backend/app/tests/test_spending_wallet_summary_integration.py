"""Period summary with spending wallets, through the transactions API.

The acceptance scenarios, plus the invariant that the category rows (including
"Unallocated wallet spend") sum to the expense total after every create, edit
and delete. Uses a throwaway user. Skips without a database.
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
WHEN = "2026-09-15T00:00:00"
PERIOD = {"start_date": "2026-09-01T00:00:00", "end_date": "2026-09-30T23:59:59"}


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def headers(client):
    """Log in as a throwaway user; everything it owns is deleted afterwards."""
    from app.core.auth import get_password_hash
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User

    db = SessionLocal()
    u = User(email=f"wsum-{os.urandom(4).hex()}@example.com",
             password_hash=get_password_hash("password123"),
             first_name="Wallet", last_name="Summary", is_verified=True)
    db.add(u)
    db.commit()
    db.refresh(u)
    login = client.post(f"{API}/auth/login", json={"email": u.email, "password": "password123"})
    assert login.status_code == 200, login.text

    yield {"Authorization": f"Bearer {login.json()['access_token']}"}

    db.query(Transaction).filter(Transaction.user_id == u.id).delete()
    db.query(Account).filter(Account.user_id == u.id).delete()
    db.query(Category).filter(Category.user_id == u.id).delete()
    db.query(User).filter(User.id == u.id).delete()
    db.commit()
    db.close()


def _account(client, headers, name, account_type, wallet=False):
    r = client.post(f"{API}/accounts/", headers=headers, json={
        "name": name, "account_type": account_type, "balance": 10000,
        "is_spending_wallet": wallet})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _category(client, headers, name):
    r = client.post(f"{API}/categories/", headers=headers, json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _debit(client, headers, account, amount, category=None):
    r = client.post(f"{API}/transactions/", headers=headers, json={
        "account_id": account, "amount": amount, "transaction_type": "debit",
        "transaction_date": WHEN, "category_id": category})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _transfer(client, headers, src, dst, amount, fee=0):
    r = client.post(f"{API}/transactions/", headers=headers, json={
        "account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": dst,
        "amount": amount, "transfer_fee": fee, "transaction_type": "transfer",
        "transaction_date": WHEN})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _summary(client, headers):
    r = client.get(f"{API}/transactions/summary/period", headers=headers, params=PERIOD)
    assert r.status_code == 200, r.text
    body = r.json()
    rows = {name: Decimal(str(v["expenses"])) for name, v in body["category_breakdown"].items()}
    total = Decimal(str(body["summary"]["total_expenses"]))
    assert sum(rows.values(), Decimal("0")) == total, (rows, total)  # the invariant
    return total, rows


def test_top_up_2000_fee_10_plus_wallet_parking_500(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    parking = _category(client, headers, "Parking")
    _transfer(client, headers, bank, gcash, 2000, fee=10)
    _debit(client, headers, gcash, 500, parking)

    total, rows = _summary(client, headers)
    assert total == Decimal("2010")
    assert rows["Parking"] == Decimal("500")


def test_bank_top_up_then_fee_bearing_gcash_to_cash(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    cash = _account(client, headers, "Cash", "cash", wallet=True)
    _transfer(client, headers, bank, gcash, 1000, fee=5)
    _transfer(client, headers, gcash, cash, 300, fee=15)

    total, rows = _summary(client, headers)
    assert total == Decimal("1005")  # only the top-up plus its fee
    assert rows["Transfer fees"] == Decimal("20")  # the GCash fee is still shown


def test_invariant_holds_after_create_edit_and_delete(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    checking = _account(client, headers, "Checking", "checking")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    food = _category(client, headers, "Food")

    # Create: the invariant is asserted inside every _summary call.
    ids = [
        _debit(client, headers, bank, 250, food),
        _debit(client, headers, bank, 40),
        _transfer(client, headers, bank, gcash, 1500, fee=12),
        _debit(client, headers, gcash, 600, food),
        _transfer(client, headers, gcash, bank, 200, fee=8),
        _transfer(client, headers, bank, checking, 3000, fee=20),
    ]
    total, rows = _summary(client, headers)
    assert total == Decimal("250") + 40 + 1512 + 20
    assert rows["Unallocated wallet spend"] == Decimal("1500") - 600 - 8

    # Edit: amounts, fees, and moving a debit between a bank and a wallet.
    edits = [
        (ids[3], {"amount": 900}),
        (ids[0], {"account_id": gcash}),
        (ids[2], {"transfer_fee": 30}),
        (ids[4], {"transfer_fee": 0}),
        (ids[5], {"transfer_to_account_id": gcash}),
    ]
    for txn_id, change in edits:
        r = client.put(f"{API}/transactions/{txn_id}", headers=headers, json=change)
        assert r.status_code == 200, r.text
        _summary(client, headers)
    total, _ = _summary(client, headers)
    # Bank 40 + top-up 1,530 + second top-up 3,020; the wallet debits are not counted.
    assert total == Decimal("40") + 1530 + 3020

    # Delete, one by one, back to nothing.
    for txn_id in ids:
        r = client.delete(f"{API}/transactions/{txn_id}", headers=headers)
        assert r.status_code == 200, r.text
        _summary(client, headers)
    assert _summary(client, headers) == (Decimal("0"), {})

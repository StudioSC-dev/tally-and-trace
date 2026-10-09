"""Period summary with spending wallets, through the transactions API.

The acceptance scenarios, plus the invariant that the category rows (including
"Unallocated wallet spend" and "Returned from wallets") sum to the expense total
after every create, edit and delete. Uses a throwaway user. Skips without a database.
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
    # The 200 GCash -> Bank return offsets the top-up; it is not wallet spend.
    assert total == Decimal("250") + 40 + 1512 + 20 - 200
    assert rows["Unallocated wallet spend"] == Decimal("1500") - 600 - 8
    assert rows["Returned from wallets"] == Decimal("-200")

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
    # Bank 40 + top-up 1,530 + second top-up 3,020 - the 200 returned to the bank;
    # the wallet debits are not counted.
    assert total == Decimal("40") + 1530 + 3020 - 200

    # Delete, one by one, back to nothing.
    for txn_id in ids:
        r = client.delete(f"{API}/transactions/{txn_id}", headers=headers)
        assert r.status_code == 200, r.text
        _summary(client, headers)
    assert _summary(client, headers) == (Decimal("0"), {})


@pytest.fixture
def other_user(client):
    """A caller (logged in) and another user; all removed afterwards."""
    from app.core.auth import get_password_hash
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.models.transaction import Transaction
    from app.models.user import User

    db = SessionLocal()
    users = []
    for label in ("caller", "member"):
        u = User(email=f"wsum-{label}-{os.urandom(4).hex()}@example.com",
                 password_hash=get_password_hash("password123"),
                 first_name="Wallet", last_name=label, is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        users.append(u)
    caller, member = users
    login = client.post(f"{API}/auth/login",
                        json={"email": caller.email, "password": "password123"})
    assert login.status_code == 200, login.text

    yield {"db": db, "caller": caller, "member": member,
           "headers": {"Authorization": f"Bearer {login.json()['access_token']}"}}

    db.rollback()
    ids = [caller.id, member.id]
    db.query(Transaction).filter(Transaction.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_another_users_transfers_in_are_not_the_callers_expense(client, other_user):
    from datetime import datetime

    from app.models.account import Account, AccountType
    from app.models.transaction import Transaction, TransactionType

    db, caller, member = (other_user[k] for k in ("db", "caller", "member"))
    gcash = Account(user_id=caller.id, name="GCash",
                    account_type=AccountType.E_WALLET, balance=0, is_spending_wallet=True)
    bank = Account(user_id=caller.id, name="Bank",
                   account_type=AccountType.SAVINGS, balance=0)
    theirs = Account(user_id=member.id, name="Their bank", account_type=AccountType.SAVINGS,
                     balance=10000)
    db.add_all([gcash, bank, theirs])
    db.commit()
    for dst, amount, fee in ((gcash, 1000, 0), (bank, 3000, 25)):
        db.add(Transaction(user_id=member.id, account_id=theirs.id, amount=amount,
                           transaction_type=TransactionType.TRANSFER,
                           transfer_from_account_id=theirs.id, transfer_to_account_id=dst.id,
                           transfer_fee=fee, transaction_date=datetime(2026, 9, 15),
                           is_posted=True))
    db.commit()

    total, rows = _summary(client, other_user["headers"])
    assert total == Decimal("0") and rows == {}


def test_card_purchase_paid_from_a_topped_up_wallet_is_expensed_once(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    card = _account(client, headers, "Card", "credit")
    food = _category(client, headers, "Food")
    _debit(client, headers, card, 1000, food)
    _transfer(client, headers, bank, gcash, 1000)
    _transfer(client, headers, gcash, card, 1000)  # the card payment, from the wallet

    total, rows = _summary(client, headers)
    assert total == Decimal("1000")
    assert rows == {"Food": Decimal("1000"), "Unallocated wallet spend": Decimal("1000"),
                    "Returned from wallets": Decimal("-1000")}


def test_money_returned_from_a_wallet_to_the_bank_reduces_expense(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    _transfer(client, headers, bank, gcash, 1000)
    _transfer(client, headers, gcash, bank, 200, fee=5)

    total, rows = _summary(client, headers)
    assert total == Decimal("800")
    # The 5 fee stays wallet detail (shown, out of the total, taken from unallocated).
    assert rows == {"Transfer fees": Decimal("5"), "Unallocated wallet spend": Decimal("995"),
                    "Returned from wallets": Decimal("-200")}


def test_invariant_holds_as_returns_are_created_edited_and_deleted(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    cash = _account(client, headers, "Cash", "cash", wallet=True)
    card = _account(client, headers, "Card", "credit")
    top_up = _transfer(client, headers, bank, gcash, 1500, fee=10)
    pay_card = _transfer(client, headers, gcash, card, 700)
    back = _transfer(client, headers, gcash, bank, 300, fee=3)
    assert _summary(client, headers)[0] == Decimal("1510") - 700 - 300

    for txn_id, change, expected in (
        (back, {"amount": 400}, Decimal("1510") - 700 - 400),
        (pay_card, {"transfer_to_account_id": cash}, Decimal("1510") - 400),  # wallet to wallet
        (back, {"transfer_fee": 0}, Decimal("1510") - 400),
    ):
        r = client.put(f"{API}/transactions/{txn_id}", headers=headers, json=change)
        assert r.status_code == 200, r.text
        assert _summary(client, headers)[0] == expected

    for txn_id in (back, pay_card, top_up):
        r = client.delete(f"{API}/transactions/{txn_id}", headers=headers)
        assert r.status_code == 200, r.text
        _summary(client, headers)
    assert _summary(client, headers) == (Decimal("0"), {})


def _credit(client, headers, account, amount, category=None):
    r = client.post(f"{API}/transactions/", headers=headers, json={
        "account_id": account, "amount": amount, "transaction_type": "credit",
        "transaction_date": WHEN, "category_id": category})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _net(client, headers):
    r = client.get(f"{API}/transactions/summary/period", headers=headers, params=PERIOD)
    assert r.status_code == 200, r.text
    s = r.json()["summary"]
    return Decimal(str(s["total_income"])), Decimal(str(s["net_flow"]))


def test_income_into_a_wallet_counts_once_as_it_is_created_edited_and_deleted(client, headers):
    bank = _account(client, headers, "Bank", "savings")
    gcash = _account(client, headers, "GCash", "e_wallet", wallet=True)
    food = _category(client, headers, "Food")

    pay = _credit(client, headers, gcash, 5000)
    back = _transfer(client, headers, gcash, bank, 5000)
    total, rows = _summary(client, headers)
    assert total == Decimal("0")
    assert rows == {"Uncategorized": Decimal("0"), "Unallocated wallet spend": Decimal("5000"),
                    "Returned from wallets": Decimal("-5000")}
    assert _net(client, headers) == (Decimal("5000"), Decimal("5000"))

    spend = _debit(client, headers, gcash, 1200, food)
    for txn_id, change, expected_total, expected_net in (
        (back, {"amount": 3000}, Decimal("2000"), Decimal("3000")),  # 2,000 stays in GCash
        (pay, {"amount": 6000}, Decimal("3000"), Decimal("3000")),
        (pay, {"account_id": bank}, Decimal("-3000"), Decimal("9000")),  # no longer a top-up
        (pay, {"account_id": gcash}, Decimal("3000"), Decimal("3000")),
    ):
        r = client.put(f"{API}/transactions/{txn_id}", headers=headers, json=change)
        assert r.status_code == 200, r.text
        assert _summary(client, headers)[0] == expected_total
        assert _net(client, headers)[1] == expected_net
    _, rows = _summary(client, headers)
    assert rows["Food"] == Decimal("1200")
    assert rows["Unallocated wallet spend"] == Decimal("6000") - 1200

    for txn_id in (spend, back, pay):
        r = client.delete(f"{API}/transactions/{txn_id}", headers=headers)
        assert r.status_code == 200, r.text
        _summary(client, headers)
    assert _summary(client, headers) == (Decimal("0"), {})


@pytest.fixture
def two_owners(client):
    """Two logged-in callers, A and B, each owning the accounts of one scope."""
    from app.core.access import touches_accounts
    from app.core.auth import get_password_hash
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.models.transaction import Transaction
    from app.models.user import User

    db = SessionLocal()
    users, headers = [], []
    for label in ("A", "B"):
        u = User(email=f"wsum-{label.lower()}-{os.urandom(4).hex()}@example.com",
                 password_hash=get_password_hash("password123"),
                 first_name="Wallet", last_name=label, is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        login = client.post(f"{API}/auth/login",
                            json={"email": u.email, "password": "password123"})
        assert login.status_code == 200, login.text
        users.append(u)
        headers.append({"Authorization": f"Bearer {login.json()['access_token']}"})

    yield {"db": db, "users": users, "headers": headers}

    db.rollback()
    ids = [u.id for u in users]
    account_ids = [a.id for a in db.query(Account.id).filter(Account.user_id.in_(ids))]
    db.query(Transaction).filter(Transaction.user_id.in_(ids)).delete(synchronize_session=False)
    if account_ids:
        db.query(Transaction).filter(touches_accounts(Transaction, account_ids)).delete(
            synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    db.close()


def test_summaries_count_top_ups_by_source_account_not_by_creator(client, two_owners):
    from datetime import datetime
    from app.models.account import Account, AccountType
    from app.models.transaction import Transaction, TransactionType

    db = two_owners["db"]
    a, b = two_owners["users"]
    headers_a, headers_b = two_owners["headers"]
    bank_a = Account(user_id=a.id, name="A Bank", account_type=AccountType.SAVINGS,
                     balance=10000)
    bank_b = Account(user_id=b.id, name="B Bank", account_type=AccountType.SAVINGS,
                     balance=10000)
    wallet_b = Account(user_id=b.id, name="B GCash", account_type=AccountType.E_WALLET,
                       balance=0, is_spending_wallet=True)
    db.add_all([bank_a, bank_b, wallet_b])
    db.commit()

    def transfer(creator, src, dst, amount, fee):
        t = Transaction(user_id=creator.id, account_id=src.id, transfer_from_account_id=src.id,
                        transfer_to_account_id=dst.id, amount=Decimal(amount),
                        transfer_fee=Decimal(fee), transaction_type=TransactionType.TRANSFER,
                        transaction_date=datetime(2026, 9, 15))
        db.add(t)
        db.commit()
        return t

    # B's own spending stays out of A's summary.
    r = client.post(f"{API}/transactions/", headers=headers_b, json={
        "account_id": bank_b.id, "amount": 70, "transaction_type": "debit",
        "transaction_date": WHEN})
    assert r.status_code == 200, r.text

    # A's bank tops up B's wallet, created by B (written directly: the API
    # refuses a record across two owners' accounts).
    a_top_up = transfer(b, bank_a, wallet_b, "1000", "10")
    # B's bank tops up B's wallet, created by A.
    transfer(a, bank_b, wallet_b, "300", "0")

    # B's wallet is hidden from A, so A's summary can't read it as a wallet: the
    # top-up is a plain transfer out with its fee (audit round 1, A).
    assert _summary(client, headers_a) == (Decimal("10"), {"Transfer fees": Decimal("10")})
    assert _summary(client, headers_b) == (Decimal("370"), {
        "Uncategorized": Decimal("70"), "Unallocated wallet spend": Decimal("300")})

    # Moving the source moves the spend with it.
    a_top_up.transfer_from_account_id = a_top_up.account_id = bank_b.id
    db.commit()
    assert _summary(client, headers_a)[0] == Decimal("0")
    assert _summary(client, headers_b)[0] == Decimal("1380")

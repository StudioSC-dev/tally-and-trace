"""Per-user export routes and their explicit schema (STU-229).

``GET /data/export.json`` and ``GET /data/export.csv`` (one table, or a ZIP of
all of them) export the caller's own records in full, plus a limited view of
records another user made on an account the caller owns. Every field is named
by the export schema, never read off the ORM. They replace the entity export
routes. Everything goes through the HTTP layer, on throwaway users. Skips
without a database.
"""
import csv
import io
import json
import os
import secrets
import zipfile
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
WHEN = "2026-10-05T00:00:00"
OWNER_MARK = "Xq9Mine"
OTHER_MARK = "Xq9Theirs"


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


def _post(client, headers, path, body):
    r = client.post(f"{API}{path}", json=body, headers=headers)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture
def world(client, db):
    """An owner with one record of every kind, another user with their own, and a
    legacy transfer the other user made into the owner's bank."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.category import Category
    from app.models.transaction import RecurrenceFrequency, Transaction, TransactionType
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    made, sides = [], {}
    for side, mark in (("owner", OWNER_MARK), ("other", OTHER_MARK)):
        email = f"export-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Export", last_name=side, is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        made.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        bank = _post(client, h, "/accounts/", {
            "name": f"{mark} Bank", "account_type": "checking", "balance": 10_000})
        category = _post(client, h, "/categories/", {"name": f"{mark} Food"})
        sides[side] = {
            "id": u.id, "email": email, "headers": h, "bank": bank, "category": category,
            "allocation": _post(client, h, "/allocations/", {
                "account_id": bank, "name": f"{mark} Fund", "allocation_type": "budget",
                "configuration": {"category_ids": [category]}}),
            "transaction": _post(client, h, "/transactions/", {
                "account_id": bank, "amount": 25, "transaction_type": "debit",
                "transaction_date": WHEN, "description": f"{mark} lunch",
                "category_id": category}),
            "entry": _post(client, h, "/budget-entries/", {
                "name": f"{mark} Rent", "entry_type": "expense", "amount": 900,
                "next_occurrence": WHEN, "account_id": bank}),
            "accountless": _post(client, h, "/budget-entries/", {
                "name": f"{mark} Side gig", "entry_type": "income", "amount": 300,
                "next_occurrence": WHEN}),
            "wish": _post(client, h, "/wishlist/", {
                "name": f"{mark} Bike", "estimated_cost": 500, "category_id": category}),
        }
    owner, other = sides["owner"], sides["other"]
    # Legacy data: the API refuses a record across two owners' accounts now.
    legacy = Transaction(
        user_id=other["id"], account_id=other["bank"], amount=Decimal("1000"),
        transfer_fee=Decimal("40"), transaction_type=TransactionType.TRANSFER,
        transfer_from_account_id=other["bank"], transfer_to_account_id=owner["bank"],
        transaction_date=datetime(2026, 10, 6), description=f"{OTHER_MARK} secret",
        category_id=other["category"], receipt_url=f"/{OTHER_MARK}.png", is_posted=False)
    legacy_entry = BudgetEntry(
        user_id=other["id"], name=f"{OTHER_MARK} allowance", entry_type=BudgetEntryType.EXPENSE,
        amount=Decimal("50"), cadence=RecurrenceFrequency.MONTHLY, next_occurrence=datetime(2026, 10, 7),
        account_id=other["bank"], transfer_to_account_id=owner["bank"],
        category_id=other["category"])
    db.add_all([legacy, legacy_entry])
    db.commit()
    sides["legacy"], sides["legacy_entry"] = legacy.id, legacy_entry.id

    yield sides

    db.rollback()
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation, Category):
        db.query(model).filter(model.user_id.in_(made)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(made)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(made)).delete(synchronize_session=False)
    db.commit()


def _export(client, who):
    r = client.get(f"{API}/data/export.json", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/json")
    assert "attachment" in r.headers["content-disposition"]
    return r


def test_json_export_follows_the_explicit_schema(client, world):
    from app.services.export import EXPORT_VERSION, TABLE_FIELDS, USER_FIELDS

    body = _export(client, world["owner"]).json()

    assert set(body) == {"export_version", "exported_at", "user", *TABLE_FIELDS}
    assert body["export_version"] == EXPORT_VERSION
    assert set(body["user"]) == set(USER_FIELDS)
    assert body["user"]["email"] == world["owner"]["email"]
    for table, fields in TABLE_FIELDS.items():
        for row in body[table]:
            assert list(row) == list(fields), table


def test_json_export_holds_the_owners_records_in_full(client, world):
    owner = world["owner"]
    body = _export(client, owner).json()

    assert [a["id"] for a in body["accounts"]] == [owner["bank"]]
    assert [t["id"] for t in body["transactions"]] == [owner["transaction"]]
    assert sorted(e["id"] for e in body["budget_entries"]) == sorted(
        [owner["entry"], owner["accountless"]])
    assert [c["id"] for c in body["categories"]] == [owner["category"]]
    assert [a["id"] for a in body["allocations"]] == [owner["allocation"]]
    assert body["allocations"][0]["configuration"] == {"category_ids": [owner["category"]]}
    assert [w["id"] for w in body["wishlist_items"]] == [owner["wish"]]
    txn = body["transactions"][0]
    assert (txn["description"], txn["category_id"], txn["amount"]) == (
        f"{OWNER_MARK} lunch", owner["category"], "25.00")


def test_records_by_others_on_the_owners_accounts_are_limited(client, world):
    owner = world["owner"]
    body = _export(client, owner).json()

    assert body["others_transactions"] == [{
        "id": world["legacy"], "transaction_date": "2026-10-06T00:00:00+00:00",
        # The source is not the owner's: one total, no fee split.
        "amount": "1040.00", "transfer_fee": None, "currency": "PHP",
        "transaction_type": "transfer", "is_posted": False,
        "account_id": None, "transfer_from_account_id": None,
        "transfer_to_account_id": owner["bank"],
    }]
    (entry,) = body["others_budget_entries"]
    assert entry["id"] == world["legacy_entry"]
    assert (entry["account_id"], entry["transfer_to_account_id"]) == (None, owner["bank"])
    assert "name" not in entry and "category_id" not in entry


def test_the_export_never_carries_another_users_details_or_unlisted_columns(client, world):
    for who, foreign in (("owner", OTHER_MARK), ("other", OWNER_MARK)):
        raw = _export(client, world[who]).text
        assert foreign not in raw, who
        for column in ("password_hash", "entity_id", "user_id"):
            assert f'"{column}"' not in raw, (who, column)
    other = _export(client, world["other"]).json()
    assert [a["id"] for a in other["accounts"]] == [world["other"]["bank"]]
    assert world["legacy"] in [t["id"] for t in other["transactions"]]
    assert other["others_transactions"] == [] and other["others_budget_entries"] == []


def test_csv_export_of_one_table_uses_the_schema_header(client, world):
    from app.services.export import TABLE_FIELDS

    owner = world["owner"]
    for table, fields in TABLE_FIELDS.items():
        r = client.get(f"{API}/data/export.csv", params={"table": table},
                       headers=owner["headers"])
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("text/csv")
        rows = list(csv.reader(io.StringIO(r.text)))
        assert rows[0] == list(fields), table
        assert OTHER_MARK not in r.text, table
    r = client.get(f"{API}/data/export.csv", params={"table": "transactions"},
                   headers=owner["headers"])
    (row,) = csv.DictReader(io.StringIO(r.text))
    assert (row["id"], row["description"]) == (str(owner["transaction"]), f"{OWNER_MARK} lunch")
    r = client.get(f"{API}/data/export.csv", params={"table": "allocations"},
                   headers=owner["headers"])
    (row,) = csv.DictReader(io.StringIO(r.text))
    assert json.loads(row["configuration"]) == {"category_ids": [owner["category"]]}


def test_csv_export_without_a_table_is_a_zip_of_every_table(client, world):
    from app.services.export import TABLE_FIELDS

    r = client.get(f"{API}/data/export.csv", headers=world["owner"]["headers"])
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert sorted(zf.namelist()) == sorted(f"{t}.csv" for t in TABLE_FIELDS)
        for table, fields in TABLE_FIELDS.items():
            content = zf.read(f"{table}.csv").decode()
            assert next(csv.reader(io.StringIO(content))) == list(fields), table
            assert OTHER_MARK not in content, table
        legacy = list(csv.DictReader(io.StringIO(zf.read("others_transactions.csv").decode())))
        assert [row["id"] for row in legacy] == [str(world["legacy"])]


def test_an_unknown_csv_table_is_rejected(client, world):
    r = client.get(f"{API}/data/export.csv", params={"table": "users"},
                   headers=world["owner"]["headers"])
    assert r.status_code == 400


def test_exports_need_a_login_and_the_entity_routes_are_gone(client, world):
    for path in ("/data/export.json", "/data/export.csv"):
        assert client.get(f"{API}{path}").status_code in (401, 403)
    for path in ("/data/entities/1/export.json", "/data/entities/1/export.csv"):
        assert client.get(f"{API}{path}", headers=world["owner"]["headers"]).status_code == 404

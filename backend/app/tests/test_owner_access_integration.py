"""A second user can't reach the owner's records through any router (STU-229).

Access is computed from accounts (``app/core/access.py``): a record is readable
and writable by its creator and by the owner of the accounts it touches, and
categories, allocations and wishlist items are their owner's alone. With no
shares, that is "your own records only", and a miss is 404, never 403.

The sweep covers every route with an id in its path (a guard test fails when a
new one is added without joining the sweep), the create routes that take an
account id, and every list and aggregate route. Everything goes through the
HTTP layer, on throwaway users. Skips without a database.
"""
import json
import os
import secrets

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
MARK = "Zq7Owner"  # in every name the owner creates; never in the stranger's responses


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
def people(client, db):
    """Factory for throwaway logged-in users; everything they made is removed."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    users = []

    def make():
        email = f"access-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Access", last_name="Probe", is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        users.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": u.id, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    yield make

    db.rollback()
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation):
        db.query(model).filter(model.user_id.in_(users)).delete(synchronize_session=False)
    db.query(Category).filter(Category.user_id.in_(users)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(users)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
    db.commit()


def _post(client, who, path, body):
    r = client.post(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code in (200, 201), r.text
    return r.json()


@pytest.fixture
def world(client, people):
    """An owner with one of every kind of record, and a stranger with a bank of their own."""
    owner, stranger = people(), people()
    bank = _post(client, owner, "/accounts/", {
        "name": f"{MARK} Bank", "account_type": "checking", "balance": 50_000})
    card = _post(client, owner, "/accounts/", {
        "name": f"{MARK} Card", "account_type": "credit", "balance": 0,
        "billing_cycle_start": 15, "days_until_due_date": 21, "payment_account_id": bank["id"]})
    loan = _post(client, owner, "/accounts/", {
        "name": f"{MARK} Loan", "account_type": "loan", "loan_kind": "auto",
        "balance": -100_000, "loan_annual_rate": 10, "loan_term_months": 24,
        "loan_payment_amount": 4_615, "loan_first_payment_date": "2026-10-04",
        "payment_account_id": bank["id"]})
    category = _post(client, owner, "/categories/", {"name": f"{MARK} Groceries"})
    allocation = _post(client, owner, "/allocations/", {
        "account_id": bank["id"], "name": f"{MARK} Fund", "allocation_type": "savings",
        "target_amount": 10_000})
    txn = _post(client, owner, "/transactions/", {
        "account_id": bank["id"], "amount": 1_234, "transaction_type": "debit",
        "transaction_date": WHEN, "description": f"{MARK} groceries",
        "category_id": category["id"]})
    entry = _post(client, owner, "/budget-entries/", {
        "name": f"{MARK} Rent", "entry_type": "expense", "amount": 9_876,
        "next_occurrence": WHEN, "account_id": bank["id"], "category_id": category["id"]})
    accountless = _post(client, owner, "/budget-entries/", {
        "name": f"{MARK} Side gig", "entry_type": "income", "amount": 4_321,
        "next_occurrence": WHEN})
    wish = _post(client, owner, "/wishlist/", {"name": f"{MARK} Bike", "estimated_cost": 500})
    stranger_bank = _post(client, stranger, "/accounts/", {
        "name": "Stranger bank", "account_type": "checking", "balance": 1_000})
    return {
        "owner": owner, "stranger": stranger, "bank": bank["id"], "card": card["id"],
        "loan": loan["id"], "category": category["id"], "allocation": allocation["id"],
        "transaction": txn["id"], "entry": entry["id"], "accountless": accountless["id"],
        "wish": wish["id"], "stranger_bank": stranger_bank["id"],
    }


def _id_routes(w):
    """(method, path, kwargs) for every route with an id, on the owner's records."""
    sb = w["stranger_bank"]
    routes = [
        ("get", f"/accounts/{w['bank']}", {}),
        ("put", f"/accounts/{w['bank']}", {"json": {"name": "Taken"}}),
        ("delete", f"/accounts/{w['card']}", {}),
        ("get", f"/accounts/{w['bank']}/balance", {}),
        ("get", f"/accounts/{w['loan']}/loan-schedule", {}),
        ("post", f"/accounts/{w['loan']}/loan-payment",
         {"json": {"from_account_id": sb, "principal": 100, "interest": 0}}),
        ("post", f"/accounts/{w['loan']}/loan-prepayment",
         {"json": {"from_account_id": sb, "amount": 100}}),
        ("get", f"/transactions/{w['transaction']}", {}),
        ("put", f"/transactions/{w['transaction']}", {"json": {"amount": 1}}),
        ("delete", f"/transactions/{w['transaction']}", {}),
        ("post", f"/transactions/{w['transaction']}/upload-receipt",
         {"files": {"file": ("r.png", b"x", "image/png")}}),
        ("get", f"/categories/{w['category']}", {}),
        ("put", f"/categories/{w['category']}", {"json": {"name": "Taken"}}),
        ("delete", f"/categories/{w['category']}", {}),
        ("get", f"/allocations/{w['allocation']}", {}),
        ("put", f"/allocations/{w['allocation']}", {"json": {"name": "Taken"}}),
        ("delete", f"/allocations/{w['allocation']}", {}),
        ("get", f"/allocations/{w['allocation']}/progress", {}),
        ("get", f"/budget-entries/{w['entry']}", {}),
        ("put", f"/budget-entries/{w['entry']}", {"json": {"amount": 1}}),
        ("delete", f"/budget-entries/{w['entry']}", {}),
        ("post", f"/budget-entries/{w['entry']}/materialize", {}),
        ("get", f"/budget-entries/{w['accountless']}", {}),
        ("put", f"/budget-entries/{w['accountless']}", {"json": {"amount": 1}}),
        ("delete", f"/budget-entries/{w['accountless']}", {}),
        ("post", f"/budget-entries/{w['accountless']}/materialize", {}),
        ("get", f"/wishlist/{w['wish']}", {}),
        ("put", f"/wishlist/{w['wish']}", {"json": {"name": "Taken"}}),
        ("delete", f"/wishlist/{w['wish']}", {}),
        ("get", f"/wishlist/{w['wish']}/readiness", {}),
    ]
    return routes


def _create_routes(w):
    """Creates by the stranger that point at the owner's accounts or records."""
    sb, bank = w["stranger_bank"], w["bank"]
    return [
        ("/transactions/", {"account_id": bank, "amount": 1, "transaction_type": "debit",
                            "transaction_date": WHEN}),
        ("/transactions/", {"account_id": sb, "amount": 1, "transaction_type": "transfer",
                            "transaction_date": WHEN, "transfer_from_account_id": sb,
                            "transfer_to_account_id": bank}),
        ("/transactions/", {"account_id": sb, "amount": 1, "transaction_type": "transfer",
                            "transaction_date": WHEN, "transfer_from_account_id": sb,
                            "transfer_to_account_id": w["loan"]}),
        ("/budget-entries/", {"name": "x", "entry_type": "expense", "amount": 1,
                              "next_occurrence": WHEN, "account_id": bank}),
        ("/budget-entries/", {"name": "x", "entry_type": "expense", "amount": 1,
                              "next_occurrence": WHEN, "account_id": sb,
                              "transfer_to_account_id": bank}),
        ("/budget-entries/", {"name": "x", "entry_type": "expense", "amount": 1,
                              "next_occurrence": WHEN, "account_id": sb,
                              "overflow_account_id": bank}),
        ("/allocations/", {"account_id": bank, "name": "x", "allocation_type": "savings"}),
        ("/accounts/", {"name": "x", "account_type": "credit", "balance": 0,
                        "payment_account_id": bank}),
        ("/accounts/", {"name": "x", "account_type": "loan", "loan_kind": "auto",
                        "balance": -1, "payment_account_id": bank}),
    ]


LIST_ROUTES = [
    ("/accounts/", {}),
    ("/transactions/", {}),
    ("/transactions/summary/period",
     {"start_date": "2026-10-01T00:00:00", "end_date": "2026-10-31T23:59:59"}),
    ("/categories/", {}),
    ("/allocations/", {}),
    ("/allocations/summary/goals", {}),
    ("/budget-entries/", {}),
    ("/wishlist/", {}),
    ("/wishlist/plan", {}),
    ("/dashboard/snapshot", {}),
    ("/forecast/cashflow", {}),
    ("/forecast/upcoming", {"days": 60}),
    ("/forecast/timeline", {"days": 60}),
    ("/forecast/disposable", {}),
]


def _snapshot(client, w):
    """The owner's view of their own records, to prove the sweep changed nothing."""
    owner = w["owner"]
    paths = [p for m, p, _ in _id_routes(w) if m == "get"]
    out = {}
    for p in paths:
        r = client.get(f"{API}{p}", headers=owner["headers"])
        assert r.status_code == 200, (p, r.text)
        out[p] = r.json()
    return out


def test_every_route_with_an_id_is_in_the_sweep(client, people):
    """A new route with an id must join the sweep (and be checked) before it can pass."""
    from app.main import app

    w = {k: 0 for k in ("bank", "card", "loan", "transaction", "category", "allocation",
                        "entry", "accountless", "wish", "stranger_bank")}
    swept = {(m.upper(), p.replace("/0", "/{id}")) for m, p, _ in _id_routes(w)}
    for path, ops in app.openapi()["paths"].items():
        if "{" not in path or not path.startswith(API) or "/entities/" in path:
            continue
        generic = path[len(API):]
        for name in ("account_id", "transaction_id", "category_id", "allocation_id",
                     "entry_id", "item_id"):
            generic = generic.replace("{" + name + "}", "{id}")
        for method in ops:
            assert (method.upper(), generic) in swept, (method, path)


def test_a_stranger_gets_404_on_every_route_with_an_owners_id(client, world):
    before = _snapshot(client, world)
    stranger = world["stranger"]
    for method, path, kw in _id_routes(world):
        r = getattr(client, method)(f"{API}{path}", headers=stranger["headers"], **kw)
        assert r.status_code == 404, (method, path, r.status_code, r.text)
        assert MARK not in r.text, (method, path)
    assert _snapshot(client, world) == before


def test_a_stranger_cannot_create_records_on_the_owners_accounts(client, world):
    stranger, owner = world["stranger"], world["owner"]
    before = _snapshot(client, world)
    for path, body in _create_routes(world):
        r = client.post(f"{API}{path}", json=body, headers=stranger["headers"])
        assert r.status_code == 404, (path, body, r.status_code, r.text)
        assert MARK not in r.text, (path, body)
    assert _snapshot(client, world) == before
    r = client.get(f"{API}/transactions/", headers=stranger["headers"])
    assert r.status_code == 200 and MARK not in r.text
    assert client.get(f"{API}/accounts/{world['stranger_bank']}",
                      headers=stranger["headers"]).json()["balance"] == 1_000.0
    assert len(client.get(f"{API}/accounts/", headers=owner["headers"]).json()) == 3


def test_list_and_aggregate_routes_show_a_stranger_nothing_of_the_owners(client, world):
    stranger, owner = world["stranger"], world["owner"]
    for path, params in LIST_ROUTES:
        r = client.get(f"{API}{path}", headers=stranger["headers"], params=params)
        assert r.status_code == 200, (path, r.text)
        assert MARK not in r.text, path
        for amount in ("1234", "9876", "4321"):
            assert amount not in json.dumps(r.json()).replace(".0", ""), (path, amount)
        # The owner sees their own records on the same routes.
        r = client.get(f"{API}{path}", headers=owner["headers"], params=params)
        assert r.status_code == 200, (path, r.text)


def test_the_owner_still_reaches_every_record_after_the_sweep(client, world):
    owner = world["owner"]
    for method, path, kw in _id_routes(world):
        if method == "get":
            r = client.get(f"{API}{path}", headers=owner["headers"])
            assert r.status_code == 200, (path, r.text)
    listed = client.get(f"{API}/budget-entries/", headers=owner["headers"]).json()
    ids = {e["id"] for e in (listed["items"] if isinstance(listed, dict) else listed)}
    assert {world["entry"], world["accountless"]} <= ids


def test_entity_headers_and_params_are_ignored(client, world):
    """The X-Entity-Id header and entity_id parameter no longer exist: they widen nothing."""
    stranger = world["stranger"]
    headers = {**stranger["headers"], "X-Entity-Id": "1"}
    for path, params in LIST_ROUTES:
        r = client.get(f"{API}{path}", headers=headers, params={**params, "entity_id": 1})
        assert r.status_code == 200, (path, r.text)
        assert MARK not in r.text, path
    r = client.get(f"{API}/transactions/{world['transaction']}", headers=headers)
    assert r.status_code == 404

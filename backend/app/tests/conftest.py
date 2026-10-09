"""Fixtures for the shared-account tests (STU-232), prefixed ``sw_`` so no
existing test module's own fixtures are shadowed.

``sw`` builds the household every shared-account test starts from, through the
HTTP layer: an owner (A) with a joint account shared with a partner (B,
editor), a viewer (V) and an admin (D), plus private accounts on both sides
and a stranger (S) with an account of their own. Every name the owner gives a
private record carries ``PRIVATE``; tests assert it never reaches anyone else.
"""
import os
import secrets
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text

API = "/api/v1"
PASSWORD = "Password123!"
PRIVATE = "Zq9Priv"  # in every private name of the owner's; never in anyone else's view


def sw_db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def sw_client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def sw_db(sw_client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def sw_people(sw_client, sw_db):
    """Factory for throwaway logged-in users; everything they made is removed."""
    from app.core.auth import get_password_hash
    from app.models.account import Account
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    db, client = sw_db, sw_client
    users = []

    def make(first="Share", last="Probe"):
        email = f"share-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name=first, last_name=last, is_verified=True)
        db.add(u)
        db.commit()
        db.refresh(u)
        users.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": u.id, "email": email,
                "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    yield make

    db.rollback()
    if not users:
        return
    owned = [a for (a,) in db.query(Account.id).filter(Account.user_id.in_(users))]
    db.query(Transaction).filter(Transaction.user_id.in_(users)).delete(synchronize_session=False)
    if owned:
        from app.core.access import touches_accounts
        db.query(Transaction).filter(touches_accounts(Transaction, owned)).delete(
            synchronize_session=False)
    for model in (BudgetEntry, WishlistItem, Allocation, Category):
        db.query(model).filter(model.user_id.in_(users)).delete(synchronize_session=False)
    db.query(Account).filter(Account.user_id.in_(users)).update(
        {"payment_account_id": None, "payment_overflow_account_id": None},
        synchronize_session=False)
    db.commit()
    db.query(Account).filter(Account.user_id.in_(users)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(users)).delete(synchronize_session=False)
    db.commit()


def sw_post(client, who, path, body, expect=(200, 201)):
    r = client.post(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code in expect, (path, r.status_code, r.text)
    return r.json()


def sw_share(db, account_id, user_id, role, created_by=None):
    """A share row, written directly (the share endpoints are tested on their own)."""
    from app.models.account_share import AccountShare

    share = AccountShare(account_id=account_id, user_id=user_id, role=role,
                         created_by=created_by)
    db.add(share)
    db.commit()
    return share.id


@pytest.fixture
def sw(sw_client, sw_db, sw_people):
    """The shared household (see the module docstring)."""
    client, db = sw_client, sw_db
    a = sw_people("Alice", "Owner")
    b = sw_people("Bea", "Partner")
    v = sw_people("Vic", "Viewer")
    d = sw_people("Dee", "Admin")
    s = sw_people("Sam", "Stranger")
    joint = sw_post(client, a, "/accounts/", {
        "name": "Joint account", "account_type": "checking", "balance": 10_000})["id"]
    a_private = sw_post(client, a, "/accounts/", {
        "name": f"{PRIVATE} bank", "account_type": "checking", "balance": 5_000,
        "description": f"{PRIVATE} description"})["id"]
    a_card = sw_post(client, a, "/accounts/", {
        "name": f"{PRIVATE} card", "account_type": "credit", "balance": 0,
        "billing_cycle_start": 15, "days_until_due_date": 21,
        "payment_account_id": a_private, "credit_limit": 77_777})["id"]
    a_loan = sw_post(client, a, "/accounts/", {
        "name": f"{PRIVATE} loan", "account_type": "loan", "loan_kind": "auto",
        "balance": -100_000, "loan_annual_rate": 12, "loan_term_months": 24,
        "loan_payment_amount": 5_000, "loan_first_payment_date": "2026-10-20",
        "payment_account_id": a_private})["id"]
    b_private = sw_post(client, b, "/accounts/", {
        "name": "Bea bank", "account_type": "checking", "balance": 3_000})["id"]
    s_bank = sw_post(client, s, "/accounts/", {
        "name": "Sam bank", "account_type": "checking", "balance": 1_000})["id"]
    shares = {
        "b": sw_share(db, joint, b["id"], "editor", a["id"]),
        "v": sw_share(db, joint, v["id"], "viewer", a["id"]),
        "d": sw_share(db, joint, d["id"], "admin", a["id"]),
    }
    return {
        "a": a, "b": b, "v": v, "d": d, "s": s, "joint": joint, "a_private": a_private,
        "a_card": a_card, "a_loan": a_loan, "b_private": b_private, "s_bank": s_bank,
        "shares": shares,
    }


def sw_money(value) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def sw_leaks(body, private_ids=(), numbers=(), path="$"):
    """Every leak in a JSON tree, envelopes included.

    A leak is a string containing ``PRIVATE``, a private id under any id key
    (``id``, ``*_id``, ``*_ids``), or one of ``numbers`` anywhere (a sentinel
    amount such as a hidden loan's interest).
    """
    private_ids = set(private_ids)
    numbers = {round(float(n), 2) for n in numbers}
    found = []

    def walk(node, where, key=None):
        if isinstance(node, dict):
            for k, v in node.items():
                if PRIVATE in str(k):
                    found.append((where, k))
                walk(v, f"{where}.{k}", k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{where}[{i}]", key)
        elif isinstance(node, str):
            if PRIVATE in node:
                found.append((where, node))
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            idish = key is not None and (key == "id" or key.endswith("_id") or key.endswith("_ids"))
            if idish and node in private_ids:
                found.append((where, node))
            if round(float(node), 2) in numbers:
                found.append((where, node))

    walk(body, path)
    return found

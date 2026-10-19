"""Fixtures for the shared-account tests (STU-232), prefixed ``sw_`` so no
existing test module's own fixtures are shadowed.

``sw`` builds the household every shared-account test starts from, through the
HTTP layer: an owner (A) with a joint account shared with a partner (B,
editor), a viewer (V) and an admin (D), plus private accounts on both sides
and a stranger (S) with an account of their own. Every name the owner gives a
private record carries ``PRIVATE``; tests assert it never reaches anyone else.
"""
# The database guard runs before anything else: no import below may reach `app` or
# `sqlalchemy` until DATABASE_URL has been vetted as a local throwaway database.
import os

from app.tests import _db_guard

_db_guard.guard()

import secrets  # noqa: E402
from datetime import datetime, timedelta  # noqa: E402
from decimal import Decimal  # noqa: E402

import pytest  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

API = "/api/v1"
PASSWORD = "Password123!"
PRIVATE = "Zq9Priv"  # in every private name of the owner's; never in anyone else's view


# --- Exchange rates (STU-236, plan B8) -------------------------------------------------------
# Tests never touch the network or the wall clock. Every request's ``get_fx`` and every
# offline service call reads FX_STORE (58.00 PHP per USD, fetched an hour before FX_REF)
# through a clock frozen at FX_REF, so the rate never goes stale whatever the date.

FX_REF = datetime(2026, 11, 2, 0, 0)  # naive UTC


def fx_clock() -> datetime:
    return FX_REF


class FxNoNetwork:
    """A rate provider that fails any test reaching it."""

    def fetch(self):
        raise AssertionError("the exchange-rate provider was reached from a test")


def _fx_store():
    from app.services.fx import MemoryRateStore, StoredRate

    fetched = FX_REF - timedelta(hours=1)
    return MemoryRateStore([
        StoredRate("USD", Decimal("1"), fetched.date(), fetched, "test"),
        StoredRate("PHP", Decimal("58.00"), fetched.date(), fetched, "test"),
    ])


FX_STORE = _fx_store()

# `_fx_store` imported app.services.fx, so the application's engine now exists.
from app.core.database import engine as _app_engine  # noqa: E402

_reason = _db_guard.check_engine(_app_engine.url, os.environ["DATABASE_URL"])
if _reason:
    pytest.exit(f"refusing: {_reason}", returncode=2)
_db_guard.require_reachable(_app_engine)


def fx_rates():
    """A fresh ``FxRates`` over the fixture store: what ``get_fx`` returns in tests."""
    from app.services.fx import FxRates

    return FxRates(FX_STORE, provider=FxNoNetwork(), clock=fx_clock, on_stale=lambda: None)


@pytest.fixture(scope="session", autouse=True)
def fx_fixture_rates():
    from app.main import app
    from app.services import fx

    saved = (fx._offline_factory, fx._refresher.provider, fx._refresher.clock)
    app.dependency_overrides[fx.get_fx] = fx_rates
    fx._offline_factory = lambda db: fx_rates()
    fx._refresher.provider = FxNoNetwork()
    fx._refresher.clock = fx_clock
    try:
        yield
    finally:
        app.dependency_overrides.pop(fx.get_fx, None)
        fx._offline_factory, fx._refresher.provider, fx._refresher.clock = saved


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


# --- Household tag shares (STU-233) ---------------------------------------------------------

def hh_household(db, who) -> int:
    """``who``'s Household system tag id (made when missing: ``sw_people`` users
    are created outside registration)."""
    from app.core.tags import ensure_household_tag

    tag = ensure_household_tag(db, who["id"])
    db.commit()
    return tag.id


def hh_tag_share(db, sharer, holder) -> int:
    """``sharer`` shares their Household tag with ``holder`` (a row, written directly;
    the endpoints are tested in ``test_household_shares_integration.py``)."""
    from app.models.tag_share import TagShare

    share = TagShare(tag_id=hh_household(db, sharer), user_id=holder["id"])
    db.add(share)
    db.commit()
    return share.id


@pytest.fixture
def hh(sw_client, sw_db, sw_people):
    """The Household-share world: owner A, partner B (editor on A's joint
    account), and a third user C holding both A's and B's Household tag shares.

    A's joint account carries A's Household tag. A also has a private bank,
    card (paid from the private bank), loan and spending wallet, every name
    carrying ``PRIVATE``. B and C each have a private bank. No records yet.
    """
    client, db = sw_client, sw_db
    a = sw_people("Alice", "Owner")
    b = sw_people("Bea", "Partner")
    c = sw_people("Cal", "Third")
    hh_a, hh_b, hh_c = (hh_household(db, w) for w in (a, b, c))
    joint = sw_post(client, a, "/accounts/", {
        "name": "Joint account", "account_type": "checking", "balance": 10_000,
        "tag_ids": [hh_a]})["id"]
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
    a_wallet = sw_post(client, a, "/accounts/", {
        "name": f"{PRIVATE} wallet", "account_type": "checking", "balance": 800,
        "is_spending_wallet": True})["id"]
    b_private = sw_post(client, b, "/accounts/", {
        "name": "Bea bank", "account_type": "checking", "balance": 3_000})["id"]
    c_private = sw_post(client, c, "/accounts/", {
        "name": "Cal bank", "account_type": "checking", "balance": 2_000})["id"]
    b_share = sw_share(db, joint, b["id"], "editor", a["id"])
    return {
        "a": a, "b": b, "c": c, "hh_a": hh_a, "hh_b": hh_b, "hh_c": hh_c,
        "joint": joint, "a_private": a_private, "a_card": a_card, "a_loan": a_loan,
        "a_wallet": a_wallet, "b_private": b_private, "c_private": c_private,
        "b_share": b_share,
        "a_to_c": hh_tag_share(db, a, c), "b_to_c": hh_tag_share(db, b, c),
    }

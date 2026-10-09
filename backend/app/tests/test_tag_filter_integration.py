"""``?tag=`` filters by effective tag (STU-231).

A record's effective tags are its own tags plus its owner's tags on the
accounts it is booked on: a transaction's ``account_id``, and on a transfer its
``transfer_from_account_id`` and ``transfer_to_account_id``; a recurring
entry's ``account_id`` and ``transfer_to_account_id`` (never its overflow
account). The filter covers the transaction, recurring-entry and account lists,
the period summary and every projection view; each record counts once, however
many ways it carries the tag. A tag the caller can't use (another user's, or
an unknown id) gets exactly the response of a tag with no records. Everything
goes through the HTTP layer, on throwaway users. Skips without a database.
"""
import json
import os
import secrets
from datetime import datetime, timedelta

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
UNKNOWN_TAG = 2_000_000_000
TODAY = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
PAST = (TODAY - timedelta(days=2)).isoformat()
SOON = (TODAY + timedelta(days=3)).isoformat()
NEXT = (TODAY + timedelta(days=5)).isoformat()
PERIOD = {"start_date": (TODAY - timedelta(days=10)).isoformat(),
          "end_date": (TODAY + timedelta(days=1)).isoformat()}


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
    """Factory for throwaway logged-in users with a Household tag; all removed afterwards."""
    from app.core.auth import get_password_hash
    from app.core.tags import ensure_household_tag
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction
    from app.models.user import User

    users = []

    def make():
        email = f"tagfilter-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Filter", last_name="Probe", is_verified=True)
        db.add(u)
        db.flush()
        ensure_household_tag(db, u)
        db.commit()
        users.append(u.id)
        r = client.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD})
        assert r.status_code == 200, r.text
        return {"id": u.id, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}

    yield make

    db.rollback()
    for model in (Transaction, BudgetEntry):
        db.query(model).filter(model.user_id.in_(users)).delete(synchronize_session=False)
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


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, params, r.text)
    return r.json()


@pytest.fixture
def world(client, db, people):
    """An owner's records, tagged Household and Business in every way that counts,
    and some that must not; plus a stranger with a tag of their own on their records."""
    from app.models.transaction import Transaction, TransactionType

    owner, stranger = people(), people()
    (household,) = [t["id"] for t in _get(client, owner, "/tags/") if t["is_system"]]
    business = _post(client, owner, "/tags/", {"name": "Business"})["id"]
    unused = _post(client, owner, "/tags/", {"name": "Unused"})["id"]
    foreign = _post(client, stranger, "/tags/", {"name": "Zq7Foreign"})["id"]

    bank = _post(client, owner, "/accounts/", {
        "name": "Bank", "account_type": "checking", "balance": 10_000})["id"]
    home = _post(client, owner, "/accounts/", {
        "name": "Home", "account_type": "savings", "balance": 5_000,
        "tag_ids": [household]})["id"]
    card = _post(client, owner, "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 1,
        "days_until_due_date": 10, "payment_account_id": bank, "tag_ids": [business]})["id"]

    def txn(account, amount, kind="debit", posted=True, when=PAST, tags=(), **extra):
        return _post(client, owner, "/transactions/", {
            "account_id": account, "amount": amount, "transaction_type": kind,
            "transaction_date": when, "is_posted": posted, "description": f"T{amount}",
            "tag_ids": list(tags), **extra})["id"]

    t = {
        "biz": txn(bank, 100, tags=[business]),
        "home_untagged": txn(home, 200),                      # via its account
        "home_tagged": txn(home, 300, tags=[household]),      # both ways: counted once
        "transfer_in": txn(bank, 400, kind="transfer", transfer_from_account_id=bank,
                           transfer_to_account_id=home),      # via its destination
        "plain": txn(bank, 600, kind="credit"),
        "pending_home": txn(home, 700, posted=False, when=SOON, tags=[household]),
        "pending_plain": txn(bank, 800, posted=False, when=SOON),
        "card_charge": txn(card, 900, posted=False, when=SOON),
    }
    # A debit carrying a stale transfer_to on Home (only a direct write leaves one):
    # transfer fields count only on a transfer, so it is not Household.
    stale = Transaction(
        user_id=owner["id"], account_id=bank, transfer_to_account_id=home, amount=500,
        currency="PHP", transaction_type=TransactionType.DEBIT, is_posted=True,
        transaction_date=datetime.fromisoformat(PAST), description="T500", transfer_fee=0)
    db.add(stale)
    db.commit()
    t["stale"] = stale.id

    def entry(name, amount, account=None, tags=(), **extra):
        return _post(client, owner, "/budget-entries/", {
            "name": name, "entry_type": "expense", "amount": amount, "cadence": "annual",
            "next_occurrence": NEXT, "account_id": account, "tag_ids": list(tags),
            **extra})["id"]

    e = {
        "home_bill": entry("E50", 50, home),                              # via its account
        "biz_bill": entry("E70", 70, bank, tags=[business]),
        "to_home": entry("E80", 80, bank, transfer_to_account_id=home),   # via its destination
        "overflow_home": entry("E90", 90, bank, overflow_account_id=home),  # overflow: no
        "home_tagged": entry("E60", 60, home, tags=[household]),          # both ways: once
        "plain": entry("E40", 40, bank),
    }
    stranger_bank = _post(client, stranger, "/accounts/", {
        "name": "Stranger bank", "account_type": "checking", "balance": 100,
        "tag_ids": [foreign]})["id"]
    _post(client, stranger, "/transactions/", {
        "account_id": stranger_bank, "amount": 1, "transaction_type": "debit",
        "transaction_date": PAST, "tag_ids": [foreign]})
    return {"owner": owner, "household": household, "business": business, "unused": unused,
            "foreign": foreign, "bank": bank, "home": home, "card": card, "t": t, "e": e}


def _ids(page):
    return sorted(r["id"] for r in page["items"])


def test_transaction_list_filters_by_effective_tag(client, world):
    owner, t = world["owner"], world["t"]
    page = _get(client, owner, "/transactions/", tag=world["household"], limit=100)
    assert _ids(page) == sorted([t["home_untagged"], t["home_tagged"], t["transfer_in"],
                                 t["pending_home"]])
    assert page["total"] == 4 and page["has_more"] is False
    page = _get(client, owner, "/transactions/", tag=world["business"], limit=100)
    assert _ids(page) == sorted([t["biz"], t["card_charge"]])
    # Paging counts each row once.
    first = _get(client, owner, "/transactions/", tag=world["household"], limit=3)
    assert (first["total"], len(first["items"]), first["has_more"]) == (4, 3, True)


def test_recurring_entry_list_filters_by_effective_tag(client, world):
    owner, e = world["owner"], world["e"]
    page = _get(client, owner, "/budget-entries/", tag=world["household"])
    assert _ids(page) == sorted([e["home_bill"], e["to_home"], e["home_tagged"]])
    assert page["total"] == 3
    page = _get(client, owner, "/budget-entries/", tag=world["business"])
    assert _ids(page) == [e["biz_bill"]]


def test_account_list_filters_by_the_accounts_own_tags(client, world):
    owner = world["owner"]
    page = _get(client, owner, "/accounts/", tag=world["household"])
    assert _ids(page) == [world["home"]] and page["total"] == 1
    page = _get(client, owner, "/accounts/", tag=world["business"])
    assert _ids(page) == [world["card"]]


def test_period_summary_totals_are_exact(client, world):
    owner = world["owner"]
    summary = _get(client, owner, "/transactions/summary/period", tag=world["household"],
                   **PERIOD)["summary"]
    # 200 + 300 posted on Home; the transfer into Home moves no expense (no fee).
    assert summary == {"total_income": 0, "total_expenses": 500, "net_flow": -500,
                       "transaction_count": 3}
    summary = _get(client, owner, "/transactions/summary/period", tag=world["business"],
                   **PERIOD)["summary"]
    assert summary == {"total_income": 0, "total_expenses": 100, "net_flow": -100,
                       "transaction_count": 1}
    whole = _get(client, owner, "/transactions/summary/period", **PERIOD)["summary"]
    assert whole["transaction_count"] == 6  # 5 posted through the API + the stale row


def test_disposable_income_counts_each_tagged_entry_once(client, world):
    owner = world["owner"]
    # Annual entries: a twelfth a month. Home bill 50 + Home tagged 60; the transfer
    # into Home moves the caller's own money, so it is no expense.
    result = _get(client, owner, "/forecast/disposable", tag=world["household"])
    assert result == {"monthly_income": 0.0, "monthly_expenses": round(110 / 12, 2),
                      "monthly_disposable": round(-110 / 12, 2)}


def _sources(items):
    return sorted((i["source"], i["source_id"]) for i in items)


def test_projection_views_keep_only_tagged_events_each_once(client, world):
    owner, t, e = world["owner"], world["t"], world["e"]
    household = [("budget_entry", e["home_bill"]), ("budget_entry", e["home_tagged"]),
                 ("budget_entry", e["to_home"]), ("transaction", t["pending_home"])]

    upcoming = _get(client, owner, "/forecast/upcoming", days=20, tag=world["household"])
    assert _sources(upcoming["items"]) == sorted(household)

    whole = _get(client, owner, "/forecast/timeline", days=20)
    tagged = _get(client, owner, "/forecast/timeline", days=20, tag=world["household"])
    assert _sources(tagged["events"]) == sorted(household)
    # Same scope and opening; only the tagged cash moves: -(50 + 60 + 700), and the
    # transfer from Bank into Home moves no pooled cash.
    assert tagged["opening_balance"] == whole["opening_balance"] == 15_000
    assert tagged["closing_balance"] == 15_000 - 810
    closings = {a["account_name"]: a["closing_balance"] for a in tagged["by_account"]}
    # Posted rows already moved the balances: Bank 10,100 and Home 4,900 today.
    assert closings == {"Bank": 10_100 - 80, "Home": 4_900 - 50 - 60 - 700 + 80}

    periods = _get(client, owner, "/forecast/cashflow", months=2,
                   tag=world["household"])["periods"]
    assert sum(p["net"] for p in periods) == -810
    assert sum(p["expenses"] for p in periods) == 110
    assert sum(p["unposted_expenses"] for p in periods) == 700

    snapshot = _get(client, owner, "/dashboard/snapshot", tag=world["household"])
    assert _sources(snapshot["upcoming_this_month"]) == sorted(household)
    assert sorted(p["name"] for p in snapshot["payables"]) == ["E50", "E60", "T700"]
    assert snapshot["balances"]["total"] == 15_000  # balances are not filtered


def test_statements_and_loan_dues_follow_their_accounts_tags(client, world):
    owner = world["owner"]
    business = _get(client, owner, "/forecast/upcoming", days=90, tag=world["business"])
    sources = _sources(business["items"])
    assert ("statement", world["card"]) in sources
    assert ("transaction", world["t"]["card_charge"]) in sources
    household = _get(client, owner, "/forecast/upcoming", days=90, tag=world["household"])
    assert all(s != "statement" for s, _ in _sources(household["items"]))


FILTERED_ROUTES = [
    ("/transactions/", {"limit": 100}),
    ("/transactions/summary/period", PERIOD),
    ("/budget-entries/", {}),
    ("/accounts/", {"limit": 100}),
    ("/forecast/cashflow", {"months": 2}),
    ("/forecast/upcoming", {"days": 90}),
    ("/forecast/timeline", {"days": 90}),
    ("/forecast/disposable", {}),
    ("/dashboard/snapshot", {}),
]


@pytest.mark.parametrize("path,params", FILTERED_ROUTES)
def test_another_users_tag_gets_exactly_the_unknown_id_response(client, world, path, params):
    owner = world["owner"]
    foreign = _get(client, owner, path, tag=world["foreign"], **params)
    unknown = _get(client, owner, path, tag=UNKNOWN_TAG, **params)
    unused = _get(client, owner, path, tag=world["unused"], **params)
    assert foreign == unknown == unused
    assert "Zq7Foreign" not in json.dumps(foreign)
    whole = _get(client, owner, path, **params)
    if path in ("/transactions/", "/budget-entries/", "/accounts/"):
        assert foreign["items"] == [] and foreign["total"] == 0
        assert whole["total"] > 0
    elif path == "/transactions/summary/period":
        assert foreign["summary"]["transaction_count"] == 0
    elif path == "/forecast/upcoming":
        assert foreign["items"] == [] and whole["items"]
    elif path == "/forecast/timeline":
        assert foreign["events"] == [] and whole["events"]

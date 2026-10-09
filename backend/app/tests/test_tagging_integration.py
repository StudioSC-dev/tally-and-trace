"""Tagging accounts, transactions and recurring entries (STU-231).

``tag_ids`` on create puts the caller's own tags on the record; on update an
omitted field leaves them, a list replaces them and null is refused. Every
response carries ``tags``: the record's explicit tags the caller may see (their
own), never another user's. A user tags only with their own tags (another
user's id and an unknown id get the same 404) and only a record they may edit
(its write rule). Materialising a recurring entry copies its explicit tags onto
the new transaction, once. Everything goes through the HTTP layer, on
throwaway users. Skips without a database.
"""
import os
import secrets
from datetime import datetime

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
UNKNOWN_TAG = 2_000_000_000


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
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.category import Category
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.models.wishlist_item import WishlistItem

    users = []

    def make():
        email = f"tagging-{secrets.token_hex(6)}@example.com"
        u = User(email=email, password_hash=get_password_hash(PASSWORD),
                 first_name="Tagging", last_name="Probe", is_verified=True)
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
    for model in (Transaction, BudgetEntry, WishlistItem, Allocation, Category):
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


def _tag(client, who, name):
    return _post(client, who, "/tags/", {"name": name})


def _names(record):
    return [t["name"] for t in record["tags"]]


# The three taggable resources: (base path, create body given a bank id).
RESOURCES = {
    "account": ("/accounts/", lambda bank: {
        "name": "Tagged bank", "account_type": "savings", "balance": 0}),
    "transaction": ("/transactions/", lambda bank: {
        "account_id": bank, "amount": 10, "transaction_type": "debit",
        "transaction_date": WHEN, "description": "Tagged row"}),
    "entry": ("/budget-entries/", lambda bank: {
        "name": "Tagged bill", "entry_type": "expense", "amount": 10,
        "next_occurrence": WHEN, "account_id": bank}),
}


@pytest.fixture
def owner_world(client, people):
    owner, stranger = people(), people()
    bank = _post(client, owner, "/accounts/", {
        "name": "Owner bank", "account_type": "checking", "balance": 1_000})["id"]
    return {
        "owner": owner, "stranger": stranger, "bank": bank,
        "business": _tag(client, owner, "Business")["id"],
        "travel": _tag(client, owner, "Travel")["id"],
        "foreign": _tag(client, stranger, "Zq7Foreign")["id"],
    }


def _links(db, kind, record_id):
    table, column = {
        "account": ("account_tags", "account_id"),
        "transaction": ("transaction_tags", "transaction_id"),
        "entry": ("budget_entry_tags", "budget_entry_id"),
    }[kind]
    return sorted(r[0] for r in db.execute(
        text(f"SELECT tag_id FROM {table} WHERE {column} = :r"), {"r": record_id}))


@pytest.mark.parametrize("kind", sorted(RESOURCES))
def test_create_update_and_read_tags(client, db, owner_world, kind):
    w, owner = owner_world, owner_world["owner"]
    base, body = RESOURCES[kind]
    created = _post(client, owner, base, {
        **body(w["bank"]), "tag_ids": [w["travel"], w["business"], w["business"]]})
    rid = created["id"]
    assert _names(created) == ["Business", "Travel"]
    assert {"id", "name", "color", "is_system"} == set(created["tags"][0])
    assert "tag_ids" not in created
    assert _names(client.get(f"{API}{base}{rid}", headers=owner["headers"]).json()) == [
        "Business", "Travel"]
    listed = client.get(f"{API}{base}", headers=owner["headers"], params={"limit": 200}).json()
    assert [_names(r) for r in listed["items"] if r["id"] == rid] == [["Business", "Travel"]]

    # An update that leaves tag_ids out keeps them.
    r = client.put(f"{API}{base}{rid}", headers=owner["headers"], json={"amount": 11}
                   if kind != "account" else {"name": "Renamed"})
    assert r.status_code == 200, r.text
    assert _names(r.json()) == ["Business", "Travel"]
    # A list replaces them.
    r = client.put(f"{API}{base}{rid}", headers=owner["headers"], json={"tag_ids": [w["travel"]]})
    assert r.status_code == 200, r.text
    assert _names(r.json()) == ["Travel"]
    assert _links(db, kind, rid) == [w["travel"]]
    # [] removes them; null is refused.
    r = client.put(f"{API}{base}{rid}", headers=owner["headers"], json={"tag_ids": None})
    assert r.status_code == 422, r.text
    r = client.put(f"{API}{base}{rid}", headers=owner["headers"], json={"tag_ids": []})
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == [] and _links(db, kind, rid) == []


@pytest.mark.parametrize("kind", sorted(RESOURCES))
def test_a_foreign_or_unknown_tag_id_is_refused_on_create_and_update(client, db, owner_world, kind):
    w, owner = owner_world, owner_world["owner"]
    base, body = RESOURCES[kind]
    before = client.get(f"{API}{base}", headers=owner["headers"], params={"limit": 200}).json()
    responses = []
    for bad in (w["foreign"], UNKNOWN_TAG):
        r = client.post(f"{API}{base}", headers=owner["headers"],
                        json={**body(w["bank"]), "tag_ids": [w["business"], bad]})
        assert r.status_code == 404, r.text
        responses.append(r.json())
    assert responses[0] == responses[1] == {"detail": "Tag not found"}
    after = client.get(f"{API}{base}", headers=owner["headers"], params={"limit": 200}).json()
    assert after["total"] == before["total"]  # nothing was created

    rid = _post(client, owner, base, {**body(w["bank"]), "tag_ids": [w["business"]]})["id"]
    responses = []
    for bad in (w["foreign"], UNKNOWN_TAG):
        r = client.put(f"{API}{base}{rid}", headers=owner["headers"],
                       json={"tag_ids": [bad], "description": "changed"}
                       if kind == "transaction" else {"tag_ids": [bad]})
        assert r.status_code == 404, r.text
        responses.append(r.json())
    assert responses[0] == responses[1] == {"detail": "Tag not found"}
    assert _links(db, kind, rid) == [w["business"]]
    if kind == "transaction":
        stored = client.get(f"{API}{base}{rid}", headers=owner["headers"]).json()
        assert stored["description"] == "Tagged row"  # the refused edit changed nothing


@pytest.mark.parametrize("kind", sorted(RESOURCES))
def test_tagging_another_users_record_is_refused(client, db, owner_world, kind):
    """No edit rights, no tagging: the stranger's own tag on the owner's record is 404."""
    w, owner, stranger = owner_world, owner_world["owner"], owner_world["stranger"]
    base, body = RESOURCES[kind]
    rid = _post(client, owner, base, {**body(w["bank"]), "tag_ids": [w["business"]]})["id"]
    r = client.put(f"{API}{base}{rid}", headers=stranger["headers"],
                   json={"tag_ids": [w["foreign"]]})
    assert r.status_code == 404, r.text
    assert "Zq7Foreign" not in r.text
    assert _links(db, kind, rid) == [w["business"]]


@pytest.fixture
def legacy(client, db, people):
    """B's transaction and entry on A's account (readable by both, writable by neither),
    each carrying one tag of A's and one of B's, as only a direct write could leave them."""
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import Transaction, TransactionType

    a, b = people(), people()
    bank = _post(client, a, "/accounts/", {
        "name": "A bank", "account_type": "checking", "balance": 1_000})["id"]
    a_tag, b_tag = _tag(client, a, "Zq7A tag")["id"], _tag(client, b, "Zq7B tag")["id"]
    txn = Transaction(
        user_id=b["id"], account_id=bank, amount=55, currency="PHP",
        transaction_type=TransactionType.DEBIT, transaction_date=datetime.fromisoformat(WHEN),
        description="Legacy row", is_posted=False, transfer_fee=0)
    entry = BudgetEntry(
        user_id=b["id"], account_id=bank, name="Legacy bill", amount=66, currency="PHP",
        entry_type=BudgetEntryType.EXPENSE, next_occurrence=datetime.fromisoformat(WHEN))
    db.add_all([txn, entry])
    db.commit()
    for tag in (a_tag, b_tag):
        db.execute(text("INSERT INTO transaction_tags VALUES (:t, :r)"), {"t": tag, "r": txn.id})
        db.execute(text("INSERT INTO budget_entry_tags VALUES (:t, :r)"),
                   {"t": tag, "r": entry.id})
    db.commit()
    return {"a": a, "b": b, "a_tag": a_tag, "b_tag": b_tag,
            "transaction": txn.id, "entry": entry.id}


@pytest.mark.parametrize("kind", ["transaction", "entry"])
def test_a_reader_without_edit_rights_cannot_tag_and_sees_only_their_own_tags(
        client, db, legacy, kind):
    base = "/transactions/" if kind == "transaction" else "/budget-entries/"
    rid = legacy[kind]
    for actor, own, other in (("a", "Zq7A tag", "Zq7B tag"), ("b", "Zq7B tag", "Zq7A tag")):
        who = legacy[actor]
        r = client.get(f"{API}{base}{rid}", headers=who["headers"])
        assert r.status_code == 200, r.text
        assert _names(r.json()) == [own]
        assert other not in r.text
        listed = client.get(f"{API}{base}", headers=who["headers"], params={"limit": 200})
        assert [_names(x) for x in listed.json()["items"] if x["id"] == rid] == [[own]]
        assert other not in listed.text
        # Both may read it, neither may edit it, so neither may tag it.
        r = client.put(f"{API}{base}{rid}", headers=who["headers"],
                       json={"tag_ids": [legacy[f"{actor}_tag"]]})
        assert r.status_code == 404, r.text
    assert _links(db, kind, rid) == sorted([legacy["a_tag"], legacy["b_tag"]])


def test_replacing_tags_keeps_tags_another_user_put_on_the_record(client, db, owner_world):
    w, owner = owner_world, owner_world["owner"]
    rid = _post(client, owner, "/transactions/", {
        **RESOURCES["transaction"][1](w["bank"]), "tag_ids": [w["business"]]})["id"]
    db.execute(text("INSERT INTO transaction_tags VALUES (:t, :r)"),
               {"t": w["foreign"], "r": rid})
    db.commit()
    r = client.put(f"{API}/transactions/{rid}", headers=owner["headers"],
                   json={"tag_ids": [w["travel"]]})
    assert r.status_code == 200, r.text
    assert _names(r.json()) == ["Travel"]  # the stranger's tag is never shown
    assert _links(db, "transaction", rid) == sorted([w["travel"], w["foreign"]])


def test_deleting_a_tag_removes_it_from_records(client, owner_world):
    w, owner = owner_world, owner_world["owner"]
    rid = _post(client, owner, "/transactions/", {
        **RESOURCES["transaction"][1](w["bank"]), "tag_ids": [w["business"], w["travel"]]})["id"]
    assert client.delete(f"{API}/tags/{w['business']}",
                         headers=owner["headers"]).status_code == 204
    assert _names(client.get(f"{API}/transactions/{rid}",
                             headers=owner["headers"]).json()) == ["Travel"]


def test_materialise_copies_explicit_tags_once(client, db, owner_world):
    """Explicit tags only (not the account's), and later entry changes don't propagate."""
    w, owner = owner_world, owner_world["owner"]
    r = client.put(f"{API}/accounts/{w['bank']}", headers=owner["headers"],
                   json={"tag_ids": [w["travel"]]})
    assert r.status_code == 200, r.text
    entry = _post(client, owner, "/budget-entries/", {
        **RESOURCES["entry"][1](w["bank"]), "tag_ids": [w["business"]]})
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=owner["headers"])
    assert r.status_code == 201, r.text
    txn = r.json()
    assert _names(txn) == ["Business"]
    assert _links(db, "transaction", txn["id"]) == [w["business"]]

    r = client.put(f"{API}/budget-entries/{entry['id']}", headers=owner["headers"],
                   json={"tag_ids": [w["travel"]]})
    assert r.status_code == 200, r.text
    assert _links(db, "transaction", txn["id"]) == [w["business"]]
    assert _names(client.get(f"{API}/transactions/{txn['id']}",
                             headers=owner["headers"]).json()) == ["Business"]
    # The next occurrence copies the entry's tags as they are now.
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=owner["headers"])
    assert r.status_code == 201, r.text
    assert _names(r.json()) == ["Travel"]


def test_materialise_ignores_links_from_other_users_tags(client, db, owner_world):
    """Only the entry owner's tags are copied, whatever sits in the link table."""
    w, owner = owner_world, owner_world["owner"]
    entry = _post(client, owner, "/budget-entries/", {
        **RESOURCES["entry"][1](w["bank"]), "tag_ids": [w["business"]]})
    db.execute(text("INSERT INTO budget_entry_tags (tag_id, budget_entry_id) VALUES (:t, :e)"),
               {"t": w["foreign"], "e": entry["id"]})
    db.commit()
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=owner["headers"])
    assert r.status_code == 201, r.text
    assert _links(db, "transaction", r.json()["id"]) == [w["business"]]


def test_a_failed_materialise_copies_no_tags(client, db, owner_world):
    """The copy is in the transaction's own commit: a refused post leaves nothing."""
    w, owner = owner_world, owner_world["owner"]
    loan = _post(client, owner, "/accounts/", {
        "name": "Owner loan", "account_type": "loan", "loan_kind": "auto", "balance": -100,
        "loan_annual_rate": 10, "loan_term_months": 12, "loan_payment_amount": 10,
        "loan_first_payment_date": "2026-10-04", "payment_account_id": w["bank"]})["id"]
    entry = _post(client, owner, "/budget-entries/", {
        "name": "Too big", "entry_type": "expense", "amount": 5_000,
        "next_occurrence": WHEN, "account_id": w["bank"], "transfer_to_account_id": loan,
        "tag_ids": [w["business"]]})
    before = db.execute(text("SELECT count(*) FROM transaction_tags")).scalar_one()
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=owner["headers"])
    assert r.status_code == 400, r.text
    assert db.execute(text("SELECT count(*) FROM transaction_tags")).scalar_one() == before


def test_loan_payment_responses_carry_tags(client, owner_world):
    w, owner = owner_world, owner_world["owner"]
    loan = _post(client, owner, "/accounts/", {
        "name": "Owner loan", "account_type": "loan", "loan_kind": "home", "balance": -100,
        "loan_annual_rate": 0, "loan_term_months": 12, "loan_payment_amount": 10,
        "loan_first_payment_date": "2026-10-04", "payment_account_id": w["bank"]})["id"]
    r = client.post(f"{API}/accounts/{loan}/loan-prepayment", headers=owner["headers"],
                    json={"amount": 5})
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == []

"""Description autofill: the suggestions endpoint (STU-626).

``GET /transactions/description-suggestions?q=`` lists the descriptions the caller
used before that start with ``q`` (case-insensitive), most recent first, up to 8,
each with the latest such row's type, account, category, tags and transfer accounts
(``app/services/description_suggestions.py``). The form's own rules (untouched
fields only, the amount never, Edit never) are in the frontend unit suite
``transaction_description_autofill`` and the e2e suite of the same name.

Scenarios: ``prefix_suggestions_order_and_limit`` (AC1),
``selection_uses_latest_transaction`` (AC2), ``unavailable_references_are_skipped``
(AC4), ``limited_rows_never_supply_suggestions`` (AC5), ``suggestions_query_budget``
and ``suggestions_realistic_fixture_latency`` (AC6), ``case_insensitive_matching``
(AC8). Skips without a database.
"""
from datetime import datetime, timedelta

import pytest

from app.tests.conftest import API, PRIVATE, hh_household, sw_db_reachable, sw_post
from app.tests.fixtures.suggestions import suggestion_reads

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

URL = f"{API}/transactions/description-suggestions"
DAY0 = datetime(2026, 10, 1, 9, 0)


def _when(days: int) -> str:
    return (DAY0 + timedelta(days=days)).isoformat()


def _suggest(client, who, q):
    r = client.get(URL, params={"q": q}, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["items"]


def _txn(client, who, account, description, days=0, **extra):
    body = {"account_id": account, "amount": 100, "transaction_type": "debit",
            "transaction_date": _when(days), "description": description, **extra}
    return sw_post(client, who, "/transactions/", body)


def _bank(client, who, name="Bank", **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "balance": 10_000, **extra})["id"]


# --- AC1: prefix, order, limit -----------------------------------------------------------------

def test_prefix_suggestions_order_and_limit(sw_client, sw_people):
    """Distinct descriptions starting with the prefix, most recent first, at most 8;
    a repeated description is listed once, at its latest use; others never match."""
    a = sw_people()
    bank = _bank(sw_client, a)
    for i in range(10):
        _txn(sw_client, a, bank, f"Shop {i}", days=i)
    _txn(sw_client, a, bank, "Shop 2", days=20)  # Shop 2 used again, latest of all
    _txn(sw_client, a, bank, "Market", days=30)
    _txn(sw_client, a, bank, "Workshop", days=31)  # contains "shop", does not start with it

    got = [s["description"] for s in _suggest(sw_client, a, "Shop")]
    assert got == ["Shop 2", "Shop 9", "Shop 8", "Shop 7", "Shop 6", "Shop 5", "Shop 4",
                   "Shop 3"]
    assert [s["description"] for s in _suggest(sw_client, a, "Mar")] == ["Market"]
    assert _suggest(sw_client, a, "Nothing like it") == []
    assert _suggest(sw_client, a, "   ") == []
    # LIKE wildcards in the prefix are literal.
    assert _suggest(sw_client, a, "%") == [] and _suggest(sw_client, a, "_hop") == []


# --- AC2: the latest matching row supplies every listed value ---------------------------------

def test_selection_uses_latest_transaction(sw_client, sw_people, sw_db):
    a = sw_people()
    bank = _bank(sw_client, a, "Old bank")
    savings = _bank(sw_client, a, "Savings")
    cash = _bank(sw_client, a, "Cash")
    old_cat = sw_post(sw_client, a, "/categories/", {"name": "Old"})["id"]
    new_cat = sw_post(sw_client, a, "/categories/", {"name": "New"})["id"]
    t1 = sw_post(sw_client, a, "/tags/", {"name": "One"})["id"]
    t2 = sw_post(sw_client, a, "/tags/", {"name": "Two"})["id"]
    _txn(sw_client, a, bank, "Rent", days=0, category_id=old_cat, tag_ids=[t1], amount=999)
    _txn(sw_client, a, cash, "Rent", days=5, category_id=new_cat, tag_ids=[t2, t1],
         amount=12_345)
    _txn(sw_client, a, bank, "Rent", days=2, category_id=old_cat)  # older by date, newer by id

    [rent] = _suggest(sw_client, a, "rent")
    assert rent == {"description": "Rent", "transaction_type": "debit", "account_id": cash,
                    "category_id": new_cat, "tag_ids": sorted([t1, t2]),
                    "transfer_from_account_id": None, "transfer_to_account_id": None}
    assert "amount" not in rent

    sw_post(sw_client, a, "/transactions/", {
        "account_id": bank, "amount": 500, "transaction_type": "transfer",
        "transaction_date": _when(1), "description": "To savings",
        "transfer_from_account_id": bank, "transfer_to_account_id": savings})
    sw_post(sw_client, a, "/transactions/", {
        "account_id": cash, "amount": 700, "transaction_type": "transfer",
        "transaction_date": _when(3), "description": "To savings",
        "transfer_from_account_id": cash, "transfer_to_account_id": savings})
    [move] = _suggest(sw_client, a, "To sav")
    assert move == {"description": "To savings", "transaction_type": "transfer",
                    "account_id": cash, "category_id": None, "tag_ids": [],
                    "transfer_from_account_id": cash, "transfer_to_account_id": savings}


# --- AC8: case ---------------------------------------------------------------------------------

def test_case_insensitive_matching(sw_client, sw_people):
    """Prefixes match whatever their case, and descriptions differing only in case are
    one suggestion, shown as its latest use spelled it."""
    a = sw_people()
    bank = _bank(sw_client, a)
    _txn(sw_client, a, bank, "coffee bean", days=0)
    _txn(sw_client, a, bank, "Coffee Bean", days=1)
    _txn(sw_client, a, bank, "COFFEE BEAN", days=2)
    for q in ("coffee", "COFFEE", "cOfFeE b", "Coffee Bean"):
        assert [s["description"] for s in _suggest(sw_client, a, q)] == ["COFFEE BEAN"], q


# --- AC4: references the caller can no longer use ----------------------------------------------

def test_unavailable_references_are_skipped(sw_client, sw_people, sw_db, sw):
    """A deactivated account, a deleted category and a deleted tag come back as null or
    left out; so do accounts the caller can still see but no longer add to (a share
    turned to viewer), the transfer from and to accounts included."""
    from app.models.account import Account
    from app.models.account_share import AccountShare

    a = sw_people()
    bank = _bank(sw_client, a, "Closing bank")
    other = _bank(sw_client, a, "Other bank")
    cat = sw_post(sw_client, a, "/categories/", {"name": "Gone soon"})["id"]
    keep_tag = sw_post(sw_client, a, "/tags/", {"name": "Keep"})["id"]
    gone_tag = sw_post(sw_client, a, "/tags/", {"name": "Gone"})["id"]
    _txn(sw_client, a, bank, "Gym", category_id=cat, tag_ids=[keep_tag, gone_tag])
    sw_post(sw_client, a, "/transactions/", {
        "account_id": bank, "amount": 50, "transaction_type": "transfer",
        "transaction_date": _when(0), "description": "Sweep",
        "transfer_from_account_id": bank, "transfer_to_account_id": other})

    assert sw_client.delete(f"{API}/categories/{cat}", headers=a["headers"]).status_code < 300
    assert sw_client.delete(f"{API}/tags/{gone_tag}", headers=a["headers"]).status_code < 300
    sw_db.query(Account).filter(Account.id == bank).update({"is_active": False})
    sw_db.commit()

    [gym] = _suggest(sw_client, a, "Gym")
    assert gym == {"description": "Gym", "transaction_type": "debit", "account_id": None,
                   "category_id": None, "tag_ids": [keep_tag],
                   "transfer_from_account_id": None, "transfer_to_account_id": None}
    [sweep] = _suggest(sw_client, a, "Sweep")
    assert sweep["transfer_from_account_id"] is None and sweep["account_id"] is None
    assert sweep["transfer_to_account_id"] == other

    # B, an editor on the joint account, records a transfer from it to their own bank;
    # then the share is turned to viewer: the row is still B's own and in full, but the
    # joint account is no longer one B may add to.
    b, joint, b_bank = sw["b"], sw["joint"], sw["b_private"]
    sw_post(sw_client, b, "/transactions/", {
        "account_id": joint, "amount": 20, "transaction_type": "transfer",
        "transaction_date": _when(0), "description": "Pocket money",
        "transfer_from_account_id": joint, "transfer_to_account_id": b_bank})
    sw_db.query(AccountShare).filter(AccountShare.id == sw["shares"]["b"]).update(
        {"role": "viewer"})
    sw_db.commit()
    [pocket] = _suggest(sw_client, b, "Pocket")
    assert (pocket["account_id"], pocket["transfer_from_account_id"],
            pocket["transfer_to_account_id"]) == (None, None, b_bank)

    # Unshared altogether: B no longer sees the row in full, so it supplies nothing.
    sw_db.query(AccountShare).filter(AccountShare.id == sw["shares"]["b"]).delete()
    sw_db.commit()
    assert _suggest(sw_client, b, "Pocket") == []


# --- AC5: limited rows never count ---------------------------------------------------------------

def test_limited_rows_never_supply_suggestions(sw_client, sw_db, sw, hh):
    """A viewer and a Household member are shown the owner's rows limited, and get no
    suggestion from them, even where the limited view shows the stored description. An
    editor sees the owner's joint rows shared_full and gets them, with none of the
    owner's private references (category, tags)."""
    from app.models.tag import transaction_tags

    a, b, v, joint = sw["a"], sw["b"], sw["v"], sw["joint"]
    cat = sw_post(sw_client, a, "/categories/", {"name": f"{PRIVATE} cat"})["id"]
    tag = sw_post(sw_client, a, "/tags/", {"name": f"{PRIVATE} tag"})["id"]
    _txn(sw_client, a, joint, f"{PRIVATE} joint spend", category_id=cat, tag_ids=[tag])
    _txn(sw_client, a, sw["a_private"], f"{PRIVATE} private spend")
    listed = sw_client.get(f"{API}/transactions/", headers=v["headers"]).json()["items"]
    assert any(r["view"] == "limited" for r in listed)  # the viewer does see the row, limited

    assert _suggest(sw_client, v, PRIVATE) == []
    assert _suggest(sw_client, v, PRIVATE[:2]) == []
    assert _suggest(sw_client, sw["s"], PRIVATE) == []
    [shared] = _suggest(sw_client, b, PRIVATE)
    assert shared["description"] == f"{PRIVATE} joint spend"
    assert shared["category_id"] is None and shared["tag_ids"] == []
    assert shared["account_id"] == joint

    # Household (rule c): C is shown A's tagged row's stored text, in the limited view.
    ha, c = hh["a"], hh["c"]
    row = _txn(sw_client, ha, hh["joint"], f"{PRIVATE} household shop")
    sw_db.execute(transaction_tags.insert().values(tag_id=hh_household(sw_db, ha),
                                                   transaction_id=row["id"]))
    sw_db.commit()
    seen = sw_client.get(f"{API}/household/{ha['id']}/transactions",
                         headers=c["headers"]).json()
    assert f"{PRIVATE} household shop" in str(seen)
    assert _suggest(sw_client, c, PRIVATE) == []


# --- AC6: one statement, and the latency budget ---------------------------------------------------

SUGGESTIONS_SQL_GATE = 1


def test_suggestions_query_budget(sw_client, sw_people, sw):
    """At most one SQL statement of its own per request, for a full list of 8 (with
    categories, tags and transfers), a miss, and a viewer, on top of the fixed cost."""
    a = sw_people()
    bank = _bank(sw_client, a)
    other = _bank(sw_client, a, "Other")
    cat = sw_post(sw_client, a, "/categories/", {"name": "Cat"})["id"]
    tags = [sw_post(sw_client, a, "/tags/", {"name": f"T{i}"})["id"] for i in range(3)]
    for i in range(12):
        _txn(sw_client, a, bank, f"Item {i}", days=i, category_id=cat, tag_ids=tags[: i % 4])
    sw_post(sw_client, a, "/transactions/", {
        "account_id": bank, "amount": 5, "transaction_type": "transfer",
        "transaction_date": _when(40), "description": "Item transfer",
        "transfer_from_account_id": bank, "transfer_to_account_id": other})
    assert len(_suggest(sw_client, a, "Item")) == 8
    for who, q in ((a, "Item"), (a, "No such thing"), (sw["v"], "Joint"), (sw["b"], "x")):
        reads, _ = suggestion_reads(sw_client, who, q)
        assert len(reads) <= SUGGESTIONS_SQL_GATE, (q, reads)


@pytest.fixture(scope="module")
def suggestions_world(sw_client):
    from app.core.database import SessionLocal
    from app.tests.fixtures.suggestions import build_suggestions

    db = SessionLocal()
    world = None
    try:
        world = build_suggestions(db, tag="sugg-test")
        yield world
    finally:
        if world is not None:
            world.remove(db)
        db.close()


def test_suggestions_realistic_fixture_latency(sw_client, suggestions_world):
    """10,000 rows in full and 10,000 limited: p95 of 100 requests (after 10 warm-ups)
    at most 250 ms, one statement of the suggestions' own each, and no limited row's
    description suggested (the owner's rows are all limited to this caller)."""
    from app.tests.fixtures import suggestions as fixture

    headers = suggestions_world.headers(sw_client)
    who = {"headers": headers}
    for q in ("s", "Starbucks", "zzz"):
        reads, _ = suggestion_reads(sw_client, who, q)
        assert len(reads) <= SUGGESTIONS_SQL_GATE, (q, reads)
    items = _suggest(sw_client, who, "s")
    assert len(items) == 8
    # Every row the limited half holds is on the owner's bank: none may be the source.
    assert all(i["account_id"] in (suggestions_world.accounts["own_bank"],
                                   suggestions_world.accounts["own_cash"]) for i in items)
    result = fixture.measure_latency(sw_client, headers)
    print(f"\nsuggestions latency: {result}")
    assert result["p95_ms"] <= fixture.P95_LIMIT_MS, result

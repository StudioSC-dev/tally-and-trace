"""Recurring-entry kinds (STU-343, plan sections 2.0 and 2.1).

``billing_kind`` is stored ("subscription" or "bill"); ``kind`` is derived and
read-only on the full and shared_full views: subscription, installment, bill or
cash, null for income and transfers. An open-ended card expense created, or edited
with the field absent and none stored, gets a server default (bill under the
creator's Utilities category, subscription otherwise). Skips without a database.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


@pytest.fixture
def kinds(sw_client, sw_db, sw_people):
    """Alice with Checking, Savings, a card and categories; Bea edits Joint, Vic views it."""
    from app.tests.conftest import sw_share

    a, b, v = sw_people("Alice", "Owner"), sw_people("Bea", "Editor"), sw_people("Vic", "Viewer")
    account = lambda name, kind, **extra: sw_post(sw_client, a, "/accounts/", {  # noqa: E731
        "name": name, "account_type": kind, "balance": 1_000, **extra})["id"]
    checking = account("Checking", "checking")
    savings = account("Savings", "savings")
    card = account("Card", "credit", billing_cycle_start=15, days_until_due_date=21,
                   payment_account_id=checking)
    joint = account("Joint", "checking")
    sw_share(sw_db, joint, b["id"], "editor", a["id"])
    sw_share(sw_db, joint, v["id"], "viewer", a["id"])
    category = lambda name: sw_post(sw_client, a, "/categories/", {"name": name})["id"]  # noqa: E731

    def entry(who=a, expect=(201,), **body):
        body = {"entry_type": "expense", "amount": 100, "cadence": "monthly",
                "next_occurrence": "2026-11-01T00:00:00", **body}
        r = sw_client.post(f"{API}/budget-entries/", json=body, headers=who["headers"])
        assert r.status_code in expect, r.text
        return r.json()

    def put(entry_id, body, who=a):
        r = sw_client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])
        assert r.status_code == 200, r.text
        return r.json()

    def get(entry_id, who=a):
        r = sw_client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
        assert r.status_code == 200, r.text
        return r.json()

    def listing(who):
        r = sw_client.get(f"{API}/budget-entries/", headers=who["headers"])
        assert r.status_code == 200, r.text
        return r.json()["items"]

    return {"list": listing, "a": a, "b": b, "v": v, "checking": checking, "savings": savings, "card": card,
            "joint": joint, "category": category, "entry": entry, "put": put, "get": get}


def test_entry_kinds_are_derived(kinds):
    entry, card, cat = kinds["entry"], kinds["card"], kinds["category"]
    utilities = cat("Utilities")
    capped = {"end_mode": "after_occurrences", "max_occurrences": 24}

    netflix = entry(name="Netflix", account_id=card)
    assert (netflix["kind"], netflix["billing_kind"]) == ("subscription", "subscription")

    meralco = entry(name="Meralco", account_id=card, category_id=utilities)
    assert (meralco["kind"], meralco["billing_kind"]) == ("bill", "bill")
    assert kinds["get"](meralco["id"])["billing_kind"] == "bill"

    iphone = entry(name="iPhone", account_id=card, **capped)
    assert (iphone["kind"], iphone["billing_kind"]) == ("installment", None)

    globe = entry(name="Globe", account_id=card, billing_kind="bill", **capped)
    assert (globe["kind"], globe["billing_kind"]) == ("bill", "bill")

    sub_capped = entry(name="Phone", account_id=card, billing_kind="subscription", **capped)
    assert (sub_capped["kind"], sub_capped["billing_kind"]) == ("installment", "subscription")

    rent = entry(name="Rent", account_id=kinds["checking"])
    assert (rent["kind"], rent["billing_kind"]) == ("cash", None)
    capped_cash = entry(name="Loan-ish", account_id=kinds["checking"], **capped)
    assert capped_cash["kind"] == "cash"

    salary = entry(name="Salary", entry_type="income", account_id=kinds["checking"])
    transfer = entry(name="Save", account_id=kinds["checking"],
                     transfer_to_account_id=kinds["savings"])
    card_income = entry(name="Cashback", entry_type="income", account_id=card, **capped)
    for row in (salary, transfer, card_income):
        assert row["kind"] is None and row["billing_kind"] is None


def test_utilities_default_applies_on_create_and_on_put_only_when_unsent(kinds):
    entry, put, get, card = kinds["entry"], kinds["put"], kinds["get"], kinds["card"]
    utilities, entertainment = kinds["category"]("utilities"), kinds["category"]("Entertainment")

    assert entry(name="Water", account_id=card, category_id=utilities)["billing_kind"] == "bill"
    assert entry(name="Spotify", account_id=card,
                 category_id=entertainment)["billing_kind"] == "subscription"
    assert entry(name="Plain", account_id=card)["billing_kind"] == "subscription"
    # Explicit values, null included, are stored as sent.
    explicit = entry(name="Explicit", account_id=card, category_id=utilities,
                     billing_kind="subscription")
    assert explicit["billing_kind"] == "subscription"
    cleared = entry(name="Cleared", account_id=card, category_id=utilities, billing_kind=None)
    assert cleared["billing_kind"] is None and cleared["kind"] == "subscription"

    # PUT with the field absent and nothing stored applies the default; with the field
    # sent (null included) it does not.
    assert put(cleared["id"], {"name": "Cleared 2"})["billing_kind"] == "bill"
    again = entry(name="Again", account_id=card, category_id=utilities, billing_kind=None)
    sent_null = put(again["id"], {"name": "Again 2", "billing_kind": None})
    assert sent_null["billing_kind"] is None
    assert get(again["id"])["billing_kind"] is None
    # A stored value is never replaced by the default.
    assert put(explicit["id"], {"name": "Explicit 2"})["billing_kind"] == "subscription"

    # A cash expense and a capped card expense get no default, on create or on PUT.
    rent = entry(name="Rent", account_id=kinds["checking"], category_id=utilities)
    assert rent["billing_kind"] is None
    assert put(rent["id"], {"name": "Rent 2"})["billing_kind"] is None
    iphone = entry(name="iPhone", account_id=card, category_id=utilities,
                   end_mode="after_occurrences", max_occurrences=12)
    assert iphone["billing_kind"] is None
    assert put(iphone["id"], {"name": "iPhone 2"})["billing_kind"] is None


def test_put_installment_clears_a_bill_override(kinds):
    entry, put, get = kinds["entry"], kinds["put"], kinds["get"]
    globe = entry(name="Globe", account_id=kinds["card"], billing_kind="bill",
                  end_mode="after_occurrences", max_occurrences=24)
    assert globe["kind"] == "bill"
    cleared = put(globe["id"], {"billing_kind": None})
    assert (cleared["kind"], cleared["billing_kind"]) == ("installment", None)
    stored = get(globe["id"])
    assert (stored["kind"], stored["billing_kind"]) == ("installment", None)
    # Still capped, so the default does not bring a value back on a later edit.
    assert put(globe["id"], {"name": "Globe 2"})["billing_kind"] is None


def test_billing_kind_rejects_unknown_values(kinds, sw_client):
    r = sw_client.post(f"{API}/budget-entries/", headers=kinds["a"]["headers"], json={
        "name": "X", "entry_type": "expense", "amount": 1,
        "next_occurrence": "2026-11-01T00:00:00", "account_id": kinds["card"],
        "billing_kind": "other"})
    assert r.status_code == 422


def test_kind_and_billing_kind_per_view(kinds):
    entry, get, put = kinds["entry"], kinds["get"], kinds["put"]
    # A cash expense on the shared account, with a stored override (kept as sent).
    joint = entry(name="Shared bill", account_id=kinds["joint"], billing_kind="bill")
    assert joint["view"] == "full"
    assert (joint["kind"], joint["billing_kind"]) == ("cash", "bill")

    shared = get(joint["id"], kinds["b"])
    assert shared["view"] == "shared_full"
    assert (shared["kind"], shared["billing_kind"]) == ("cash", "bill")

    limited = get(joint["id"], kinds["v"])
    assert limited["view"] == "limited"
    assert "kind" not in limited and "billing_kind" not in limited

    # The list carries the same views.
    for who, view in ((kinds["a"], "full"), (kinds["b"], "shared_full"), (kinds["v"], "limited")):
        rows = {r["id"]: r for r in kinds["list"](who)}
        assert rows[joint["id"]]["view"] == view
    assert all("kind" not in r for r in kinds["list"](kinds["v"]))

    # kind is read-only: a request cannot set it.
    assert put(joint["id"], {"kind": "installment"})["kind"] == "cash"


"""Filtering transactions by category name and by who entered them (STU-321).

``category_names`` matches by name, the way ``summary/period`` counts categories:
a row's category counts only when its creator owns it, so a household sharing an
account sees every member's "Groceries" under one filter. It never matches a row
whose category the caller is not shown (``category_name`` null), and it never
widens what the caller may read. ``entered_by=me`` is a separate, deliberate
filter: rows the caller owns.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-05T00:00:00"
RANGE = {"start_date": "2026-10-01T00:00:00", "end_date": "2026-10-31T23:59:59"}


def _category(client, who, name):
    return sw_post(client, who, "/categories/", {"name": name})["id"]


def _debit(client, who, account, amount, category=None, when=DAY, posted=True, **extra):
    body = {"account_id": account, "amount": amount, "transaction_type": "debit",
            "description": "Spend", "transaction_date": when, "is_posted": posted, **extra}
    if category is not None:
        body["category_id"] = category
    return sw_post(client, who, "/transactions/", body)["id"]


def _transfer(client, who, frm, to, amount, category=None, posted=True, **extra):
    body = {"account_id": frm, "transfer_from_account_id": frm, "transfer_to_account_id": to,
            "amount": amount, "transaction_type": "transfer", "description": "Move",
            "transaction_date": DAY, "is_posted": posted, **extra}
    if category is not None:
        body["category_id"] = category
    return sw_post(client, who, "/transactions/", body)["id"]


def _list(client, who, expect=200, **params):
    params.setdefault("limit", 1000)
    r = client.get(f"{API}/transactions/", headers=who["headers"], params=params)
    assert r.status_code == expect, (params, r.status_code, r.text)
    return r.json()


def _ids(body):
    return sorted(i["id"] for i in body["items"])


def _summary(client, who, expect=200, **params):
    r = client.get(f"{API}/transactions/summary/period", headers=who["headers"], params=params)
    assert r.status_code == expect, (params, r.status_code, r.text)
    return r.json()


@pytest.fixture
def groceries(hh, sw_client):
    """A and B each own a "Groceries"; rows: A and B on the joint account, A private."""
    a, b = hh["a"], hh["b"]
    a_cat = _category(sw_client, a, "Groceries")
    b_cat = _category(sw_client, b, "Groceries")
    return {
        "a_cat": a_cat, "b_cat": b_cat,
        "a_joint": _debit(sw_client, a, hh["joint"], 100, a_cat),
        "b_joint": _debit(sw_client, b, hh["joint"], 40, b_cat),
        "a_private": _debit(sw_client, a, hh["a_private"], 25, a_cat),
        "b_private": _debit(sw_client, b, hh["b_private"], 7, b_cat),
    }


def test_name_matches_every_members_category_on_shared_accounts(hh, groceries, sw_client):
    body = _list(sw_client, hh["a"], category_names="Groceries")
    assert _ids(body) == sorted([groceries["a_joint"], groceries["b_joint"],
                                 groceries["a_private"]])
    assert body["total"] == 3
    # B's own private row is not A's to read.
    assert groceries["b_private"] not in _ids(body)


def test_name_match_is_case_sensitive_and_exact(hh, groceries, sw_client):
    assert _list(sw_client, hh["a"], category_names="groceries")["total"] == 0
    assert _list(sw_client, hh["a"], category_names="Grocer")["total"] == 0


def test_a_stale_reference_to_another_members_category_is_not_matched(hh, sw_client, sw_db):
    from app.models.transaction import Transaction

    a, b = hh["a"], hh["b"]
    dining = _category(sw_client, a, "Dining")
    mine = _debit(sw_client, a, hh["a_private"], 10, dining)
    stale = _debit(sw_client, b, hh["joint"], 20)
    # The API refuses another owner's category, so the stale reference is written directly.
    sw_db.query(Transaction).filter(Transaction.id == stale).update({"category_id": dining})
    sw_db.commit()
    body = _list(sw_client, a, category_names="Dining")
    assert _ids(body) == [mine]


def test_a_tag_viewer_matches_rows_in_view_and_sees_the_category(hh, groceries, sw_client):
    c = hh["c"]
    body = _list(sw_client, c, category_names="Groceries")
    # A's row on the Household-tagged joint account; nothing outside C's view.
    assert _ids(body) == [groceries["a_joint"]]
    assert body["items"][0]["category_name"] == "Groceries"
    assert body["total"] == 1


def test_a_hidden_category_never_matches_a_limited_transfer_direct_share(hh, sw, sw_client):
    # B moves money from the joint account into B's private account under B's "Savings".
    b, a = sw["b"], sw["a"]
    savings = _category(sw_client, b, "Savings")
    row = _transfer(sw_client, b, sw["joint"], sw["b_private"], 50, savings)
    listing = _list(sw_client, a)
    shown = next(i for i in listing["items"] if i["id"] == row)
    assert shown["view"] == "limited"
    assert shown["category_name"] is None
    body = _list(sw_client, a, category_names="Savings")
    assert body["items"] == [] and body["total"] == 0
    # B, who sees both sides, still finds it.
    assert _ids(_list(sw_client, b, category_names="Savings")) == [row]


def test_a_hidden_category_never_matches_through_a_tag_share(hh, sw_client):
    a, c = hh["a"], hh["c"]
    savings = _category(sw_client, a, "Savings")
    # No explicit Household tag: C reads it only because the joint account is tagged.
    row = _transfer(sw_client, a, hh["joint"], hh["a_private"], 50, savings)
    shown = next(i for i in _list(sw_client, c)["items"] if i["id"] == row)
    assert shown["category_name"] is None
    body = _list(sw_client, c, category_names="Savings")
    assert body["items"] == [] and body["total"] == 0


def test_an_explicit_household_tag_shows_the_category_and_matches(hh, sw_client):
    a, c = hh["a"], hh["c"]
    savings = _category(sw_client, a, "Savings")
    row = _transfer(sw_client, a, hh["joint"], hh["a_private"], 50, savings,
                    tag_ids=[hh["hh_a"]])
    shown = next(i for i in _list(sw_client, c)["items"] if i["id"] == row)
    assert shown["category_name"] == "Savings"
    assert _ids(_list(sw_client, c, category_names="Savings")) == [row]


def test_reserved_names_match_real_categories_only(hh, sw_client):
    a = hh["a"]
    fees = _category(sw_client, a, "Transfer fees")
    real = _debit(sw_client, a, hh["a_private"], 12, fees)
    _debit(sw_client, a, hh["a_private"], 9)  # uncategorised
    assert _ids(_list(sw_client, a, category_names="Transfer fees")) == [real]
    assert _list(sw_client, a, category_names="Uncategorized")["total"] == 0


def test_name_filter_combines_with_other_filters(hh, groceries, sw_client):
    a = hh["a"]
    dining = _category(sw_client, a, "Dining")
    dine = _debit(sw_client, a, hh["a_private"], 30, dining)
    credit = sw_post(sw_client, a, "/transactions/", {
        "account_id": hh["a_private"], "amount": 5, "transaction_type": "credit",
        "description": "Refund", "transaction_date": DAY, "is_posted": True,
        "category_id": groceries["a_cat"]})["id"]
    late = _debit(sw_client, a, hh["a_private"], 3, groceries["a_cat"],
                  when="2026-11-20T00:00:00")
    both = _list(sw_client, a, category_names=["Groceries", "Dining"])
    assert dine in _ids(both) and groceries["a_joint"] in _ids(both)
    only_debits = _list(sw_client, a, category_names="Groceries", transaction_types="debit")
    assert credit not in _ids(only_debits) and groceries["a_joint"] in _ids(only_debits)
    ranged = _list(sw_client, a, category_names="Groceries", **RANGE)
    assert late not in _ids(ranged) and groceries["a_joint"] in _ids(ranged)
    tag = sw_post(sw_client, a, "/tags/", {"name": "Trip"}, expect=(201,))["id"]
    tagged = _debit(sw_client, a, hh["a_private"], 2, groceries["a_cat"], tag_ids=[tag])
    assert _ids(_list(sw_client, a, category_names="Groceries", tag=tag)) == [tagged]


def test_name_filter_still_hides_what_the_caller_cannot_read(hh, groceries, sw_client):
    # B's joint-account row is outside the tag viewer C's reach, whatever the name.
    c = hh["c"]
    assert groceries["b_joint"] not in _ids(_list(sw_client, c, category_names="Groceries"))


def test_entered_by_me_keeps_only_the_callers_rows(hh, groceries, sw_client):
    a = hh["a"]
    mine = _list(sw_client, a, entered_by="me")
    assert groceries["b_joint"] not in _ids(mine)
    assert {groceries["a_joint"], groceries["a_private"]} <= set(_ids(mine))
    combined = _list(sw_client, a, entered_by="me", category_names="Groceries")
    assert _ids(combined) == sorted([groceries["a_joint"], groceries["a_private"]])
    assert _list(sw_client, a, entered_by="bob", expect=422)


def test_entered_by_me_counts_a_row_an_editor_materialised_as_the_owners(hh, sw_client):
    a, b = hh["a"], hh["b"]
    entry = sw_post(sw_client, a, "/budget-entries/", {
        "name": "Bill", "entry_type": "expense", "amount": 40,
        "next_occurrence": "2026-10-05T00:00:00", "account_id": hh["joint"]})["id"]
    r = sw_client.post(f"{API}/budget-entries/{entry}/materialize", json={},
                       headers=b["headers"])
    assert r.status_code == 201, r.text
    row = r.json()["id"]
    assert row in _ids(_list(sw_client, a, entered_by="me"))
    assert row not in _ids(_list(sw_client, b, entered_by="me"))


def test_category_names_are_bounded(hh, sw_client):
    a = hh["a"]
    _list(sw_client, a, expect=422, category_names="x" * 101)
    _list(sw_client, a, expect=422, category_names="")
    _list(sw_client, a, expect=422, category_names=[f"n{i}" for i in range(51)])
    _list(sw_client, a, expect=200, category_names=[f"n{i}" for i in range(50)])


def test_names_match_the_summary_breakdown(hh, sw_client):
    a, b = hh["a"], hh["b"]
    a_cat = _category(sw_client, a, "Fuel")
    b_cat = _category(sw_client, b, "Fuel")
    _debit(sw_client, a, hh["joint"], 100.50, a_cat)
    _debit(sw_client, b, hh["joint"], 40.25, b_cat)
    _debit(sw_client, a, hh["a_private"], 9.25, a_cat)
    _debit(sw_client, a, hh["a_private"], 60, a_cat, posted=False)
    _debit(sw_client, a, hh["a_private"], 15, a_cat, when="2026-12-05T00:00:00")
    rows = _list(sw_client, a, category_names="Fuel", transaction_types="debit", **RANGE)
    listed = sum(i["amount"] for i in rows["items"] if i["is_posted"])
    summary = _summary(sw_client, a, **RANGE)
    assert round(listed, 2) == pytest.approx(
        float(summary["category_breakdown"]["Fuel"]["expenses"]))


def test_summary_bounds_are_optional(hh, sw_client):
    a = hh["a"]
    early = _debit(sw_client, a, hh["a_private"], 1, when="2026-09-10T00:00:00")
    mid = _debit(sw_client, a, hh["a_private"], 10, when="2026-10-10T00:00:00")
    late = _debit(sw_client, a, hh["a_private"], 100, when="2026-11-10T00:00:00")
    assert early and mid and late
    def spent(**params):
        body = _summary(sw_client, a, **params)
        return float(body["summary"]["total_expenses"]), body["period"]
    total, period = spent()
    assert total == 111.0
    assert period == {"start_date": None, "end_date": None}
    total, period = spent(start_date="2026-10-01T00:00:00")
    assert total == 110.0
    assert period["end_date"] is None and period["start_date"] is not None
    total, period = spent(end_date="2026-10-31T00:00:00")
    assert total == 11.0
    assert period["start_date"] is None and period["end_date"] is not None

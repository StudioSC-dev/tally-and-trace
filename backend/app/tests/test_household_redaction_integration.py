"""Household tag shares: what the holder is shown (STU-233, plan §2).

Description rule (ii): a record carrying, explicitly, the Household tag its
owner shared with the caller shows its stored text even on an account the
caller can't view (the account stays neutral). Effective tags never count.
Tags: the caller's own, plus the sharer's Household tag where rule (c)
applies; never another user's private tag.
"""
import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _txn(client, who, account, amount, description, tags=(), **extra):
    body = {"account_id": account, "amount": amount, "transaction_type": "debit",
            "description": description, "transaction_date": DAY, "is_posted": True,
            "tag_ids": list(tags), **extra}
    return sw_post(client, who, "/transactions/", body)["id"]


def _tag_ids(body):
    return [t["id"] for t in body["tags"]]


@pytest.fixture
def world(hh, sw_client):
    client, a, b = sw_client, hh["a"], hh["b"]
    utilities = sw_post(client, a, "/categories/", {"name": "Utilities"})["id"]
    a_private_tag = sw_post(client, a, "/tags/", {"name": f"{PRIVATE} Business"},
                            expect=(201,))["id"]
    rec = {
        "utilities": utilities, "a_private_tag": a_private_tag,
        "explicit": _txn(client, a, hh["a_private"], 55, "Shared internet",
                         tags=[hh["hh_a"]], category_id=utilities),
        "joint": _txn(client, a, hh["joint"], 120, "Household groceries",
                      tags=[hh["hh_a"], a_private_tag]),
        "explicit_loan": sw_post(client, a, "/transactions/", {
            "account_id": hh["joint"], "transfer_from_account_id": hh["joint"],
            "transfer_to_account_id": hh["a_loan"], "amount": 400,
            "transaction_type": "transfer", "description": "Household car share",
            "transaction_date": DAY, "is_posted": True, "tag_ids": [hh["hh_a"]]})["id"],
        "entry": sw_post(client, a, "/budget-entries/", {
            "name": "Household water", "entry_type": "expense", "amount": 30,
            "next_occurrence": "2026-10-20T00:00:00", "account_id": None,
            "tag_ids": [hh["hh_a"]]})["id"],
    }
    # B tags A's joint transaction with B's own Household tag (B is an editor).
    r = client.put(f"{API}/transactions/{rec['joint']}", headers=b["headers"],
                   json={"tag_ids": [hh["hh_b"]]})
    assert r.status_code == 200
    return rec


def test_an_explicit_household_record_on_a_hidden_account_shows_its_description(hh, world,
                                                                                sw_client):
    body = _get(sw_client, hh["c"], f"/transactions/{world['explicit']}")
    assert body["view"] == "limited"
    assert body["display_description"] == "Shared internet"
    assert body["category_name"] == "Utilities"
    assert body["account"] == {"id": None, "name": "Other account"}
    assert _tag_ids(body) == [hh["hh_a"]]
    assert not any(body["permissions"].values())
    assert sw_leaks(body, private_ids=[hh["a_private"]]) == []


def test_an_explicit_household_payment_into_a_hidden_loan_shows_its_text_not_the_split(
        hh, world, sw_client):
    body = _get(sw_client, hh["c"], f"/transactions/{world['explicit_loan']}")
    assert body["display_description"] == "Household car share"
    assert body["counterpart"] == {"id": None, "name": "Loan payment"}
    assert body["transfer_fee"] is None


def test_an_accountless_household_entry_is_limited_with_its_name(hh, world, sw_client):
    body = _get(sw_client, hh["c"], f"/budget-entries/{world['entry']}")
    assert body["view"] == "limited"
    assert body["display_name"] == "Household water"
    assert body["account"] is None and body["counterpart"] is None
    assert _tag_ids(body) == [hh["hh_a"]]
    assert not any(body["permissions"].values())


def test_only_the_sharers_household_tag_and_own_tags_are_shown(hh, world, sw_client):
    c = hh["c"]
    joint_txn = _get(sw_client, c, f"/transactions/{world['joint']}")
    # A's Household tag (rule c holds); never A's private tag, nor B's tag on A's record.
    assert _tag_ids(joint_txn) == [hh["hh_a"]]
    assert sw_leaks(joint_txn) == []
    account = _get(sw_client, c, f"/accounts/{hh['joint']}")
    assert _tag_ids(account) == [hh["hh_a"]]
    # B sees B's own tag and not A's on the same record; A sees A's own two.
    assert _tag_ids(_get(sw_client, hh["b"], f"/transactions/{world['joint']}")) == [hh["hh_b"]]
    assert sorted(_tag_ids(_get(sw_client, hh["a"], f"/transactions/{world['joint']}"))) == \
        sorted([hh["hh_a"], world["a_private_tag"]])
    # The shared tag is never one C can tag with.
    r = sw_client.put(f"{API}/transactions/{world['joint']}", headers=c["headers"],
                      json={"tag_ids": [hh["hh_a"]]})
    assert r.status_code == 404


def test_search_matches_the_text_rule_ii_shows(hh, world, sw_client):
    c = hh["c"]
    found = _get(sw_client, c, "/transactions/", search="internet")["items"]
    assert [t["id"] for t in found] == [world["explicit"]]
    assert _get(sw_client, c, "/transactions/", search=PRIVATE)["items"] == []


def test_the_holder_filters_by_the_shared_household_tag(hh, world, sw_client):
    c = hh["c"]
    ids = {t["id"] for t in _get(sw_client, c, "/transactions/", tag=hh["hh_a"],
                                 limit=100)["items"]}
    assert ids == {world["explicit"], world["joint"], world["explicit_loan"]}
    entries = _get(sw_client, c, "/budget-entries/", tag=hh["hh_a"])["items"]
    assert [e["id"] for e in entries] == [world["entry"]]
    # A tag C holds no share of filters to nothing, like an unknown id.
    assert _get(sw_client, c, "/transactions/", tag=world["a_private_tag"])["items"] == []


def test_snapshot_accounts_seen_through_a_tag_share_carry_no_settings(hh, sw_client):
    # A marks the joint account a spending wallet: a setting C never sees.
    r = sw_client.put(f"{API}/accounts/{hh['joint']}", json={"is_spending_wallet": True},
                      headers=hh["a"]["headers"])
    assert r.status_code == 200, r.text
    by_account = _get(sw_client, hh["c"], "/dashboard/snapshot")["balances"]["by_account"]
    assert sorted((x["id"], tuple(sorted(x))) for x in by_account) == sorted([
        (hh["joint"], ("balance", "currency", "id", "name")),
        (hh["c_private"], ("balance", "currency", "id", "is_spending_wallet", "name")),
    ])
    # The owner, and a direct editor, still get the setting.
    for who in ("a", "b"):
        rows = _get(sw_client, hh[who], "/dashboard/snapshot")["balances"]["by_account"]
        assert [x["is_spending_wallet"] for x in rows if x["id"] == hh["joint"]] == [True]

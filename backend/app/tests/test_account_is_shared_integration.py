"""``is_shared`` on account responses (STU-325).

True for an owner's account that has an account share or carries the owner's own
Household tag (held or not); false otherwise; null for admin, editor and viewer;
absent for ``tag_viewer``. Uses the ``hh`` world (``conftest.py``).
"""
import pytest
from sqlalchemy import event

from app.tests.conftest import API, hh_tag_share, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _put(client, who, path, body):
    r = client.put(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _listed(client, who):
    return {a["id"]: a for a in _get(client, who, "/accounts/", limit=100)["items"]}


def test_an_owned_account_nobody_can_see_is_not_shared(hh, sw_client):
    assert _listed(sw_client, hh["a"])[hh["a_private"]]["is_shared"] is False


def test_an_account_share_makes_it_shared(hh, sw_client, sw_db):
    sw_share(sw_db, hh["a_card"], hh["b"]["id"], "viewer", hh["a"]["id"])
    accounts = _listed(sw_client, hh["a"])
    assert accounts[hh["a_card"]]["is_shared"] is True
    assert accounts[hh["a_private"]]["is_shared"] is False


def test_the_owners_household_tag_makes_it_shared_even_when_nobody_holds_it(hh, sw_client, sw_db):
    from app.models.tag_share import TagShare

    a = hh["a"]
    put = _put(sw_client, a, f"/accounts/{hh['a_wallet']}", {"tag_ids": [hh["hh_a"]]})
    assert put["is_shared"] is True
    assert _listed(sw_client, a)[hh["a_wallet"]]["is_shared"] is True
    sw_db.query(TagShare).filter(TagShare.id == hh["a_to_c"]).delete()
    sw_db.commit()
    assert _listed(sw_client, a)[hh["a_wallet"]]["is_shared"] is True
    assert _listed(sw_client, a)[hh["joint"]]["is_shared"] is True
    put = _put(sw_client, a, f"/accounts/{hh['a_wallet']}", {"tag_ids": []})
    assert put["is_shared"] is False
    assert _listed(sw_client, a)[hh["a_wallet"]]["is_shared"] is False


def test_create_with_the_household_tag_is_shared(hh, sw_client):
    created = sw_post(sw_client, hh["a"], "/accounts/", {
        "name": "New joint", "account_type": "savings", "balance": 1, "tag_ids": [hh["hh_a"]]})
    assert created["is_shared"] is True


def test_single_get_by_role(hh, sw_client):
    joint = hh["joint"]
    assert _get(sw_client, hh["a"], f"/accounts/{joint}")["is_shared"] is True
    assert _get(sw_client, hh["a"], f"/accounts/{hh['a_private']}")["is_shared"] is False
    editor = _get(sw_client, hh["b"], f"/accounts/{joint}")
    assert editor["my_role"] == "editor" and editor["is_shared"] is None
    tag_viewer = _get(sw_client, hh["c"], f"/accounts/{joint}")
    assert tag_viewer["my_role"] == "tag_viewer" and "is_shared" not in tag_viewer


def test_shared_with_me_lists_null_or_absent(hh, sw_client):
    b_joint = _listed(sw_client, hh["b"])[hh["joint"]]
    assert b_joint["my_role"] == "editor" and b_joint["is_shared"] is None
    c_joint = _listed(sw_client, hh["c"])[hh["joint"]]
    assert c_joint["my_role"] == "tag_viewer" and "is_shared" not in c_joint


def test_another_users_household_tag_does_not_count(hh, sw_client, sw_db):
    from app.models.account_share import AccountShare

    a, b = hh["a"], hh["b"]
    acct = sw_post(sw_client, a, "/accounts/", {
        "name": "Borrowed", "account_type": "checking", "balance": 1})["id"]
    share = sw_share(sw_db, acct, b["id"], "admin", a["id"])
    _put(sw_client, b, f"/accounts/{acct}", {"tag_ids": [hh["hh_b"]]})
    sw_db.query(AccountShare).filter(AccountShare.id == share).delete()
    sw_db.commit()
    assert _listed(sw_client, a)[acct]["is_shared"] is False


def test_household_dashboard_carries_the_same_rule(hh, sw_client, sw_db):
    hh_tag_share(sw_db, hh["a"], hh["b"])
    r = sw_client.get(f"{API}/household/{hh['a']['id']}/dashboard", headers=hh["c"]["headers"])
    assert r.status_code == 200, r.text
    accounts = {x["id"]: x for x in r.json()["accounts"]}
    assert set(accounts[hh["joint"]]) == {"id", "name", "account_type", "currency", "balance",
                                          "my_role", "permissions", "owner_name", "tags"}
    own = sw_client.get(f"{API}/household/{hh['a']['id']}/dashboard", headers=hh["a"]["headers"])
    assert own.status_code == 200, own.text
    assert {x["id"]: x for x in own.json()["accounts"]}[hh["joint"]]["is_shared"] is True
    direct = sw_client.get(f"{API}/household/{hh['a']['id']}/dashboard",
                           headers=hh["b"]["headers"])
    assert direct.status_code == 200, direct.text
    assert {x["id"]: x for x in direct.json()["accounts"]}[hh["joint"]]["is_shared"] is None


def test_listing_does_not_query_per_account(hh, sw_client, sw_people):
    from app.core.database import engine

    fresh = sw_people("Nina", "Plus")
    sw_post(sw_client, fresh, "/accounts/", {"name": "One", "account_type": "checking",
                                             "balance": 1})

    def statements():
        seen = []

        def count(conn, cursor, statement, parameters, context, executemany):
            seen.append(statement)

        event.listen(engine, "before_cursor_execute", count)
        try:
            _get(sw_client, fresh, "/accounts/", limit=100)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        return len(seen)

    before = statements()
    for n in range(5):
        sw_post(sw_client, fresh, "/accounts/", {"name": f"Extra {n}", "account_type": "savings",
                                                 "balance": 1})
    assert statements() == before

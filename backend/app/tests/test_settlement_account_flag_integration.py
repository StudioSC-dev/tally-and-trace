"""``accounts.auto_post_enabled``, the loan side of the one settlement flag.

Read-only on the API, and shown to an account's owner and admins alone: null for
an editor or viewer, absent for a tag viewer, in the owner's export and not in a
shared account's reference. Skips without a database.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


@pytest.fixture
def shared_loan(sw, sw_client, sw_db):
    """Alice's opted-in loan, shared with her editor, viewer and admin."""
    from app.models.account import Account

    loan = sw["a_loan"]
    for who, role in (("b", "editor"), ("v", "viewer"), ("d", "admin")):
        sw_share(sw_db, loan, sw[who]["id"], role, sw["a"]["id"])
    sw_db.query(Account).filter(Account.id == loan).update({"auto_post_enabled": True})
    sw_db.commit()
    return loan


@pytest.mark.parametrize("who, shown", [("a", True), ("d", True), ("b", None), ("v", None)])
def test_the_account_flag_stays_with_managers(sw, sw_client, shared_loan, who, shown):
    headers = sw[who]["headers"]
    one = sw_client.get(f"{API}/accounts/{shared_loan}", headers=headers)
    assert one.status_code == 200, one.text
    assert one.json()["auto_post_enabled"] is shown
    listed = sw_client.get(f"{API}/accounts/", headers=headers, params={"limit": 100})
    assert listed.status_code == 200, listed.text
    items = listed.json()
    items = items["items"] if isinstance(items, dict) else items
    (row,) = [a for a in items if a["id"] == shared_loan]
    assert row["auto_post_enabled"] is shown


def test_a_tag_viewer_sees_no_account_flag(hh, sw_client, sw_db):
    from app.models.account import Account

    sw_db.query(Account).filter(Account.id == hh["joint"]).update({"auto_post_enabled": True})
    sw_db.commit()
    body = sw_client.get(f"{API}/accounts/{hh['joint']}", headers=hh["c"]["headers"])
    assert body.status_code == 200, body.text
    assert body.json()["my_role"] == "tag_viewer"
    assert "auto_post_enabled" not in body.json()


def test_the_export_gives_the_flag_to_the_owner_alone(sw, sw_client, shared_loan):
    def export(who):
        r = sw_client.get(f"{API}/data/export.json", headers=sw[who]["headers"])
        assert r.status_code == 200, r.text
        return r.json()

    (own,) = [a for a in export("a")["accounts"] if a["id"] == shared_loan]
    assert own["auto_post_enabled"] is True
    for who in ("b", "v", "d"):
        (ref,) = [a for a in export(who)["shared_accounts"] if a["id"] == shared_loan]
        assert "auto_post_enabled" not in ref


def test_no_create_or_edit_sets_the_account_flag(sw, sw_client, sw_db):
    from app.models.account import Account

    a = sw["a"]
    r = sw_client.put(f"{API}/accounts/{sw['a_loan']}", headers=a["headers"],
                      json={"auto_post_enabled": True})
    assert r.status_code == 200, r.text
    assert r.json()["auto_post_enabled"] is False
    created = sw_post(sw_client, a, "/accounts/", {
        "name": "New", "account_type": "checking", "balance": 0, "auto_post_enabled": True})
    assert created["auto_post_enabled"] is False
    sw_db.expire_all()
    assert sw_db.get(Account, created["id"]).auto_post_enabled is False

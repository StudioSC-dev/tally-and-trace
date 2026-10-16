"""The cash-flow timeline's main account in user settings (STU-326, plan section 2).

``PUT /auth/me`` takes ``main_account_id``: an active projection-cash account
the caller holds a direct role on (owner, admin, editor, viewer). A card, loan
or spending wallet is a 400; anything the caller can't use directly (a
stranger's, an inactive or unknown account, a Household ``tag_viewer`` one) is
a 404. An explicit null clears it. Every user response re-checks the stored
pin and reads one that no longer passes as null, without changing the row.
Skips without a database.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


def _me(client, who):
    r = client.get(f"{API}/auth/me", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _pin(client, who, account_id):
    return client.put(f"{API}/auth/me", json={"main_account_id": account_id},
                      headers=who["headers"])


def _stored(db, who):
    from app.models.user import User

    db.expire_all()
    return db.get(User, who["id"]).main_account_id


def test_pin_own_cash_account_and_me_echoes_it(sw_client, sw):
    a = sw["a"]
    assert _me(sw_client, a)["main_account_id"] is None
    r = _pin(sw_client, a, sw["a_private"])
    assert r.status_code == 200, r.text
    assert r.json()["main_account_id"] == sw["a_private"]
    assert _me(sw_client, a)["main_account_id"] == sw["a_private"]


def test_card_loan_and_wallet_are_400(sw_client, sw):
    a = sw["a"]
    wallet = sw_post(sw_client, a, "/accounts/", {
        "name": "Pocket", "account_type": "cash", "balance": 500,
        "is_spending_wallet": True})["id"]
    for account_id in (sw["a_card"], sw["a_loan"], wallet):
        r = _pin(sw_client, a, account_id)
        assert r.status_code == 400, (account_id, r.text)
        assert r.json()["detail"] == "Only a cash account can be the main account"
    assert _me(sw_client, a)["main_account_id"] is None


def test_strangers_inactive_and_unknown_accounts_are_404(sw_client, sw_db, sw):
    from app.models.account import Account

    a = sw["a"]
    old = sw_post(sw_client, a, "/accounts/", {
        "name": "Old bank", "account_type": "savings", "balance": 0})["id"]
    sw_db.query(Account).filter(Account.id == old).update({"is_active": False})
    sw_db.commit()
    for account_id in (sw["s_bank"], sw["b_private"], old, 987_654_321):
        r = _pin(sw_client, a, account_id)
        assert r.status_code == 404, (account_id, r.text)
        assert r.json()["detail"] == "Account not found"
    assert _stored(sw_db, a) is None


def test_viewer_can_pin_a_shared_cash_account(sw_client, sw):
    r = _pin(sw_client, sw["v"], sw["joint"])
    assert r.status_code == 200, r.text
    assert _me(sw_client, sw["v"])["main_account_id"] == sw["joint"]


def test_tag_viewer_account_is_404(sw_client, hh):
    # C sees A's Household-tagged joint account only as a tag viewer.
    r = _pin(sw_client, hh["c"], hh["joint"])
    assert r.status_code == 404, r.text
    assert _pin(sw_client, hh["c"], hh["c_private"]).status_code == 200


def test_null_clears_and_other_fields_leave_the_pin(sw_client, sw):
    a = sw["a"]
    assert _pin(sw_client, a, sw["joint"]).status_code == 200
    r = sw_client.put(f"{API}/auth/me", json={"first_name": "Alicia"}, headers=a["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["main_account_id"] == sw["joint"]
    assert r.json()["first_name"] == "Alicia"
    r = _pin(sw_client, a, None)
    assert r.status_code == 200, r.text
    assert r.json()["main_account_id"] is None
    assert _me(sw_client, a)["main_account_id"] is None


def test_revoked_share_reads_null_and_keeps_the_row(sw_client, sw_db, sw):
    from app.models.account_share import AccountShare

    v = sw["v"]
    assert _pin(sw_client, v, sw["joint"]).status_code == 200
    sw_db.query(AccountShare).filter(AccountShare.id == sw["shares"]["v"]).delete()
    sw_db.commit()
    assert _me(sw_client, v)["main_account_id"] is None
    assert _stored(sw_db, v) == sw["joint"]


def test_regranted_share_brings_the_pin_back(sw_client, sw_db, sw):
    from app.models.account_share import AccountShare
    from app.tests.conftest import sw_share

    v = sw["v"]
    assert _pin(sw_client, v, sw["joint"]).status_code == 200
    sw_db.query(AccountShare).filter(AccountShare.id == sw["shares"]["v"]).delete()
    sw_db.commit()
    assert _me(sw_client, v)["main_account_id"] is None
    sw_share(sw_db, sw["joint"], v["id"], "viewer", sw["a"]["id"])
    assert _me(sw_client, v)["main_account_id"] == sw["joint"]


def test_deactivated_account_reads_null_and_keeps_the_row(sw_client, sw_db, sw):
    a = sw["a"]
    spare = sw_post(sw_client, a, "/accounts/", {
        "name": "Spare", "account_type": "savings", "balance": 10})["id"]
    assert _pin(sw_client, a, spare).status_code == 200
    r = sw_client.delete(f"{API}/accounts/{spare}", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert _me(sw_client, a)["main_account_id"] is None
    assert _stored(sw_db, a) == spare
    # The other user responses re-check it too.
    r = sw_client.put(f"{API}/auth/me", json={"last_name": "Owner"}, headers=a["headers"])
    assert r.json()["main_account_id"] is None
    r = sw_client.patch(f"{API}/auth/complete-onboarding", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["main_account_id"] is None


def test_hard_delete_clears_the_row(sw_client, sw_db, sw):
    from app.models.account import Account

    a = sw["a"]
    spare = sw_post(sw_client, a, "/accounts/", {
        "name": "Spare", "account_type": "savings", "balance": 10})["id"]
    assert _pin(sw_client, a, spare).status_code == 200
    sw_db.query(Account).filter(Account.id == spare).delete()
    sw_db.commit()
    assert _stored(sw_db, a) is None
    assert _me(sw_client, a)["main_account_id"] is None


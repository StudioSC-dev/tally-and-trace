"""Deactivating a shared account (STU-234): the owner's alone, seen by sharees.

Every other role (admin, editor, viewer, a Household ``tag_viewer``, a
stranger) gets the 404 every other refused account change gets, before any
obligation check, so none learns what the account owes. Once the owner
deactivates it, every direct sharee sees it inactive, exactly as the owner does.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
DEACTIVATIONS = ["put", "delete"]


def _call(client, who, method, path, body=None):
    return client.request(method, f"{API}{path}", json=body, headers=who["headers"])


def _deactivate(client, who, account_id, how):
    if how == "put":
        return _call(client, who, "PUT", f"/accounts/{account_id}", {"is_active": False})
    return _call(client, who, "DELETE", f"/accounts/{account_id}")


def _is_active(client, who, account_id):
    return _call(client, who, "GET", f"/accounts/{account_id}").json()["is_active"]


def _charge(client, who, card, amount):
    return sw_post(client, who, "/transactions/", {
        "account_id": card, "amount": amount, "transaction_type": "debit",
        "description": "Charge", "transaction_date": DAY, "is_posted": True})


# --- Owner only -------------------------------------------------------------------------

@pytest.mark.parametrize("how", DEACTIVATIONS)
@pytest.mark.parametrize("who", ["d", "b", "v", "s"])
def test_non_owners_cannot_deactivate_and_never_see_an_obligation(sw, sw_client, sw_db, who, how):
    a, card = sw["a"], sw["a_card"]
    for role_holder, role in (("d", "admin"), ("b", "editor"), ("v", "viewer")):
        sw_share(sw_db, card, sw[role_holder]["id"], role, a["id"])
    _charge(sw_client, a, card, 2_500)

    for account in (card, sw["joint"]):
        r = _deactivate(sw_client, sw[who], account, how)
        assert r.status_code == 404, r.text
        assert r.json()["detail"] == "Account not found"
        assert _is_active(sw_client, a, account) is True


@pytest.mark.parametrize("how", DEACTIVATIONS)
@pytest.mark.parametrize("who", ["d", "b", "v", "s"])
def test_non_owners_probing_a_loan_with_a_pending_payment_get_404(sw, sw_client, sw_db,
                                                                  who, how):
    a, loan = sw["a"], sw["a_loan"]
    for role_holder, role in (("d", "admin"), ("b", "editor"), ("v", "viewer")):
        sw_share(sw_db, loan, sw[role_holder]["id"], role, a["id"])
    sw_post(sw_client, a, f"/accounts/{loan}/loan-payment",
            {"amount": 5_000, "is_posted": False, "transaction_date": DAY})

    r = _deactivate(sw_client, sw[who], loan, how)
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "Account not found"
    assert _is_active(sw_client, a, loan) is True


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_tag_viewer_cannot_deactivate(hh, sw_client, how):
    a, c, joint = hh["a"], hh["c"], hh["joint"]  # C holds A's Household tag share
    assert _call(sw_client, c, "GET", f"/accounts/{joint}").json()["my_role"] == "tag_viewer"

    r = _deactivate(sw_client, c, joint, how)
    assert r.status_code == 404, r.text
    assert _is_active(sw_client, a, joint) is True


# --- Sharees see it inactive ------------------------------------------------------------

@pytest.mark.parametrize("who", ["a", "d", "b", "v"])
def test_sharees_see_a_deactivated_shared_account_as_inactive(sw, sw_client, who):
    joint, caller = sw["joint"], sw[who]
    assert _deactivate(sw_client, sw["a"], joint, "put").status_code == 200

    detail = _call(sw_client, caller, "GET", f"/accounts/{joint}")
    assert detail.status_code == 200
    assert detail.json()["is_active"] is False

    def listed(query=""):
        r = _call(sw_client, caller, "GET", f"/accounts/?limit=1000{query}")
        assert r.status_code == 200
        return {item["id"]: item for item in r.json()["items"]}

    assert listed()[joint]["is_active"] is False
    assert listed("&is_active=false")[joint]["is_active"] is False
    assert joint not in listed("&is_active=true")

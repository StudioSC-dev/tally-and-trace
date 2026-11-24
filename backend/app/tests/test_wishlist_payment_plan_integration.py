"""A wishlist item's payment account and plan (STU-779).

An item names the account its purchase is paid from and whether it is paid in full
or as a card installment over 2 to 60 months. The account passes the recurring
entries' check: the caller and the item's owner both hold an edit role on it, so
a household admin or editor plans on a shared account and a viewer cannot. Uses
the ``sw`` household (A owns the joint account, B edits it, V views it, D admins
it; S is a stranger). Skips without a database.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


def _create(client, who, expect=(201,), **fields):
    body = {"name": "Laptop", "estimated_cost": 60_000, "currency": "PHP", **fields}
    r = client.post(f"{API}/wishlist/", json=body, headers=who["headers"])
    assert r.status_code in expect, r.text
    return r


def _update(client, who, item_id, expect=(200,), **fields):
    r = client.put(f"{API}/wishlist/{item_id}", json=fields, headers=who["headers"])
    assert r.status_code in expect, r.text
    return r


def test_an_item_defaults_to_a_full_payment_from_no_account(sw_client, sw):
    body = _create(sw_client, sw["a"]).json()
    assert (body["payment_plan"], body["installment_months"], body["account_id"],
            body["installment_entry_id"], body["notice"]) == ("full", None, None, None, None)


def test_an_installment_needs_a_card_and_a_month_count(sw_client, sw):
    client, a = sw_client, sw["a"]
    ok = _create(client, a, payment_plan="installment", installment_months=6,
                 account_id=sw["a_card"]).json()
    assert (ok["payment_plan"], ok["installment_months"], ok["account_id"]) == (
        "installment", 6, sw["a_card"])
    # No month count, or one out of 2..60.
    for months in (None, 1, 61):
        _create(client, a, expect=(422,), payment_plan="installment",
                installment_months=months, account_id=sw["a_card"])
    # A month count on a full payment.
    _create(client, a, expect=(422,), installment_months=6, account_id=sw["a_card"])
    # Not a card, or no account.
    r = _create(client, a, expect=(400,), payment_plan="installment", installment_months=6,
                account_id=sw["a_private"])
    assert r.json()["detail"] == "An installment is paid from a credit card account"
    _create(client, a, expect=(400,), payment_plan="installment", installment_months=6)
    # A full payment may come from a card or a bank, never a loan.
    _create(client, a, account_id=sw["a_card"])
    _create(client, a, account_id=sw["a_private"])
    r = _create(client, a, expect=(400,), account_id=sw["a_loan"])
    assert r.json()["detail"] == "A wishlist item cannot be paid from a loan"


def test_a_price_too_small_for_the_months_is_refused(sw_client, sw):
    r = _create(sw_client, sw["a"], expect=(422,), estimated_cost=0.01,
                payment_plan="installment", installment_months=2, account_id=sw["a_card"])
    assert r.json()["detail"] == "The price is too small to split into 2 payments"
    item = _create(sw_client, sw["a"], estimated_cost=0.06).json()["id"]
    _update(sw_client, sw["a"], item, expect=(422,), payment_plan="installment",
            installment_months=4, account_id=sw["a_card"])


def test_household_edit_roles_may_plan_on_a_shared_account(sw_client, sw_db, sw):
    client = sw_client
    # The joint account: B edits it, D admins it, V only views it, S has no role.
    for who in (sw["b"], sw["d"]):
        assert _create(client, who, account_id=sw["joint"]).json()["account_id"] == sw["joint"]
    for who in (sw["v"], sw["s"]):
        r = _create(client, who, expect=(404,), account_id=sw["joint"])
        assert r.json()["detail"] == "Account not found"
    # A's card shared with B as an editor: B may put an installment on it.
    sw_share(sw_db, sw["a_card"], sw["b"]["id"], "editor", sw["a"]["id"])
    body = _create(client, sw["b"], payment_plan="installment", installment_months=12,
                   account_id=sw["a_card"]).json()
    assert body["user_id"] == sw["b"]["id"]
    # Another user's private account is never found.
    _create(client, sw["b"], expect=(404,), account_id=sw["a_private"])


def test_an_update_keeps_the_payment_rules(sw_client, sw):
    client, a = sw_client, sw["a"]
    item = _create(client, a, payment_plan="installment", installment_months=6,
                   account_id=sw["a_card"]).json()["id"]
    # Back to a full payment clears the months.
    body = _update(client, a, item, payment_plan="full").json()
    assert (body["payment_plan"], body["installment_months"]) == ("full", None)
    # An installment again, but on a bank account, or without months.
    _update(client, a, item, expect=(400,), payment_plan="installment", installment_months=6,
            account_id=sw["a_private"])
    _update(client, a, item, expect=(422,), payment_plan="installment")
    _update(client, a, item, expect=(422,), payment_plan=None)
    body = _update(client, a, item, payment_plan="installment", installment_months=3).json()
    assert (body["payment_plan"], body["installment_months"], body["account_id"]) == (
        "installment", 3, sw["a_card"])
    # Moving an installment to a bank account is refused; clearing the account too.
    _update(client, a, item, expect=(400,), account_id=sw["a_private"])
    _update(client, a, item, expect=(400,), account_id=None)
    # A name change alone is never refused on the account.
    assert _update(client, a, item, name="Laptop Pro").json()["name"] == "Laptop Pro"


def test_an_update_checks_the_account_for_the_caller(sw_client, sw_db, sw):
    client = sw_client
    item = _create(client, sw["b"]).json()["id"]
    _update(client, sw["b"], item, expect=(404,), account_id=sw["a_card"])
    _update(client, sw["b"], item, account_id=sw["joint"])
    # Someone else's item is not found at all.
    _update(client, sw["a"], item, expect=(404,), account_id=sw["joint"])


def test_the_export_lists_the_payment_fields(sw_client, sw):
    client, a = sw_client, sw["a"]
    _create(client, a, payment_plan="installment", installment_months=6,
            account_id=sw["a_card"])
    r = client.get(f"{API}/data/export.json", headers=a["headers"])
    assert r.status_code == 200, r.text
    (row,) = r.json()["wishlist_items"]
    assert (row["account_id"], row["payment_plan"], row["installment_months"],
            row["installment_entry_id"]) == (sw["a_card"], "installment", 6, None)


def test_plain_sw_post_still_creates(sw_client, sw):
    assert sw_post(sw_client, sw["a"], "/wishlist/", {
        "name": "Mug", "estimated_cost": 10})["payment_plan"] == "full"

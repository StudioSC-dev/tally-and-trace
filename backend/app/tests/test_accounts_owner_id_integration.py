"""STU-244: account responses carry ``owner_id``, the owner's user id.

The web routing picker matches the edited account's owner by id, since two
owners can share a display name. Every direct role (owner, admin, editor,
viewer) gets it; an account reached only through a Household tag share keeps
its minimal ``tag_viewer`` shape. Nothing else in the response or in who sees
which account changes.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# The direct-role fields before STU-244: the stored fields and the access fields.
ACCESS_FIELDS = {"my_role", "permissions", "owner_name", "is_shared"}
TAG_VIEWER_FIELDS = {"id", "name", "account_type", "currency", "balance", "my_role",
                     "permissions", "owner_name", "tags"}


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _listed(client, who):
    return {a["id"]: a for a in _get(client, who, "/accounts/", limit=100)["items"]}


def test_account_out_has_owner_id(sw, sw_client, sw_db, sw_people):
    """AC7: list, read, create and update all give the owner's id, to the owner
    and to every sharee, and two owners with one display name get different ids."""
    a = sw["a"]
    for acct in (sw["joint"], sw["a_private"], sw["a_card"], sw["a_loan"]):
        assert _listed(sw_client, a)[acct]["owner_id"] == a["id"]
        assert _get(sw_client, a, f"/accounts/{acct}")["owner_id"] == a["id"]
    for who in ("b", "v", "d"):
        assert _listed(sw_client, sw[who])[sw["joint"]]["owner_id"] == a["id"]
        assert _get(sw_client, sw[who], f"/accounts/{sw['joint']}")["owner_id"] == a["id"]
    assert _listed(sw_client, sw["b"])[sw["b_private"]]["owner_id"] == sw["b"]["id"]

    created = sw_post(sw_client, a, "/accounts/", {
        "name": "Spare", "account_type": "savings", "balance": 0})
    assert created["owner_id"] == a["id"]
    r = sw_client.put(f"{API}/accounts/{created['id']}", headers=a["headers"],
                      json={"name": "Spare 2"})
    assert r.status_code == 200, r.text
    assert r.json()["owner_id"] == a["id"]

    # A second "Alice O.": same display name, different owner.
    twin = sw_people("Alice", "Other")
    twin_bank = sw_post(sw_client, twin, "/accounts/", {
        "name": "Twin bank", "account_type": "checking", "balance": 0})["id"]
    sw_share(sw_db, twin_bank, sw["d"]["id"], "editor", twin["id"])
    seen = _listed(sw_client, sw["d"])
    assert seen[twin_bank]["owner_name"] == seen[sw["joint"]]["owner_name"] == "Alice O."
    assert seen[twin_bank]["owner_id"] == twin["id"] != seen[sw["joint"]]["owner_id"]


def test_owner_id_preserves_existing_fields_and_visibility(sw, sw_client, hh):
    """AC10: the same fields as before plus ``owner_id``, the same accounts for
    each caller, the editor's manager-only fields still null, and the
    ``tag_viewer`` shape unchanged (no ``owner_id``)."""
    from app.schemas.account import AccountFields

    direct_fields = set(AccountFields.model_fields) | ACCESS_FIELDS | {"owner_id"}
    expected = {
        "a": {sw["joint"], sw["a_private"], sw["a_card"], sw["a_loan"]},
        "b": {sw["joint"], sw["b_private"]},
        "v": {sw["joint"]},
        "d": {sw["joint"]},
        "s": {sw["s_bank"]},
    }
    for who, ids in expected.items():
        listed = _listed(sw_client, sw[who])
        assert set(listed) == ids, who
        for account in listed.values():
            assert set(account) == direct_fields, (who, set(account) ^ direct_fields)
    joint_for_b = _listed(sw_client, sw["b"])[sw["joint"]]
    assert joint_for_b["my_role"] == "editor" and joint_for_b["is_shared"] is None
    assert joint_for_b["description"] is None and joint_for_b["owner_name"] == "Alice O."
    assert _listed(sw_client, sw["a"])[sw["a_private"]]["description"].endswith("description")
    r = sw_client.get(f"{API}/accounts/{sw['a_private']}", headers=sw["b"]["headers"])
    assert r.status_code == 404

    c_seen = _listed(sw_client, hh["c"])
    assert set(c_seen) == {hh["joint"], hh["c_private"]}
    assert set(c_seen[hh["joint"]]) == TAG_VIEWER_FIELDS
    assert c_seen[hh["c_private"]]["owner_id"] == hh["c"]["id"]

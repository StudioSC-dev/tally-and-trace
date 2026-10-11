"""Shared accounts (STU-232): who holds which role, and who may read what.

Role resolution is ``account_role``; the HTTP checks prove every read path
honours it: a share grants reading the account and every record touching it,
and nothing else; a stranger still gets 404.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _get(client, who, path):
    return client.get(f"{API}{path}", headers=who["headers"])


def test_account_role_comes_from_the_share_row(sw, sw_db):
    from app.core.access import account_role
    from app.models.account import Account

    joint = sw_db.get(Account, sw["joint"])
    sw_db.refresh(joint)
    assert account_role(sw["a"]["id"], joint) == "owner"
    assert account_role(sw["b"]["id"], joint) == "editor"
    assert account_role(sw["v"]["id"], joint) == "viewer"
    assert account_role(sw["d"]["id"], joint) == "admin"
    assert account_role(sw["s"]["id"], joint) == "none"
    private = sw_db.get(Account, sw["a_private"])
    assert account_role(sw["b"]["id"], private) == "none"


def test_owner_wins_over_a_share_row(sw, sw_db):
    """A stray share row naming the owner never lowers the owner's role."""
    from app.core.access import account_role, role_map
    from app.models.account import Account

    sw_share(sw_db, sw["joint"], sw["a"]["id"], "viewer")
    joint = sw_db.get(Account, sw["joint"])
    sw_db.refresh(joint)
    assert account_role(sw["a"]["id"], joint) == "owner"
    assert role_map(sw_db, sw["a"]["id"])[sw["joint"]] == "owner"


def test_role_map_matches_account_role(sw, sw_db):
    from app.core.access import role_map

    assert role_map(sw_db, sw["b"]["id"]) == {sw["joint"]: "editor", sw["b_private"]: "owner"}
    assert role_map(sw_db, sw["v"]["id"]) == {sw["joint"]: "viewer"}
    assert role_map(sw_db, sw["s"]["id"]) == {sw["s_bank"]: "owner"}


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_sharees_list_and_read_the_shared_account(sw, sw_client, who):
    listed = _get(sw_client, sw[who], "/accounts/?limit=100").json()["items"]
    ids = {a["id"] for a in listed}
    assert sw["joint"] in ids
    assert not ids & {sw["a_private"], sw["a_card"], sw["a_loan"]}
    assert _get(sw_client, sw[who], f"/accounts/{sw['joint']}").status_code == 200
    for hidden in ("a_private", "a_card", "a_loan", "s_bank"):
        assert _get(sw_client, sw[who], f"/accounts/{sw[hidden]}").status_code == 404


def test_stranger_reads_nothing_shared(sw, sw_client):
    s = sw["s"]
    ids = {a["id"] for a in _get(sw_client, s, "/accounts/?limit=100").json()["items"]}
    assert ids == {sw["s_bank"]}
    assert _get(sw_client, s, f"/accounts/{sw['joint']}").status_code == 404
    assert _get(sw_client, s, f"/accounts/{sw['joint']}/balance").status_code == 404


def _records(sw, sw_client):
    a, b = sw["a"], sw["b"]
    owner_txn = sw_post(sw_client, a, "/transactions/", {
        "account_id": sw["joint"], "amount": 120, "transaction_type": "debit",
        "description": "Groceries", "transaction_date": "2026-10-01T00:00:00"})["id"]
    private_txn = sw_post(sw_client, a, "/transactions/", {
        "account_id": sw["a_private"], "amount": 55, "transaction_type": "debit",
        "description": "Private spend", "transaction_date": "2026-10-01T00:00:00"})["id"]
    partner_txn = sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["b_private"], "amount": 30, "transaction_type": "debit",
        "description": "Partner spend", "transaction_date": "2026-10-01T00:00:00"})["id"]
    entry = sw_post(sw_client, a, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 900,
        "next_occurrence": "2026-11-01T00:00:00", "account_id": sw["joint"]})["id"]
    private_entry = sw_post(sw_client, a, "/budget-entries/", {
        "name": "Gym", "entry_type": "expense", "amount": 50,
        "next_occurrence": "2026-11-01T00:00:00", "account_id": sw["a_private"]})["id"]
    return owner_txn, private_txn, partner_txn, entry, private_entry


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_sharees_read_records_on_the_shared_account_only(sw, sw_client, who):
    owner_txn, private_txn, partner_txn, entry, private_entry = _records(sw, sw_client)
    caller = sw[who]
    listed = {t["id"] for t in _get(sw_client, caller, "/transactions/?limit=100").json()["items"]}
    assert owner_txn in listed and private_txn not in listed
    assert _get(sw_client, caller, f"/transactions/{owner_txn}").status_code == 200
    assert _get(sw_client, caller, f"/transactions/{private_txn}").status_code == 404
    entries = {e["id"] for e in _get(sw_client, caller, "/budget-entries/?limit=100").json()["items"]}
    assert entry in entries and private_entry not in entries
    assert _get(sw_client, caller, f"/budget-entries/{entry}").status_code == 200
    assert _get(sw_client, caller, f"/budget-entries/{private_entry}").status_code == 404
    # The owner never gains the partner's private records through the share.
    assert _get(sw_client, sw["a"], f"/transactions/{partner_txn}").status_code == 404


def test_stranger_reads_no_shared_record(sw, sw_client):
    owner_txn, _, _, entry, _ = _records(sw, sw_client)
    s = sw["s"]
    assert _get(sw_client, s, f"/transactions/{owner_txn}").status_code == 404
    assert _get(sw_client, s, f"/budget-entries/{entry}").status_code == 404
    assert _get(sw_client, s, "/transactions/?limit=100").json()["items"] == []

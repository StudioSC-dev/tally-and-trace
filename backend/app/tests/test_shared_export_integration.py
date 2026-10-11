"""Shared accounts (STU-232): the export through the Limited models.

Another user's records, and the caller's own records on an account they can no
longer view, are exported only through the Limited allowlists. The JSON, the
one-table CSVs and the ZIP carry none of the owner's private sentinels,
including after a revocation.
"""
import io
import re
import zipfile

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post
from app.tests.test_shared_redaction_integration import INTEREST, house  # noqa: F401

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

WHEN = "2026-10-03T00:00:00"


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r


def _all_exports(client, who):
    """(the JSON body, every CSV and ZIP member as text)."""
    from app.services.export import TABLE_FIELDS

    body = _get(client, who, "/data/export.json").json()
    texts = [_get(client, who, "/data/export.csv", table=t).text for t in TABLE_FIELDS]
    archive = zipfile.ZipFile(io.BytesIO(_get(client, who, "/data/export.csv").content))
    texts += [archive.read(name).decode() for name in archive.namelist()]
    return body, texts


def _clean(body, texts, private_ids):
    assert sw_leaks(body, private_ids, numbers=[INTEREST]) == []
    for text in texts:
        assert PRIVATE not in text
        assert not re.search(rf"(?<![\d.]){re.escape(str(INTEREST))}(?!\d)", text)


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_exports_carry_no_sentinel(sw, sw_client, house, who):  # noqa: F811
    body, texts = _all_exports(sw_client, sw[who])
    _clean(body, texts, house["private_ids"])
    assert body["export_version"] == 2
    others = {t["id"]: t for t in body["others_transactions"]}
    assert house["private_txn"] not in others
    joint_txn = others[house["joint_txn"]]
    assert set(joint_txn) == {"id", "date", "display_description", "amount", "transfer_fee",
                              "currency", "transaction_type", "is_posted", "category_name",
                              "created_by", "account", "counterpart"}
    assert joint_txn["display_description"] == "Weekly groceries"
    assert joint_txn["created_by"] == "Alice O."
    loan = others[house["loan_payment"]]
    assert (loan["amount"], loan["transfer_fee"]) == ("4777.77", None)
    assert loan["counterpart"] == {"id": None, "name": "Loan payment"}
    deposit = others[house["deposit"]]
    assert (deposit["display_description"], deposit["account"]) == (
        "Transfer", {"id": None, "name": "Other account"})
    entries = {e["id"]: e for e in body["others_budget_entries"]}
    assert house["private_entry"] not in entries
    assert entries[house["overflow_entry"]]["display_name"] == "Recurring expense"
    shared = {a["id"]: a for a in body["shared_accounts"]}
    assert set(shared) == {sw["joint"], house["card"], house["shared_loan"]}
    assert all(set(a) == {"id", "name", "account_type", "currency", "my_role", "owner_name"}
               for a in shared.values())
    assert body["accounts"] == [] or all(a["id"] not in shared for a in body["accounts"])
    assert all(PRIVATE not in t["name"] for t in body["tags"])


def test_the_owner_exports_their_own_records_in_full(sw, sw_client, house):  # noqa: F811
    body = _get(sw_client, sw["a"], "/data/export.json").json()
    own = {t["id"]: t for t in body["transactions"]}
    assert own[house["private_txn"]]["description"] == f"{PRIVATE} pharmacy"
    assert own[house["joint_txn"]]["receipt_url"] == f"/uploads/receipts/{PRIVATE}.png"
    assert body["shared_accounts"] == []
    assert body["others_transactions"] == []


def test_exports_stay_clean_after_a_revocation(sw, sw_client, house):  # noqa: F811
    b = sw["b"]
    spent = sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["joint"], "amount": 33, "transaction_type": "debit",
        "transaction_date": WHEN, "description": "Bea snacks"})["id"]
    moved = sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["b_private"], "transfer_from_account_id": sw["b_private"],
        "transfer_to_account_id": sw["joint"], "amount": 200, "transaction_type": "transfer",
        "transaction_date": WHEN, "description": "Bea deposit"})["id"]
    r = sw_client.delete(f"{API}/accounts/{sw['joint']}/shares/{sw['shares']['b']}",
                         headers=sw["a"]["headers"])
    assert r.status_code == 204

    body, texts = _all_exports(sw_client, b)
    _clean(body, texts, house["private_ids"] | {sw["joint"]})
    assert "Joint account" not in str(body) and all("Joint account" not in t for t in texts)
    assert {a["id"] for a in body["shared_accounts"]} == {house["card"], house["shared_loan"]}
    # Bea's own records on the joint account are limited for her now.
    others = {t["id"]: t for t in body["others_transactions"]}
    assert {spent, moved} <= set(others)
    assert {house["joint_txn"], house["deposit"], house["loan_payment"]}.isdisjoint(others)
    assert others[moved]["counterpart"] == {"id": None, "name": "Other account"}
    assert others[moved]["account"] == {"id": sw["b_private"], "name": "Bea bank"}
    assert others[spent]["display_description"] == "Expense"

    # The owner exports Bea's records on the joint account limited, with her
    # private account neutral.
    owner = _get(sw_client, sw["a"], "/data/export.json").json()
    theirs = {t["id"]: t for t in owner["others_transactions"]}
    assert set(theirs) == {spent, moved}
    assert theirs[moved]["account"] == {"id": None, "name": "Other account"}
    assert theirs[moved]["display_description"] == "Transfer"
    assert theirs[spent]["display_description"] == "Bea snacks"
    assert theirs[spent]["created_by"] == "Bea P."
    assert sw_leaks(owner["others_transactions"], {sw["b_private"]}) == []

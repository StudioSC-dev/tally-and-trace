"""Limited pending foreign rows keep today's shape (STU-304, owner ruling 2026-11-15).

A pending charge stored in the form's convention (``amount`` the account's figure,
``currency`` the account's, ``projected_amount``/``projected_currency`` the foreign
face) shows a Limited reader the record's stored ``amount`` and ``currency``, never
the face, and carries exactly the epic's approved Limited keys.
"""
from datetime import timedelta

import pytest

from app.core.time import naive_utc_now
from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_shared_redaction_integration import LIMITED_TRANSACTION_KEYS
from app.tests.test_card_statements_due_integration import LIMITED_KEYS as LIMITED_EVENT_KEYS

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _get(client, who, path):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def test_no_new_limited_keys(hh, sw_client):
    a, c = hh["a"], hh["c"]
    soon = (naive_utc_now() + timedelta(days=3)).replace(hour=0, minute=0, second=0,
                                                        microsecond=0)
    # Stored PHP 580; the face is USD 10: the two differ in figure and in currency.
    txn = sw_post(sw_client, a, "/transactions/", {
        "account_id": hh["a_card"], "amount": 580, "currency": "PHP",
        "projected_amount": 10, "projected_currency": "USD", "transaction_type": "debit",
        "transaction_date": soon.isoformat(), "is_posted": False,
        "description": "Dollar streaming", "tag_ids": [hh["hh_a"]]})["id"]

    # The record, read Limited: its stored amount and currency, the approved keys.
    body = _get(sw_client, c, f"/transactions/{txn}")
    assert body["view"] == "limited" and set(body) == LIMITED_TRANSACTION_KEYS
    assert (body["amount"], body["currency"], body["is_posted"]) == (580.0, "PHP", False)

    # The same charge as a Limited household row: the stored figure under the stored
    # currency, no cash, and exactly the Limited event keys.
    items = _get(sw_client, c, f"/household/{a['id']}/upcoming")["items"]
    (row,) = [i for i in items if i["display_name"] == "Dollar streaming"]
    assert set(row) == LIMITED_EVENT_KEYS
    assert (row["face_amount"], row["currency"], row["cash_delta"]) == (580.0, "PHP", 0.0)

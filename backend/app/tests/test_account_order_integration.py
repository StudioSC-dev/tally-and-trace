"""The snapshot lists accounts in id order whatever order the accounts table holds them in (STU-620).

Postgres hands rows back in storage order when a query has no ORDER BY, and updating a row
moves it to the end of the heap. After enough updates the order a request sees changes
between requests, so the snapshot's ``by_account`` lists came back shuffled. The projection
scope (``get_account_balances``) now sorts by ``Account.id``.
"""
import json

from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable
from app.tests.fixtures import golden

import pytest

needs_db = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _reorder_on_disk(db):
    """Rewrite every account row in descending id order: each update appends a new row
    version, so a heap scan now returns the accounts newest id first."""
    ids = [r[0] for r in db.execute(text("SELECT id FROM accounts ORDER BY id")).all()]
    for account_id in reversed(ids):
        db.execute(text("UPDATE accounts SET name = name WHERE id = :i"), {"i": account_id})
    db.commit()
    return ids


def _heap_ids(db):
    return [r[0] for r in db.execute(text("SELECT id FROM accounts")).all()]


@needs_db
def test_snapshot_account_order_survives_the_table_being_reordered(sw_client):
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        with golden.golden_world(sw_client) as (world, callers, ids):
            owner = callers["owner"]
            _reorder_on_disk(db)
            heap = _heap_ids(db)
            assert heap != sorted(heap), "the table is still in id order: the reorder did nothing"
            got = golden.capture(sw_client, world, owner, "owner", ids)["snapshot"]
            raw = sw_client.get(f"{API}/dashboard/snapshot", headers=owner.headers)
            assert raw.status_code == 200
            raw_body = raw.json()
    finally:
        db.close()
    # The golden text sorts ``balances.by_account``, so read the raw response: every
    # list of per-account rows must already be in ascending account id order.
    balances = [a["id"] for a in raw_body["balances"]["by_account"]]
    assert len(balances) > 1 and balances == sorted(balances)
    closings = [[a["account_id"] for a in row["by_account"]] for row in raw_body["account_closings"]]
    assert closings and all(c == sorted(c) for c in closings)

    want = golden.golden_file("owner", "snapshot").read_text(encoding="utf-8")
    # The golden compare sorts ``balances.by_account`` by its text; the rest of the snapshot
    # (every ``account_closings`` row's ``by_account``) must match in order.
    assert json.loads(got)["body"]["account_closings"] == json.loads(want)["body"]["account_closings"]
    assert got == want


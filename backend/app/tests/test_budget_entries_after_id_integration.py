"""The ``after_id`` cursor on ``GET /budget-entries/`` (STU-799). Skips without a database.

A cursor request returns the matching entries with an id above ``after_id``, in
ascending id order, so a client paging by the last id it saw returns every
surviving match exactly once even when an earlier entry is deleted or its next
occurrence changes between requests. A request without it keeps the display
order (next occurrence, then id) and offset paging.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _entry(client, who, account, name, day, entry_type="expense"):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": entry_type, "amount": 100, "cadence": "monthly",
        "next_occurrence": f"2027-03-{day:02d}T00:00:00", "account_id": account})["id"]


def _list(client, who, **params):
    r = client.get(f"{API}/budget-entries/", params=params, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _drain(client, who, limit, **params):
    seen, after_id = [], 0
    while True:
        page = _list(client, who, limit=limit, after_id=after_id, **params)
        seen += [e["id"] for e in page["items"]]
        if not page["has_more"]:
            return seen
        after_id = page["items"][-1]["id"]


def test_budget_entries_after_id_orders_by_id_and_preserves_legacy_pagination(
        sw_client, sw_people):
    who = sw_people()
    account = sw_post(sw_client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    # Id order and display order disagree: later ids fall earlier in the month.
    days = [20, 5, 15, 10, 25]
    ids = [_entry(sw_client, who, account, f"E{n}", day) for n, day in enumerate(days)]
    income = _entry(sw_client, who, account, "Pay", 1, entry_type="income")
    everything = ids + [income]

    # Legacy: no after_id keeps next-occurrence order and offset paging.
    legacy = _list(sw_client, who, limit=200)
    by_display = [income, ids[1], ids[3], ids[2], ids[0], ids[4]]
    assert [e["id"] for e in legacy["items"]] == by_display
    first = _list(sw_client, who, limit=2, offset=0)
    second = _list(sw_client, who, limit=2, offset=2)
    assert [e["id"] for e in first["items"] + second["items"]] == by_display[:4]
    assert first["has_more"] is True and first["total"] == 6

    # Cursor: ids above the cursor, ascending id.
    page = _list(sw_client, who, limit=200, after_id=0)
    assert [e["id"] for e in page["items"]] == everything
    page = _list(sw_client, who, limit=2, after_id=ids[1])
    assert [e["id"] for e in page["items"]] == [ids[2], ids[3]]
    assert page["has_more"] is True and page["total"] == 4
    last = _list(sw_client, who, limit=2, after_id=ids[4])
    assert [e["id"] for e in last["items"]] == [income] and last["has_more"] is False
    assert _list(sw_client, who, after_id=income)["items"] == []

    # The cursor keeps the other filters.
    only_income = _list(sw_client, who, after_id=0, entry_type="income")
    assert [e["id"] for e in only_income["items"]] == [income]

    # Paging by the last id returns each match once while an earlier entry is
    # deleted and another is moved to the front of the display order.
    page = _list(sw_client, who, limit=2, after_id=0)
    seen = [e["id"] for e in page["items"]]
    assert seen == ids[:2]
    deleted = sw_client.delete(f"{API}/budget-entries/{ids[0]}", headers=who["headers"])
    assert deleted.status_code < 300, deleted.text
    moved = sw_client.put(f"{API}/budget-entries/{ids[4]}", headers=who["headers"], json={
        "next_occurrence": "2027-02-01T00:00:00"})
    assert moved.status_code == 200, moved.text
    rest = []
    after_id = seen[-1]
    while True:
        page = _list(sw_client, who, limit=2, after_id=after_id)
        rest += [e["id"] for e in page["items"]]
        if not page["has_more"]:
            break
        after_id = page["items"][-1]["id"]
    assert seen + rest == [ids[0], ids[1], ids[2], ids[3], ids[4], income]
    assert rest == [ids[2], ids[3], ids[4], income]
    assert _drain(sw_client, who, 2) == [ids[1], ids[2], ids[3], ids[4], income]

"""``GET /transactions/`` filters by ``is_posted`` and by ``ids`` (STU-384).

The Transactions page's "Due and overdue" section lists pending rows up to
today + 30 days, and fetches the pending rows linked to missed occurrences by
id whatever their date. Both filters sit inside the read rule: an id the
caller cannot read matches nothing. Skips without a database.
"""
from datetime import datetime, time, timedelta

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

TODAY = datetime.combine(datetime.now().date(), time())


def _account(client, who, name="Checking"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "balance": 50_000})["id"]


def _txn(client, who, account_id, day: datetime, description, posted=True):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": 10,
        "description": description, "transaction_date": day.isoformat(),
        "is_posted": posted})["id"]


def _bulk(db, who, account_id, days, posted=False):
    """Many rows at once, written directly (listing does not read balances)."""
    from app.models.transaction import Transaction, TransactionType

    rows = [Transaction(user_id=who["id"], account_id=account_id, amount=1,
                        transaction_type=TransactionType.DEBIT, is_posted=posted,
                        description=f"bulk {i}", transaction_date=day,
                        created_by_actor=who["id"])
            for i, day in enumerate(days)]
    db.add_all(rows)
    db.commit()
    return [r.id for r in rows]


def _list(client, who, **params):
    r = client.get(f"{API}/transactions/", params=params, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _ids(body):
    return {t["id"] for t in body["items"]}


def test_is_posted_filters_both_ways(sw_client, sw_people):
    client = sw_client
    a, s = sw_people("Alice", "Owner"), sw_people("Sam", "Stranger")
    acct = _account(client, a)
    posted = _txn(client, a, acct, TODAY - timedelta(days=1), "Posted")
    pending = _txn(client, a, acct, TODAY - timedelta(days=1), "Pending", posted=False)

    assert _ids(_list(client, a, is_posted="false", limit=100)) == {pending}
    assert _ids(_list(client, a, is_posted="true", limit=100)) == {posted}
    assert _ids(_list(client, a, limit=100)) == {posted, pending}
    for flag in ("false", "true"):
        assert _list(client, s, is_posted=flag, limit=100)["items"] == []


def test_pending_window_lists_the_overdue_row_and_not_far_future_ones(sw_client, sw_db, sw_people):
    client = sw_client
    a = sw_people("Alice", "Owner")
    acct = _account(client, a)
    _bulk(sw_db, a, acct, [TODAY + timedelta(days=40 + i % 21) for i in range(200)])
    overdue = _txn(client, a, acct, TODAY - timedelta(days=3), "Overdue", posted=False)
    _txn(client, a, acct, TODAY - timedelta(days=3), "Posted", posted=True)

    end = (TODAY + timedelta(days=30)).replace(hour=23, minute=59, second=59)
    body = _list(client, a, is_posted="false", end_date=end.isoformat(), limit=50)
    assert _ids(body) == {overdue}
    assert body["total"] == 1
    assert body["has_more"] is False


def test_pending_window_pages_past_a_thousand_rows(sw_client, sw_db, sw_people):
    client = sw_client
    a = sw_people("Alice", "Owner")
    acct = _account(client, a)
    # Newest first: the oldest row is the 1001st.
    oldest = TODAY - timedelta(days=5)
    ids = _bulk(sw_db, a, acct, [oldest] + [TODAY + timedelta(days=1)] * 1000)

    end = (TODAY + timedelta(days=30)).replace(hour=23, minute=59, second=59)
    first = _list(client, a, is_posted="false", end_date=end.isoformat(), limit=1000)
    assert first["total"] == 1001
    assert first["has_more"] is True
    assert len(first["items"]) == 1000
    rest = _list(client, a, is_posted="false", end_date=end.isoformat(), limit=1000,
                 offset=1000)
    assert _ids(rest) == {ids[0]}
    assert rest["has_more"] is False


def test_ids_returns_exactly_the_listed_readable_rows(sw_client, sw_people):
    client = sw_client
    a, s = sw_people("Alice", "Owner"), sw_people("Sam", "Stranger")
    acct, s_acct = _account(client, a), _account(client, s, "Sam bank")
    far = _txn(client, a, acct, TODAY + timedelta(days=45), "Far pending", posted=False)
    near = _txn(client, a, acct, TODAY - timedelta(days=2), "Near pending", posted=False)
    posted = _txn(client, a, acct, TODAY - timedelta(days=2), "Posted")
    _txn(client, a, acct, TODAY - timedelta(days=2), "Not asked for", posted=False)
    hidden = _txn(client, s, s_acct, TODAY - timedelta(days=2), "Sam's", posted=False)

    body = _list(client, a, ids=[far, near, posted, hidden], limit=10)
    assert _ids(body) == {far, near, posted}
    assert body["total"] == 3

    body = _list(client, a, ids=[far, near, posted, hidden], is_posted="false", limit=10)
    assert _ids(body) == {far, near}

    assert _list(client, s, ids=[far, near, posted], limit=10)["items"] == []


def test_ids_is_capped_at_five_hundred(sw_client, sw_people):
    a = sw_people("Alice", "Owner")
    r = sw_client.get(f"{API}/transactions/", params={"ids": list(range(1, 502))},
                      headers=a["headers"])
    assert r.status_code == 422, r.text

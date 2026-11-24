"""Allocation progress (STU-781). Skips without a database.

``GET /allocations/{id}/progress`` was a 500 for an allocation with a target date and no
monthly target: the datetime import sat inside the monthly-target branch.
"""
from datetime import datetime, timedelta

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _allocation(client, who, **fields) -> tuple:
    account = sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 10_000})["id"]
    allocation = sw_post(client, who, "/allocations/", {
        "account_id": account, "name": "Goal", "allocation_type": "goal",
        "target_amount": 1_000, **fields})["id"]
    return account, allocation


def _progress(client, who, allocation):
    return client.get(f"{API}/allocations/{allocation}/progress", headers=who["headers"])


def test_progress_with_target_date_and_no_monthly_target(sw_client, sw_people):
    client = sw_client
    me = sw_people()
    target = (datetime.now() + timedelta(days=30)).isoformat()
    _, allocation = _allocation(client, me, target_date=target)

    r = _progress(client, me, allocation)

    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body["days_remaining"], int)
    assert body["monthly_progress"] == 0
    assert body["monthly_target"] is None


def test_progress_with_monthly_target_unchanged(sw_client, sw_people):
    client = sw_client
    me = sw_people()
    target = (datetime.now() + timedelta(days=30)).isoformat()
    account, allocation = _allocation(
        client, me, monthly_target=100, target_date=target)
    sw_post(client, me, "/transactions/", {
        "account_id": account, "allocation_id": allocation, "amount": 40,
        "transaction_type": "credit",
        "transaction_date": datetime.now().replace(day=1, hour=12).isoformat()})

    r = _progress(client, me, allocation)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["monthly_target"] == 100
    assert body["monthly_progress"] == 40
    assert isinstance(body["days_remaining"], int)

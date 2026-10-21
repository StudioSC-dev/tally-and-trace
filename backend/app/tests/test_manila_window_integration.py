"""The projection window and statement status start on the Manila calendar day (STU-343 Plan C).

Manila is UTC+8 with no daylight saving, so 16:00 UTC is Manila midnight: at
16:30 UTC on Mar 17 it is already Mar 18 in Manila, at 15:30 UTC still Mar 17.
Skips without a database.
"""
import sys
from datetime import datetime

import pytest

from app.services import forecast
from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def test_projection_windows_start_on_the_manila_day(monkeypatch):
    pin_clock(monkeypatch, datetime(2027, 3, 17, 16, 30))
    assert forecast._upcoming_window(30, None) == (datetime(2027, 3, 18), datetime(2027, 4, 18))
    assert forecast._timeline_window(30, None)[0] == datetime(2027, 3, 18)
    assert forecast._month_boundaries(3, None)[0] == datetime(2027, 3, 18)

    pin_clock(monkeypatch, datetime(2027, 3, 17, 15, 30))
    assert forecast._upcoming_window(30, None)[0] == datetime(2027, 3, 17)
    assert forecast._timeline_window(30, None)[0] == datetime(2027, 3, 17)
    assert forecast._month_boundaries(3, None)[0] == datetime(2027, 3, 17)


def test_statement_status_turns_overdue_at_manila_midnight(sw_client, sw_people, monkeypatch):
    """Card C closes on the 24th and is due 21 days later: the statement closing
    Feb 24 is due Mar 17, and turns overdue when Mar 18 begins in Manila."""
    client, me = sw_client, sw_people()
    checking = sw_post(client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    card = sw_post(client, me, "/accounts/", {
        "name": "Card C", "account_type": "credit", "balance": 0, "billing_cycle_start": 24,
        "days_until_due_date": 21, "payment_account_id": checking})["id"]
    sw_post(client, me, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": 1_200,
        "description": "Bookstore", "transaction_date": "2027-02-10T00:00:00",
        "is_posted": True})

    def statement_due_mar_17():
        r = client.get(f"{API}/accounts/{card}/statements", headers=me["headers"])
        assert r.status_code == 200, r.text
        [statement] = [s for s in r.json()["statements"]
                       if s["due_date"].startswith("2027-03-17")]
        assert statement["amount_due"] == 1_200.0
        return statement["status"]

    pin_clock(monkeypatch, datetime(2027, 3, 17, 15, 59))
    assert statement_due_mar_17() == "open"

    pin_clock(monkeypatch, datetime(2027, 3, 17, 16, 1))
    assert statement_due_mar_17() == "overdue"

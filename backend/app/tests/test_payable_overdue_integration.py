"""Payables flag an overdue occurrence on the Manila calendar day (STU-343).

A full budget-entry payable carries the occurrence it stands for
(``occurrence_date``) and ``overdue``, that occurrence being before today in
Manila. Skips without a database.
"""
import sys
from datetime import datetime

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _checking(client, who, balance=50_000):
    return sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": balance})["id"]


def _entry_payables(client, who, entry_id):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return [(p["due_date"], p["occurrence_date"], p["overdue"])
            for p in r.json()["payables"]
            if p.get("source") == "budget_entry" and p.get("source_id") == entry_id]


def test_full_payables_carry_occurrence_date_and_overdue(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = sw_post(client, me, "/budget-entries/", {
        "name": "Sofa installment", "entry_type": "expense", "amount": 3_000,
        "cadence": "monthly", "next_occurrence": "2026-10-05T00:00:00",
        "account_id": checking, "end_mode": "after_occurrences", "max_occurrences": 3})["id"]
    pin_clock(monkeypatch, REF)

    assert _entry_payables(client, me, entry) == [
        ("2026-10-18", "2026-10-05", True),
        ("2026-11-05", "2026-11-05", False),
    ]


def test_overdue_uses_the_manila_calendar(sw_client, sw_people, monkeypatch):
    """16:30 UTC on Oct 18 is 00:30 on Oct 19 in Manila: an Oct 18 occurrence is overdue,
    though the (UTC) window still starts on Oct 18 and lists it on its own day."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = sw_post(client, me, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 20_000,
        "cadence": "monthly", "next_occurrence": "2026-10-18T00:00:00",
        "account_id": checking})["id"]

    pin_clock(monkeypatch, datetime(2026, 10, 18, 16, 30))
    assert _entry_payables(client, me, entry)[0] == ("2026-10-18", "2026-10-18", True)

    pin_clock(monkeypatch, REF)
    assert _entry_payables(client, me, entry)[0] == ("2026-10-18", "2026-10-18", False)

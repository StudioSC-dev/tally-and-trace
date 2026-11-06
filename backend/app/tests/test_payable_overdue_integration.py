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
    """16:30 UTC on Oct 18 is 00:30 on Oct 19 in Manila: the window starts on Oct 19, so
    the open-ended rent's Oct 18 occurrence is before it and dropped, as every open-ended
    missed occurrence is, and the first payable is November's."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    entry = sw_post(client, me, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 20_000,
        "cadence": "monthly", "next_occurrence": "2026-10-18T00:00:00",
        "account_id": checking})["id"]

    pin_clock(monkeypatch, datetime(2026, 10, 18, 16, 30))
    assert _entry_payables(client, me, entry)[0] == ("2026-11-18", "2026-11-18", False)

    pin_clock(monkeypatch, REF)
    assert _entry_payables(client, me, entry)[0] == ("2026-10-18", "2026-10-18", False)


# --- every source (overdue label for loans, statements and pending transactions) ---------------

def _snapshot_payables(client, who):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["payables"]


def _of(rows, source, source_id=None):
    return [p for p in rows if p.get("source") == source
            and (source_id is None or p.get("source_id") == source_id)]


def _loan(client, who, paying, first="2026-10-05"):
    return sw_post(client, who, "/accounts/", {
        "name": "Car loan", "account_type": "loan", "loan_kind": "auto", "balance": -90_000,
        "loan_annual_rate": 6, "loan_term_months": 12, "loan_payment_amount": 8_000,
        "loan_first_payment_date": first, "payment_account_id": paying})["id"]


def test_overdue_loan_carries_its_real_date(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    loan = _loan(client, me, checking)
    pin_clock(monkeypatch, REF)

    rows = _of(_snapshot_payables(client, me), "loan", loan)
    assert [(p["due_date"], p["overdue"], p.get("original_date")) for p in rows] == [
        ("2026-10-18", True, "2026-10-05"),
        ("2026-11-05", False, None),
    ]
    assert "occurrence_date" not in rows[0]


def test_overdue_pending_transaction_carries_its_real_date(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    txn = sw_post(client, me, "/transactions/", {
        "account_id": checking, "transaction_type": "debit", "amount": 700,
        "description": "Water bill", "transaction_date": "2026-10-10T00:00:00",
        "is_posted": False})["id"]
    pin_clock(monkeypatch, REF)

    (row,) = _of(_snapshot_payables(client, me), "transaction", txn)
    assert (row["due_date"], row["overdue"], row["original_date"]) == (
        "2026-10-18", True, "2026-10-10")


def test_overdue_statement_carries_its_real_date(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    card = sw_post(client, me, "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "credit_limit": 100_000,
        "billing_cycle_start": 3, "days_until_due_date": 21,
        "payment_account_id": checking})["id"]
    sw_post(client, me, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": 4_000,
        "description": "Purchase", "transaction_date": "2026-08-20T00:00:00",
        "is_posted": True})
    pin_clock(monkeypatch, REF)

    rows = _of(_snapshot_payables(client, me), "statement", card)
    # The cycle that closed on Sep 3 fell due on Sep 24; the Oct 3 cycle owes nothing.
    assert [(p["due_date"], p["overdue"], p.get("original_date")) for p in rows] == [
        ("2026-10-18", True, "2026-09-24")]
    assert rows[0]["statement_close"] == "2026-09-03"


def test_row_order_and_due_date_do_not_change(sw_client, sw_people, monkeypatch):
    """The listing day and the order are as before: only the new fields are added."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    loan = _loan(client, me, checking)
    txn = sw_post(client, me, "/transactions/", {
        "account_id": checking, "transaction_type": "debit", "amount": 700,
        "description": "Water bill", "transaction_date": "2026-10-10T00:00:00",
        "is_posted": False})["id"]
    entry = sw_post(client, me, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 20_000, "cadence": "monthly",
        "next_occurrence": "2026-10-05T00:00:00", "account_id": checking,
        "end_mode": "after_occurrences", "max_occurrences": 3})["id"]
    pin_clock(monkeypatch, REF)

    rows = _snapshot_payables(client, me)
    got = [(p["source"], p["source_id"], p["due_date"]) for p in rows]
    # Recorded from the unchanged code (origin/main fc3dd78) for this scenario.
    assert got == [
        ("budget_entry", entry, "2026-10-18"),
        ("transaction", txn, "2026-10-18"),
        ("loan", loan, "2026-10-18"),
        ("budget_entry", entry, "2026-11-05"),
        ("loan", loan, "2026-11-05"),
    ]


def test_limited_row_keeps_its_real_date(sw, sw_client, sw_db, monkeypatch):
    """A shared-account viewer's Limited row lists on the window start with the real day in
    ``original_date``, which the dashboard shows (frontend/e2e/due-and-overdue.cjs)."""
    client, a, v = sw_client, sw["a"], sw["v"]
    sw_post(client, a, "/transactions/", {
        "account_id": sw["joint"], "transaction_type": "debit", "amount": 700,
        "description": "Water bill", "transaction_date": "2026-10-10T00:00:00",
        "is_posted": False})
    pin_clock(monkeypatch, REF)

    limited = [p for p in _snapshot_payables(client, v) if p.get("view") == "limited"]
    assert [(p["date"], p["overdue"], p["original_date"]) for p in limited] == [
        ("2026-10-18", True, "2026-10-10")]

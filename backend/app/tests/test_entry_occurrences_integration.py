"""GET /budget-entries/{id}/occurrences: what Mark paid can record (STU-343).

Skips without a database.
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


def _entry(client, who, account_id, next_day, amount=20_000, name="Rent", **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})["id"]


def _occurrences(client, who, entry_id, expect=200, **params):
    r = client.get(f"{API}/budget-entries/{entry_id}/occurrences", params=params,
                   headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _pending(client, who, account_id, entry_id, day, amount=20_000):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": "Rent", "transaction_date": f"{day}T00:00:00", "is_posted": False,
        "budget_entry_id": entry_id})["id"]


def test_occurrences_for_a_stale_rent(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    rent = _entry(client, me, _checking(client, me), "2026-08-01")
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, rent)

    assert {k: body[k] for k in ("entry_id", "today", "capped", "kind", "due_unposted",
                                 "omitted")} == {
        "entry_id": rent, "today": "2026-10-18", "capped": False, "kind": "cash",
        "due_unposted": 3, "omitted": 0}
    assert [(o["occurrence_date"], o["due"], o["linked"], o["skipped_before"])
            for o in body["occurrences"]] == [
        ("2026-08-01", True, None, 0),
        ("2026-09-01", True, None, 1),
        ("2026-10-01", True, None, 2),
        ("2026-11-01", False, None, 3),
    ]


def test_occurrences_always_include_the_requested_one(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    laundry = sw_post(client, me, "/budget-entries/", {
        "name": "Laundry", "entry_type": "expense", "amount": 100, "cadence": "weekly",
        "next_occurrence": "2025-06-01T00:00:00", "account_id": _checking(client, me)})["id"]
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, laundry, include="2026-10-25")
    days = [o["occurrence_date"] for o in body["occurrences"]]
    assert len(days) == 39
    assert (days[0], days[29], days[30], days[-1]) == (
        "2025-06-01", "2025-12-21", "2026-09-20", "2026-11-15")
    assert (body["omitted"], body["due_unposted"]) == (38, 73)
    oct25 = next(o for o in body["occurrences"] if o["occurrence_date"] == "2026-10-25")
    assert (oct25["skipped_before"], oct25["due"]) == (73, False)

    later = _occurrences(client, me, laundry, include="2026-12-27")
    assert len(later["occurrences"]) == 40
    assert later["occurrences"][-1]["occurrence_date"] == "2026-12-27"

    off = _occurrences(client, me, laundry, expect=422, include="2026-10-26")
    assert off["detail"] == "Not an occurrence of this schedule"


def test_occurrences_report_linked_rows(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _entry(client, me, checking, "2026-10-01")
    _pending(client, me, checking, rent, "2026-10-01")
    r = client.post(f"{API}/budget-entries/{rent}/materialize", headers=me["headers"],
                    json={"occurrence_date": "2026-11-01T00:00:00Z", "advance": False})
    assert r.status_code == 201, r.text
    _pending(client, me, checking, rent, "2026-12-01")
    _pending(client, me, checking, rent, "2026-12-01")
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, rent, include="2026-12-01")

    assert [(o["occurrence_date"], o["linked"], o["skipped_before"])
            for o in body["occurrences"]] == [
        ("2026-10-01", "pending", 0),
        ("2026-11-01", "posted", 1),
        ("2026-12-01", "ambiguous", 1),
    ]
    assert body["due_unposted"] == 1


def test_occurrences_for_capped_and_forbidden(sw_client, sw, monkeypatch):
    client, a = sw_client, sw["a"]
    phone = _entry(client, a, _checking(client, a), "2026-07-05", amount=1_000,
                   name="Phone", end_mode="after_occurrences", max_occurrences=24)
    joint_rent = _entry(client, a, sw["joint"], "2026-11-01")
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, a, phone)
    assert (body["capped"], body["kind"], body["due_unposted"], body["omitted"]) == (
        True, "cash", 4, 4)
    assert [o["occurrence_date"] for o in body["occurrences"]] == ["2026-07-05"]

    # B edits the joint account; V only views it, S has nothing.
    assert _occurrences(client, sw["b"], joint_rent)["entry_id"] == joint_rent
    _occurrences(client, sw["v"], joint_rent, expect=404)
    _occurrences(client, sw["s"], joint_rent, expect=404)
    _occurrences(client, sw["s"], phone, expect=404)

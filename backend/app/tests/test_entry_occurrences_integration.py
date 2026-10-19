"""GET /budget-entries/{id}/occurrences: what Mark paid can record (STU-343).

Skips without a database.
"""
import sys
from datetime import date, datetime, timedelta

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
    assert (body["oldest_due"], body["latest_due"]) == ("2026-08-01", "2026-10-01")
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


def test_occurrences_report_the_due_range_of_omitted_ones(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    laundry = sw_post(client, me, "/budget-entries/", {
        "name": "Laundry", "entry_type": "expense", "amount": 100, "cadence": "weekly",
        "next_occurrence": "2025-06-01T00:00:00", "account_id": checking})["id"]
    # Record the first 31 Sundays (2025-06-01..2025-12-28), 2026-09-13 and every
    # listed due one (2026-09-20..2026-10-18): only 2026-01-04..2026-09-06, all
    # in the omitted middle, stay unrecorded.
    recorded = [date(2025, 6, 1) + timedelta(weeks=i) for i in range(31)]
    recorded += [date(2026, 9, 13) + timedelta(weeks=i) for i in range(6)]
    for day in recorded:
        sw_post(client, me, "/transactions/", {
            "account_id": checking, "transaction_type": "debit", "amount": 100,
            "description": "Laundry", "transaction_date": f"{day}T00:00:00",
            "is_posted": True, "budget_entry_id": laundry})
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, laundry)

    listed = {o["occurrence_date"] for o in body["occurrences"]}
    assert body["omitted"] > 0
    assert not any(o["due"] and o["linked"] is None for o in body["occurrences"])
    assert body["due_unposted"] == 36
    assert (body["oldest_due"], body["latest_due"]) == ("2026-01-04", "2026-09-06")
    assert not {body["oldest_due"], body["latest_due"]} & listed
    # The gap: 2025-12-28..2026-09-13 (38 Sundays) sits right before 2026-09-20,
    # and the oldest unrecorded one is inside it.
    gaps = {o["occurrence_date"]: o["omitted_before"] for o in body["occurrences"]
            if o["omitted_before"]}
    assert gaps == {"2026-09-20": 38}
    assert sum(o["omitted_before"] for o in body["occurrences"]) == body["omitted"] == 38
    assert body["oldest_unrecorded"] == "2026-01-04"
    assert body["oldest_unrecorded"] not in listed


def test_occurrences_mark_a_recorded_omitted_run(sw_client, sw_people, monkeypatch):
    """Every omitted occurrence recorded: the gap is still marked, and the oldest
    unrecorded one is the first unrecorded of the whole walk (then none)."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    laundry = sw_post(client, me, "/budget-entries/", {
        "name": "Laundry", "entry_type": "expense", "amount": 100, "cadence": "weekly",
        "next_occurrence": "2025-06-01T00:00:00", "account_id": checking})["id"]

    def record(days):
        for day in days:
            sw_post(client, me, "/transactions/", {
                "account_id": checking, "transaction_type": "debit", "amount": 100,
                "description": "Laundry", "transaction_date": f"{day}T00:00:00",
                "is_posted": True, "budget_entry_id": laundry})

    # Every due Sunday, 2025-06-01..2026-10-18.
    record(date(2025, 6, 1) + timedelta(weeks=i) for i in range(73))
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, laundry)
    assert body["due_unposted"] == 0
    gaps = {o["occurrence_date"]: o["omitted_before"] for o in body["occurrences"]
            if o["omitted_before"]}
    assert gaps == {"2026-09-20": 38} and body["omitted"] == 38
    assert body["occurrences"][0]["omitted_before"] == 0
    assert body["oldest_unrecorded"] == "2026-10-25"

    record(date(2026, 10, 25) + timedelta(weeks=i) for i in range(4))  # ..2026-11-15
    assert _occurrences(client, me, laundry)["oldest_unrecorded"] is None


def test_occurrences_report_no_due_range_when_nothing_is_due(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    rent = _entry(client, me, _checking(client, me), "2026-11-01")
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, rent)

    assert (body["due_unposted"], body["oldest_due"], body["latest_due"]) == (0, None, None)


def test_occurrences_walk_a_decades_stale_schedule_completely(sw_client, sw_people, monkeypatch):
    """Past the projection's guard (2000 weekly steps, 600 semi-monthly months)."""
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    weekly = sw_post(client, me, "/budget-entries/", {
        "name": "Laundry", "entry_type": "expense", "amount": 100, "cadence": "weekly",
        "next_occurrence": "1985-01-06T00:00:00", "account_id": checking})["id"]
    semi = sw_post(client, me, "/budget-entries/", {
        "name": "Allowance", "entry_type": "expense", "amount": 100,
        "cadence": "semi_monthly", "semi_monthly_day_1": 1, "semi_monthly_day_2": 15,
        "next_occurrence": "1970-01-01T00:00:00", "account_id": checking})["id"]
    pin_clock(monkeypatch, REF)

    body = _occurrences(client, me, weekly, include="2026-10-18")
    assert (body["due_unposted"], body["oldest_due"], body["latest_due"]) == (
        2181, "1985-01-06", "2026-10-18")
    assert len(body["occurrences"]) + body["omitted"] == 2185  # through 2026-11-15
    oct18 = next(o for o in body["occurrences"] if o["occurrence_date"] == "2026-10-18")
    assert oct18["skipped_before"] == 2180

    body = _occurrences(client, me, semi, include="2026-11-15")
    assert (body["due_unposted"], body["oldest_due"], body["latest_due"]) == (
        1364, "1970-01-01", "2026-10-15")
    assert body["occurrences"][-1]["occurrence_date"] == "2026-11-15"
    assert body["occurrences"][-1]["skipped_before"] == 1365

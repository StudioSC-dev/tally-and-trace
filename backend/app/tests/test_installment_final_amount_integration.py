"""An installment's last payment bills ``final_amount`` (STU-658). Skips without a database.

A card installment split from its total bills the total ÷ N rounded to the
centavo each month, and the last payment absorbs the difference, as Metrobank
and HSBC state. The entry stores that last figure as ``final_amount``; every
reader of a recurring occurrence's amount reads it through
``forecast.occurrence_amount``: ``final_amount`` on the last occurrence,
``amount`` on every other.

World (``hh``): owner A's card (cycle on the 15th, due 21 days later, paid from
A's private bank), and C, who holds A's Household tag share. "Laptop" is A's
10,000.00 installment over three months tagged Household: 3,333.33 on
2026-12-15 and 2027-01-15, then 3,333.34 on 2027-02-15. Each reader case runs
with no payments paid before import and with two (``occurrences_paid_offset``),
which must not change which occurrence is the last. Today is 2026-11-16 in
Manila unless a phase moves the clock.
"""
import sys
from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 16, 2, 0)  # 10:00 in Manila
TOKEN = "test-job-token"
MONTHLY, LAST = 3333.33, 3333.34
DAYS = ["2026-12-15", "2027-01-15", "2027-02-15"]
CLOSES = [date(2026, 12, 15), date(2027, 1, 15), date(2027, 2, 15)]


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def on_day(monkeypatch, day: str) -> None:
    pin_clock(monkeypatch, datetime.fromisoformat(f"{day}T02:00:00"))


def _get(w, path, who=None, **params):
    r = w["client"].get(f"{API}{path}", params=params, headers=(who or w["a"])["headers"])
    assert r.status_code == 200, (path, r.text)
    return r.json()


def _laptop(w, offset=0, **extra) -> dict:
    body = {"name": "Laptop", "entry_type": "expense", "amount": MONTHLY, "final_amount": LAST,
            "cadence": "monthly", "next_occurrence": "2026-12-05T00:00:00",
            "end_mode": "after_occurrences", "max_occurrences": 3,
            "occurrences_paid_offset": offset, "account_id": w["a_card"],
            "tag_ids": [w["hh_a"]], **extra}
    return sw_post(w["client"], w["a"], "/budget-entries/", body)


@pytest.fixture
def world(hh, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    pin_clock(monkeypatch, REF)
    return {**hh, "client": hh.get("client"), "monkeypatch": monkeypatch}


@pytest.fixture
def w(world, sw_client, sw_db):
    return {**world, "client": sw_client, "db": sw_db}


def _txn_amounts(w, entry_id) -> list:
    w["db"].rollback()
    return [(r.occurrence_date.date().isoformat(), float(r.amount), r.is_posted)
            for r in w["db"].execute(text(
                "SELECT occurrence_date, amount, is_posted FROM transactions "
                "WHERE budget_entry_id = :e ORDER BY occurrence_date, id"), {"e": entry_id})]


def _mark_paid(w, entry_id, times) -> list:
    out = []
    for _ in range(times):
        r = w["client"].post(f"{API}/budget-entries/{entry_id}/materialize", json={},
                             headers=w["a"]["headers"])
        assert r.status_code == 201, r.text
        out.append((r.json()["transaction_date"][:10], r.json()["amount"]))
    return out


def _auto_post_off(w, entry_id) -> None:
    r = w["client"].post(f"{API}/budget-entries/{entry_id}/auto-post", json={"enabled": False},
                         headers=w["a"]["headers"])
    assert r.status_code == 200, r.text


def _first_two_paid(w, entry_id) -> None:
    """Phase B: the first two months recorded by Mark paid on 2027-02-01, so the
    last is the only one left."""
    _auto_post_off(w, entry_id)
    on_day(w["monkeypatch"], "2027-02-01")
    assert _mark_paid(w, entry_id, 2) == [(DAYS[0], MONTHLY), (DAYS[1], MONTHLY)]


# --- validation (AC2) -------------------------------------------------------------------------

def test_final_amount_validation(w):
    client, headers = w["client"], w["a"]["headers"]

    def create(**extra):
        body = {"name": "Probe", "entry_type": "expense", "amount": 100, "cadence": "monthly",
                "next_occurrence": "2026-12-05T00:00:00", "end_mode": "after_occurrences",
                "max_occurrences": 3, "account_id": w["a_card"], **extra}
        return client.post(f"{API}/budget-entries/", json=body, headers=headers)

    def entries():
        w["db"].rollback()
        return w["db"].execute(text("SELECT count(*) FROM budget_entries WHERE user_id = :u"),
                               {"u": w["a"]["id"]}).scalar_one()

    before = entries()
    for bad in (0, -5, 0.001, 12.345):
        assert create(final_amount=bad).status_code == 422, bad
    # Without a finite occurrence count.
    assert create(final_amount=99, end_mode="indefinite", max_occurrences=None).status_code == 422
    assert create(final_amount=99, end_mode="on_date", max_occurrences=None,
                  end_date="2027-06-01T00:00:00").status_code == 422
    assert create(final_amount=99, max_occurrences=None).status_code == 422
    assert entries() == before

    entry = create(final_amount=101.5).json()
    assert entry["final_amount"] == 101.5
    url = f"{API}/budget-entries/{entry['id']}"
    for bad in ({"final_amount": 0}, {"final_amount": -1}, {"final_amount": 1.005},
                {"end_mode": "indefinite", "max_occurrences": None}):
        assert client.put(url, json=bad, headers=headers).status_code == 422, bad
    w["db"].rollback()
    assert w["db"].execute(text(
        "SELECT final_amount, end_mode FROM budget_entries WHERE id = :e"),
        {"e": entry["id"]}).one() == (Decimal("101.50"), "after_occurrences")
    # An open-ended entry cannot be given one.
    open_ended = create(end_mode="indefinite", max_occurrences=None).json()
    assert client.put(f"{API}/budget-entries/{open_ended['id']}", json={"final_amount": 5},
                      headers=headers).status_code == 422
    # Cleared, every occurrence is ``amount`` again; a later edit may set it.
    r = client.put(url, json={"final_amount": None}, headers=headers)
    assert r.status_code == 200 and r.json()["final_amount"] is None, r.text
    r = client.put(url, json={"final_amount": "99.99"}, headers=headers)
    assert r.status_code == 200 and r.json()["final_amount"] == 99.99, r.text

    # ``repeat.final_amount`` follows the same rules, and a refusal saves nothing.
    before = entries()
    for repeat in ({"end_mode": "after_occurrences", "max_occurrences": 3, "final_amount": 0},
                   {"end_mode": "after_occurrences", "max_occurrences": 3,
                    "final_amount": "1.001"},
                   {"end_mode": "indefinite", "final_amount": "5"}):
        r = client.post(f"{API}/transactions/repeating", json={
            "transaction": {"account_id": w["a_card"], "amount": 5, "transaction_type": "debit",
                            "transaction_date": "2026-11-16T00:00:00", "description": "Probe"},
            "repeat": {"cadence": "monthly", **repeat}}, headers=headers)
        assert r.status_code == 422, (repeat, r.text)
    assert entries() == before

"""POST /budget-entries/{id}/materialize-due: Post N due (STU-343).

Every due occurrence (through today on the Manila calendar) of a non-capped
subscription or cash expense is recorded in one commit, each through the Mark
paid primitive. Skips without a database.
"""
import os
import sys
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking):
    return _account(client, who, "Card C", "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)


def _entry(client, who, account_id, next_day, amount, name, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})["id"]


def _row(client, who, account_id, entry_id, day, amount, posted=False):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": "Linked", "transaction_date": f"{day}T00:00:00",
        "is_posted": posted, "budget_entry_id": entry_id})["id"]


def _due(client, who, entry_id):
    return client.post(f"{API}/budget-entries/{entry_id}/materialize-due",
                       headers=who["headers"])


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _state(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _linked(engine, entry_id) -> list:
    with engine.connect() as c:
        return [tuple(r) for r in c.execute(text(
            "SELECT id, is_posted FROM transactions WHERE budget_entry_id = :e ORDER BY id"),
            {"e": entry_id})]


def _summary(body) -> list:
    return [(r["occurrence_date"], r["outcome"]) for r in body["results"]]


def test_materialize_due_posts_every_due_occurrence(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    netflix = _entry(client, me, card, "2026-08-10", 549, "Netflix")
    rent = _entry(client, me, checking, "2026-09-01", 20_000, "Rent")
    pin_clock(monkeypatch, REF)

    r = _due(client, me, netflix)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["entry_id"] == netflix and body["is_active"] is True
    assert _summary(body) == [("2026-08-10", "created"), ("2026-09-10", "created"),
                              ("2026-10-10", "created")]
    assert [t["transaction"]["transaction_date"][:10] for t in body["results"]] == [
        "2026-08-10", "2026-09-10", "2026-10-10"]
    assert all(t["transaction"]["is_posted"] for t in body["results"])
    assert body["next_occurrence"].startswith("2026-11-10")
    assert _balance(client, me, card) == Decimal("-1647.00")

    r = _due(client, me, rent)
    assert r.status_code == 200, r.text
    assert _summary(r.json()) == [("2026-09-01", "created"), ("2026-10-01", "created")]
    assert _state(client, me, rent)["next_occurrence"].startswith("2026-11-01")
    assert _balance(client, me, checking) == Decimal("10000.00")


def test_materialize_due_reuses_a_linked_pending_row(sw_client, sw_people, engine, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    netflix = _entry(client, me, card, "2026-08-10", 549, "Netflix")
    pending = _row(client, me, card, netflix, "2026-09-10", 549)
    pin_clock(monkeypatch, REF)

    r = _due(client, me, netflix)

    assert r.status_code == 200, r.text
    assert _summary(r.json()) == [("2026-08-10", "created"), ("2026-09-10", "posted_pending"),
                                  ("2026-10-10", "created")]
    assert r.json()["results"][1]["transaction"]["id"] == pending
    assert [posted for _, posted in _linked(engine, netflix)] == [True, True, True]
    assert _balance(client, me, card) == Decimal("-1647.00")


def test_materialize_due_advances_past_a_posted_month(sw_client, sw_people, engine, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    netflix = _entry(client, me, card, "2026-08-10", 549, "Netflix")
    _row(client, me, card, netflix, "2026-09-10", 549, posted=True)
    pin_clock(monkeypatch, REF)

    r = _due(client, me, netflix)

    assert r.status_code == 200, r.text
    assert _summary(r.json()) == [("2026-08-10", "created"), ("2026-09-10", "already_posted"),
                                  ("2026-10-10", "created")]
    assert len(_linked(engine, netflix)) == 3
    assert _balance(client, me, card) == Decimal("-1647.00")
    assert r.json()["next_occurrence"].startswith("2026-11-10")
    assert _state(client, me, netflix)["next_occurrence"].startswith("2026-11-10")


def test_materialize_due_locks_pending_rows_before_creating(sw_client, sw_people, monkeypatch):
    import app.routers.transactions as transactions_router
    from app.core import locking

    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    netflix = _entry(client, me, card, "2026-08-10", 549, "Netflix")
    sep = _row(client, me, card, netflix, "2026-09-10", 549)
    aug = _row(client, me, card, netflix, "2026-08-10", 549)
    assert aug > sep
    pin_clock(monkeypatch, REF)

    calls = []
    real_lock, real_add = locking.lock_transaction, transactions_router.add_transaction

    def spy_lock(db, txn_id, **kwargs):
        calls.append(("lock", txn_id))
        return real_lock(db, txn_id, **kwargs)

    def spy_add(*args, **kwargs):
        calls.append(("add", None))
        return real_add(*args, **kwargs)

    monkeypatch.setattr(locking, "lock_transaction", spy_lock)
    monkeypatch.setattr(transactions_router, "add_transaction", spy_add)

    r = _due(client, me, netflix)

    assert r.status_code == 200, r.text
    assert _summary(r.json()) == [("2026-08-10", "posted_pending"),
                                  ("2026-09-10", "posted_pending"), ("2026-10-10", "created")]
    first_add = calls.index(("add", None))
    assert calls[:2] == [("lock", sep), ("lock", aug)], calls
    assert {("lock", sep), ("lock", aug)} <= set(calls[:first_add]), calls


def test_materialize_due_includes_today_and_nothing_later(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    today = _entry(client, me, checking, "2026-10-18", 1_000, "Today")
    manila = _entry(client, me, checking, "2026-10-19", 1_000, "Manila tomorrow")

    pin_clock(monkeypatch, REF)
    r = _due(client, me, today)
    assert r.status_code == 200, r.text
    assert _summary(r.json()) == [("2026-10-18", "created")]
    assert r.json()["next_occurrence"].startswith("2026-11-18")
    r = _due(client, me, manila)
    assert r.status_code == 200 and r.json()["results"] == [], r.text

    # 16:30 UTC on Oct 18 is Oct 19 in Manila: the Oct 19 occurrence is due.
    pin_clock(monkeypatch, datetime(2026, 10, 18, 16, 30))
    r = _due(client, me, manila)
    assert r.status_code == 200, r.text
    assert _summary(r.json()) == [("2026-10-19", "created")]
    assert _balance(client, me, checking) == Decimal("48000.00")


def test_materialize_due_refuses_capped_bill_foreign_income_and_transfer(
        sw_client, sw_people, engine, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    savings = _account(client, me, "Savings", "savings", 1_000)
    card = _card(client, me, checking)
    cases = {
        "Mark each installment month paid": _entry(
            client, me, checking, "2026-08-05", 3_000, "Sofa",
            end_mode="after_occurrences", max_occurrences=6),
        "Bills vary: mark each paid with the amount charged": _entry(
            client, me, card, "2026-08-12", 1_799, "Globe", billing_kind="bill"),
        "Mark each paid with the amount charged": _entry(
            client, me, checking, "2026-08-20", 20, "Claude", currency="USD"),
        "Post N due is for recurring expenses": [
            _entry(client, me, checking, "2026-08-15", 30_000, "Salary", entry_type="income"),
            _entry(client, me, checking, "2026-08-15", 5_000, "Save",
                   transfer_to_account_id=savings),
        ],
    }
    pin_clock(monkeypatch, REF)

    for detail, entries in cases.items():
        for entry in entries if isinstance(entries, list) else [entries]:
            before = _state(client, me, entry)["next_occurrence"]
            r = _due(client, me, entry)
            assert r.status_code == 400, (detail, r.text)
            assert r.json()["detail"] == detail
            assert _linked(engine, entry) == []
            assert _state(client, me, entry)["next_occurrence"] == before
    assert _balance(client, me, checking) == Decimal("50000.00")


def test_materialize_due_rolls_back_on_ambiguity(sw_client, sw_people, engine, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    rent = _entry(client, me, checking, "2026-09-01", 20_000, "Rent")
    _row(client, me, checking, rent, "2026-10-01", 20_000)
    _row(client, me, checking, rent, "2026-10-01", 20_000)
    before = _linked(engine, rent)
    pin_clock(monkeypatch, REF)

    r = _due(client, me, rent)

    assert r.status_code == 409, r.text
    assert "more than one linked transaction" in r.json()["detail"]
    assert _linked(engine, rent) == before
    assert _balance(client, me, checking) == Decimal("50000.00")
    assert _state(client, me, rent)["next_occurrence"].startswith("2026-09-01")


def test_materialize_due_with_nothing_due_is_empty(sw_client, sw_people, engine, monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    rent = _entry(client, me, checking, "2026-11-01", 20_000, "Rent")
    pin_clock(monkeypatch, REF)

    r = _due(client, me, rent)

    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["entry_id"], body["results"], body["is_active"]) == (rent, [], True)
    assert body["next_occurrence"].startswith("2026-11-01")
    assert _linked(engine, rent) == []

"""Mark paid records the chosen occurrence once (STU-343).

``POST /budget-entries/{id}/materialize`` takes ``occurrence_date``, reuses a
row already linked to that occurrence (a pending one is posted, a posted one
only moves the schedule on), and reports what it recorded in the
``X-Occurrence*`` headers. The primitive underneath (services/posting.py) never
commits. Skips without a database.
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
HEADERS = ("X-Occurrence-Outcome", "X-Occurrence-Recorded", "X-Occurrences-Skipped-Count",
           "X-Occurrences-Skipped")


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


def _day(d: str) -> str:
    return f"{d}T00:00:00Z"


def _checking(client, who, balance=50_000, name="Checking"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "balance": balance})["id"]


def _balance(client, who, account_id) -> Decimal:
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _rent(client, who, account_id, next_day, amount=20_000, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})["id"]


def _entry(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _materialize(client, who, entry_id, **body):
    return client.post(f"{API}/budget-entries/{entry_id}/materialize", json=body,
                       headers=who["headers"])


def _pending(client, who, account_id, entry_id, day, amount=20_000):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": "Rent", "transaction_date": f"{day}T00:00:00", "is_posted": False,
        "budget_entry_id": entry_id})["id"]


def _linked(engine, entry_id) -> list:
    with engine.connect() as c:
        return [tuple(r) for r in c.execute(text(
            "SELECT id, is_posted, amount FROM transactions WHERE budget_entry_id = :e "
            "ORDER BY id"), {"e": entry_id})]


def _headers(r) -> dict:
    return {h: r.headers.get(h) for h in HEADERS}


def test_mark_paid_records_the_chosen_occurrence_of_a_stale_rent(sw_client, sw_people):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-08-01")

    r = _materialize(client, me, rent, occurrence_date=_day("2026-11-01"),
                     transaction_date=_day("2026-10-17"))

    assert r.status_code == 201, r.text
    assert _headers(r) == {
        "X-Occurrence-Outcome": "created",
        "X-Occurrence-Recorded": "2026-11-01",
        "X-Occurrences-Skipped-Count": "3",
        "X-Occurrences-Skipped": "2026-08-01,2026-09-01,2026-10-01",
    }
    txn = r.json()
    assert txn["transaction_date"].startswith("2026-10-17")
    assert txn["is_posted"] is True
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-12-01")
    assert _balance(client, me, checking) == Decimal("30000.00")


def test_skipped_header_count_is_complete_for_a_long_stale_schedule(sw_client, sw_people):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    laundry = sw_post(client, me, "/budget-entries/", {
        "name": "Laundry", "entry_type": "expense", "amount": 100, "cadence": "weekly",
        "next_occurrence": "2025-06-01T00:00:00", "account_id": checking})["id"]

    r = _materialize(client, me, laundry, occurrence_date=_day("2026-10-25"))

    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrences-Skipped-Count"] == "73"
    skipped = r.headers["X-Occurrences-Skipped"].split(",")
    assert len(skipped) == 60
    assert (skipped[0], skipped[-1]) == ("2025-06-01", "2026-07-19")
    assert _entry(client, me, laundry)["next_occurrence"].startswith("2026-11-01")
    assert _balance(client, me, checking) == Decimal("49900.00")


def test_mark_paid_resolves_a_recent_occurrence_of_a_decades_stale_schedule(sw_client,
                                                                           sw_people):
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

    r = _materialize(client, me, weekly, occurrence_date=_day("2026-10-18"))
    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrence-Recorded"] == "2026-10-18"
    assert r.headers["X-Occurrences-Skipped-Count"] == "2180"
    assert r.headers["X-Occurrences-Skipped"].split(",")[0] == "1985-01-06"
    assert _entry(client, me, weekly)["next_occurrence"].startswith("2026-10-25")

    r = _materialize(client, me, semi, occurrence_date=_day("2026-10-15"))
    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrence-Recorded"] == "2026-10-15"
    assert r.headers["X-Occurrences-Skipped-Count"] == "1363"
    assert _entry(client, me, semi)["next_occurrence"].startswith("2026-11-01")


def test_cors_exposes_the_occurrence_headers(sw_client, sw_people):
    from app.core.config import settings

    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-08-01")
    origin = settings.BACKEND_CORS_ORIGINS[0]

    r = client.post(f"{API}/budget-entries/{rent}/materialize",
                    json={"occurrence_date": _day("2026-09-01")},
                    headers={**me["headers"], "Origin": origin})

    assert r.status_code == 201, r.text
    exposed = {h.strip().lower()
               for h in r.headers["access-control-expose-headers"].split(",")}
    assert {h.lower() for h in HEADERS} <= exposed


def test_capped_entry_refuses_a_later_occurrence(sw_client, sw_people, engine):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    phone = _rent(client, me, checking, "2026-07-05", amount=1_000,
                  end_mode="after_occurrences", max_occurrences=24)

    later = _materialize(client, me, phone, occurrence_date=_day("2026-11-05"))
    assert later.status_code == 409, later.text
    assert later.json()["detail"] == "Record the oldest unrecorded month first"
    assert _linked(engine, phone) == []

    oldest = _materialize(client, me, phone, occurrence_date=_day("2026-07-05"))
    assert oldest.status_code == 201, oldest.text
    state = _entry(client, me, phone)
    assert state["max_occurrences"] == 23
    assert state["next_occurrence"].startswith("2026-08-05")


def test_occurrence_off_schedule_or_before_next_is_rejected(sw_client, sw_people, engine):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-08-01")

    for day in ("2026-08-02", "2026-07-01"):
        r = _materialize(client, me, rent, occurrence_date=_day(day))
        assert r.status_code == 422, (day, r.text)
        assert r.json()["detail"] == "Not an occurrence of this schedule"
    assert _linked(engine, rent) == []
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-08-01")


def test_mark_paid_posts_a_linked_pending_row_instead_of_adding_one(sw_client, sw_people,
                                                                    engine):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-10-01")
    pending = _pending(client, me, checking, rent, "2026-10-01")
    body = {"occurrence_date": _day("2026-10-01"), "transaction_date": _day("2026-10-02")}

    r = _materialize(client, me, rent, **body)

    assert r.status_code == 200, r.text
    assert r.headers["X-Occurrence-Outcome"] == "posted_pending"
    assert r.headers["X-Occurrences-Skipped-Count"] == "0"
    assert "X-Occurrences-Skipped" not in r.headers
    txn = r.json()
    assert (txn["id"], txn["is_posted"]) == (pending, True)
    assert txn["transaction_date"].startswith("2026-10-02")
    assert _balance(client, me, checking) == Decimal("30000.00")
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-11-01")

    retry = _materialize(client, me, rent, **body)
    assert retry.status_code == 422, retry.text
    assert [row[0] for row in _linked(engine, rent)] == [pending]
    assert _balance(client, me, checking) == Decimal("30000.00")


def test_omitted_occurrence_records_next_occurrence(sw_client, sw_people):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-11-01")

    r = _materialize(client, me, rent)

    assert r.status_code == 201, r.text
    assert r.headers["X-Occurrence-Recorded"] == "2026-11-01"
    assert r.headers["X-Occurrences-Skipped-Count"] == "0"
    assert "X-Occurrences-Skipped" not in r.headers


def test_mark_paid_after_post_without_advancing_advances_only(sw_client, sw_people, engine):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-10-01")
    oct1 = _day("2026-10-01")

    first = _materialize(client, me, rent, occurrence_date=oct1, advance=False)
    assert first.status_code == 201, first.text
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-10-01")

    again = _materialize(client, me, rent, occurrence_date=oct1, advance=False)
    assert again.status_code == 409, again.text
    assert again.json()["detail"] == "This occurrence is already recorded"

    moved = _materialize(client, me, rent, occurrence_date=oct1)
    assert moved.status_code == 200, moved.text
    assert moved.headers["X-Occurrence-Outcome"] == "already_posted"
    assert moved.json()["id"] == first.json()["id"]
    assert len(_linked(engine, rent)) == 1
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-11-01")
    assert _balance(client, me, checking) == Decimal("30000.00")


def test_two_linked_rows_for_one_occurrence_are_refused(sw_client, sw_people, engine):
    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-10-01")
    _pending(client, me, checking, rent, "2026-10-01")
    _pending(client, me, checking, rent, "2026-10-01")
    before = _linked(engine, rent)

    r = _materialize(client, me, rent, occurrence_date=_day("2026-10-01"))

    assert r.status_code == 409, r.text
    assert "more than one linked transaction" in r.json()["detail"]
    assert _linked(engine, rent) == before
    assert _balance(client, me, checking) == Decimal("50000.00")
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-10-01")


def test_record_occurrence_refuses_a_pending_row_the_actor_cannot_edit(
        sw_client, sw_people, engine, monkeypatch):
    import app.services.posting as posting

    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-10-01")
    pending = _pending(client, me, checking, rent, "2026-10-01")

    class NoEdit:
        def __init__(self, db, user):
            pass

        def permissions(self, record):
            return {"can_edit": False, "can_delete": False, "can_post": False,
                    "can_revert": False, "can_tag": False}

    monkeypatch.setattr(posting, "RecordAccess", NoEdit)
    r = _materialize(client, me, rent, occurrence_date=_day("2026-10-01"))

    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "This occurrence is recorded on a transaction you can't edit"
    assert _linked(engine, rent) == [(pending, False, Decimal("20000.00"))]
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-10-01")


def test_record_occurrence_does_not_commit(sw_client, sw_db, sw_people, engine, monkeypatch):
    from app.core import locking
    from app.models.user import User
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services import posting

    client, me = sw_client, sw_people()
    checking = _checking(client, me)
    rent = _rent(client, me, checking, "2026-10-01")
    db = sw_db

    def no_commit():
        raise AssertionError("record_occurrence committed")

    locking.lock_owner_budgets(db, me["id"])
    entry = locking.lock_entry(db, rent)
    monkeypatch.setattr(db, "commit", no_commit)
    recorded = posting.record_occurrence(db, entry, db.get(User, me["id"]),
                                         BudgetEntryMaterialize(), entry.next_occurrence)
    assert recorded.outcome == posting.Outcome.CREATED
    assert recorded.occurrence.date() == datetime(2026, 10, 1).date()
    db.rollback()
    monkeypatch.undo()

    assert _linked(engine, rent) == []
    assert _balance(client, me, checking) == Decimal("50000.00")
    assert _entry(client, me, rent)["next_occurrence"].startswith("2026-10-01")


# --- S2: a pending loan payment posted by Mark paid means what create means -------

LOAN_BODIES = {
    "no_amount": ({}, Decimal("4000.00"), Decimal("1000.00"), Decimal("-96000.00")),
    "amount": ({"amount": 5000}, Decimal("4000.00"), Decimal("1000.00"), Decimal("-96000.00")),
    "amount_and_fee": ({"amount": 5000, "transfer_fee": 0}, Decimal("5000.00"),
                       Decimal("0.00"), Decimal("-95000.00")),
}


@pytest.mark.parametrize("mode", ["create", "reuse"])
@pytest.mark.parametrize("variant", list(LOAN_BODIES))
def test_pending_loan_payment_reuse_matches_create(sw_client, sw, engine, mode, variant):
    client, a, loan = sw_client, sw["a"], sw["a_loan"]
    checking = _checking(client, a)
    entry = sw_post(client, a, "/budget-entries/", {
        "name": "Loan payment", "entry_type": "expense", "amount": 5_000,
        "cadence": "monthly", "next_occurrence": "2026-11-01T00:00:00",
        "account_id": checking, "transfer_to_account_id": loan})["id"]
    pending = None
    if mode == "reuse":
        row = sw_post(client, a, "/transactions/", {
            "account_id": checking, "transfer_from_account_id": checking,
            "transfer_to_account_id": loan, "transaction_type": "transfer", "amount": 5_000,
            "transaction_date": "2026-11-01T00:00:00", "is_posted": False,
            "budget_entry_id": entry, "description": "Loan payment"})
        assert (Decimal(str(row["amount"])), Decimal(str(row["transfer_fee"]))) == (
            Decimal("4000.00"), Decimal("1000.00"))
        pending = row["id"]
    body, principal, interest, loan_balance = LOAN_BODIES[variant]

    r = _materialize(client, a, entry, occurrence_date=_day("2026-11-01"), **body)

    assert r.status_code == (201 if mode == "create" else 200), r.text
    txn = r.json()
    assert r.headers["X-Occurrence-Outcome"] == (
        "created" if mode == "create" else "posted_pending")
    if mode == "reuse":
        assert txn["id"] == pending
    assert txn["is_posted"] is True and txn["loan_payment_kind"] == "scheduled"
    assert (Decimal(str(txn["amount"])), Decimal(str(txn["transfer_fee"]))) == (
        principal, interest)
    assert _balance(client, a, checking) == Decimal("45000.00")
    assert _balance(client, a, loan) == loan_balance
    assert len(_linked(engine, entry)) == 1


# --- S5: an installment marked paid on its own date keeps its statement --------

def _card_setup(client, people):
    me = people()
    checking = _checking(client, me)
    card = sw_post(client, me, "/accounts/", {
        "name": "Card C", "account_type": "credit", "balance": 0,
        "billing_cycle_start": 24, "days_until_due_date": 21,
        "payment_account_id": checking})["id"]
    phone = sw_post(client, me, "/budget-entries/", {
        "name": "iPhone", "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
        "next_occurrence": "2026-11-05T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": 24})["id"]
    return me, card, phone


def _statements(db, user_id) -> dict:
    """Statement payables over 60 days, ``[2026-10-18, 2026-12-18)``, by due day."""
    from app.services import forecast

    db.expire_all()
    return {p["due_date"]: p["amount"]
            for p in forecast.payables_by_currency(db, user_id, days=60)
            if p.get("source") == "statement"}


@pytest.mark.parametrize("paid_on, expected", [
    ("2026-11-05", {"2026-12-15": 5000.0}),
    ("2026-10-18", {"2026-11-14": 5000.0}),
])
def test_installment_marked_paid_on_its_date_keeps_statement_payables(
        sw_client, sw_db, sw_people, monkeypatch, paid_on, expected):
    from app.services import forecast

    client = sw_client
    pin_clock(monkeypatch, REF)
    start, end = forecast._upcoming_window(60, None)
    assert (start, end) == (datetime(2026, 10, 18), datetime(2026, 12, 18))
    me, card, phone = _card_setup(client, sw_people)
    assert _statements(sw_db, me["id"]) == {"2026-12-15": 5000.0}

    r = _materialize(client, me, phone, occurrence_date=_day("2026-11-05"),
                     transaction_date=_day(paid_on))

    assert r.status_code == 201, r.text
    assert _statements(sw_db, me["id"]) == expected

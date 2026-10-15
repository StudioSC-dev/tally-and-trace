"""Materialize and the projection follow the day rules (STU-315, plan sections 2.3, 3.5, 3.6).

Each entry is written with its ``anchor_day`` or ``day_rule`` directly, so
these tests exercise only the schedule. Materialize reads ``next_occurrence``
back from the ``timestamptz`` column as an aware value and compares the advanced
one with ``end_date``; the step keeps its time zone, so the final occurrence of
an ``on_date`` entry deactivates it rather than raising. Accounts and amounts
are generic fixtures. Skips without a database.
"""
from datetime import date, datetime
from decimal import Decimal

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

REF = datetime(2026, 10, 15)


def _naive(dt):
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _entry(db, who, account_id, next_occurrence, **kw):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    fields = dict(user_id=who["id"], name="Generic bill", entry_type=BudgetEntryType.EXPENSE,
                  amount=Decimal("100.00"), cadence=RecurrenceFrequency.MONTHLY,
                  next_occurrence=next_occurrence, account_id=account_id)
    fields.update(kw)
    e = BudgetEntry(**fields)
    db.add(e)
    db.commit()
    return e.id


def _pay(client, who, entry_id):
    r = client.post(f"{API}/budget-entries/{entry_id}/materialize", headers=who["headers"],
                    json={})
    assert r.status_code == 201, r.text
    return r.json()


def _stored(db, entry_id):
    from app.models.budget_entry import BudgetEntry

    db.expire_all()
    e = db.get(BudgetEntry, entry_id)
    return _naive(e.next_occurrence), e.is_active


def _fulfils(db, txn_id):
    from app.models.transaction import Transaction

    return _naive(db.get(Transaction, txn_id).occurrence_date)


@pytest.fixture
def world(sw_client, sw_db, sw_people):
    who = sw_people("Day", "Rule")
    bank = sw_post(sw_client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 10_000})["id"]
    return who, bank


def test_materialize_steps_an_anchored_31_through_february(sw_client, sw_db, world):
    who, bank = world
    entry = _entry(sw_db, who, bank, datetime(2027, 1, 31), anchor_day=31)
    first = _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2027, 2, 28), True)
    second = _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2027, 3, 31), True)
    assert _fulfils(sw_db, first["id"]) == datetime(2027, 1, 31)
    assert _fulfils(sw_db, second["id"]) == datetime(2027, 2, 28)


def test_materialize_steps_to_the_last_weekday(sw_client, sw_db, world):
    who, bank = world
    entry = _entry(sw_db, who, bank, datetime(2026, 10, 30), day_rule="last_weekday")
    txn = _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2026, 11, 30), True)
    assert _fulfils(sw_db, txn["id"]) == datetime(2026, 10, 30)
    _pay(sw_client, who, entry)
    _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2027, 1, 29), True)


def test_on_date_anchored_entry_deactivates_after_its_final_occurrence(sw_client, sw_db, world):
    who, bank = world
    entry = _entry(sw_db, who, bank, datetime(2027, 1, 31), anchor_day=31,
                   end_mode="on_date", end_date=datetime(2027, 3, 31))
    _pay(sw_client, who, entry)
    _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2027, 3, 31), True)  # the end date itself
    final = _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2027, 3, 31), False)
    assert _fulfils(sw_db, final["id"]) == datetime(2027, 3, 31)


def test_on_date_last_weekday_entry_deactivates_after_its_final_occurrence(
        sw_client, sw_db, world):
    who, bank = world
    entry = _entry(sw_db, who, bank, datetime(2026, 10, 30), day_rule="last_weekday",
                   end_mode="on_date", end_date=datetime(2026, 11, 30))
    _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2026, 11, 30), True)
    _pay(sw_client, who, entry)
    assert _stored(sw_db, entry) == (datetime(2026, 11, 30), False)


def test_timeline_events_land_on_rule_dates(sw_client, sw_db, world):
    from app.models.budget_entry import BudgetEntryType
    from app.services.forecast import project_running_balance

    who, bank = world
    salary = _entry(sw_db, who, bank, datetime(2026, 10, 30), day_rule="last_weekday",
                    name="Generic salary", entry_type=BudgetEntryType.INCOME)
    rent = _entry(sw_db, who, bank, datetime(2026, 10, 31), anchor_day=31)
    legacy = _entry(sw_db, who, bank, datetime(2026, 10, 31), name="Generic legacy")
    timeline = project_running_balance(sw_db, who["id"], days=200, reference=REF)
    dates = {}
    for e in timeline["events"]:
        if e.get("source") == "budget_entry":
            dates.setdefault(e["source_id"], []).append(e["date"])
    assert dates[salary][:5] == [date(2026, 10, 30), date(2026, 11, 30), date(2026, 12, 31),
                                 date(2027, 1, 29), date(2027, 2, 26)]
    assert dates[rent][:6] == [date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 31),
                               date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 31)]
    assert dates[legacy][:6] == [date(2026, 10, 31), date(2026, 11, 30), date(2026, 12, 30),
                                 date(2027, 1, 30), date(2027, 2, 28), date(2027, 3, 28)]

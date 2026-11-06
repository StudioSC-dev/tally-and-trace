"""Autopay for cash entries: the job, the toggle and the held payment (settlement
plan, PR 6). Skips without a database.

Reference Sunday 2026-10-18, 10:00 in Manila. O owns Checking (50,000), Card C
and a spending wallet. "Rent" is O's 5,000 monthly on Checking, next 2026-10-25
unless a test says otherwise. Each test turns the entry on through the toggle,
or writes a stray flag straight to the row.
"""
import os
import sys
import threading
import time
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = [pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable"),
              pytest.mark.usefixtures("legacy_card_installments")]

REF = datetime(2026, 10, 18, 2, 0)  # Sunday, 10:00 in Manila
TOKEN = "test-job-token"
PROBE_DEADLINE = 10
JOIN_TIMEOUT = 30


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def on_day(monkeypatch, day: str) -> None:
    pin_clock(monkeypatch, datetime.fromisoformat(f"{day}T02:00:00"))


def _account(client, who, name, account_type, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    o = sw_people("Olive", "Owner")
    checking = _account(sw_client, o, "Checking", "checking", 50_000)
    card = _account(sw_client, o, "Card C", "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)
    pin_clock(monkeypatch, REF)
    return {"client": sw_client, "db": sw_db, "o": o, "checking": checking, "card": card}


def _entry(w, name="Rent", next_day="2026-10-25", account=None, **extra) -> int:
    body = {"name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
            "next_occurrence": f"{next_day}T00:00:00", "account_id": account or w["checking"],
            **extra}
    return sw_post(w["client"], w["o"], "/budget-entries/", body)["id"]


def _toggle(w, entry_id, enabled=True, who=None, **extra):
    return w["client"].post(f"{API}/budget-entries/{entry_id}/auto-post",
                            json={"enabled": enabled, **extra},
                            headers=(who or w["o"])["headers"])


def _turn_on(w, entry_id, **extra) -> dict:
    r = _toggle(w, entry_id, **extra)
    assert r.status_code == 200, r.text
    return r.json()


def _preview(w, entry_id) -> dict:
    r = w["client"].get(f"{API}/budget-entries/{entry_id}/auto-post-preview",
                        headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _job(client, **params) -> dict:
    r = client.post(f"{API}/jobs/post-due-installments", params=params,
                    headers={"X-Job-Token": TOKEN})
    assert r.status_code == 200, r.text
    return r.json()


def _flag(db, entry_id, reviewed=False) -> None:
    db.execute(text("UPDATE budget_entries SET auto_post_enabled = TRUE, "
                    "installment_reviewed_at = CASE WHEN :r THEN now() END WHERE id = :id"),
               {"r": reviewed, "id": entry_id})
    db.commit()
    db.expire_all()


def _rows(db, entry_id) -> list:
    db.rollback()
    return [(r.transaction_date.date(), r.occurrence_date.date() if r.occurrence_date else None,
             float(r.amount), r.is_posted)
            for r in db.execute(text(
                "SELECT transaction_date, occurrence_date, amount, is_posted FROM transactions "
                "WHERE budget_entry_id = :e ORDER BY transaction_date, id"), {"e": entry_id})]


def _state(db, entry_id) -> tuple:
    db.rollback()
    row = db.execute(text("SELECT next_occurrence, auto_post_enabled FROM budget_entries "
                          "WHERE id = :e"), {"e": entry_id}).one()
    return row.next_occurrence.date(), row.auto_post_enabled


def _balance(db, account_id) -> float:
    db.rollback()
    return float(db.execute(text("SELECT balance FROM accounts WHERE id = :a"),
                            {"a": account_id}).scalar())


def _typed(w, day, amount=5_000, kind="debit", account=None) -> int:
    return sw_post(w["client"], w["o"], "/transactions/", {
        "account_id": account or w["checking"], "amount": amount, "transaction_type": kind,
        "transaction_date": f"{day}T00:00:00", "description": "Typed by hand"})["id"]


def _force(w, entry_id, day, forced) -> None:
    r = w["client"].put(f"{API}/budget-entries/{entry_id}/occurrences/{day}/date",
                        json={"effective_date": forced}, headers=w["o"]["headers"])
    assert r.status_code == 200, r.text


def _autopay_due(w, who=None) -> list:
    r = w["client"].get(f"{API}/dashboard/snapshot", headers=(who or w["o"])["headers"])
    assert r.status_code == 200, r.text
    return r.json()["autopay_due"]


# 1 -----------------------------------------------------------------------------------------

def test_opted_in_entry_posts_on_its_date(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    assert _job(w["client"])["posted"] == 0

    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}
    assert _rows(db, rent) == [(date(2026, 10, 25), date(2026, 10, 25), 5_000.0, True)]
    assert _state(db, rent) == (date(2026, 11, 25), True)
    assert _balance(db, w["checking"]) == 45_000


# 2 -----------------------------------------------------------------------------------------

def _stray(w, kind) -> int:
    client, o, open_ended = w["client"], w["o"], {"next_day": "2026-10-05"}
    if kind == "manual":
        return _entry(w, **open_ended)
    if kind == "card subscription":
        return _entry(w, account=w["card"], **open_ended)
    if kind == "card bill":
        return _entry(w, account=w["card"], billing_kind="bill", **open_ended)
    if kind == "transfer":
        savings = _account(client, o, "Savings", "savings")
        return _entry(w, transfer_to_account_id=savings, **open_ended)
    if kind == "income":
        return _entry(w, entry_type="income", **open_ended)
    wallet = _account(client, o, "Wallet", "cash", 50_000, is_spending_wallet=True)
    return _entry(w, account=wallet, **open_ended)


@pytest.mark.parametrize("kind", ["manual", "card subscription", "card bill", "transfer",
                                  "income", "wallet spending"])
def test_nothing_else_posts_even_with_a_stray_flag(world, kind):
    w, db = world, world["db"]
    entry_id = _stray(w, kind)
    if kind != "manual":
        _flag(db, entry_id)

    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, entry_id) == []
    assert _state(db, entry_id)[0] == date(2026, 10, 5)
    assert _balance(db, w["checking"]) == 50_000


def test_a_cash_entry_with_a_card_review_stamp_is_a_stray_flag(world):
    """An account that stopped being a card leaves a reviewed, flagged cash entry:
    nobody opted it in. The toggle does, and it then posts."""
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-10-05")
    _flag(db, rent, reviewed=True)
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _autopay_due(w) == []

    _turn_on(w, rent, expected_due=1)
    assert [row[0] for row in _rows(db, rent)] == [date(2026, 10, 5)]
    assert db.execute(text("SELECT installment_reviewed_at FROM budget_entries WHERE id = :e"),
                      {"e": rent}).scalar() is None


# 3 -----------------------------------------------------------------------------------------

def test_a_forced_date_posts_on_the_effective_date_not_the_nominal(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    _force(w, rent, "2026-10-25", "2026-10-28")

    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 0
    assert _rows(db, rent) == []

    on_day(monkeypatch, "2026-10-28")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, rent) == [(date(2026, 10, 28), date(2026, 10, 25), 5_000.0, True)]
    assert _state(db, rent)[0] == date(2026, 11, 25)


def test_a_date_forced_earlier_posts_on_it(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    _force(w, rent, "2026-10-25", "2026-10-20")

    on_day(monkeypatch, "2026-10-19")
    assert _job(w["client"])["posted"] == 0
    on_day(monkeypatch, "2026-10-20")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, rent) == [(date(2026, 10, 20), date(2026, 10, 25), 5_000.0, True)]


def test_an_entry_not_yet_due_is_not_listed_by_a_run(world):
    """The job's scope is PR 4's narrowing: a far nominal date with no due override
    stays out of ``entries``."""
    w = world
    _turn_on(w, _entry(w))
    r = w["client"].post(f"{API}/budget-entries/post-due-installments", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["entries"] == []


# 4 and 5 -----------------------------------------------------------------------------------

def test_running_twice_posts_once(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert len(_rows(db, rent)) == 1
    assert _balance(db, w["checking"]) == 45_000


def test_a_hand_recorded_occurrence_does_not_post_again(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")
    r = w["client"].post(f"{API}/budget-entries/{rent}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text

    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert len(_rows(db, rent)) == 1
    assert _balance(db, w["checking"]) == 45_000


def test_a_posted_link_ahead_of_next_occurrence_only_advances(world, monkeypatch):
    """Oct 25 is on the schedule and already paid by hand, with Nov 25 due behind it."""
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-11-25")
    r = w["client"].post(f"{API}/budget-entries/{rent}/materialize",
                         json={"occurrence_date": "2026-10-25T00:00:00", "advance": False},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    assert _state(db, rent)[0] == date(2026, 10, 25)

    assert _job(w["client"])["posted"] == 1
    assert [row[1] for row in _rows(db, rent)] == [date(2026, 10, 25), date(2026, 11, 25)]
    assert _balance(db, w["checking"]) == 40_000


def test_a_pending_linked_row_is_posted_not_added_to(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    sw_post(w["client"], w["o"], "/transactions/", {
        "account_id": w["checking"], "amount": 5_200, "transaction_type": "debit",
        "transaction_date": "2026-10-24T00:00:00", "budget_entry_id": rent,
        "is_posted": False})
    db.execute(text("UPDATE transactions SET occurrence_date = '2026-10-25' "
                    "WHERE budget_entry_id = :e"), {"e": rent})
    db.commit()
    on_day(monkeypatch, "2026-10-25")

    assert _job(w["client"])["posted"] == 1
    assert _rows(db, rent) == [(date(2026, 10, 24), date(2026, 10, 25), 5_200.0, True)]
    assert _balance(db, w["checking"]) == 44_800


# 6 -----------------------------------------------------------------------------------------

def test_a_hand_typed_row_within_three_days_holds_it(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    _typed(w, "2026-10-23")
    on_day(monkeypatch, "2026-10-25")

    body = _job(w["client"])
    assert body["posted"] == 0 and body["skipped"] == {"possible_duplicate": 1}
    assert _rows(db, rent) == []
    assert _state(db, rent) == (date(2026, 10, 25), True)
    assert [(row["state"], row["block_reason"], row["postable_count"])
            for row in _autopay_due(w)] == [("held", "possible_duplicate", 0)]


def test_the_duplicate_window_centres_on_the_effective_date(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    _force(w, rent, "2026-10-25", "2026-11-05")
    _typed(w, "2026-10-25")  # the nominal day, eleven days off the effective one
    on_day(monkeypatch, "2026-11-05")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, rent)[0][0] == date(2026, 11, 5)


def test_a_row_outside_the_window_or_of_another_amount_holds_nothing(world, monkeypatch):
    w = world
    rent = _entry(w)
    _turn_on(w, rent)
    _typed(w, "2026-10-21")
    _typed(w, "2026-10-24", amount=4_999)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}


# 7 -----------------------------------------------------------------------------------------

def test_insufficient_balance_holds_flags_retries_then_posts_on_its_own_day(world, monkeypatch):
    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 3_000)
    rent = _entry(w, account=poor)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")

    body = _job(w["client"])
    assert body == {"dry_run": False, "posted": 0, "skipped": {"insufficient_funds": 1}}
    assert _rows(db, rent) == []
    assert _balance(db, poor) == 3_000
    assert _state(db, rent) == (date(2026, 10, 25), True)
    assert _autopay_due(w) == [{
        "source": "budget_entry", "source_id": rent, "name": "Rent", "account_name": "Poor",
        "due_count": 1, "postable_count": 0, "oldest": "2026-10-25", "state": "held",
        "block_reason": "insufficient_funds"}]

    on_day(monkeypatch, "2026-10-26")
    assert _job(w["client"])["skipped"] == {"insufficient_funds": 1}
    assert _rows(db, rent) == []

    _typed(w, "2026-10-27", amount=2_000, kind="credit", account=poor)
    on_day(monkeypatch, "2026-10-27")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}
    assert _rows(db, rent) == [(date(2026, 10, 25), date(2026, 10, 25), 5_000.0, True)]
    assert _balance(db, poor) == 0
    assert _autopay_due(w) == []


def test_the_funds_check_is_cumulative_and_stops_oldest_first(world, monkeypatch):
    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 12_000)
    rent = _entry(w, account=poor, next_day="2026-08-25")
    _turn_on(w, rent, expected_due=2)  # Aug 25, Sep 25; Oct 25 is not due yet
    assert [row[0] for row in _rows(db, rent)] == [date(2026, 8, 25), date(2026, 9, 25)]
    assert _balance(db, poor) == 2_000

    on_day(monkeypatch, "2026-11-25")
    assert _job(w["client"])["skipped"] == {"insufficient_funds": 1}
    assert len(_rows(db, rent)) == 2
    assert _state(db, rent)[0] == date(2026, 10, 25)
    row = _autopay_due(w)[0]
    assert (row["due_count"], row["postable_count"], row["oldest"]) == (2, 0, "2026-10-25")


def test_a_negative_balance_does_not_stop_a_month_already_paid(world, monkeypatch):
    """A posted-linked month moves no money, so the job advances past it whatever
    the balance; the next month, which would move money, is still held."""
    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 1_000)
    rent = _entry(w, account=poor)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")
    r = w["client"].post(f"{API}/budget-entries/{rent}/materialize", json={"advance": False},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    assert _balance(db, poor) == -4_000
    assert _state(db, rent)[0] == date(2026, 10, 25)

    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _state(db, rent)[0] == date(2026, 11, 25)
    assert len(_rows(db, rent)) == 1
    assert _balance(db, poor) == -4_000

    on_day(monkeypatch, "2026-11-25")
    assert _job(w["client"])["skipped"] == {"insufficient_funds": 1}
    assert len(_rows(db, rent)) == 1


def test_the_overflow_account_does_not_count_as_funds(world, monkeypatch):
    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 1_000)
    rent = _entry(w, account=poor, overflow_account_id=w["checking"])
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["skipped"] == {"insufficient_funds": 1}
    assert _balance(db, w["checking"]) == 50_000


def test_the_funds_check_waits_for_the_account_lock(world, monkeypatch):
    """A deposit in flight holds the account; the job reads the balance after it."""
    from app.core import locking
    from app.core.database import SessionLocal

    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 1_000)
    rent = _entry(w, account=poor)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")

    engine = create_engine(os.environ["DATABASE_URL"])
    holder = SessionLocal()
    worker = _Worker(lambda: _job(w["client"]))
    try:
        locking.lock_accounts(holder, [poor])[poor].balance = 9_000
        holder.flush()
        worker.thread.start()
        assert _wait_waiters(engine, 1, [worker]), "the job did not wait for the account"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        worker.thread.join(JOIN_TIMEOUT)
        engine.dispose()
    assert worker.error is None
    assert worker.result["posted"] == 1
    assert _balance(db, poor) == 4_000


# 8 and 9 -----------------------------------------------------------------------------------

def test_catch_up_posts_each_missed_occurrence_on_its_own_day(world):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-07-25")
    assert _preview(w, rent) == {"block": None, "due_count": 3, "oldest": "2026-07-25"}

    body = _turn_on(w, rent, expected_due=3)
    assert body["auto_post_enabled"] is True
    assert _rows(db, rent) == [
        (date(2026, 7, 25), date(2026, 7, 25), 5_000.0, True),
        (date(2026, 8, 25), date(2026, 8, 25), 5_000.0, True),
        (date(2026, 9, 25), date(2026, 9, 25), 5_000.0, True)]
    assert _state(db, rent) == (date(2026, 10, 25), True)
    assert _balance(db, w["checking"]) == 35_000
    assert _preview(w, rent)["due_count"] == 0
    assert _job(w["client"])["posted"] == 0


def test_catch_up_reads_the_forced_date(world):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-09-25")
    _force(w, rent, "2026-09-25", "2026-09-27")
    assert _preview(w, rent)["oldest"] == "2026-09-27"
    _turn_on(w, rent, expected_due=1)
    assert _rows(db, rent) == [(date(2026, 9, 27), date(2026, 9, 25), 5_000.0, True)]


def test_a_funds_stop_does_not_fail_the_toggle(world):
    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 6_000)
    rent = _entry(w, account=poor, next_day="2026-08-25")
    _turn_on(w, rent, expected_due=2)
    assert [row[0] for row in _rows(db, rent)] == [date(2026, 8, 25)]
    assert _state(db, rent) == (date(2026, 9, 25), True)
    assert _autopay_due(w)[0]["block_reason"] == "insufficient_funds"


def test_a_duplicate_stop_does_not_fail_the_toggle(world):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-08-25")
    _typed(w, "2026-09-24")
    _turn_on(w, rent, expected_due=2)
    assert [row[0] for row in _rows(db, rent)] == [date(2026, 8, 25)]
    assert _state(db, rent) == (date(2026, 9, 25), True)
    assert _autopay_due(w)[0]["block_reason"] == "possible_duplicate"


@pytest.mark.parametrize("sent", [{"expected_due": 2}, {"expected_due": 4}, {}])
def test_a_wrong_expected_due_is_409_and_changes_nothing(world, sent):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-07-25")
    r = _toggle(w, rent, **sent)
    assert r.status_code == 409, r.text
    assert _rows(db, rent) == []
    assert _state(db, rent) == (date(2026, 7, 25), False)
    assert _balance(db, w["checking"]) == 50_000


def test_a_stale_count_after_a_hand_payment_is_409(world):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-09-25")
    assert _preview(w, rent)["due_count"] == 1
    r = w["client"].post(f"{API}/budget-entries/{rent}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    assert _toggle(w, rent, expected_due=1).status_code == 409
    assert _state(db, rent)[1] is False


def test_an_occurrence_outside_the_record_dates_refuses_the_toggle(world):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-09-25")
    db.execute(text("UPDATE budget_entries SET next_occurrence = '1900-09-25' WHERE id = :e"),
               {"e": rent})
    db.commit()
    db.expire_all()
    due = _preview(w, rent)["due_count"]
    r = _toggle(w, rent, expected_due=due)
    assert r.status_code == 422, r.text
    assert _rows(db, rent) == []
    assert _state(db, rent)[1] is False


# 10 ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("kind, block, message", [
    ("foreign", "foreign_currency", "This entry is in another currency than its account, "
                                    "so it can't settle by autopay"),
    ("wallet spending", "spending_wallet", "Spending from a wallet can't settle by autopay"),
    ("transfer", "not_cash", "Only a cash entry can settle by autopay"),
    ("income", "not_cash", "Only a cash entry can settle by autopay"),
    ("card subscription", "not_cash", "Only a cash entry can settle by autopay"),
])
def test_turning_on_is_refused_with_its_reason(world, kind, block, message):
    w, db = world, world["db"]
    entry_id = (_entry(w, currency="USD", next_day="2026-10-05") if kind == "foreign"
                else _stray(w, kind))
    preview = _preview(w, entry_id)
    assert preview["block"] == block

    r = _toggle(w, entry_id, expected_due=preview["due_count"])
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == message
    assert _state(db, entry_id) == (date(2026, 10, 5), False)
    assert _rows(db, entry_id) == []


def test_a_paused_entry_cannot_be_turned_on(world):
    w, db = world, world["db"]
    rent = _entry(w)
    r = w["client"].put(f"{API}/budget-entries/{rent}", json={"is_active": False},
                        headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    assert _toggle(w, rent).status_code == 409
    assert _state(db, rent)[1] is False


def test_a_card_installment_still_turns_on_by_its_review(world):
    w = world
    tablet = _entry(w, account=w["card"], end_mode="after_occurrences", max_occurrences=6)
    r = _toggle(w, tablet)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Review the installment to turn auto-post on"


def test_the_toggle_and_preview_need_the_write_rule(world, sw_people):
    w, db = world, world["db"]
    rent = _entry(w)
    viewer = sw_people("Vic", "Viewer")
    sw_share(db, w["checking"], viewer["id"], "viewer", w["o"]["id"])
    assert _toggle(w, rent, who=viewer).status_code == 404
    r = w["client"].get(f"{API}/budget-entries/{rent}/auto-post-preview",
                        headers=viewer["headers"])
    assert r.status_code == 404
    assert _state(db, rent)[1] is False


# 12 ----------------------------------------------------------------------------------------

def test_dry_run_writes_nothing_and_carries_counts_only(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")

    body = _job(w["client"], dry_run=True)
    assert body == {"dry_run": True, "posted": 1, "skipped": {}}
    assert _rows(db, rent) == []
    assert _state(db, rent)[0] == date(2026, 10, 25)
    assert _balance(db, w["checking"]) == 50_000


# 13 ----------------------------------------------------------------------------------------

class _Worker:
    def __init__(self, fn):
        self.fn = fn
        self.result = None
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            self.result = self.fn()
        except BaseException as exc:  # recorded for the test thread
            self.error = exc


def _wait_waiters(engine, target, workers) -> bool:
    deadline = time.monotonic() + PROBE_DEADLINE
    while True:
        with engine.connect() as probe:
            waiting = probe.execute(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND wait_event_type = 'Lock'")).scalar()
            probe.rollback()
        if waiting >= target:
            return True
        if any(not w.thread.is_alive() for w in workers) or time.monotonic() > deadline:
            return False
        time.sleep(0.05)


def test_job_and_mark_paid_on_one_occurrence_produce_one_row(world, monkeypatch):
    from app.core import locking
    from app.core.database import SessionLocal
    from app.models.user import User
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services.posting import record_occurrence

    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")

    engine = create_engine(os.environ["DATABASE_URL"])
    holder = SessionLocal()
    worker = _Worker(lambda: _job(w["client"]))
    try:
        locking.lock_owner_budgets(holder, w["o"]["id"])
        entry = locking.lock_entry(holder, rent)
        record_occurrence(holder, entry, holder.get(User, w["o"]["id"]),
                          BudgetEntryMaterialize(), datetime(2026, 10, 25))
        worker.thread.start()
        assert _wait_waiters(engine, 1, [worker]), "the job did not wait for the Mark paid"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        worker.thread.join(JOIN_TIMEOUT)
        engine.dispose()
    assert not worker.thread.is_alive()
    assert worker.error is None
    assert worker.result["posted"] == 0
    assert len(_rows(db, rent)) == 1
    assert _balance(db, w["checking"]) == 45_000


def test_two_concurrent_toggles_post_each_occurrence_once(world):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-09-25")
    workers = [_Worker(lambda: _toggle(w, rent, expected_due=1)) for _ in range(2)]
    for worker in workers:
        worker.thread.start()
    for worker in workers:
        worker.thread.join(JOIN_TIMEOUT)
    assert sorted(worker.result.status_code for worker in workers) == [200, 409]
    assert len(_rows(db, rent)) == 1


# 14 and 15 ---------------------------------------------------------------------------------

def test_turning_off_stops_posting_and_leaves_history_alone(world, monkeypatch):
    w, db = world, world["db"]
    rent = _entry(w, next_day="2026-09-25")
    _turn_on(w, rent, expected_due=1)
    history = _rows(db, rent)

    assert _toggle(w, rent, enabled=False).json()["auto_post_enabled"] is False
    on_day(monkeypatch, "2026-11-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, rent) == history
    assert _state(db, rent) == (date(2026, 10, 25), False)
    assert _autopay_due(w) == []


def test_a_bank_expense_marked_subscription_qualifies(world, monkeypatch):
    w, db = world, world["db"]
    stream = _entry(w, name="Stream", billing_kind="subscription")
    assert _preview(w, stream)["block"] is None
    _turn_on(w, stream)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, stream)[0][0] == date(2026, 10, 25)


# Every other run, and who sees the flag ------------------------------------------------------

def test_post_now_posts_a_due_cash_entry_and_retries_a_held_one(world, monkeypatch):
    w, db = world, world["db"]
    poor = _account(w["client"], w["o"], "Poor", "checking", 1_000)
    held = _entry(w, name="Held", account=poor)
    rent = _entry(w)
    _turn_on(w, held)
    _turn_on(w, rent)
    on_day(monkeypatch, "2026-10-25")
    r = w["client"].post(f"{API}/budget-entries/post-due-installments", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["posted"] == 1
    assert r.json()["skipped"] == {"insufficient_funds": 1}
    assert len(_rows(db, rent)) == 1 and _rows(db, held) == []


def test_autopay_due_lists_only_what_the_caller_can_edit(world, monkeypatch, sw_people):
    w, db = world, world["db"]
    rent = _entry(w)
    _turn_on(w, rent)
    viewer = sw_people("Vic", "Viewer")
    sw_share(db, w["checking"], viewer["id"], "viewer", w["o"]["id"])
    assert _autopay_due(w) == []  # nothing due yet

    on_day(monkeypatch, "2026-10-25")
    row = _autopay_due(w)[0]
    assert (row["state"], row["postable_count"], row["block_reason"]) == ("on", 1, None)
    assert _autopay_due(w, viewer) == []


def test_autopay_due_leaves_card_installments_to_their_own_list(world):
    w, db = world, world["db"]
    tablet = _entry(w, name="Tablet", account=w["card"], next_day="2026-09-05",
                    end_mode="after_occurrences", max_occurrences=6)
    _flag(db, tablet, reviewed=True)
    assert _autopay_due(w) == []

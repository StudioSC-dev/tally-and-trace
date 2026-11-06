"""Autopay for loans: the job, the toggle and the held payment (settlement plan,
PR 7). Skips without a database.

Reference Sunday 2026-10-18, 10:00 in Manila. O owns Checking (50,000) and the
"Auto" loan: 100,000 owed at 12% (1% a month), 10,000 monthly from Checking, fixed
over 12 months, first due 2026-10-25 unless a test says otherwise, so the first
payment splits 9,000 principal and 1,000 interest.
"""
import os
import sys
import threading
import time
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

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


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    o = sw_people("Olive", "Owner")
    checking = sw_post(sw_client, o, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    pin_clock(monkeypatch, REF)
    return {"client": sw_client, "db": sw_db, "o": o, "checking": checking}


def _bank(w, name, balance) -> int:
    return sw_post(w["client"], w["o"], "/accounts/", {
        "name": name, "account_type": "checking", "balance": balance})["id"]


def _loan(w, **extra) -> int:
    body = {"name": "Auto", "account_type": "loan", "loan_kind": "auto", "balance": -100_000,
            "loan_annual_rate": 12, "loan_term_months": 12, "loan_payment_amount": 10_000,
            "loan_first_payment_date": "2026-10-25", "loan_amortization": "fixed",
            "payment_account_id": w["checking"], **extra}
    return sw_post(w["client"], w["o"], "/accounts/", body)["id"]


def _toggle(w, loan, enabled=True, who=None, **extra):
    return w["client"].post(f"{API}/accounts/{loan}/auto-post",
                            json={"enabled": enabled, **extra},
                            headers=(who or w["o"])["headers"])


def _turn_on(w, loan, **extra) -> dict:
    r = _toggle(w, loan, **extra)
    assert r.status_code == 200, r.text
    return r.json()


def _preview(w, loan, who=None):
    return w["client"].get(f"{API}/accounts/{loan}/auto-post-preview",
                           headers=(who or w["o"])["headers"])


def _job(client, **params) -> dict:
    r = client.post(f"{API}/jobs/post-due-installments", params=params,
                    headers={"X-Job-Token": TOKEN})
    assert r.status_code == 200, r.text
    return r.json()


def _flag(db, loan) -> None:
    db.execute(text("UPDATE accounts SET auto_post_enabled = TRUE WHERE id = :a"), {"a": loan})
    db.commit()
    db.expire_all()


def _sql(db, statement, **params) -> None:
    db.execute(text(statement), params)
    db.commit()
    db.expire_all()


def _rows(db, loan) -> list:
    db.rollback()
    return [(r.transaction_date.date().isoformat(), float(r.amount), float(r.transfer_fee),
             r.is_posted)
            for r in db.execute(text(
                "SELECT transaction_date, amount, transfer_fee, is_posted FROM transactions "
                "WHERE transfer_to_account_id = :l ORDER BY transaction_date, id"), {"l": loan})]


def _balance(db, account_id) -> float:
    db.rollback()
    return float(db.execute(text("SELECT balance FROM accounts WHERE id = :a"),
                            {"a": account_id}).scalar())


def _is_on(db, loan) -> bool:
    db.rollback()
    return db.execute(text("SELECT auto_post_enabled FROM accounts WHERE id = :a"),
                      {"a": loan}).scalar()


def _schedule(w, loan, who=None) -> dict:
    r = w["client"].get(f"{API}/accounts/{loan}/loan-schedule",
                        headers=(who or w["o"])["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _pay(w, loan, day, is_posted=True, **body) -> dict:
    return sw_post(w["client"], w["o"], f"/accounts/{loan}/loan-payment", {
        "transaction_date": f"{day}T00:00:00", "is_posted": is_posted, **body})


def _force(w, loan, day, forced):
    return w["client"].put(f"{API}/accounts/{loan}/loan-due-dates/{day}/date",
                           json={"effective_date": forced}, headers=w["o"]["headers"])


def _recurring(w, loan) -> int:
    return sw_post(w["client"], w["o"], "/budget-entries/", {
        "name": "Car loan", "entry_type": "expense", "amount": 10_000, "cadence": "monthly",
        "next_occurrence": "2026-10-25T00:00:00", "account_id": w["checking"],
        "transfer_to_account_id": loan})["id"]


def _deposit(w, account, amount) -> None:
    sw_post(w["client"], w["o"], "/transactions/", {
        "account_id": account, "amount": amount, "transaction_type": "credit",
        "transaction_date": "2026-10-18T00:00:00", "description": "Salary"})


def _snapshot(w, who=None) -> dict:
    r = w["client"].get(f"{API}/dashboard/snapshot", headers=(who or w["o"])["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _due_row(w, loan, who=None):
    rows = [r for r in _snapshot(w, who)["autopay_due"]
            if r["source"] == "loan" and r["source_id"] == loan]
    assert len(rows) <= 1
    return rows[0] if rows else None


def _post_now(w, who=None, **body):
    r = w["client"].post(f"{API}/budget-entries/post-due-installments", json=body,
                         headers=(who or w["o"])["headers"])
    assert r.status_code == 200, r.text
    return r.json()


# 1 -----------------------------------------------------------------------------------------

def test_an_opted_in_loan_posts_one_split_payment_on_its_due_date(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-24")
    assert _job(w["client"])["posted"] == 0
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}
    assert _rows(db, loan) == [("2026-10-25", 9_000, 1_000, True)]
    assert _balance(db, loan) == -91_000
    assert _balance(db, w["checking"]) == 40_000
    schedule = _schedule(w, loan)
    assert schedule["payments_made"] == 1
    assert schedule["next_due_date"] == "2026-11-25"
    assert schedule["payments"][0]["kind"] == "scheduled"


def test_a_row_belongs_to_the_loan_owner(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _job(w["client"])
    db.rollback()
    row = db.execute(text("SELECT user_id, created_by_actor, loan_payment_kind, "
                          "transfer_from_account_id FROM transactions "
                          "WHERE transfer_to_account_id = :l"), {"l": loan}).one()
    assert tuple(row) == (w["o"]["id"], w["o"]["id"], "scheduled", w["checking"])


def test_nothing_posts_unless_the_flag_was_turned_on(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _post_now(w)["posted"] == 0
    assert _rows(db, loan) == []
    assert _is_on(db, loan) is False


def test_turning_off_stops_posting_and_leaves_history_alone(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _job(w["client"])
    assert _turn_on(w, loan, enabled=False)["auto_post_enabled"] is False
    on_day(monkeypatch, "2026-11-25")
    assert _job(w["client"])["posted"] == 0
    assert _rows(db, loan) == [("2026-10-25", 9_000, 1_000, True)]


# 2 -----------------------------------------------------------------------------------------

def test_a_forced_date_posts_on_the_effective_date_not_the_nominal(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    assert _force(w, loan, "2026-10-25", "2026-10-28").status_code == 200
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 0
    assert _rows(db, loan) == []
    on_day(monkeypatch, "2026-10-28")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, loan) == [("2026-10-28", 9_000, 1_000, True)]


def test_a_date_forced_earlier_posts_on_it(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-11-03")
    assert _force(w, loan, "2026-11-03", "2026-10-20").status_code == 200
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-19")
    assert _job(w["client"])["posted"] == 0
    on_day(monkeypatch, "2026-10-20")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, loan) == [("2026-10-20", 9_000, 1_000, True)]


def test_a_posted_due_date_stays_protected_from_a_forced_date(world, monkeypatch):
    w = world
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _job(w["client"])
    assert _force(w, loan, "2026-10-25", "2026-10-27").status_code == 409


def test_a_held_due_date_can_be_forced_and_then_posts_on_it(world, monkeypatch):
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 1_000)
    loan = _loan(w, payment_account_id=poor)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _job(w["client"])
    assert _force(w, loan, "2026-10-25", "2026-10-27").status_code == 200
    _deposit(w, poor, 20_000)
    assert _job(w["client"])["posted"] == 0
    on_day(monkeypatch, "2026-10-27")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, loan) == [("2026-10-27", 9_000, 1_000, True)]


# 3 -----------------------------------------------------------------------------------------

def test_running_twice_posts_once(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert _job(w["client"])["posted"] == 0
    assert _post_now(w)["posted"] == 0
    assert len(_rows(db, loan)) == 1


# 4 and 5 -----------------------------------------------------------------------------------

def test_a_hand_payment_before_the_run_means_no_post(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _pay(w, loan, "2026-10-24")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == [("2026-10-24", 9_000, 1_000, True)]
    assert _due_row(w, loan) is None


def test_a_hand_part_payment_posts_only_the_rest(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _pay(w, loan, "2026-10-24", principal="3000", interest="1000")
    assert _job(w["client"])["posted"] == 1
    rows = _rows(db, loan)
    assert len(rows) == 2
    assert rows[1][0] == "2026-10-25"
    assert rows[1][1] + rows[1][2] == 6_000
    assert _balance(db, w["checking"]) == 40_000
    schedule = _schedule(w, loan)
    assert schedule["payments_made"] == 1
    assert schedule["next_due_date"] == "2026-11-25"
    assert _job(w["client"])["posted"] == 0


# 6 -----------------------------------------------------------------------------------------

def test_a_pending_planned_payment_stops_it(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    _pay(w, loan, "2026-10-24", is_posted=False, amount="4000")
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0,
                                 "skipped": {"planned_payment": 1}}
    assert [row[3] for row in _rows(db, loan)] == [False]
    row = _due_row(w, loan)
    assert (row["state"], row["block_reason"]) == ("held", "planned_payment")


def test_a_planned_payment_stop_leaves_the_toggle_on(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-09-25")
    _pay(w, loan, "2026-10-10", is_posted=False, amount="4000")
    assert _preview(w, loan).json()["due_count"] == 1
    _turn_on(w, loan, expected_due=1)
    assert _is_on(db, loan) is True
    assert [row[3] for row in _rows(db, loan)] == [False]


# 7 -----------------------------------------------------------------------------------------

def test_a_recurring_transfer_blocks_turning_on(world):
    w, db = world, world["db"]
    loan = _loan(w)
    _recurring(w, loan)
    assert _preview(w, loan).json()["block"] == "recurring_entry"
    r = _toggle(w, loan)
    assert r.status_code == 400
    assert "recurring transfer" in r.json()["detail"]
    assert _is_on(db, loan) is False


def test_a_recurring_transfer_added_after_blocks_the_job(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    _recurring(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0,
                                 "skipped": {"recurring_entry": 1}}
    assert _rows(db, loan) == []
    row = _due_row(w, loan)
    assert (row["state"], row["block_reason"]) == ("blocked", "recurring_entry")


# 8 -----------------------------------------------------------------------------------------

def test_a_shortfall_holds_flags_retries_then_posts_on_its_own_day(world, monkeypatch):
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 9_999.99)
    loan = _loan(w, payment_account_id=poor)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0,
                                 "skipped": {"insufficient_funds": 1}}
    assert _rows(db, loan) == []
    assert _balance(db, poor) == 9_999.99
    row = _due_row(w, loan)
    assert (row["state"], row["block_reason"]) == ("held", "insufficient_funds")
    assert (row["due_count"], row["postable_count"]) == (1, 0)
    assert (row["oldest"], row["account_name"]) == ("2026-10-25", "Poor")

    on_day(monkeypatch, "2026-10-26")
    assert _job(w["client"])["skipped"] == {"insufficient_funds": 1}
    _deposit(w, poor, 0.01)
    on_day(monkeypatch, "2026-10-27")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}
    assert _rows(db, loan) == [("2026-10-25", 9_000, 1_000, True)]
    assert _balance(db, poor) == 0
    assert _due_row(w, loan) is None


def test_a_held_due_date_paid_by_hand_never_posts_twice(world, monkeypatch):
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 1_000)
    loan = _loan(w, payment_account_id=poor)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _job(w["client"])
    _deposit(w, poor, 30_000)
    _pay(w, loan, "2026-10-26")
    on_day(monkeypatch, "2026-10-27")
    assert _job(w["client"])["posted"] == 0
    assert len(_rows(db, loan)) == 1


def _overdraw(w, account) -> None:
    _sql(w["db"], "UPDATE accounts SET balance = -500 WHERE id = :a", a=account)


def test_a_negative_paying_account_holds_rather_than_errors(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    _overdraw(w, w["checking"])
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0,
                                 "skipped": {"insufficient_funds": 1}}
    assert _rows(db, loan) == []
    row = _due_row(w, loan)
    assert (row["state"], row["block_reason"]) == ("held", "insufficient_funds")


def test_a_negative_paying_account_holds_a_catch_up(world):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-08-25")
    _overdraw(w, w["checking"])
    _turn_on(w, loan, expected_due=2)
    assert _is_on(db, loan) is True
    assert _rows(db, loan) == []
    assert _balance(db, w["checking"]) == -500


@pytest.fixture
def a_due_date_owing_nothing(monkeypatch):
    """The first row of every loan's open due dates owes nothing. The schedule
    never lists one today; this pins what a run does if it ever does."""
    from decimal import Decimal

    from app.services import loans as loan_svc

    real = loan_svc.due_dates
    monkeypatch.setattr(loan_svc, "due_dates", lambda db, loan, end: [
        (-1, date(2026, 9, 25), Decimal("0")), *real(db, loan, end)])


def test_a_due_date_owing_nothing_is_not_counted_or_funds_checked(
        world, a_due_date_owing_nothing):
    w = world
    loan = _loan(w)
    assert _preview(w, loan).json() == {"block": None, "due_count": 0, "oldest": None}
    _turn_on(w, loan)
    _overdraw(w, w["checking"])
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}


def test_a_due_date_owing_nothing_does_not_stall_the_walk(
        world, monkeypatch, a_due_date_owing_nothing):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}
    assert _rows(db, loan) == [("2026-10-25", 9_000, 1_000, True)]


# 9 -----------------------------------------------------------------------------------------

def test_catch_up_posts_each_due_date_oldest_first_on_the_reduced_balance(world):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-08-25")
    preview = _preview(w, loan).json()
    assert preview == {"block": None, "due_count": 2, "oldest": "2026-08-25"}
    _turn_on(w, loan, expected_due=2)
    assert _rows(db, loan) == [("2026-08-25", 9_000, 1_000, True),
                               ("2026-09-25", 9_090, 910, True)]
    assert _balance(db, loan) == -81_910
    assert _schedule(w, loan)["next_due_date"] == "2026-10-25"


def test_catch_up_reads_the_forced_date(world):
    w, db = world, world["db"]
    loan = _loan(w)
    assert _force(w, loan, "2026-10-25", "2026-10-17").status_code == 200
    assert _preview(w, loan).json() == {"block": None, "due_count": 1, "oldest": "2026-10-17"}
    _turn_on(w, loan, expected_due=1)
    assert _rows(db, loan) == [("2026-10-17", 9_000, 1_000, True)]


def test_catch_up_stops_cleanly_on_insufficient_funds(world, monkeypatch):
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 15_000)
    loan = _loan(w, payment_account_id=poor, loan_first_payment_date="2026-08-25")
    _turn_on(w, loan, expected_due=2)
    assert _is_on(db, loan) is True
    assert _rows(db, loan) == [("2026-08-25", 9_000, 1_000, True)]
    assert _balance(db, poor) == 5_000
    row = _due_row(w, loan)
    assert (row["due_count"], row["state"], row["oldest"]) == (1, "held", "2026-09-25")
    _deposit(w, poor, 5_000)
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, loan)[1][0] == "2026-09-25"


@pytest.mark.parametrize("sent", [None, 1, 3])
def test_a_wrong_expected_due_is_409_and_changes_nothing(world, sent):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-08-25")
    body = {} if sent is None else {"expected_due": sent}
    assert _toggle(w, loan, **body).status_code == 409
    assert _is_on(db, loan) is False
    assert _rows(db, loan) == []


def test_a_stale_count_after_a_hand_payment_is_409(world):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-08-25")
    count = _preview(w, loan).json()["due_count"]
    _pay(w, loan, "2026-10-01")
    assert _toggle(w, loan, expected_due=count).status_code == 409
    assert _is_on(db, loan) is False
    assert len(_rows(db, loan)) == 1


def test_a_due_date_outside_the_record_dates_refuses_the_toggle(world, monkeypatch):
    from app.core import record_dates

    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-08-25")
    monkeypatch.setattr(record_dates, "_in_range", lambda value: False)
    assert _toggle(w, loan, expected_due=2).status_code == 422
    assert _is_on(db, loan) is False
    assert _rows(db, loan) == []


# 10 ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("mode", ["fixed", "reduce_term"])
def test_both_modes_post_the_amount_the_schedule_says(world, monkeypatch, mode):
    w, db = world, world["db"]
    loan = _loan(w, loan_amortization=mode, loan_payment_amount=8_000)
    said = _schedule(w, loan)["upcoming"][0]["payment"]
    assert said == 8_000
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, loan) == [("2026-10-25", 7_000, 1_000, True)]


def test_a_final_smaller_reduce_term_payment_posts_what_is_left(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, loan_amortization="reduce_term", balance=-5_000)
    said = _schedule(w, loan)["upcoming"][0]["payment"]
    assert said == 5_050
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert _rows(db, loan) == [("2026-10-25", 5_000, 50, True)]
    assert _balance(db, loan) == 0
    on_day(monkeypatch, "2026-11-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}


def test_a_final_part_paid_reduce_term_payment_posts_what_the_schedule_says(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, loan_amortization="reduce_term", balance=-5_000)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    _pay(w, loan, "2026-10-24", principal="1000", interest="30")
    said = _schedule(w, loan)["upcoming"][0]
    assert (said["payment"], said["principal"], said["interest"]) == (4_000, 4_000, 0)
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {}}
    assert _rows(db, loan)[1:] == [("2026-10-25", 4_000, 0, True)]
    assert _balance(db, loan) == 0
    assert _balance(db, w["checking"]) == 50_000 - 1_030 - 4_000


# 11 ----------------------------------------------------------------------------------------

def test_a_final_smaller_fixed_payment_stops_at_needs_amount(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, balance=-5_000, loan_term_months=1)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {"needs_amount": 1}}
    assert _rows(db, loan) == []
    row = _due_row(w, loan)
    assert (row["state"], row["block_reason"]) == ("held", "needs_amount")


def test_a_run_posts_up_to_the_final_payment_and_stops_there(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, balance=-12_000, loan_term_months=2, loan_first_payment_date="2026-09-25")
    _flag(db, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 1, "skipped": {"needs_amount": 1}}
    assert _rows(db, loan) == [("2026-09-25", 9_880, 120, True)]


# 12 ----------------------------------------------------------------------------------------

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


def test_job_against_a_hand_payment_leaves_the_due_date_paid_once(world, monkeypatch):
    from decimal import Decimal

    from app.core import locking
    from app.core.database import SessionLocal
    from app.services import loans as loan_svc

    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")

    engine = create_engine(os.environ["DATABASE_URL"])
    holder = SessionLocal()
    worker = _Worker(lambda: _job(w["client"]))
    try:
        locked = locking.lock_accounts(holder, [loan, w["checking"]])
        loan_svc.record_payment(
            holder, user_id=w["o"]["id"], loan=locked[loan], funding=locked[w["checking"]],
            principal=Decimal("9000"), interest=Decimal("1000"), kind=loan_svc.SCHEDULED,
            when=datetime(2026, 10, 25), is_posted=True, description=None)
        holder.flush()
        worker.thread.start()
        assert _wait_waiters(engine, 1, [worker]), "the job did not wait for the hand payment"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        worker.thread.join(JOIN_TIMEOUT)
        engine.dispose()
    assert not worker.thread.is_alive()
    assert worker.error is None
    assert worker.result["posted"] == 0
    assert len(_rows(db, loan)) == 1
    assert _balance(db, w["checking"]) == 40_000


def test_two_concurrent_jobs_post_once(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    workers = [_Worker(lambda: _job(w["client"])) for _ in range(2)]
    for worker in workers:
        worker.thread.start()
    for worker in workers:
        worker.thread.join(JOIN_TIMEOUT)
    assert sorted(worker.result["posted"] for worker in workers) == [0, 1]
    assert len(_rows(db, loan)) == 1


def test_two_concurrent_toggles_post_each_due_date_once(world):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-09-25")
    workers = [_Worker(lambda: _toggle(w, loan, expected_due=1)) for _ in range(2)]
    for worker in workers:
        worker.thread.start()
    for worker in workers:
        worker.thread.join(JOIN_TIMEOUT)
    assert sorted(worker.result.status_code for worker in workers) == [200, 409]
    assert len(_rows(db, loan)) == 1


def test_a_loan_rerouted_while_waiting_posts_nothing_from_the_old_account(world, monkeypatch):
    from app.core import locking
    from app.core.database import SessionLocal

    w, db = world, world["db"]
    other = _bank(w, "Other", 50_000)
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")

    engine = create_engine(os.environ["DATABASE_URL"])
    holder = SessionLocal()
    worker = _Worker(lambda: _job(w["client"]))
    try:
        locking.lock_accounts(holder, [loan])[loan].payment_account_id = other
        holder.flush()
        worker.thread.start()
        assert _wait_waiters(engine, 1, [worker]), "the job did not wait for the edit"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        worker.thread.join(JOIN_TIMEOUT)
        engine.dispose()
    assert worker.error is None
    assert worker.result["posted"] == 0
    assert _balance(db, w["checking"]) == 50_000
    assert _job(w["client"])["posted"] == 1
    assert _balance(db, other) == 40_000


# 13 ----------------------------------------------------------------------------------------

def _break(w, kind, loan) -> None:
    db = w["db"]
    if kind == "no_funding_account":
        _sql(db, "UPDATE accounts SET payment_account_id = NULL WHERE id = :a", a=loan)
    elif kind == "foreign_currency":
        _sql(db, "UPDATE accounts SET currency = 'USD' WHERE id = :a", a=w["checking"])
    elif kind == "no_rate":
        _sql(db, "UPDATE accounts SET loan_annual_rate = NULL WHERE id = :a", a=loan)
    else:
        _sql(db, "UPDATE accounts SET loan_payment_amount = NULL WHERE id = :a", a=loan)


BLOCKS = [("no_funding_account", "payment account"), ("foreign_currency", "another currency"),
          ("no_rate", "interest rate"), ("no_schedule", "payment amount")]


@pytest.mark.parametrize("reason,message", BLOCKS)
def test_turning_on_is_refused_with_its_reason(world, reason, message):
    w, db = world, world["db"]
    loan = _loan(w)
    _break(w, reason, loan)
    assert _preview(w, loan).json()["block"] == reason
    r = _toggle(w, loan)
    assert r.status_code == 400
    assert message in r.json()["detail"]
    assert _is_on(db, loan) is False


@pytest.mark.parametrize("reason", ["no_funding_account", "foreign_currency", "no_rate"])
def test_a_flagged_loan_that_breaks_is_blocked_with_its_reason(world, monkeypatch, reason):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    _break(w, reason, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {reason: 1}}
    assert _rows(db, loan) == []
    row = _due_row(w, loan)
    assert (row["state"], row["block_reason"]) == ("blocked", reason)


def test_a_flagged_loan_with_nothing_due_is_not_a_skip(world):
    w = world
    loan = _loan(w)
    _turn_on(w, loan)
    _break(w, "no_rate", loan)
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}


# 14 ----------------------------------------------------------------------------------------

def test_dry_run_writes_nothing_and_carries_counts_only(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-09-25")
    _flag(db, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"], dry_run=True) == {"dry_run": True, "posted": 2, "skipped": {}}
    assert _rows(db, loan) == []
    assert _balance(db, loan) == -100_000
    assert _balance(db, w["checking"]) == 50_000
    assert _job(w["client"])["posted"] == 2


# 15 ----------------------------------------------------------------------------------------

def _settlements(w, loan, who=None) -> dict:
    snapshot = _snapshot(w, who)
    return {key: [r.get("settlement") for r in snapshot[key]
                  if r.get("source") == "loan" and r.get("source_id") == loan]
            for key in ("payables", "upcoming_this_month")}


def test_loan_rows_report_settlement(world):
    w = world
    loan = _loan(w)
    assert _settlements(w, loan) == {"payables": ["manual"], "upcoming_this_month": ["manual"]}
    assert _schedule(w, loan)["settlement"] == "manual"
    _turn_on(w, loan)
    assert _settlements(w, loan) == {"payables": ["autopay"], "upcoming_this_month": ["autopay"]}
    assert _schedule(w, loan)["settlement"] == "autopay"


# Only an owner or admin sees or changes the flag -------------------------------------------

@pytest.mark.parametrize("role", ["editor", "viewer"])
def test_anyone_but_a_manager_can_neither_see_nor_change_the_flag(world, sw_people, role):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-09-25")
    other = sw_people("Sam", "Shared")
    sw_share(db, loan, other["id"], role, w["o"]["id"])
    sw_share(db, w["checking"], other["id"], "editor", w["o"]["id"])
    assert _preview(w, loan, other).status_code == 404
    assert _toggle(w, loan, who=other, expected_due=1).status_code == 404
    assert _is_on(db, loan) is False

    _turn_on(w, loan, expected_due=1)
    assert _toggle(w, loan, enabled=False, who=other).status_code == 404
    assert _is_on(db, loan) is True
    account = w["client"].get(f"{API}/accounts/{loan}", headers=other["headers"]).json()
    assert account["auto_post_enabled"] is None
    assert all(r is None for rows in _settlements(w, loan, other).values() for r in rows)
    assert _schedule(w, loan, other).get("settlement") is None


def test_an_editor_sees_no_autopay_row_and_post_now_skips_the_loan(world, sw_people, monkeypatch):
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 1_000)
    loan = _loan(w, payment_account_id=poor)
    editor = sw_people("Eddie", "Editor")
    sw_share(db, loan, editor["id"], "editor", w["o"]["id"])
    sw_share(db, poor, editor["id"], "editor", w["o"]["id"])
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _due_row(w, loan) is not None
    assert _due_row(w, loan, editor) is None
    assert _post_now(w, editor) == {"trigger": "button", "throttled": False, "posted": 0,
                                    "skipped": {}, "entries": []}
    _deposit(w, poor, 20_000)
    assert _post_now(w, editor)["posted"] == 0
    assert _rows(db, loan) == []


def test_an_admin_toggles_and_the_row_stays_the_owners(world, sw_people):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-09-25")
    admin = sw_people("Ada", "Admin")
    sw_share(db, loan, admin["id"], "admin", w["o"]["id"])
    sw_share(db, w["checking"], admin["id"], "editor", w["o"]["id"])
    assert _preview(w, loan, admin).json()["due_count"] == 1
    assert _turn_on(w, loan, who=admin, expected_due=1)["auto_post_enabled"] is True
    assert _schedule(w, loan, admin)["settlement"] == "autopay"
    db.rollback()
    assert db.execute(text("SELECT user_id FROM transactions WHERE transfer_to_account_id = :l"),
                      {"l": loan}).scalar() == w["o"]["id"]


def test_an_admin_who_cannot_use_the_paying_account_cannot_turn_it_on(world, sw_people):
    w, db = world, world["db"]
    loan = _loan(w)
    admin = sw_people("Ada", "Admin")
    sw_share(db, loan, admin["id"], "admin", w["o"]["id"])
    assert _preview(w, loan, admin).json()["block"] == "no_access"
    assert _toggle(w, loan, who=admin).status_code == 400
    assert _is_on(db, loan) is False


def test_the_toggle_is_for_loans(world):
    w = world
    assert _toggle(w, w["checking"]).status_code == 400
    assert _preview(w, w["checking"]).status_code == 400


# An edit that can open past due dates clears the flag --------------------------------------

def _edit(w, loan, **fields) -> dict:
    r = w["client"].put(f"{API}/accounts/{loan}", json=fields, headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def test_moving_the_first_date_earlier_posts_nothing_and_reads_manual(world):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    assert _edit(w, loan, loan_first_payment_date="2026-08-25")["auto_post_enabled"] is False
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == []
    assert _schedule(w, loan)["settlement"] == "manual"
    assert set(_settlements(w, loan)["payables"]) == {"manual"}
    assert _preview(w, loan).json()["due_count"] == 2
    assert _toggle(w, loan).status_code == 409
    _turn_on(w, loan, expected_due=2)
    assert len(_rows(db, loan)) == 2


def test_lowering_the_offset_posts_nothing_and_reads_manual(world):
    w, db = world, world["db"]
    loan = _loan(w, loan_first_payment_date="2026-07-25", loan_payments_made_offset=3)
    _turn_on(w, loan)
    assert _edit(w, loan, loan_payments_made_offset=1)["auto_post_enabled"] is False
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == []
    assert _schedule(w, loan)["settlement"] == "manual"
    assert _preview(w, loan).json()["due_count"] == 2


@pytest.mark.parametrize("edit", [
    {"loan_payment_amount": 12_000}, {"loan_term_months": 24},
    {"loan_amortization": "reduce_term"}, {"balance": -120_000},
    {"payment_account_id": None}, {"loan_annual_rate": None},
    {"loan_first_payment_date": None}, {"loan_payment_amount": None},
    {"loan_payment_amount": 8_000}, {"loan_term_months": 6}, {"loan_annual_rate": 10},
    {"loan_first_payment_date": "2026-10-28"}, {"loan_payments_made_offset": 1},
    {"loan_term_months": None},
])
def test_any_change_to_a_schedule_term_clears_the_flag(world, edit):
    w = world
    loan = _loan(w)
    _turn_on(w, loan)
    assert _edit(w, loan, **edit)["auto_post_enabled"] is False


def test_a_rate_rise_on_a_reduce_term_loan_posts_nothing_unconfirmed(world, monkeypatch):
    """A held loan with one payment left at 1%. At 100% interest takes more of it,
    the schedule runs one payment longer, and that one is a due date already past."""
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 1_000)
    loan = _loan(w, loan_amortization="reduce_term", balance=-9_800, loan_annual_rate=1,
                 loan_first_payment_date="2026-09-25", payment_account_id=poor)
    _flag(db, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _preview(w, loan).json()["due_count"] == 1

    assert _edit(w, loan, loan_annual_rate=100)["auto_post_enabled"] is False
    assert _preview(w, loan).json()["due_count"] == 2
    _deposit(w, poor, 100_000)
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == []
    assert _schedule(w, loan)["settlement"] == "manual"


def test_a_rate_cut_on_a_reduce_term_loan_clears_the_flag(world):
    w = world
    loan = _loan(w, loan_amortization="reduce_term")
    _turn_on(w, loan)
    assert _edit(w, loan, loan_annual_rate=10)["auto_post_enabled"] is False


def test_a_lower_amount_on_a_reduce_term_loan_posts_nothing_unconfirmed(world, monkeypatch):
    """A held loan with one payment left. A smaller payment runs the schedule longer,
    and the extra one is a due date already past."""
    w, db = world, world["db"]
    poor = _bank(w, "Poor", 1_000)
    loan = _loan(w, loan_amortization="reduce_term", balance=-9_800,
                 loan_first_payment_date="2026-09-25", payment_account_id=poor)
    _flag(db, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _preview(w, loan).json()["due_count"] == 1

    assert _edit(w, loan, loan_payment_amount=5_000)["auto_post_enabled"] is False
    assert _preview(w, loan).json()["due_count"] == 2
    _deposit(w, poor, 100_000)
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == []
    assert _schedule(w, loan)["settlement"] == "manual"


def test_a_home_loan_kind_clears_the_flag_where_it_sets_the_mode(world):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    _sql(db, "UPDATE accounts SET loan_amortization = NULL WHERE id = :a", a=loan)
    assert _edit(w, loan, loan_kind="home")["auto_post_enabled"] is False


def test_a_new_kind_keeps_the_flag_where_the_mode_is_stored(world):
    w = world
    loan = _loan(w)
    _turn_on(w, loan)
    assert _edit(w, loan, loan_kind="home")["auto_post_enabled"] is True


@pytest.mark.parametrize("edit", [
    {"name": "Car"}, {"description": "Bank of Somewhere"},
    {"loan_first_payment_date": "2026-10-25", "loan_payment_amount": 10_000,
     "loan_term_months": 12, "loan_payments_made_offset": 0, "loan_amortization": "fixed",
     "loan_annual_rate": 12, "balance": -100_000},
    {"balance": -90_000},
])
def test_an_edit_that_opens_nothing_keeps_the_flag(world, edit):
    w = world
    loan = _loan(w)
    _turn_on(w, loan)
    assert _edit(w, loan, **edit)["auto_post_enabled"] is True
    assert _schedule(w, loan)["settlement"] == "autopay"


def test_an_unrelated_edit_keeps_posting(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    _edit(w, loan, name="Car")
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert len(_rows(db, loan)) == 1


def test_moving_the_paying_account_keeps_the_flag_and_pays_from_it(world, monkeypatch):
    w, db = world, world["db"]
    other = _bank(w, "Other", 50_000)
    loan = _loan(w)
    _turn_on(w, loan)
    assert _edit(w, loan, payment_account_id=other)["auto_post_enabled"] is True
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    assert _balance(db, other) == 40_000


def test_an_edit_on_an_unflagged_loan_leaves_it_off(world):
    w = world
    loan = _loan(w)
    assert _edit(w, loan, loan_first_payment_date="2026-08-25")["auto_post_enabled"] is False


# A payment taken back stops autopay ----------------------------------------------------------

def _paid_by_the_job(w, monkeypatch) -> tuple:
    """A loan whose 2026-10-25 payment the job posted, and that row's id."""
    db = w["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    assert _job(w["client"])["posted"] == 1
    db.rollback()
    return loan, db.execute(text("SELECT id FROM transactions WHERE transfer_to_account_id = :l"),
                            {"l": loan}).scalar()


def _edit_row(w, txn, **fields):
    return w["client"].put(f"{API}/transactions/{txn}", json=fields, headers=w["o"]["headers"])


def _delete_row(w, txn) -> None:
    r = w["client"].delete(f"{API}/transactions/{txn}", headers=w["o"]["headers"])
    assert r.status_code == 200, r.text


def test_a_deleted_payment_is_not_posted_again_and_the_loan_reads_manual(world, monkeypatch):
    w, db = world, world["db"]
    loan, txn = _paid_by_the_job(w, monkeypatch)
    _delete_row(w, txn)
    assert _is_on(db, loan) is False
    assert _schedule(w, loan)["settlement"] == "manual"
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == []
    assert _balance(db, w["checking"]) == 50_000


def test_turning_it_back_on_shows_the_count_and_posts_once(world, monkeypatch):
    w, db = world, world["db"]
    loan, txn = _paid_by_the_job(w, monkeypatch)
    _delete_row(w, txn)
    assert _preview(w, loan).json() == {"block": None, "due_count": 1, "oldest": "2026-10-25"}
    assert _toggle(w, loan).status_code == 409
    _turn_on(w, loan, expected_due=1)
    assert _rows(db, loan) == [("2026-10-25", 9_000, 1_000, True)]
    assert _job(w["client"])["posted"] == 0
    assert len(_rows(db, loan)) == 1


def test_an_unposted_payment_is_not_posted_again_and_the_loan_reads_manual(world, monkeypatch):
    w, db = world, world["db"]
    loan, txn = _paid_by_the_job(w, monkeypatch)
    assert _edit_row(w, txn, is_posted=False).status_code == 200
    assert _is_on(db, loan) is False
    assert _schedule(w, loan)["settlement"] == "manual"
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert [row[3] for row in _rows(db, loan)] == [False]
    assert _balance(db, w["checking"]) == 50_000


def test_a_reduced_payment_stops_autopay(world, monkeypatch):
    w, db = world, world["db"]
    loan, txn = _paid_by_the_job(w, monkeypatch)
    assert _edit_row(w, txn, amount=8_000).status_code == 200
    assert _is_on(db, loan) is False
    assert _job(w["client"])["posted"] == 0
    assert len(_rows(db, loan)) == 1


@pytest.mark.parametrize("edit", [
    {"transaction_date": "2026-10-26T00:00:00"},
    {"description": "BPI debit"},
    {"amount": 9_500, "transfer_fee": 500},  # the bank's split: the same cash
    {"amount": 9_500, "transfer_fee": 1_000},  # more cash pays more, reopens nothing
])
def test_an_edit_that_reopens_nothing_keeps_the_flag(world, monkeypatch, edit):
    w, db = world, world["db"]
    loan, txn = _paid_by_the_job(w, monkeypatch)
    r = _edit_row(w, txn, **edit)
    assert r.status_code == 200, r.text
    assert _is_on(db, loan) is True
    assert _job(w["client"])["posted"] == 0


def test_a_payment_cannot_be_retargeted_so_the_flag_stands(world, monkeypatch):
    w, db = world, world["db"]
    other = _loan(w, name="Other")
    loan, txn = _paid_by_the_job(w, monkeypatch)
    assert _edit_row(w, txn, transfer_to_account_id=other).status_code == 400
    assert _is_on(db, loan) is True


def test_deleting_a_hand_payment_stops_autopay_too(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    txn = _pay(w, loan, "2026-10-17")["id"]
    _delete_row(w, txn)
    assert _is_on(db, loan) is False


def _held_by_a_plan(w, monkeypatch, today="2026-10-26", amount="4000") -> tuple:
    loan = _loan(w)
    _turn_on(w, loan)
    txn = _pay(w, loan, "2026-10-24", is_posted=False, amount=amount)["id"]
    on_day(monkeypatch, today)
    assert _job(w["client"])["skipped"] == {"planned_payment": 1}
    return loan, txn


def test_deleting_a_planned_payment_clears_the_flag(world, monkeypatch):
    w = world
    loan = _loan(w)
    _turn_on(w, loan)
    txn = _pay(w, loan, "2026-10-24", is_posted=False, amount="4000")["id"]
    _delete_row(w, txn)
    on_day(monkeypatch, "2026-10-25")
    _reads_manual_and_confirms(w, loan)


def test_deleting_a_planned_payment_that_held_a_due_date_clears_the_flag(world, monkeypatch):
    w = world
    loan, txn = _held_by_a_plan(w, monkeypatch)
    _delete_row(w, txn)
    _reads_manual_and_confirms(w, loan)


def test_deleting_a_pending_prepayment_keeps_the_flag(world):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    txn = _pay(w, loan, "2026-10-24", is_posted=False, amount="4000")["id"]
    _sql(db, "UPDATE transactions SET loan_payment_kind = 'prepayment' WHERE id = :t", t=txn)
    _delete_row(w, txn)
    assert _is_on(db, loan) is True


def test_moving_a_planned_payment_off_its_date_clears_the_flag(world, monkeypatch):
    w = world
    loan, txn = _held_by_a_plan(w, monkeypatch)
    r = _edit_row(w, txn, transaction_date="2026-12-20T00:00:00")
    assert r.status_code == 200, r.text
    _reads_manual_and_confirms(w, loan)


def test_posting_a_planned_payment_for_part_clears_the_flag(world, monkeypatch):
    w = world
    loan, txn = _held_by_a_plan(w, monkeypatch)
    assert _edit_row(w, txn, is_posted=True).status_code == 200
    _reads_manual_and_confirms(w, loan)


def test_posting_a_planned_payment_with_a_date_due_behind_it_clears_the_flag(world, monkeypatch):
    w = world
    loan, txn = _held_by_a_plan(w, monkeypatch, today="2026-11-26", amount="10000")
    assert _edit_row(w, txn, is_posted=True).status_code == 200
    _reads_manual_and_confirms(w, loan)


def test_posting_a_planned_payment_that_settles_all_that_is_due_keeps_the_flag(world, monkeypatch):
    w, db = world, world["db"]
    loan, txn = _held_by_a_plan(w, monkeypatch, amount="10000")
    assert _edit_row(w, txn, is_posted=True).status_code == 200
    assert _is_on(db, loan) is True
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}


@pytest.mark.parametrize("fields", [{"amount": 1_000}, {"description": "Renamed"},
                                    {"amount": 6_000}], ids=["less", "text", "more"])
def test_an_edit_that_leaves_a_plan_on_its_date_keeps_the_hold(world, monkeypatch, fields):
    w, db = world, world["db"]
    loan, txn = _held_by_a_plan(w, monkeypatch)
    assert _edit_row(w, txn, **fields).status_code == 200
    assert _is_on(db, loan) is True
    assert _job(w["client"])["skipped"] == {"planned_payment": 1}
    assert len(_rows(db, loan)) == 1


def test_a_planned_payment_cannot_be_edited_down_to_nothing(world, monkeypatch):
    w = world
    _, txn = _held_by_a_plan(w, monkeypatch)
    assert _edit_row(w, txn, amount=0, transfer_fee=0).status_code == 400


# Post now and the page-open run ------------------------------------------------------------

def test_post_now_posts_a_due_loan_and_reports_it(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    result = _post_now(w)
    assert result["posted"] == 1
    assert result["loans"] == [{"loan_id": loan, "posted": 1, "skipped_reason": None}]
    assert result["entries"] == []
    assert len(_rows(db, loan)) == 1


def test_the_page_open_run_posts_a_due_loan(world, monkeypatch):
    w, db = world, world["db"]
    loan = _loan(w)
    _turn_on(w, loan)
    on_day(monkeypatch, "2026-10-25")
    result = _post_now(w, trigger="page_open")
    assert result["posted"] == 1
    assert len(_rows(db, loan)) == 1
    assert date.fromisoformat(_rows(db, loan)[0][0]) == date(2026, 10, 25)


# A recurring transfer into the loan stops -----------------------------------------------------

def _behind_a_transfer(w, monkeypatch, today="2026-10-26", who=None, **entry) -> tuple:
    """A loan turned on, then a recurring transfer that holds the job off while a
    payment falls due behind it."""
    loan = _loan(w)
    _turn_on(w, loan)
    feed = sw_post(w["client"], who or w["o"], "/budget-entries/", {
        "name": "Car loan", "entry_type": "expense", "amount": 10_000, "cadence": "monthly",
        "next_occurrence": "2026-10-25T00:00:00", "account_id": w["checking"],
        "transfer_to_account_id": loan, **entry})["id"]
    on_day(monkeypatch, today)
    assert _job(w["client"])["skipped"] == {"recurring_entry": 1}
    return loan, feed


def _reads_manual_and_confirms(w, loan, due=1) -> None:
    """The job posts nothing, and turning it back on shows the count and posts once."""
    db = w["db"]
    before = _rows(db, loan)
    assert _is_on(db, loan) is False
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert _rows(db, loan) == before
    assert set(sum(_settlements(w, loan).values(), [])) <= {"manual"}
    preview = _preview(w, loan).json()
    assert (preview["block"], preview["due_count"]) == (None, due)
    _turn_on(w, loan, expected_due=due)
    assert len(_rows(db, loan)) == len(before) + due
    assert _job(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}


def _put_entry(w, feed, **fields) -> None:
    r = w["client"].put(f"{API}/budget-entries/{feed}", json=fields, headers=w["o"]["headers"])
    assert r.status_code == 200, r.text


def test_pausing_the_transfer_clears_autopay(world, monkeypatch):
    loan, feed = _behind_a_transfer(world, monkeypatch)
    _put_entry(world, feed, is_active=False)
    _reads_manual_and_confirms(world, loan)


def test_pointing_the_transfer_elsewhere_clears_autopay(world, monkeypatch):
    loan, feed = _behind_a_transfer(world, monkeypatch)
    _put_entry(world, feed, transfer_to_account_id=_bank(world, "Savings", 0))
    _reads_manual_and_confirms(world, loan)


def test_taking_the_destination_off_the_transfer_clears_autopay(world, monkeypatch):
    loan, feed = _behind_a_transfer(world, monkeypatch)
    _put_entry(world, feed, transfer_to_account_id=None)
    _reads_manual_and_confirms(world, loan)


def test_deleting_the_transfer_clears_autopay(world, monkeypatch):
    w = world
    loan, feed = _behind_a_transfer(w, monkeypatch)
    r = w["client"].delete(f"{API}/budget-entries/{feed}", headers=w["o"]["headers"])
    assert r.status_code == 204, r.text
    _reads_manual_and_confirms(w, loan)


def test_the_last_occurrence_of_a_capped_transfer_clears_autopay(world, monkeypatch):
    w, db = world, world["db"]
    loan, feed = _behind_a_transfer(w, monkeypatch, today="2026-11-26",
                                    end_mode="after_occurrences", max_occurrences=1)
    r = w["client"].post(f"{API}/budget-entries/{feed}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    assert db.execute(text("SELECT is_active FROM budget_entries WHERE id = :e"),
                      {"e": feed}).scalar() is False
    _reads_manual_and_confirms(w, loan)


def test_a_transfer_ended_on_a_date_clears_autopay_at_its_last_one(world, monkeypatch):
    w = world
    loan, feed = _behind_a_transfer(w, monkeypatch, today="2026-11-26", end_mode="on_date",
                                    end_date="2026-10-30T00:00:00")
    r = w["client"].post(f"{API}/budget-entries/{feed}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    _reads_manual_and_confirms(w, loan)


def test_an_end_date_alone_keeps_the_block_and_the_flag(world, monkeypatch):
    w, db = world, world["db"]
    loan, feed = _behind_a_transfer(w, monkeypatch)
    _put_entry(w, feed, end_mode="on_date", end_date="2026-10-25T00:00:00")
    assert _is_on(db, loan) is True
    assert _job(w["client"])["skipped"] == {"recurring_entry": 1}
    assert _rows(db, loan) == []


def _shared_feed(w, sw_people, monkeypatch) -> tuple:
    """Mia, an editor on both accounts, sets up the transfer into Olive's loan."""
    mia = sw_people("Mia", "Member")
    loan = _loan(w)
    shares = {a: sw_share(w["db"], a, mia["id"], "editor") for a in (w["checking"], loan)}
    _turn_on(w, loan)
    sw_post(w["client"], mia, "/budget-entries/", {
        "name": "Car loan", "entry_type": "expense", "amount": 10_000, "cadence": "monthly",
        "next_occurrence": "2026-10-25T00:00:00", "account_id": w["checking"],
        "transfer_to_account_id": loan})
    on_day(monkeypatch, "2026-10-26")
    assert _job(w["client"])["skipped"] == {"recurring_entry": 1}
    return loan, mia, shares


@pytest.mark.parametrize("on", ["checking", "loan"])
def test_removing_the_creators_share_clears_autopay(world, sw_people, monkeypatch, on):
    w = world
    loan, mia, shares = _shared_feed(w, sw_people, monkeypatch)
    account = {"checking": w["checking"], "loan": loan}[on]
    r = w["client"].delete(f"{API}/accounts/{account}/shares/{shares[account]}",
                           headers=w["o"]["headers"])
    assert r.status_code == 204, r.text
    _reads_manual_and_confirms(w, loan)


def test_demoting_the_creator_clears_autopay(world, sw_people, monkeypatch):
    w = world
    loan, mia, shares = _shared_feed(w, sw_people, monkeypatch)
    r = w["client"].patch(f"{API}/accounts/{w['checking']}/shares/{shares[w['checking']]}",
                          json={"role": "viewer"}, headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    _reads_manual_and_confirms(w, loan)


def test_the_creator_leaving_clears_autopay(world, sw_people, monkeypatch):
    w = world
    loan, mia, shares = _shared_feed(w, sw_people, monkeypatch)
    r = w["client"].delete(f"{API}/shares/received/{shares[w['checking']]}",
                           headers=mia["headers"])
    assert r.status_code == 204, r.text
    _reads_manual_and_confirms(w, loan)


@pytest.mark.parametrize("fields", [
    {"amount": 9_000}, {"name": "Renamed"}, {"is_active": True},
    {"end_mode": "on_date", "end_date": "2027-06-25T00:00:00"},
], ids=["amount", "name", "still_active", "later_end"])
def test_an_edit_that_keeps_the_transfer_on_the_loan_keeps_the_flag(world, monkeypatch, fields):
    w, db = world, world["db"]
    loan, feed = _behind_a_transfer(w, monkeypatch)
    _put_entry(w, feed, **fields)
    assert _is_on(db, loan) is True
    assert _job(w["client"])["skipped"] == {"recurring_entry": 1}


def test_an_edit_to_a_paused_transfer_leaves_a_flag_set_after_the_pause(world, monkeypatch):
    w, db = world, world["db"]
    loan, feed = _behind_a_transfer(w, monkeypatch)
    _put_entry(w, feed, is_active=False)
    _turn_on(w, loan, expected_due=1)
    _put_entry(w, feed, name="Renamed", transfer_to_account_id=_bank(w, "Savings", 0))
    assert _is_on(db, loan) is True

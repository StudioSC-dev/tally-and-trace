"""The production opt-in script (settlement plan, PR 9). Skips without a database.

``services/settlement_opt_in.run`` (driven by ``scripts/set_settlement.py``) turns
autopay on for named entries and loans through the toggle's own service code.

Reference Sunday 2026-10-18, 10:00 in Manila. O owns Checking (50,000), the
"Rent" entry (5,000 monthly, first 2026-08-25: two dates past due, 08-25 and
09-25) and the "Auto" loan (100,000 owed, 10,000 monthly, first due 2026-08-25:
two dates past due).

Criteria: 1 a dry run writes nothing and prints what would post; 2 --apply turns
on and posts the catch-up (entry and loan); 3 the wrong database is refused
before connecting; 4 a rerun changes nothing.
"""
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine.url import make_url

from app.tests.conftest import sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)
BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPT = str(BACKEND_DIR / "scripts" / "set_settlement.py")
RENT, PAYMENT = 5_000, 10_000


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    o = sw_people("Olive", "Owner")
    checking = sw_post(sw_client, o, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    pin_clock(monkeypatch, REF)
    return {"client": sw_client, "db": sw_db, "o": o, "checking": checking}


def _entry(w, **extra) -> int:
    body = {"name": "Rent", "entry_type": "expense", "amount": RENT, "cadence": "monthly",
            "next_occurrence": "2026-08-25T00:00:00", "account_id": w["checking"], **extra}
    return sw_post(w["client"], w["o"], "/budget-entries/", body)["id"]


def _loan(w, **extra) -> int:
    body = {"name": "Auto", "account_type": "loan", "loan_kind": "auto", "balance": -100_000,
            "loan_annual_rate": 12, "loan_term_months": 12, "loan_payment_amount": PAYMENT,
            "loan_first_payment_date": "2026-08-25", "loan_amortization": "fixed",
            "payment_account_id": w["checking"], **extra}
    return sw_post(w["client"], w["o"], "/accounts/", body)["id"]


def _run(entries=(), loans=(), apply=False):
    """The service as the script runs it, in its own session."""
    from app.core.database import SessionLocal
    from app.services import settlement_opt_in

    db = SessionLocal()
    try:
        results = settlement_opt_in.run(db, entry_ids=list(entries), loan_ids=list(loans),
                                        apply=apply)
        return results, settlement_opt_in.summary(results, apply)
    finally:
        db.close()


def _state(db, w, entry=None, loan=None):
    """Everything the run could touch, for a before and after comparison."""
    db.rollback()
    db.expire_all()
    ids = [i for i in (entry, loan) if i]
    rows = db.execute(text(
        "SELECT id, account_id, transaction_date, is_posted FROM transactions "
        "WHERE user_id = :u ORDER BY id"), {"u": w["o"]["id"]}).all()
    flags = db.execute(text("SELECT auto_post_enabled FROM budget_entries WHERE id = ANY(:i)"),
                       {"i": ids}).all()
    accounts = db.execute(text(
        "SELECT id, balance, auto_post_enabled FROM accounts WHERE user_id = :u ORDER BY id"),
        {"u": w["o"]["id"]}).all()
    nexts = db.execute(text("SELECT id, next_occurrence FROM budget_entries WHERE id = ANY(:i)"),
                       {"i": ids}).all()
    return rows, flags, accounts, nexts


def _posted_dates(db, w):
    db.rollback()
    return [r[0].date() for r in db.execute(text(
        "SELECT transaction_date FROM transactions WHERE user_id = :u AND is_posted "
        "ORDER BY transaction_date, id"), {"u": w["o"]["id"]})]


# 1 ----------------------------------------------------------------------------------------

def test_dry_run_writes_nothing_and_prints_what_would_post(world):
    w, db = world, world["db"]
    entry, loan = _entry(w), _loan(w)
    before = _state(db, w, entry, loan)
    results, lines = _run([entry], [loan], apply=False)
    assert _state(db, w, entry, loan) == before
    assert [r.status for r in results] == ["would_turn_on", "would_turn_on"]
    text_out = "\n".join(lines)
    assert f"entry {entry}:" in text_out and f"loan {loan}:" in text_out
    assert "precheck: ok" in text_out
    assert "due: 2 (2026-08-25, 2026-09-25)" in text_out
    assert "would post: txn new 2026-08-25" in text_out
    assert "recurring transfer into loan: none" in text_out
    assert "dry run, no rows or balances change" in text_out


# 2 ----------------------------------------------------------------------------------------

def test_apply_turns_on_and_posts_the_catch_up_for_an_entry(world):
    w, db = world, world["db"]
    entry = _entry(w)
    results, lines = _run([entry], apply=True)
    assert results[0].status == "turned_on"
    assert [when for _, when in results[0].posted] == [date(2026, 8, 25), date(2026, 9, 25)]
    assert all(txn_id is not None for txn_id, _ in results[0].posted)
    db.rollback()
    assert db.execute(text("SELECT auto_post_enabled FROM budget_entries WHERE id = :i"),
                      {"i": entry}).scalar() is True
    assert _posted_dates(db, w) == [date(2026, 8, 25), date(2026, 9, 25)]
    assert float(db.execute(text("SELECT balance FROM accounts WHERE id = :i"),
                            {"i": w["checking"]}).scalar()) == 40_000
    assert "posted: txn " in "\n".join(lines) and "changes: 1 records" in lines[-1]


def test_apply_turns_on_and_posts_the_catch_up_for_a_loan(world):
    w, db = world, world["db"]
    loan = _loan(w)
    results, _ = _run(loans=[loan], apply=True)
    assert results[0].status == "turned_on"
    assert [when for _, when in results[0].posted] == [date(2026, 8, 25), date(2026, 9, 25)]
    db.rollback()
    assert db.execute(text("SELECT auto_post_enabled FROM accounts WHERE id = :i"),
                      {"i": loan}).scalar() is True
    assert _posted_dates(db, w) == [date(2026, 8, 25), date(2026, 9, 25)]
    assert float(db.execute(text("SELECT balance FROM accounts WHERE id = :i"),
                            {"i": w["checking"]}).scalar()) == 30_000


# 3 ----------------------------------------------------------------------------------------

def _script_env(url):
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env["DATABASE_URL"] = url
    return env


def test_wrong_database_is_refused_before_connecting(world):
    """An unreachable server proves no connection is tried: a refusal is exit 2 and
    prints "refused"; a connection attempt would be exit 1 and print "error"."""
    dead = "postgresql://nobody:nopass@127.0.0.1:1/real_db"
    for flags in (["--expect-host", "127.0.0.1", "--expect-db", "other_db"],
                  ["--expect-host", "other-host", "--expect-db", "real_db"]):
        out = subprocess.run([sys.executable, SCRIPT, *flags, "--entry", "1", "--apply"],
                             env=_script_env(dead), capture_output=True, text=True, timeout=60)
        assert out.returncode == 2, out.stdout + out.stderr
        assert out.stdout.startswith("refused:") and "error" not in out.stdout
        assert "nopass" not in out.stdout + out.stderr
    # The same URL with matching expectations does try to connect (and fails: exit 1).
    ok = subprocess.run([sys.executable, SCRIPT, "--expect-host", "127.0.0.1",
                         "--expect-db", "real_db", "--entry", "1"],
                        env=_script_env(dead), capture_output=True, text=True, timeout=60)
    assert ok.returncode == 1 and "error:" in ok.stdout and "nopass" not in ok.stdout


def test_nothing_is_selected_implicitly(world):
    parsed = make_url(os.environ["DATABASE_URL"])
    out = subprocess.run([sys.executable, SCRIPT, "--expect-host", parsed.host,
                          "--expect-db", parsed.database],
                         env=_script_env(os.environ["DATABASE_URL"]), capture_output=True,
                         text=True, timeout=60)
    assert out.returncode == 2 and "--entry or --loan" in out.stderr


def test_script_dry_run_prints_no_amounts(world):
    w = world
    entry = _entry(w)
    parsed = make_url(os.environ["DATABASE_URL"])
    out = subprocess.run([sys.executable, SCRIPT, "--expect-host", parsed.host,
                          "--expect-db", parsed.database, "--entry", str(entry)],
                         env=_script_env(os.environ["DATABASE_URL"]), capture_output=True,
                         text=True, timeout=300)
    assert out.returncode == 0, out.stdout + out.stderr
    assert out.stdout.startswith(f"target: host={parsed.host} db={parsed.database}\n")
    assert f"entry {entry}:" in out.stdout and "mode: dry run" in out.stdout
    assert "5000" not in out.stdout and "5,000" not in out.stdout
    assert "password" not in out.stdout


# 4 ----------------------------------------------------------------------------------------

def test_a_rerun_changes_nothing(world):
    w, db = world, world["db"]
    entry, loan = _entry(w), _loan(w)
    first, _ = _run([entry], [loan], apply=True)
    assert [r.status for r in first] == ["turned_on", "turned_on"]
    after_first = _state(db, w, entry, loan)
    second, lines = _run([entry], [loan], apply=True)
    assert [r.status for r in second] == ["already_on", "already_on"]
    assert _state(db, w, entry, loan) == after_first
    assert "changes: 0 records" in lines[-1]


# precheck -------------------------------------------------------------------------------------

def test_apply_refuses_a_record_whose_precheck_fails(world):
    w, db = world, world["db"]
    entry = _entry(w, transfer_to_account_id=_bank(w))
    loan = _loan(w)
    feeder = _entry(w, name="Car loan", transfer_to_account_id=loan)
    before = _state(db, w, entry, loan)
    results, lines = _run([entry], [loan], apply=True)
    assert [(r.status, r.reason) for r in results] == [
        ("refused", "not_cash"), ("refused", "recurring_entry")]
    assert results[1].feeding == [feeder]
    assert _state(db, w, entry, loan) == before
    out = "\n".join(lines)
    assert "precheck: refused (not_cash)" in out and "precheck: refused (recurring_entry)" in out
    assert f"recurring transfer into loan: entry {feeder}" in out


def _bank(w) -> int:
    return sw_post(w["client"], w["o"], "/accounts/", {
        "name": "Savings", "account_type": "checking", "balance": 0})["id"]


def test_a_changed_count_writes_nothing(world, monkeypatch):
    """The count is computed in the run and handed to the toggle's call; if the call
    sees another it is a 409 and nothing is written."""
    from app.services import posting

    w, db = world, world["db"]
    entry, loan = _entry(w), _loan(w)
    before = _state(db, w, entry, loan)
    real_entry, real_loan = posting.autopay_preview, posting.loan_autopay_preview
    monkeypatch.setattr(posting, "autopay_preview",
                        lambda *a: {**real_entry(*a), "due_count": 3})
    monkeypatch.setattr(posting, "loan_autopay_preview",
                        lambda *a: {**real_loan(*a), "due_count": 3})
    results, _ = _run([entry], [loan], apply=True)
    assert [(r.status, r.reason) for r in results] == [
        ("refused", "http_409"), ("refused", "http_409")]
    assert _state(db, w, entry, loan) == before


def test_short_funds_are_held_not_an_error(world):
    w, db = world, world["db"]
    poor = sw_post(w["client"], w["o"], "/accounts/", {
        "name": "Poor", "account_type": "checking", "balance": 7_000})["id"]
    entry = _entry(w, account_id=poor)
    results, lines = _run([entry], apply=True)
    assert results[0].status == "turned_on" and results[0].held == "insufficient_funds"
    assert [when for _, when in results[0].posted] == [date(2026, 8, 25)]
    db.rollback()
    assert db.execute(text("SELECT auto_post_enabled FROM budget_entries WHERE id = :i"),
                      {"i": entry}).scalar() is True
    assert "held: insufficient_funds" in "\n".join(lines)


def test_unknown_and_wrong_kind_ids_are_refused(world):
    w = world
    results, _ = _run([999_999_999], [w["checking"]], apply=True)
    assert [(r.status, r.reason) for r in results] == [
        ("refused", "not_found"), ("refused", "not_loan")]

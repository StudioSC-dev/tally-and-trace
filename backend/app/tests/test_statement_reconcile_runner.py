"""Reconciling a card statement from a JSON file (STU-752).

``services/statement_reconcile_runner.run`` (driven by
``scripts/reconcile_statement.py``) calls the service behind
``POST /cards/{account_id}/statements/reconcile``. Skips without a database. Every figure
is made up.

Reference: Wednesday 2026-03-18, 02:00 UTC (10:00 in Manila). The card closes on the 24th:
the statement reconciled closes on 2026-02-24 (window 2026-01-25 .. 2026-02-24). The script
tests run it as a subprocess on the real clock, so they use posted rows only and a
statement long closed.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine.url import make_url

from app.tests.conftest import API, fx_rates, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_statement_reconcile_integration import (
    _apply, _dry, _line, _row, _snapshot, _statement, _statements, _txn,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 3, 18, 2, 0)
CLOSE = "2026-02-24"
BACKEND_DIR = Path(__file__).resolve().parents[2]
SCRIPT = str(BACKEND_DIR / "scripts" / "reconcile_statement.py")
DOC = BACKEND_DIR.parent / "docs" / "statement-reconcile.md"


# --- helpers ----------------------------------------------------------------------------------

def _card(w, name):
    return sw_post(w["client"], w["me"], "/accounts/", {
        "name": name, "account_type": "credit", "balance": 0, "billing_cycle_start": 24,
        "days_until_due_date": 21, "payment_account_id": w["checking"]})["id"]


@pytest.fixture
def w(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = sw_post(sw_client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 100_000})["id"]
    world = {"client": sw_client, "db": sw_db, "me": me, "checking": checking,
             "people": sw_people}
    world["card"] = _card(world, "Card R")
    return world


def _busy(w, with_unposted=True):
    """One row for each action kind (the stored statements caught up) and the statement
    that reconciles them. The amounts are distinctive so output can be searched for them."""
    _row(w, "2026-02-10", 7351)                                    # update amount
    _row(w, "2026-02-12", 5100)                                    # update dates
    if with_unposted:
        _row(w, "2026-02-15", 3300, posted=False)                  # move from unposted
    _row(w, "2026-01-20", 4400)                                    # move from Jan 24
    _row(w, "2026-02-08", 6600)                                    # unpost
    _row(w, "2026-02-03", 90, kind="credit")                       # matched
    _statements(w)
    lines = [
        _line(1, "2026-02-10", "9162.40"),
        _line(2, "2026-02-13", "5100.00", posting="2026-02-14"),
        _line(3, "2026-02-15", "3300.00") if with_unposted
        else _line(3, "2026-02-16", "3300.00"),
        _line(4, "2026-01-26", "4400.00"),
        _line(5, "2026-02-05", "2750.00", description="New shop"),
        _line(6, "2026-02-03", "90.00", kind="credit"),
    ]
    return _statement(lines, close=CLOSE, due_date="2026-03-16", minimum_due="850.25")


def _run(w, statement, apply, card=None, actor=None):
    from app.core.database import SessionLocal
    from app.services import statement_reconcile_runner as runner

    db = SessionLocal()
    try:
        return runner.run(db, actor_user_id=(actor or w["me"])["id"], card_id=card or w["card"],
                          statement=runner_statement(statement), apply=apply, fx=fx_rates())
    finally:
        db.close()


def runner_statement(body):
    from app.schemas.statement_reconcile import BankStatement

    return BankStatement.model_validate(body)


def _cli(w, tmp_path, statement, *flags, card=None, actor=None, db_name=None):
    parsed = make_url(os.environ["DATABASE_URL"])
    file = tmp_path / "statement.json"
    file.write_text(json.dumps(statement))
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    out = subprocess.run(
        [sys.executable, SCRIPT, "--card-id", str(card or w["card"]), "--file", str(file),
         "--actor-user-id", str((actor or w["me"])["id"]), "--expect-host", parsed.host,
         "--expect-db", db_name or parsed.database, *flags],
        env=env, capture_output=True, text=True, timeout=300)
    return out


def _no_amount(output):
    """Nothing in ``output`` looks like an amount, and none of the made-up figures is in it
    (the fingerprint, a hash, and the target line are left out)."""
    body = "\n".join(line for line in output.splitlines() if not line.startswith(("fingerprint:", "target:")))
    assert not re.search(r"\d+\.\d+", body), body
    assert not re.search(r"\d,\d{3}", body), body
    for figure in ("7351", "9162", "5100", "3300", "4400", "6600", "2750", "850"):
        assert figure not in body, (figure, body)


def _state(w, card):
    """What a reconcile leaves on ``card``, comparable across cards."""
    db = w["db"]
    db.rollback()
    rows = [tuple(r) for r in db.execute(text(
        "SELECT description, amount, transaction_date, posting_date, is_posted, is_reconciled "
        "FROM transactions WHERE account_id = :c ORDER BY id"), {"c": card})]
    recon = [tuple(r) for r in db.execute(text(
        "SELECT statement_close, total_due, line_balance, line_count, reconciled_by_actor "
        "FROM statement_reconciliations WHERE card_id = :c"), {"c": card})]
    header = [tuple(r) for r in db.execute(text(
        "SELECT statement_close, due_date FROM card_statement_due_overrides "
        "WHERE account_id = :c"), {"c": card})]
    minimum = [tuple(r) for r in db.execute(text(
        "SELECT statement_close, amount FROM card_statement_minimums "
        "WHERE account_id = :c"), {"c": card})]
    balance = db.execute(text("SELECT balance FROM accounts WHERE id = :c"),
                         {"c": card}).scalar()
    db.rollback()
    return {"rows": rows, "recon": recon, "header": header, "minimum": minimum,
            "balance": balance}


# --- AC1: a dry run prints the actions and writes nothing -------------------------------------

def test_dry_run_prints_the_actions_and_writes_nothing(w):
    statement = _busy(w)
    before = _snapshot(w)
    outcome = _run(w, statement, apply=False)
    assert _snapshot(w) == before
    assert outcome.code == 0, outcome.lines
    out = "\n".join(outcome.lines)
    for line_no, kind in ((1, "update"), (2, "update"), (3, "move"), (4, "move"),
                          (5, "create"), (6, "matched")):
        assert re.search(rf"action: {kind} line {line_no}\b", out), out
    assert re.search(r"action: unpost row \d+", out)
    assert "header: due differs" in out and "header: minimum_due differs (amount changes)" in out
    assert "action: update line 1 row" in out and "amount changes" in out
    assert "transaction_date 2026-02-12 -> 2026-02-13" in out
    assert "balanced: yes" in out and "dry run: nothing was written" in out
    assert "applied:" not in out
    assert "fingerprint: " + _dry(w, statement)["fingerprint"] in out
    _no_amount(out)


def test_dry_run_as_a_script_writes_nothing(w, tmp_path):
    statement = _busy(w, with_unposted=False)
    before = _snapshot(w)
    out = _cli(w, tmp_path, statement)
    assert out.returncode == 0, out.stdout + out.stderr
    assert _snapshot(w) == before
    assert out.stdout.startswith("target: host=")
    assert "mode: dry run" in out.stdout and "dry run: nothing was written" in out.stdout
    assert "action: create line 5" in out.stdout and "balanced: yes" in out.stdout
    _no_amount(out.stdout)


# --- AC2: an apply is the endpoint's apply ----------------------------------------------------

def test_apply_gives_the_endpoint_result(w):
    other = {**w, "card": _card(w, "Card S")}
    statement = _busy(w)
    _busy(other)  # the same rows on a second card
    via_endpoint = _apply(w, statement)
    outcome = _run(other, statement, apply=True)
    assert outcome.code == 0, outcome.lines
    out = "\n".join(outcome.lines)
    assert "applied: statement closing 2026-02-24 is recorded as reconciled" in out
    assert re.search(r"created: line 5 as row \d+", out)

    first, second = _state(w, w["card"]), _state(w, other["card"])
    assert first["rows"] and first == second
    assert [(a["kind"], a["line_no"]) for a in via_endpoint["actions"]] == [
        (m.group(1), int(m.group(2))) for m in re.finditer(
            r"^action: (\w+) line (\d+)", out, re.M)] + [("unpost", None)]
    assert first["recon"][0][4] == w["me"]["id"]
    assert _dry(other, statement)["header"] == []  # nothing left to do
    _no_amount(out)


def test_apply_as_a_script(w, tmp_path):
    statement = _busy(w, with_unposted=False)
    out = _cli(w, tmp_path, statement, "--apply")
    assert out.returncode == 0, out.stdout + out.stderr
    assert "mode: APPLY" in out.stdout
    assert re.search(r"created: line 5 as row \d+", out.stdout)
    assert "applied: statement closing 2026-02-24 is recorded as reconciled" in out.stdout
    _no_amount(out.stdout)
    state = _state(w, w["card"])
    assert [r[4:] for r in state["rows"]].count((True, True)) == 6  # the six line items
    assert state["recon"][0][3] == 6 and state["recon"][0][4] == w["me"]["id"]
    again = _cli(w, tmp_path, statement)  # nothing left to do
    assert again.returncode == 0 and "actions: matched 6" in again.stdout, again.stdout


# --- AC3: no amount in any output -------------------------------------------------------------

def test_refusals_carry_no_amount(w, tmp_path):
    statement = _busy(w, with_unposted=False)
    # A close that is not the card's: refused on a dry run and on an apply.
    off = {**statement, "header": {**statement["header"], "close_date": "2026-02-23"}}
    before = _snapshot(w)
    for flags in ((), ("--apply",)):
        out = _cli(w, tmp_path, off, *flags)
        assert out.returncode == 3, out.stdout + out.stderr
        assert "change the card's closing day first" in out.stdout
        assert "header: close differs (statement 2026-02-23, app 2026-02-24)" in out.stdout
        _no_amount(out.stdout)
    # A statement whose header does not add up: invalid, refused before connecting.
    bad = {**statement, "header": {**statement["header"], "previous_balance": "100.00",
                                   "payments_and_credits": "0.00"}}
    out = _cli(w, tmp_path, bad, "--apply")
    assert out.returncode == 2 and "not a valid statement" in out.stdout, out.stdout
    assert "does not add up" in out.stdout
    _no_amount(out.stdout)
    assert _snapshot(w) == before


def test_an_actor_without_the_role_is_refused(w, tmp_path):
    viewer = w["people"]()
    sw_share(w["db"], w["card"], viewer["id"], "viewer")
    statement = _busy(w, with_unposted=False)
    before = _snapshot(w)
    out = _cli(w, tmp_path, statement, "--apply", actor=viewer)
    assert out.returncode == 3 and "refused: Account not found" in out.stdout, out.stdout
    assert _cli(w, tmp_path, statement, actor={"id": 2_000_000_000}).returncode == 3
    assert _snapshot(w) == before


def test_an_earlier_installment_payment_is_refused_and_nothing_is_written(w):
    """Only an installment's latest payment can be given back (STU-761): unposting an
    earlier one is noted in the dry run and refused by the apply, nothing written."""
    entry = sw_post(w["client"], w["me"], "/budget-entries/", {
        "name": "Laptop", "entry_type": "expense", "amount": 1500, "cadence": "monthly",
        "next_occurrence": "2026-02-10T00:00:00", "account_id": w["card"],
        "end_mode": "after_occurrences", "max_occurrences": 6})["id"]
    linked = []
    for _ in range(2):  # 2026-02-24, then 2026-03-24 (on the statement after)
        r = w["client"].post(f"{API}/budget-entries/{entry}/materialize", json={},
                             headers=w["me"]["headers"])
        assert r.status_code == 201, r.text
        linked.append(r.json()["id"])
    _row(w, "2026-02-01", 100)
    _statements(w)
    statement = _statement([_line(1, "2026-02-01", "100.00")], close=CLOSE)
    before = _snapshot(w)
    outcome = _run(w, statement, apply=True)
    assert outcome.code == 3, outcome.lines
    out = "\n".join(outcome.lines)
    assert f"note: row {linked[0]}: unposting it is refused" in out
    assert f"Row {linked[0]} is a payment of installment {entry} but not its latest one" in out
    assert f"row_id: {linked[0]}" in out and "nothing was written" in out
    assert _snapshot(w) == before
    assert _txn(w, linked[0])["is_posted"] is True


def test_the_latest_installment_payment_is_given_back(w):
    """The dry run notes the payment given back, and the apply does it (STU-761)."""
    entry = sw_post(w["client"], w["me"], "/budget-entries/", {
        "name": "Laptop", "entry_type": "expense", "amount": 1500, "cadence": "monthly",
        "next_occurrence": "2026-02-10T00:00:00", "account_id": w["card"],
        "end_mode": "after_occurrences", "max_occurrences": 6})["id"]
    r = w["client"].post(f"{API}/budget-entries/{entry}/materialize", json={},
                         headers=w["me"]["headers"])
    assert r.status_code == 201, r.text
    linked = r.json()["id"]
    _row(w, "2026-02-01", 100)
    _statements(w)
    statement = _statement([_line(1, "2026-02-01", "100.00")], close=CLOSE)
    note = (f"note: row {linked}: unposted and unlinked from installment {entry}; its payment "
            "due 2026-02-24 is given back (6 left, the next due 2026-02-24)")
    dry = _run(w, statement, apply=False)
    assert dry.code == 0 and note in dry.lines, dry.lines
    outcome = _run(w, statement, apply=True)
    assert outcome.code == 0, outcome.lines
    assert outcome.lines.count(note) == 2  # the dry run's, then the apply's
    row = _txn(w, linked)
    assert (row["is_posted"], row.get("budget_entry_id")) == (False, None)


def test_a_wrong_expected_database_is_refused_before_connecting(w, tmp_path):
    out = _cli(w, tmp_path, _busy(w, with_unposted=False), db_name="other_db")
    assert out.returncode == 2 and out.stdout.splitlines()[-1].startswith("refused:"), out.stdout


# --- AC4: the doc's example passes the schema -------------------------------------------------

def test_the_docs_example_passes_the_statement_schema():
    from app.schemas.statement_reconcile import BankStatement

    body = DOC.read_text()
    blocks = re.findall(r"```json\n(.*?)\n```", body, re.S)
    assert blocks, "the doc has no json example"
    statement = BankStatement.model_validate_json(blocks[0])
    assert {line.kind for line in statement.lines} == {"charge", "credit", "payment"}
    assert statement.line_balance == statement.line_balance.quantize(Decimal("0.01"))

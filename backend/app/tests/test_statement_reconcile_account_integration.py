"""Reconciling a savings, checking or e-wallet statement through the API (STU-753).

``POST /accounts/{account_id}/statements/reconcile``: the dry run, the apply through
the write paths, the verify, the reconciliation, transfers and the refusals. Skips
without a database. Every figure is made up.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). The statement's period
is February 2027 (2027-02-01 .. 2027-02-28). The checking account opens at 50,000.00
and the savings account at 20,000.00, with no rows before the period unless a test
adds one.
"""
import uuid
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2027, 3, 18, 2, 0)
START, END = "2027-02-01", "2027-02-28"
OPENING = Decimal("50000.00")


# --- helpers ----------------------------------------------------------------------------------

@pytest.fixture
def w(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = sw_post(sw_client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    savings = sw_post(sw_client, me, "/accounts/", {
        "name": "Savings", "account_type": "savings", "balance": 20_000})["id"]
    return {"client": sw_client, "db": sw_db, "me": me, "account": checking,
            "checking": checking, "savings": savings, "people": sw_people}


def _row(w, day, amount, kind="debit", posted=True, account=None, description="Shop",
         **extra):
    body = {"account_id": account or w["account"], "transaction_type": kind, "amount": amount,
            "description": description, "transaction_date": f"{day}T00:00:00",
            "is_posted": posted, **extra}
    return sw_post(w["client"], w["me"], "/transactions/", body)["id"]


def _transfer(w, day, amount, fee=0, posted=True):
    return sw_post(w["client"], w["me"], "/transactions/", {
        "account_id": w["checking"], "transaction_type": "transfer", "amount": amount,
        "transfer_fee": fee, "transfer_from_account_id": w["checking"],
        "transfer_to_account_id": w["savings"], "description": "To savings",
        "transaction_date": f"{day}T00:00:00", "is_posted": posted})["id"]


def _line(no, day, amount, kind="debit", posting=None, description=None):
    out = {"line_no": no, "transaction_date": day, "amount": str(amount), "kind": kind,
           "description": description or f"Line {no}"}
    if posting is not None:
        out["posting_date"] = posting
    return out


def _statement(lines, opening=OPENING, start=START, end=END, closing=None):
    change = sum((Decimal(x["amount"]) * (1 if x["kind"] == "credit" else -1)
                  for x in lines), Decimal("0"))
    header = {"period_start": start, "period_end": end,
              "closing_balance": str(closing if closing is not None else opening + change)}
    if opening is not None:
        header["opening_balance"] = str(opening)
    return {"header": header, "lines": lines}


def _post(w, statement, dry_run, fingerprint=None, who=None, key=None, account=None):
    headers = dict((who or w["me"])["headers"])
    if key is not None:
        headers["Idempotency-Key"] = key
    body = {"statement": statement, "dry_run": dry_run}
    if fingerprint is not None:
        body["fingerprint"] = fingerprint
    return w["client"].post(
        f"{API}/accounts/{account or w['account']}/statements/reconcile", json=body,
        headers=headers)


def _dry(w, statement, **kw):
    r = _post(w, statement, True, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def _apply(w, statement, expect=200, **kw):
    fingerprint = _dry(w, statement, **{k: v for k, v in kw.items() if k == "account"})[
        "fingerprint"]
    r = _post(w, statement, False, fingerprint, **kw)
    assert r.status_code == expect, r.text
    return r.json()


def _kinds(body):
    return [(a["kind"], a["line_no"]) for a in body["actions"]]


def _txn(w, txn_id):
    r = w["client"].get(f"{API}/transactions/{txn_id}", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _balance(w, account=None):
    r = w["client"].get(f"{API}/accounts/{account or w['account']}",
                        headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _history_at_end(w, account=None):
    """``balance_after`` of the last row dated in the period, from the balance history
    the app shows, on top of the account's balance before its first row."""
    account = account or w["account"]
    r = w["client"].get(f"{API}/accounts/{account}/balance", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    start = Decimal(str(body["current_balance"])) - Decimal(str(body["calculated_balance"]))
    inside = [h for h in body["balance_history"] if h["date"][:10] <= END]
    return start + (Decimal(str(inside[-1]["balance_after"])) if inside else Decimal("0"))


SNAPSHOT_SQL = {
    "transactions": "SELECT * FROM transactions WHERE account_id IN (:a, :b) "
                    "OR transfer_to_account_id IN (:a, :b) "
                    "OR transfer_from_account_id IN (:a, :b) ORDER BY id",
    "accounts": "SELECT * FROM accounts WHERE user_id = :user ORDER BY id",
    "allocations": "SELECT * FROM allocations WHERE user_id = :user ORDER BY id",
    "budget_entries": "SELECT * FROM budget_entries WHERE user_id = :user ORDER BY id",
    "reconciliations": "SELECT * FROM account_statement_reconciliations "
                       "WHERE account_id IN (:a, :b) ORDER BY id",
    "idempotency_keys": "SELECT user_id, key FROM idempotency_keys WHERE user_id = :user",
}


def _snapshot(w):
    db = w["db"]
    db.rollback()
    params = {"a": w["checking"], "b": w["savings"], "user": w["me"]["id"]}
    out = {name: [tuple(r) for r in db.execute(text(sql), params)]
           for name, sql in SNAPSHOT_SQL.items()}
    db.rollback()
    return out


def _reconciliations(w, account=None):
    db = w["db"]
    db.rollback()
    rows = db.execute(text(
        "SELECT period_start, period_end, opening_balance, closing_balance, change, line_count,"
        " reconciled_by_actor FROM account_statement_reconciliations WHERE account_id = :a"),
        {"a": account or w["account"]}).all()
    db.rollback()
    return [tuple(r) for r in rows]


@pytest.fixture
def busy(w):
    """One row for every action kind."""
    rows = {
        "amount": _row(w, "2027-02-10", 1000),                     # update amount
        "dates": _row(w, "2027-02-12", 500),                       # update dates
        "unposted": _row(w, "2027-02-15", 300, posted=False),      # move from unposted
        "neighbour": _row(w, "2027-01-30", 400),                   # move from January
        "stray": _row(w, "2027-02-08", 700),                       # unpost
        "same": _row(w, "2027-02-03", 90, kind="credit"),          # matched
    }
    statement = _statement([
        _line(1, "2027-02-10", "1200.00"),
        _line(2, "2027-02-13", "500.00", posting="2027-02-14"),
        _line(3, "2027-02-15", "300.00"),
        _line(4, "2027-02-01", "400.00"),
        _line(5, "2027-02-05", "250.00", kind="credit", description="Interest"),
        _line(6, "2027-02-03", "90.00", kind="credit"),
    ])
    return {**w, "rows": rows, "statement": statement}


# --- a dry run writes nothing -----------------------------------------------------------------

def test_dry_run_writes_nothing(busy):
    w = busy
    before = _snapshot(w)
    body = _dry(w, w["statement"])
    assert _snapshot(w) == before
    assert body["dry_run"] is True and body["balanced"] is True and body["header"] == []
    assert body["reconciliation"] is None and len(body["fingerprint"]) == 64
    by_line = {a["line_no"]: a for a in body["actions"] if a["line_no"] is not None}
    assert [by_line[n]["kind"] for n in range(1, 7)] == [
        "update", "update", "move", "move", "create", "matched"]
    assert by_line[5]["new_row"]["kind"] == "credit"
    (unpost,) = [a for a in body["actions"] if a["kind"] == "unpost"]
    assert unpost["row_id"] == w["rows"]["stray"]
    assert _dry(w, w["statement"])["fingerprint"] == body["fingerprint"]


# --- AC1: one integration test per action kind ------------------------------------------------

def test_matched(w):
    txn = _row(w, "2027-02-03", 90, kind="credit")
    body = _apply(w, _statement([_line(1, "2027-02-03", "90.00", kind="credit")]))
    assert _kinds(body) == [("matched", 1)]
    assert _txn(w, txn)["is_reconciled"] is True
    assert _balance(w) == Decimal("50090") == _history_at_end(w)


def test_update_amount(w):
    txn = _row(w, "2027-02-10", 1000)
    body = _apply(w, _statement([_line(1, "2027-02-10", "1200.00")]))
    assert _kinds(body) == [("update", 1)]
    row = _txn(w, txn)
    assert (row["amount"], row["is_posted"], row["is_reconciled"]) == (1200.0, True, True)
    assert _balance(w) == Decimal("48800") == _history_at_end(w)


def test_update_dates(w):
    txn = _row(w, "2027-02-12", 500)
    body = _apply(w, _statement([_line(1, "2027-02-13", "500.00", posting="2027-02-14")]))
    assert _kinds(body) == [("update", 1)]
    row = _txn(w, txn)
    assert row["transaction_date"].startswith("2027-02-13")
    assert row["posting_date"].startswith("2027-02-14")
    assert row["amount"] == 500.0 and row["is_reconciled"] is True
    assert _balance(w) == Decimal("49500")


def test_move_from_unposted(w):
    txn = _row(w, "2027-02-15", 300, posted=False)
    assert _balance(w) == OPENING
    body = _apply(w, _statement([_line(1, "2027-02-15", "300.00")]))
    assert _kinds(body) == [("move", 1)]
    row = _txn(w, txn)
    assert (row["is_posted"], row["amount"], row["is_reconciled"]) == (True, 300.0, True)
    assert _balance(w) == Decimal("49700") == _history_at_end(w)


def test_move_from_the_previous_period(w):
    txn = _row(w, "2027-01-30", 400)
    # The bank opens February at 50,000: the row it lists on 1 February is not January's.
    body = _apply(w, _statement([_line(1, "2027-02-01", "400.00")]))
    assert _kinds(body) == [("move", 1)]
    row = _txn(w, txn)
    assert row["transaction_date"].startswith("2027-02-01") and row["is_reconciled"] is True
    assert _balance(w) == Decimal("49600") == _history_at_end(w)


def test_create(w):
    _row(w, "2027-02-01", 100)
    body = _apply(w, _statement([
        _line(1, "2027-02-01", "100.00"),
        _line(2, "2027-02-05", "250.00", kind="credit", description="Interest")]))
    assert _kinds(body) == [("matched", 1), ("create", 2)]
    (create,) = [a for a in body["actions"] if a["kind"] == "create"]
    row = _txn(w, create["created_row_id"])
    assert (row["amount"], row["transaction_type"], row["is_posted"], row["category_id"],
            row["account_id"]) == (250.0, "credit", True, None, w["account"])
    assert row["transaction_date"].startswith("2027-02-05")
    assert row["description"] == "Interest" and row["is_reconciled"] is True
    assert _balance(w) == Decimal("50150") == _history_at_end(w)


def test_unpost(w):
    kept = _row(w, "2027-02-01", 100)
    stray = _row(w, "2027-02-08", 700)
    assert _balance(w) == Decimal("49200")
    body = _apply(w, _statement([_line(1, "2027-02-01", "100.00")]))
    assert _kinds(body) == [("matched", 1), ("unpost", None)]
    row = _txn(w, stray)
    assert (row["is_posted"], row["is_reconciled"]) == (False, False)
    assert _txn(w, kept)["is_reconciled"] is True
    assert _balance(w) == Decimal("49900") == _history_at_end(w)


def test_apply_reconciles_the_statement(busy):
    w = busy
    body = _apply(w, w["statement"])
    assert body["dry_run"] is False and body["notes"] == []
    rec = body["reconciliation"]
    assert (rec["period_start"], rec["period_end"]) == (START, END)
    assert Decimal(rec["opening_balance"]) == OPENING
    assert Decimal(rec["closing_balance"]) == Decimal("47940.00")
    assert Decimal(rec["change"]) == Decimal("-2060.00") and rec["line_count"] == 6
    assert rec["reconciled_by_actor"] == w["me"]["id"]
    assert _balance(w) == Decimal("47940") == _history_at_end(w)
    assert _reconciliations(w) == [(
        datetime(2027, 2, 1).date(), datetime(2027, 2, 28).date(), OPENING,
        Decimal("47940.00"), Decimal("-2060.00"), 6, w["me"]["id"])]
    for key in ("amount", "dates", "unposted", "neighbour", "same"):
        assert _txn(w, w["rows"][key])["is_reconciled"] is True
    assert _txn(w, w["rows"]["stray"])["is_reconciled"] is False
    # A second dry run finds nothing left to do; the record is replaced, not repeated.
    again = _dry(w, w["statement"])
    assert {a["kind"] for a in again["actions"]} == {"matched"}
    _apply(w, w["statement"])
    assert len(_reconciliations(w)) == 1


def test_a_statement_without_an_opening_balance(w):
    _row(w, "2027-02-01", 100)
    body = _apply(w, _statement([_line(1, "2027-02-01", "100.00")], opening=None,
                                closing=Decimal("49900.00")))
    assert body["reconciliation"]["opening_balance"] is None
    assert Decimal(body["reconciliation"]["change"]) == Decimal("-100.00")


# --- AC2: transfers ---------------------------------------------------------------------------

def test_a_transfer_is_matched_on_both_statements_and_never_created(w):
    transfer = _transfer(w, "2027-02-10", 5000, fee=15)
    _row(w, "2027-02-20", 30000, kind="credit", account=w["checking"], description="Salary")
    before = _snapshot(w)["transactions"]
    # The source bank prints the day after; the transfer keeps its own date.
    checking = _statement([
        _line(1, "2027-02-11", "5015.00", description="Transfer to savings"),
        _line(2, "2027-02-20", "30000.00", kind="credit")])
    savings = _statement([_line(1, "2027-02-10", "5000.00", kind="credit")],
                         opening=Decimal("20000.00"))
    body = _apply(w, checking, account=w["checking"])
    assert _kinds(body) == [("matched", 1), ("matched", 2)]
    body = _apply(w, savings, account=w["savings"])
    assert _kinds(body) == [("matched", 1)]
    after = _snapshot(w)["transactions"]
    assert len(after) == len(before)
    row = _txn(w, transfer)
    assert row["transaction_date"].startswith("2027-02-10") and row["is_reconciled"] is True
    assert _balance(w, w["checking"]) == Decimal("74985")
    assert _balance(w, w["savings"]) == Decimal("25000")
    assert len(_reconciliations(w, w["checking"])) == len(_reconciliations(w, w["savings"])) == 1
    # Reconciling either again changes nothing.
    for account, statement in ((w["checking"], checking), (w["savings"], savings)):
        again = _dry(w, statement, account=account)
        assert {a["kind"] for a in again["actions"]} == {"matched"}


def test_a_transfer_and_its_fee_printed_apart_are_matched_to_the_one_row(w):
    """STU-774: the bank prints the transfer and its fee as two lines; both are matched
    to the one transfer and nothing is written to it."""
    transfer = _transfer(w, "2027-02-10", 5000, fee=15)
    statement = _statement([
        _line(1, "2027-02-10", "5000.00", description="Transfer to savings"),
        _line(2, "2027-02-11", "15.00", description="Transfer fee")])
    dry = _dry(w, statement, account=w["checking"])
    assert dry["balanced"] is True
    assert [(a["kind"], a["line_no"], a["row_id"]) for a in dry["actions"]] == [
        ("matched", 1, transfer), ("matched", 2, transfer)]
    before = _snapshot(w)
    row = _txn(w, transfer)
    body = _apply(w, statement, account=w["checking"])
    assert _kinds(body) == [("matched", 1), ("matched", 2)]
    after = _txn(w, transfer)
    assert after["is_reconciled"] is True
    marking = ("is_reconciled", "updated_at")  # the reconciled marking, nothing else
    assert {k: v for k, v in after.items() if k not in marking} == {
        k: v for k, v in row.items() if k not in marking}
    assert len(_snapshot(w)["transactions"]) == len(before["transactions"])
    assert _balance(w, w["checking"]) == Decimal("44985") == _history_at_end(w, w["checking"])
    assert _reconciliations(w, w["checking"])[0][3:6] == (
        Decimal("44985.00"), Decimal("-5015.00"), 2)


def test_an_ambiguous_fee_line_is_not_paired_and_is_refused_as_before(w):
    """Two lines could be the fee: the transfer falls to the usual rules, which would
    change it, so the apply is refused as any change to a transfer is."""
    transfer = _transfer(w, "2027-02-10", 5000, fee=15)
    charge = _row(w, "2027-02-10", 15, account=w["checking"], description="Bank charge")
    statement = _statement([
        _line(1, "2027-02-10", "5000.00"), _line(2, "2027-02-10", "15.00"),
        _line(3, "2027-02-11", "15.00")])
    dry = _dry(w, statement, account=w["checking"])
    assert [(a["kind"], a["line_no"], a["row_id"]) for a in dry["actions"]] == [
        ("create", 1, None), ("matched", 2, charge), ("create", 3, None),
        ("unpost", None, transfer)]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"], account=w["checking"])
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"].startswith(f"Row {transfer} is a transfer")
    assert _snapshot(w) == before


# --- STU-774: a transfer the other account has reconciled is never changed --------------------

def _reconcile_savings_february(w, transfer_line=True):
    lines = [_line(1, "2027-02-10", "5000.00", kind="credit")] if transfer_line else []
    _apply(w, _statement(lines, opening=Decimal("20000.00")), account=w["savings"])


def _refused_as_reconciled(w, statement, transfer, other, period, account=None):
    account = account or w["checking"]
    dry = _dry(w, statement, account=account)
    before = _snapshot(w)
    balances = (_balance(w, w["checking"]), _balance(w, w["savings"]))
    r = _post(w, statement, False, dry["fingerprint"], account=account)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["message"] == (
        f"Row {transfer} is a transfer with account {other}, whose statement {period} is "
        "reconciled: changing it here would change that statement")
    assert (detail["row_id"], detail["account_id"]) == (transfer, other)
    assert _snapshot(w) == before
    assert (_balance(w, w["checking"]), _balance(w, w["savings"])) == balances
    return dry


def test_an_update_of_a_transfer_the_other_account_reconciled_is_refused(w):
    transfer = _transfer(w, "2027-02-10", 5000)
    _reconcile_savings_february(w)
    dry = _refused_as_reconciled(w, _statement([_line(1, "2027-02-10", "4990.00")]), transfer,
                                 w["savings"], "for 2027-02-01 to 2027-02-28")
    assert _kinds(dry) == [("update", 1)]


def test_an_unpost_of_a_transfer_the_other_account_reconciled_is_refused(w):
    transfer = _transfer(w, "2027-02-10", 5000)
    _reconcile_savings_february(w)
    dry = _refused_as_reconciled(w, _statement([]), transfer, w["savings"],
                                 "for 2027-02-01 to 2027-02-28")
    assert _kinds(dry) == [("unpost", None)]


def test_a_cash_advance_on_a_reconciled_card_statement_is_refused(w):
    card = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 24,
        "days_until_due_date": 21, "payment_account_id": w["checking"]})["id"]
    advance = sw_post(w["client"], w["me"], "/transactions/", {
        "account_id": card, "transaction_type": "transfer", "amount": 3000,
        "transfer_fee": 100, "transfer_from_account_id": card,
        "transfer_to_account_id": w["checking"], "description": "Cash advance",
        "transaction_date": "2027-02-05T00:00:00", "is_posted": True})["id"]
    db = w["db"]
    db.rollback()
    db.execute(text(
        "INSERT INTO statement_reconciliations (card_id, statement_close, total_due,"
        " line_balance, line_count, reconciled_by_actor)"
        " VALUES (:c, '2027-02-24', 3100, 3100, 1, :u)"), {"c": card, "u": w["me"]["id"]})
    db.commit()
    dry = _refused_as_reconciled(
        w, _statement([_line(1, "2027-02-05", "2990.00", kind="credit")]), advance, card,
        "closing 2027-02-24")
    assert _kinds(dry) == [("update", 1)]


def test_a_change_to_a_transfer_is_refused(w):
    transfer = _transfer(w, "2027-02-10", 5000)
    statement = _statement([_line(1, "2027-02-10", "4990.00", kind="credit")],
                           opening=Decimal("20000.00"))
    dry = _dry(w, statement, account=w["savings"])
    assert _kinds(dry) == [("update", 1)]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"], account=w["savings"])
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["message"].startswith(
        f"Row {transfer} is a transfer between accounts {w['checking']} and {w['savings']}")
    assert _snapshot(w) == before


def test_unposting_a_transfer_is_refused(w):
    transfer = _transfer(w, "2027-02-10", 5000)
    statement = _statement([])
    dry = _dry(w, statement, account=w["checking"])
    assert _kinds(dry) == [("unpost", None)]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"], account=w["checking"])
    assert r.status_code == 409, r.text
    assert f"Row {transfer} is a transfer" in r.json()["detail"]["message"]
    assert _snapshot(w) == before


def test_a_line_that_may_be_a_transfer_off_the_period_is_not_created(w):
    transfer = _transfer(w, "2027-03-01", 5000)
    statement = _statement([_line(1, "2027-02-28", "5000.00")])
    dry = _dry(w, statement, account=w["checking"])
    (create,) = dry["actions"]
    assert (create["kind"], create["possible_duplicate_of"]) == ("create", transfer)
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"], account=w["checking"])
    assert r.status_code == 409, r.text
    assert f"may be transfer row {transfer}" in r.json()["detail"]["message"]
    assert _snapshot(w) == before


# --- AC3: a failed verify rolls everything back -----------------------------------------------

def test_failed_verify_rolls_back_and_returns_the_gap(busy, monkeypatch):
    from app.services import statement_reconcile as sr

    w = busy
    fingerprint = _dry(w, w["statement"])["fingerprint"]
    before = _snapshot(w)
    real = sr.diff_account_statement

    def wrong(*args, **kwargs):
        # The update of line 1 writes one peso too much; the diff still says balanced.
        found = real(*args, **kwargs)
        actions = tuple(
            sr.Action(a.kind, a.line_no, a.row_id, tuple(
                sr.FieldChange(c.field, c.before, c.after + 1)
                if c.field == "amount" else c for c in a.changes), a.new_row,
                a.possible_duplicate_of) if a.line_no == 1 else a
            for a in found.actions)
        return sr.StatementDiff(found.fingerprint, found.header, actions, found.warnings,
                                found.balanced)

    monkeypatch.setattr(sr, "diff_account_statement", wrong)
    r = _post(w, w["statement"], False, fingerprint)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert Decimal(detail["gap"]) == Decimal("-1.00")
    assert Decimal(detail["app_change"]) == Decimal("-2061.00")
    assert _snapshot(w) == before


def test_a_closing_balance_the_app_does_not_reach_rolls_back_and_returns_the_gap(w):
    """The rows in the period match the bank's, but the app's balance before the
    period (its opening) is 1,000.00 off the bank's: the closing balance check fails."""
    _row(w, "2027-02-10", 1000)
    statement = _statement([_line(1, "2027-02-10", "1200.00")], opening=Decimal("49000.00"))
    dry = _dry(w, statement)
    assert dry["balanced"] is True and _kinds(dry) == [("update", 1)]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "closing balance" in detail["message"]
    assert Decimal(detail["app_closing_balance"]) == Decimal("48800.00")
    assert Decimal(detail["statement_closing_balance"]) == Decimal("47800.00")
    assert Decimal(detail["gap"]) == Decimal("1000.00")
    assert _snapshot(w) == before


# --- stale fingerprint, unbalanced, replay ----------------------------------------------------

def test_stale_fingerprint_is_refused(busy):
    w = busy
    fingerprint = _dry(w, w["statement"])["fingerprint"]
    r = w["client"].put(f"{API}/transactions/{w['rows']['same']}", json={"description": "x"},
                        headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    before = _snapshot(w)
    r = _post(w, w["statement"], False, fingerprint)
    assert r.status_code == 409, r.text
    assert "dry run" in r.json()["detail"]["message"]
    assert _snapshot(w) == before


def test_unbalanced_diff_is_refused(w):
    _row(w, "2027-02-01", 100)
    # A line dated after the period: its row would land on the next one.
    statement = _statement([_line(1, "2027-02-01", "100.00"), _line(2, "2027-03-01", "50.00")])
    dry = _dry(w, statement)
    assert dry["balanced"] is False and [x["line_no"] for x in dry["warnings"]] == [2]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 409, r.text
    assert _snapshot(w) == before


def test_replay_with_the_same_key_returns_the_stored_answer(busy):
    w = busy
    key = str(uuid.uuid4())
    fingerprint = _dry(w, w["statement"])["fingerprint"]
    first = _post(w, w["statement"], False, fingerprint, key=key)
    assert first.status_code == 200, first.text
    after = _snapshot(w)
    again = _post(w, w["statement"], False, fingerprint, key=key)
    assert again.status_code == 200, again.text
    assert again.content == first.content
    assert _snapshot(w) == after
    created = [a["created_row_id"] for a in first.json()["actions"] if a["kind"] == "create"]
    assert len(created) == 1


# --- AC4: access ------------------------------------------------------------------------------

@pytest.mark.parametrize("role", ["viewer", "editor", None])
def test_only_owners_and_admins_reconcile(w, role):
    other = w["people"]()
    if role is not None:
        sw_share(w["db"], w["account"], other["id"], role)
    _row(w, "2027-02-01", 100)
    statement = _statement([_line(1, "2027-02-01", "100.00")])
    fingerprint = _dry(w, statement)["fingerprint"]
    before = _snapshot(w)
    for dry_run in (True, False):
        r = _post(w, statement, dry_run, None if dry_run else fingerprint, who=other)
        assert r.status_code == 404, (role, r.text)
        assert r.json()["detail"] == "Account not found"
    assert _snapshot(w) == before


def test_an_admin_reconciles(w):
    admin = w["people"]()
    sw_share(w["db"], w["account"], admin["id"], "admin")
    txn = _row(w, "2027-02-01", 100)
    body = _apply(w, _statement([_line(1, "2027-02-01", "120.00")]), who=admin)
    assert body["reconciliation"]["reconciled_by_actor"] == admin["id"]
    assert _txn(w, txn)["amount"] == 120.0


def test_a_card_is_sent_to_the_card_route(w):
    card = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 24,
        "days_until_due_date": 21, "payment_account_id": w["checking"]})["id"]
    r = _post(w, _statement([]), True, account=card)
    assert r.status_code == 400, r.text
    assert f"POST /cards/{card}/statements/reconcile" in r.json()["detail"]


def test_a_loan_account_is_refused(w):
    loan = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Loan", "account_type": "loan", "balance": -100_000, "loan_kind": "auto",
        "loan_annual_rate": 10, "loan_term_months": 24, "loan_payment_amount": 4_615,
        "loan_first_payment_date": "2027-01-04", "payment_account_id": w["checking"]})["id"]
    r = _post(w, _statement([]), True, account=loan)
    assert r.status_code == 400, r.text
    assert "savings, checking, e-wallet or cash" in r.json()["detail"]


def test_a_cash_account_reconciles(w):
    """STU-774: a cash account is reconciled as a savings account is: dry run, apply and
    verify, its balance and the record as the statement says."""
    cash = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Cash", "account_type": "cash", "balance": 2_000})["id"]
    kept = _row(w, "2027-02-03", 150, account=cash)
    stray = _row(w, "2027-02-10", 40, account=cash)
    statement = _statement([
        _line(1, "2027-02-03", "150.00"),
        _line(2, "2027-02-14", "500.00", kind="credit", description="Allowance")],
        opening=Decimal("2000.00"))
    dry = _dry(w, statement, account=cash)
    assert dry["balanced"] is True
    assert _kinds(dry) == [("matched", 1), ("create", 2), ("unpost", None)]
    assert _balance(w, cash) == Decimal("1810")  # the dry run wrote nothing
    body = _apply(w, statement, account=cash)
    assert _kinds(body) == [("matched", 1), ("create", 2), ("unpost", None)]
    assert Decimal(body["reconciliation"]["closing_balance"]) == Decimal("2350.00")
    assert _balance(w, cash) == Decimal("2350") == _history_at_end(w, cash)
    assert _txn(w, kept)["is_reconciled"] is True
    assert _txn(w, stray)["is_posted"] is False
    assert _reconciliations(w, cash)[0][3:6] == (Decimal("2350.00"), Decimal("350.00"), 2)


def test_an_e_wallet_reconciles(w):
    wallet = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Wallet", "account_type": "e_wallet", "balance": 1_000})["id"]
    _row(w, "2027-02-02", 100, account=wallet)
    body = _apply(w, _statement([_line(1, "2027-02-02", "100.00")],
                                opening=Decimal("1000.00")), account=wallet)
    assert _kinds(body) == [("matched", 1)]
    assert _balance(w, wallet) == Decimal("900")


def test_a_period_not_ended_is_refused(w):
    r = _post(w, _statement([], start="2027-03-01", end="2027-03-31"), True)
    assert r.status_code == 422, r.text


# --- recurring rows ---------------------------------------------------------------------------

def test_unposting_a_recurring_row_is_refused(w):
    """Unposting a row linked to a recurring entry has no write path that moves the
    entry's paid count and schedule back: refused, as on a card."""
    entry = sw_post(w["client"], w["me"], "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 1500, "cadence": "monthly",
        "next_occurrence": "2027-02-10T00:00:00", "account_id": w["account"]})["id"]
    r = w["client"].post(f"{API}/budget-entries/{entry}/materialize", json={},
                         headers=w["me"]["headers"])
    assert r.status_code == 201, r.text
    linked = r.json()["id"]
    _row(w, "2027-02-01", 100)
    statement = _statement([_line(1, "2027-02-01", "100.00")])
    dry = _dry(w, statement)
    assert ("unpost", None) in _kinds(dry)
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 409, r.text
    assert f"Row {linked} is linked to a recurring entry" in r.json()["detail"]["message"]
    assert _snapshot(w) == before


def test_a_recurring_row_keeps_its_date(w):
    entry = sw_post(w["client"], w["me"], "/budget-entries/", {
        "name": "Salary", "entry_type": "income", "amount": 30000, "cadence": "monthly",
        "next_occurrence": "2027-02-15T00:00:00", "account_id": w["account"]})["id"]
    r = w["client"].post(f"{API}/budget-entries/{entry}/materialize", json={},
                         headers=w["me"]["headers"])
    assert r.status_code == 201, r.text
    linked = r.json()["id"]
    body = _apply(w, _statement([_line(1, "2027-02-16", "30000.00", kind="credit")]))
    assert _kinds(body) == [("matched", 1)]
    assert _txn(w, linked)["transaction_date"].startswith("2027-02-15")
    assert _balance(w) == Decimal("80000")

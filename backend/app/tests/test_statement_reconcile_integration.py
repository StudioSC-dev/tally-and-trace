"""Reconciling a card statement through the API (STU-749).

``POST /cards/{account_id}/statements/reconcile``: the dry run, the apply through the
write paths, the verify, the reconciliation and the refusals. Skips without a
database. Every figure is made up.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). The card closes on the
24th: the statement reconciled closes on 2027-02-24 (window 2027-01-25 .. 2027-02-24,
its due rolled to 2027-03-17); the one before closes on 2027-01-24 and the one open
today on 2027-03-24.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2027, 3, 18, 2, 0)
CLOSE = "2027-02-24"
PREVIOUS = date(2027, 1, 24)


# --- helpers ----------------------------------------------------------------------------------

@pytest.fixture
def w(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = sw_post(sw_client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 100_000})["id"]
    card = sw_post(sw_client, me, "/accounts/", {
        "name": "Card R", "account_type": "credit", "balance": 0, "billing_cycle_start": 24,
        "days_until_due_date": 21, "payment_account_id": checking})["id"]
    return {"client": sw_client, "db": sw_db, "me": me, "card": card, "checking": checking,
            "people": sw_people}


def _row(w, day, amount, kind="debit", posted=True, posting=None, description="Shop", **extra):
    body = {"account_id": w["card"], "transaction_type": kind, "amount": amount,
            "description": description, "transaction_date": f"{day}T00:00:00",
            "is_posted": posted, **extra}
    if posting is not None:
        body["posting_date"] = f"{posting}T00:00:00"
    return sw_post(w["client"], w["me"], "/transactions/", body)["id"]


def _line(no, day, amount, kind="charge", posting=None, description=None, **extra):
    out = {"line_no": no, "transaction_date": day, "amount": str(amount), "kind": kind,
           "description": description or f"Line {no}", **extra}
    if posting is not None:
        out["posting_date"] = posting
    return out


def _statement(lines, close=CLOSE, **header):
    balance = sum((Decimal(x["amount"]) * (-1 if x["kind"] == "credit" else 1)
                   for x in lines if x["kind"] != "payment"), Decimal("0"))
    return {"header": {"close_date": close, "total_due": str(balance), **header},
            "lines": lines}


def _post(w, statement, dry_run, fingerprint=None, who=None, key=None):
    headers = dict((who or w["me"])["headers"])
    if key is not None:
        headers["Idempotency-Key"] = key
    body = {"statement": statement, "dry_run": dry_run}
    if fingerprint is not None:
        body["fingerprint"] = fingerprint
    return w["client"].post(f"{API}/cards/{w['card']}/statements/reconcile", json=body,
                            headers=headers)


def _dry(w, statement):
    r = _post(w, statement, True)
    assert r.status_code == 200, r.text
    return r.json()


def _apply(w, statement, expect=200, **kw):
    fingerprint = _dry(w, statement)["fingerprint"]
    r = _post(w, statement, False, fingerprint, **kw)
    assert r.status_code == expect, r.text
    return r.json()


def _kinds(body):
    return [(a["kind"], a["line_no"]) for a in body["actions"]]


def _statements(w):
    """The list read (it also catches the stored statements up)."""
    r = w["client"].get(f"{API}/cards/{w['card']}/statements", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return {s["close_date"]: s for s in r.json()["statements"]}


def _detail(w, close=CLOSE):
    r = w["client"].get(f"{API}/cards/{w['card']}/statements/{close}",
                        headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _txn(w, txn_id):
    r = w["client"].get(f"{API}/transactions/{txn_id}", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _balance(w, account=None):
    r = w["client"].get(f"{API}/accounts/{account or w['card']}", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return Decimal(str(r.json()["balance"]))


def _stored(w, close):
    """The stored statement's ``(line_balance, line_count)``, or None."""
    db = w["db"]
    db.rollback()
    row = db.execute(text("SELECT line_balance, line_count FROM card_statements "
                          "WHERE card_id = :c AND close = :d"),
                     {"c": w["card"], "d": close}).first()
    return (Decimal(row[0]), row[1]) if row is not None else None


def _verify_store(w):
    from app.core.access import viewable_account_ids
    from app.models.account import Account
    from app.models.user import User
    from app.services import statements_store

    db = w["db"]
    db.rollback()
    card = db.get(Account, w["card"])
    got = statements_store.verify_card(
        db, card, viewable_account_ids(db, db.get(User, w["me"]["id"])), REF.date())
    db.rollback()
    assert got["rows_equal"] and got["summaries_equal"], got


SNAPSHOT_SQL = {
    "transactions": "SELECT * FROM transactions WHERE account_id = :card "
                    "OR transfer_to_account_id = :card OR transfer_from_account_id = :card "
                    "ORDER BY id",
    "accounts": "SELECT * FROM accounts WHERE user_id = :user ORDER BY id",
    "allocations": "SELECT * FROM allocations WHERE user_id = :user ORDER BY id",
    "budget_entries": "SELECT * FROM budget_entries WHERE user_id = :user ORDER BY id",
    "card_statements": "SELECT * FROM card_statements WHERE card_id = :card ORDER BY close",
    "card_statement_state": "SELECT * FROM card_statement_state WHERE card_id = :card",
    "due_overrides": "SELECT * FROM card_statement_due_overrides WHERE account_id = :card",
    "minimums": "SELECT * FROM card_statement_minimums WHERE account_id = :card",
    "reconciliations": "SELECT * FROM statement_reconciliations WHERE card_id = :card",
    "idempotency_keys": "SELECT user_id, key FROM idempotency_keys WHERE user_id = :user",
}


def _snapshot(w):
    db = w["db"]
    db.rollback()
    out = {name: [tuple(r) for r in db.execute(text(sql), {"card": w["card"],
                                                           "user": w["me"]["id"]})]
           for name, sql in SNAPSHOT_SQL.items()}
    db.rollback()
    return out


@pytest.fixture
def busy(w):
    """One row for every action kind, the stored statements caught up."""
    rows = {
        "amount": _row(w, "2027-02-10", 1000),                       # update amount
        "dates": _row(w, "2027-02-12", 500),                         # update dates
        "unposted": _row(w, "2027-02-15", 300, posted=False),        # move from unposted
        "neighbour": _row(w, "2027-01-20", 400),                     # move from Jan 24
        "stray": _row(w, "2027-02-08", 700),                         # unpost
        "same": _row(w, "2027-02-03", 90, kind="credit"),            # matched
    }
    _statements(w)
    statement = _statement([
        _line(1, "2027-02-10", "1200.00"),
        _line(2, "2027-02-13", "500.00", posting="2027-02-14"),
        _line(3, "2027-02-15", "300.00"),
        _line(4, "2027-01-26", "400.00"),
        _line(5, "2027-02-05", "250.00", description="New shop"),
        _line(6, "2027-02-03", "90.00", kind="credit"),
    ], due_date="2027-03-16", minimum_due="850.00")
    return {**w, "rows": rows, "statement": statement}


# --- AC1: a dry run writes nothing ------------------------------------------------------------

def test_dry_run_writes_nothing(busy):
    w = busy
    before = _snapshot(w)
    body = _dry(w, w["statement"])
    assert _snapshot(w) == before
    assert body["dry_run"] is True and body["balanced"] is True
    assert body["reconciliation"] is None and len(body["fingerprint"]) == 64
    assert {h["field"] for h in body["header"]} == {"due", "minimum_due"}
    by_line = {a["line_no"]: a for a in body["actions"] if a["line_no"] is not None}
    assert [by_line[n]["kind"] for n in range(1, 7)] == [
        "update", "update", "move", "move", "create", "matched"]
    (unpost,) = [a for a in body["actions"] if a["kind"] == "unpost"]
    assert unpost["row_id"] == w["rows"]["stray"]
    # The same request again gives the same fingerprint.
    assert _dry(w, w["statement"])["fingerprint"] == body["fingerprint"]


# --- AC2: one integration test per action kind ------------------------------------------------

def test_update_amount(w):
    txn = _row(w, "2027-02-10", 1000)
    _statements(w)
    assert _stored(w, date(2027, 2, 24)) == (Decimal("1000"), 1)
    body = _apply(w, _statement([_line(1, "2027-02-10", "1200.00")]))
    assert _kinds(body) == [("update", 1)]
    row = _txn(w, txn)
    assert (row["amount"], row["is_posted"], row["is_reconciled"]) == (1200.0, True, True)
    assert _balance(w) == Decimal("-1200")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("1200"), 1)
    _verify_store(w)


def test_update_dates(w):
    txn = _row(w, "2027-02-12", 500)
    _statements(w)
    body = _apply(w, _statement([_line(1, "2027-02-13", "500.00", posting="2027-02-14")]))
    assert _kinds(body) == [("update", 1)]
    row = _txn(w, txn)
    assert row["transaction_date"].startswith("2027-02-13")
    assert row["posting_date"].startswith("2027-02-14")
    assert row["amount"] == 500.0 and row["is_reconciled"] is True
    assert _balance(w) == Decimal("-500")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("500"), 1)
    _verify_store(w)


def test_move_from_unposted(w):
    txn = _row(w, "2027-02-15", 300, posted=False)
    _statements(w)
    assert _balance(w) == 0
    body = _apply(w, _statement([_line(1, "2027-02-15", "300.00")]))
    assert _kinds(body) == [("move", 1)]
    row = _txn(w, txn)
    assert (row["is_posted"], row["amount"], row["is_reconciled"]) == (True, 300.0, True)
    assert _balance(w) == Decimal("-300")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("300"), 1)
    _verify_store(w)


def test_move_from_a_neighbouring_statement(w):
    txn = _row(w, "2027-01-20", 400)
    _statements(w)
    assert _stored(w, PREVIOUS) == (Decimal("400"), 1)
    body = _apply(w, _statement([_line(1, "2027-01-26", "400.00")]))
    assert _kinds(body) == [("move", 1)]
    row = _txn(w, txn)
    assert row["transaction_date"].startswith("2027-01-26") and row["is_reconciled"] is True
    assert _balance(w) == Decimal("-400")
    assert _stored(w, PREVIOUS) in ((Decimal("0"), 0), None)
    assert _stored(w, date(2027, 2, 24)) == (Decimal("400"), 1)
    _verify_store(w)


def test_create(w):
    _row(w, "2027-02-01", 100)
    _statements(w)
    body = _apply(w, _statement([
        _line(1, "2027-02-01", "100.00"),
        _line(2, "2027-02-05", "250.00", posting="2027-02-06", description="New shop",
              original_amount="4.30", original_currency="USD")]))
    assert _kinds(body) == [("matched", 1), ("create", 2)]
    (create,) = [a for a in body["actions"] if a["kind"] == "create"]
    row = _txn(w, create["created_row_id"])
    assert (row["amount"], row["is_posted"], row["category_id"], row["currency"]) == (
        250.0, True, None, "PHP")
    assert (row["original_amount"], row["original_currency"]) == (4.3, "USD")
    assert row["transaction_date"].startswith("2027-02-05")
    assert row["posting_date"].startswith("2027-02-06")
    assert row["description"] == "New shop" and row["is_reconciled"] is True
    w["db"].rollback()
    actor = w["db"].execute(text("SELECT created_by_actor, user_id FROM transactions "
                                 "WHERE id = :i"), {"i": create["created_row_id"]}).first()
    assert tuple(actor) == (w["me"]["id"], w["me"]["id"])
    assert _balance(w) == Decimal("-350")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("350"), 2)
    _verify_store(w)


def test_unpost(w):
    kept = _row(w, "2027-02-01", 100)
    stray = _row(w, "2027-02-08", 700)
    _statements(w)
    assert _balance(w) == Decimal("-800")
    body = _apply(w, _statement([_line(1, "2027-02-01", "100.00")]))
    assert _kinds(body) == [("matched", 1), ("unpost", None)]
    row = _txn(w, stray)
    assert (row["is_posted"], row["is_reconciled"]) == (False, False)
    assert _txn(w, kept)["is_reconciled"] is True
    assert _balance(w) == Decimal("-100")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("100"), 1)
    _verify_store(w)


# --- AC3: after an apply the statement equals the bank's and is reconciled --------------------

def test_apply_reconciles_the_statement(busy):
    w = busy
    statement = w["statement"]
    body = _apply(w, statement)
    assert body["dry_run"] is False and body["notes"] == []
    rec = body["reconciliation"]
    assert rec["close_date"] == CLOSE and Decimal(rec["line_balance"]) == Decimal("2560.00")
    assert Decimal(rec["total_due"]) == Decimal("2560.00") and rec["line_count"] == 6
    assert rec["reconciled_by_actor"] == w["me"]["id"]

    listed = _statements(w)[CLOSE]
    assert listed["balance"] == 2560.0 and listed["line_count"] == 6
    assert listed["reconciled"] is True and listed["reconciled_at"]
    others = [s for close, s in _statements(w).items() if close != CLOSE]
    # The routes drop null fields: an unreconciled statement has no ``reconciled_at``.
    assert others and all(s["reconciled"] is False and "reconciled_at" not in s
                          for s in others)
    detail = _detail(w)
    assert detail["statement"]["reconciled"] is True
    assert detail["statement"]["reconciled_at"] == listed["reconciled_at"]
    assert sum(Decimal(str(line["amount"])) for line in detail["lines"]) == Decimal("2560")
    for line in detail["lines"]:
        assert _txn(w, line["transaction_id"])["is_reconciled"] is True

    w["db"].rollback()
    stored = w["db"].execute(text(
        "SELECT total_due, line_balance, line_count, reconciled_by_actor "
        "FROM statement_reconciliations WHERE card_id = :c"), {"c": w["card"]}).all()
    assert [tuple(r) for r in stored] == [
        (Decimal("2560.00"), Decimal("2560.00"), 6, w["me"]["id"])]
    _verify_store(w)

    # A second dry run finds nothing left to do.
    again = _dry(w, statement)
    assert again["header"] == []
    assert {a["kind"] for a in again["actions"]} == {"matched"}


# --- AC4 / AC9: a failed verify rolls everything back -----------------------------------------

def test_failed_verify_rolls_back_and_returns_the_gap(busy, monkeypatch):
    from app.services import statement_reconcile as sr

    w = busy
    fingerprint = _dry(w, w["statement"])["fingerprint"]
    before = _snapshot(w)
    real = sr.diff_statement

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

    monkeypatch.setattr(sr, "diff_statement", wrong)
    r = _post(w, w["statement"], False, fingerprint)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert Decimal(detail["gap"]) == Decimal("1.00")
    assert Decimal(detail["app_line_balance"]) == Decimal("2561.00")
    assert _snapshot(w) == before


# --- AC5: stale fingerprint, unbalanced, replay -----------------------------------------------

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
    _statements(w)
    # A line dated after the close: its row would land on the next statement.
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


# --- AC6: access ------------------------------------------------------------------------------

@pytest.mark.parametrize("role", ["viewer", "editor", None])
def test_only_owners_and_admins_reconcile(w, role):
    other = w["people"]()
    if role is not None:
        sw_share(w["db"], w["card"], other["id"], role)
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
    sw_share(w["db"], w["card"], admin["id"], "admin")
    txn = _row(w, "2027-02-01", 100)
    body = _apply(w, _statement([_line(1, "2027-02-01", "120.00")]), who=admin)
    assert body["reconciliation"]["reconciled_by_actor"] == admin["id"]
    assert _txn(w, txn)["amount"] == 120.0


# --- AC7: a row linked to a recurring entry (STU-761) -----------------------------------------

def _entry_post(w, **body):
    return sw_post(w["client"], w["me"], "/budget-entries/", {
        "name": "Laptop", "entry_type": "expense", "amount": 1500, "cadence": "monthly",
        "account_id": w["card"], **body})["id"]


def _installment(w, next_occurrence, count, **extra):
    """A card installment: its occurrences fall on the card's close (the 24th)."""
    return _entry_post(w, next_occurrence=f"{next_occurrence}T00:00:00",
                       end_mode="after_occurrences", max_occurrences=count, **extra)


def _pay(w, entry):
    """Mark paid: the entry's next occurrence recorded as a posted row."""
    r = w["client"].post(f"{API}/budget-entries/{entry}/materialize", json={},
                         headers=w["me"]["headers"])
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _entry(w, entry):
    """The entry's stored ``(max_occurrences, next_occurrence day, is_active,
    auto_post_enabled, installment_reviewed_at)``."""
    db = w["db"]
    db.rollback()
    row = db.execute(text(
        "SELECT max_occurrences, next_occurrence, is_active, auto_post_enabled, "
        "installment_reviewed_at FROM budget_entries WHERE id = :e"), {"e": entry}).first()
    db.rollback()
    return (row[0], row[1].date(), row[2], row[3], row[4])


def _paid(w, entry):
    """The paid count the app shows (``forecast.occurrences_paid``)."""
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import occurrences_paid

    db = w["db"]
    db.rollback()
    paid = occurrences_paid(db, [db.get(BudgetEntry, entry)])[entry]
    db.rollback()
    return paid


def _link(w, txn):
    db = w["db"]
    db.rollback()
    row = db.execute(text("SELECT is_posted, budget_entry_id, occurrence_date "
                          "FROM transactions WHERE id = :i"), {"i": txn}).first()
    db.rollback()
    return tuple(row)


def _auto_post_on(w, entry):
    db = w["db"]
    db.rollback()
    db.execute(text("UPDATE budget_entries SET auto_post_enabled = true, "
                    "installment_reviewed_at = now() WHERE id = :e"), {"e": entry})
    db.commit()


def test_unposting_the_latest_installment_payment_gives_it_back(w):
    """AC1: the latest recorded payment of a capped installment, unposted by the
    statement, is unlinked and given back: one more payment left, the schedule due
    on that occurrence again, auto-post off."""
    from app.models.budget_entry import BudgetEntry
    from app.services import posting

    entry = _installment(w, "2027-02-10", 6)
    paid_row = _pay(w, entry)
    _auto_post_on(w, entry)
    kept = _row(w, "2027-02-01", 100)
    _statements(w)
    assert _entry(w, entry)[:4] == (5, date(2027, 3, 24), True, True)
    assert _entry(w, entry)[4] is not None
    assert _paid(w, entry) == 1

    statement = _statement([_line(1, "2027-02-01", "100.00")])
    before = _snapshot(w)
    dry = _dry(w, statement)
    assert _snapshot(w) == before
    assert ("unpost", None) in _kinds(dry)
    assert dry["notes"] == [
        f"row {paid_row}: unposted and unlinked from installment {entry}; its payment due "
        "2027-02-24 is given back (6 left, the next due 2027-02-24); auto-post is turned off"]

    body = _apply(w, statement)
    assert body["notes"] == dry["notes"]
    assert _link(w, paid_row) == (False, None, None)
    assert _txn(w, paid_row)["is_reconciled"] is False
    assert _txn(w, kept)["is_reconciled"] is True
    assert _entry(w, entry) == (6, date(2027, 2, 24), True, False, None)
    assert _paid(w, entry) == 0
    db = w["db"]
    db.rollback()
    due = posting.due_walk(db, db.get(BudgetEntry, entry), REF.date())
    db.rollback()
    assert [d.date() for d in due] == [date(2027, 2, 24)]


def test_unposting_the_last_payment_makes_a_completed_installment_active(w):
    """AC1: a completed installment (its last payment recorded) is active again."""
    entry = _installment(w, "2027-02-10", 1)
    paid_row = _pay(w, entry)
    _row(w, "2027-02-01", 100)
    _statements(w)
    assert _entry(w, entry)[:3] == (0, date(2027, 2, 24), False)
    assert _paid(w, entry) == 1
    dry = _dry(w, _statement([_line(1, "2027-02-01", "100.00")]))
    assert dry["notes"] == [
        f"row {paid_row}: unposted and unlinked from installment {entry}; its payment due "
        "2027-02-24 is given back (1 left, the next due 2027-02-24); the completed "
        "installment is active again"]
    _apply(w, _statement([_line(1, "2027-02-01", "100.00")]))
    assert _link(w, paid_row) == (False, None, None)
    assert _entry(w, entry) == (1, date(2027, 2, 24), True, False, None)
    assert _paid(w, entry) == 0


def test_giving_back_a_payment_leaves_budgets_balance_and_statements_right(w):
    """AC4: after the apply the budget, the card balance and the stored statements
    are right, and ``verify_card`` passes."""
    from app.models.allocation import Allocation

    savings = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Savings", "account_type": "savings", "balance": 10_000})["id"]
    budget = sw_post(w["client"], w["me"], "/allocations/", {
        "account_id": savings, "name": "Gadgets", "allocation_type": "budget",
        "target_amount": 5_000, "period_frequency": "quarterly",
        "period_start": "2027-01-01T00:00:00", "period_end": "2027-04-01T00:00:00"})["id"]
    entry = _installment(w, "2027-02-10", 6, allocation_id=budget)
    _pay(w, entry)
    _row(w, "2027-02-01", 100)
    _statements(w)
    db = w["db"]
    db.rollback()
    assert Decimal(db.get(Allocation, budget).current_amount) == Decimal("1500")
    db.rollback()
    assert _balance(w) == Decimal("-1600")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("1600"), 2)

    _apply(w, _statement([_line(1, "2027-02-01", "100.00")]))
    db.rollback()
    assert Decimal(db.get(Allocation, budget).current_amount) == Decimal("0")
    db.rollback()
    assert _balance(w) == Decimal("-100")
    assert _stored(w, date(2027, 2, 24)) == (Decimal("100"), 1)
    _verify_store(w)


def test_unposting_an_earlier_installment_payment_is_refused(w):
    """AC2: a payment that is not the installment's latest is refused, nothing written."""
    entry = _installment(w, "2027-01-10", 6)
    january = _pay(w, entry)
    february = _pay(w, entry)
    _row(w, "2027-01-10", 100)
    _statements(w)
    statement = _statement([_line(1, "2027-01-10", "100.00")], close="2027-01-24")
    dry = _dry(w, statement)
    assert ("unpost", None) in _kinds(dry)
    reason = (f"Row {january} is a payment of installment {entry} but not its latest one: "
              "only the latest payment can be given back here; handle this row by hand and "
              "run the dry run again")
    assert dry["notes"] == [f"row {january}: unposting it is refused: {reason}"]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == reason
    assert r.json()["detail"]["row_id"] == january
    assert _snapshot(w) == before
    assert _link(w, february)[:2] == (True, entry)


def test_unposting_a_row_linked_to_an_installment_by_hand_is_refused(w):
    """A row linked by hand (no ``occurrence_date``) never used up a payment: refused."""
    entry = _installment(w, "2027-02-10", 6)
    by_hand = _row(w, "2027-02-15", 1500, budget_entry_id=entry)
    _row(w, "2027-02-01", 100)
    _statements(w)
    assert _link(w, by_hand) == (True, entry, None)
    statement = _statement([_line(1, "2027-02-01", "100.00")])
    dry = _dry(w, statement)
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == (
        f"Row {by_hand} was linked to installment {entry} by hand, not recorded as one of "
        "its payments: handle this row by hand and run the dry run again")
    assert _snapshot(w) == before


def test_unposting_a_row_of_an_uncapped_recurring_entry_unlinks_it(w):
    """AC3: a row of an uncapped recurring entry is unposted and unlinked; the
    entry's schedule is untouched."""
    entry = _entry_post(w, name="Streaming", amount=500,
                        next_occurrence="2027-02-10T00:00:00")
    linked = _pay(w, entry)
    _row(w, "2027-02-01", 100)
    _statements(w)
    schedule = _entry(w, entry)
    assert schedule[:3] == (None, date(2027, 3, 10), True)
    dry = _dry(w, _statement([_line(1, "2027-02-01", "100.00")]))
    assert dry["notes"] == [f"row {linked}: unposted and unlinked from recurring entry "
                            f"{entry}; its schedule is unchanged"]
    _apply(w, _statement([_line(1, "2027-02-01", "100.00")]))
    assert _link(w, linked) == (False, None, None)
    assert _entry(w, entry) == schedule
    assert _balance(w) == Decimal("-100")
    _verify_store(w)


def test_unposting_a_row_of_a_recurring_transfer_is_refused(w):
    """A recurring transfer cannot be funded from a card, so a card's line item is
    linked to one only by hand: a cash advance linked to a recurring transfer. Its
    unpost is refused, nothing written."""
    savings = sw_post(w["client"], w["me"], "/accounts/", {
        "name": "Savings", "account_type": "savings", "balance": 0})["id"]
    entry = _entry_post(w, name="Saving", amount=500, account_id=w["checking"],
                        transfer_to_account_id=savings, next_occurrence="2027-02-10T00:00:00")
    linked = _row(w, "2027-02-10", 500, kind="transfer", transfer_from_account_id=w["card"],
                  transfer_to_account_id=w["checking"], budget_entry_id=entry)
    _row(w, "2027-02-01", 100)
    _statements(w)
    assert _link(w, linked)[:2] == (True, entry)
    statement = _statement([_line(1, "2027-02-01", "100.00")])
    dry = _dry(w, statement)
    assert [a["row_id"] for a in dry["actions"] if a["kind"] == "unpost"] == [linked]
    reason = (f"Row {linked} is linked to a recurring entry: unposting it here would leave "
              "the entry's paid count and schedule as they are")
    assert dry["notes"] == [f"row {linked}: unposting it is refused: {reason}"]
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == reason
    assert _snapshot(w) == before


def test_an_installment_changed_since_the_dry_run_is_refused(w):
    """The fingerprint covers what a linked unpost does: auto-post turned on after
    the dry run changes the outcome's figures, so the apply is refused."""
    entry = _installment(w, "2027-02-10", 6)
    _pay(w, entry)
    _row(w, "2027-02-01", 100)
    _statements(w)
    statement = _statement([_line(1, "2027-02-01", "100.00")])
    fingerprint = _dry(w, statement)["fingerprint"]
    _auto_post_on(w, entry)
    assert _dry(w, statement)["fingerprint"] != fingerprint
    before = _snapshot(w)
    r = _post(w, statement, False, fingerprint)
    assert r.status_code == 409, r.text
    assert "changed since the dry run" in r.json()["detail"]["message"]
    assert _snapshot(w) == before


# --- AC11: the close, and header-only differences ---------------------------------------------

def test_a_close_mismatch_is_refused(w):
    _row(w, "2027-02-01", 100)
    _statements(w)
    statement = _statement([_line(1, "2027-02-01", "100.00")], close="2027-02-23")
    dry = _dry(w, statement)
    assert dry["header"] == [{"field": "close", "statement": "2027-02-23",
                              "app": "2027-02-24"}]
    assert dry["actions"] == [] and dry["balanced"] is False
    before = _snapshot(w)
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 422, r.text
    message = r.json()["detail"]["message"]
    assert "closes on 2027-02-23" in message and "change the card's closing day first" in message
    assert _snapshot(w) == before


def test_a_close_one_day_after_the_cards_is_refused(w):
    """The statement closes 2027-02-25, a day after the card's 2027-02-24 close and
    inside its cycle still open today: the same closing-day refusal, nothing written."""
    _row(w, "2027-02-01", 100)
    _statements(w)
    statement = _statement([_line(1, "2027-02-01", "100.00")], close="2027-02-25")
    before = _snapshot(w)
    dry = _dry(w, statement)
    assert dry["header"] == [{"field": "close", "statement": "2027-02-25",
                              "app": "2027-02-24"}]
    assert dry["actions"] == [] and dry["balanced"] is False
    r = _post(w, statement, False, dry["fingerprint"])
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["message"] == (
        "This statement closes on 2027-02-25, but this card's cycle closes on 2027-02-24: "
        "change the card's closing day first")
    assert _snapshot(w) == before


@pytest.mark.parametrize("close", ["2027-03-10", "2027-02-10"])
def test_a_close_far_from_the_cards_is_not_its_statement(w, close):
    """More than ``NEAR_CLOSE_DAYS`` from every close of the card: not its statement."""
    before = _snapshot(w)
    r = _post(w, _statement([], close=close), True)
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "Not a closed statement of this card"
    assert _snapshot(w) == before


def test_header_only_differences_are_applied(w):
    _row(w, "2027-02-01", 100)
    assert _detail(w)["statement"]["due_date"] == "2027-03-17"
    statement = _statement([_line(1, "2027-02-01", "100.00")], due_date="2027-03-16",
                           minimum_due="75.00")
    body = _apply(w, statement)
    assert {h["field"] for h in body["header"]} == {"due", "minimum_due"}
    assert _kinds(body) == [("matched", 1)]
    detail = _detail(w)["statement"]
    assert (detail["due_date"], detail["due_overridden"], detail["reconciled"]) == (
        "2027-03-16", True, True)
    r = w["client"].get(f"{API}/cards/{w['card']}/credit", headers=w["me"]["headers"])
    (feb,) = [s for s in r.json()["statements"] if s["close_date"] == CLOSE]
    assert (feb["minimum_due"]["amount"], feb["minimum_due"]["source"]) == (75.0, "statement")


def test_a_statement_not_closed_is_refused(w):
    r = _post(w, _statement([], close="2027-03-24"), True)
    assert r.status_code == 422, r.text

"""The posted-day repair and its listing (``services/statement_posting_repair``).

Driven by ``scripts/repair_statement_posting.py``. Rows are written straight
to the database, posted days included, as the web app stored them. Skips
without a database.

Reference: Saturday 2026-11-07 (Manila). "Card 5" closes on the 5th, due 20
days later.
"""
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import pytest

from app.tests.conftest import sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

TODAY = date(2026, 11, 7)
AMOUNT = 4_321.09
AMOUNT_TEXTS = ("4321.09", "4,321", "4321.1", "12.34", "4333.43")
BACKEND_DIR = Path(__file__).resolve().parents[2]


def _txn(db, who, account, day, *, kind="debit", posted=True, posting=None, entry=None,
         to=None, amount=AMOUNT):
    from app.models.transaction import Transaction, TransactionType

    when = datetime.combine(day, datetime.min.time())
    txn = Transaction(
        user_id=who["id"], account_id=account, transaction_type=TransactionType(kind),
        amount=amount, description="Row", transaction_date=when, is_posted=posted,
        posting_date=posting, budget_entry_id=entry, is_recurring=entry is not None,
        transfer_from_account_id=account if kind == "transfer" else None,
        transfer_to_account_id=to, transfer_fee=12.34 if kind == "transfer" else None)
    db.add(txn)
    db.commit()
    return txn.id


def _installment(db, who, card):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    entry = BudgetEntry(
        user_id=who["id"], name="Plan", entry_type=BudgetEntryType.EXPENSE, amount=AMOUNT,
        cadence=RecurrenceFrequency.MONTHLY, next_occurrence=datetime(2026, 12, 5),
        anchor_day=5, account_id=card, end_mode="after_occurrences", max_occurrences=6)
    db.add(entry)
    db.commit()
    return entry.id


@pytest.fixture
def world(sw_client, sw_db, sw_people):
    db, me = sw_db, sw_people()
    checking = sw_post(sw_client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 0})["id"]
    card = sw_post(sw_client, me, "/accounts/", {
        "name": "Card 5", "account_type": "credit", "balance": 0, "billing_cycle_start": 5,
        "days_until_due_date": 20, "credit_limit": 500_000})["id"]
    plan = _installment(db, me, card)
    rows = {
        # The imported shape: dated Oct 4, marked posted Oct 18.
        "imported": _txn(db, me, card, date(2026, 10, 4), posting=datetime(2026, 10, 18)),
        "late": _txn(db, me, card, date(2026, 11, 4), posting=datetime(2026, 11, 5, 23)),
        "kept": _txn(db, me, card, date(2026, 10, 20)),
        "same": _txn(db, me, card, date(2026, 10, 20), posting=datetime(2026, 10, 22)),
        "pending": _txn(db, me, card, date(2026, 11, 4), posted=False),
        "plan": _txn(db, me, card, date(2026, 10, 5), posted=False, entry=plan),
        "advance": _txn(db, me, card, date(2026, 11, 3), kind="transfer", to=checking,
                        posting=datetime(2026, 11, 6)),
        "payment": _txn(db, me, checking, date(2026, 11, 4), kind="transfer", to=card,
                        posting=datetime(2026, 11, 6)),
        "bank": _txn(db, me, checking, date(2026, 10, 4), posting=datetime(2026, 10, 18)),
    }
    return {"db": db, "me": me, "card": card, "checking": checking, "entry": plan, **rows}


def _naive(value):
    """The stored UTC value without its zone (the columns are ``timestamptz``)."""
    return value.replace(tzinfo=None) if value is not None and value.tzinfo else value


def _state(db, ids):
    from app.models.account import Account
    from app.models.transaction import Transaction

    db.expire_all()
    rows = db.query(Transaction).filter(Transaction.id.in_(ids)).order_by(Transaction.id)
    return ([(r.id, _naive(r.transaction_date), _naive(r.posting_date), r.is_posted, r.amount,
              r.updated_at)
             for r in rows],
            [(a.id, a.balance) for a in db.query(Account).filter(Account.id.in_(ids))])


def _ids(w):
    return [v for k, v in w.items() if k not in ("db", "me", "card", "checking", "entry")]


def _run(ids, apply):
    """The service as the script runs it, in its own session."""
    from app.core.database import SessionLocal
    from app.services import statement_posting_repair

    db = SessionLocal()
    try:
        return statement_posting_repair.run(db, ids, apply=apply, today=TODAY)
    finally:
        db.close()


def _mine(lines, w):
    return [line for line in lines if f"card {w['card']}:" in line]


def test_posting_repair_dry_run_writes_nothing(world):
    w = world
    db = w["db"]
    before = _state(db, [*_ids(w), w["card"], w["checking"]])
    lines = _run([w["imported"]], apply=False)
    assert _state(db, [*_ids(w), w["card"], w["checking"]]) == before

    out = "\n".join(lines)
    assert not any(text in out for text in AMOUNT_TEXTS), out
    assert f"repair txn {w['imported']}: posted day 2026-10-18 -> its own day, close " \
           "2026-11-05 -> 2026-10-05: checked, rolled back (dry run)" in lines
    card = w["card"]
    assert _mine(lines, w) == [
        f"  posted txn {w['imported']} card {card}: date 2026-10-04, posted day 2026-10-18, "
        "close 2026-10-05 -> 2026-11-05, entry none, installment no",
        f"  posted txn {w['late']} card {card}: date 2026-11-04, posted day 2026-11-06, "
        "close 2026-11-05 -> 2026-12-05, entry none, installment no",
        f"  posted txn {w['advance']} card {card}: date 2026-11-03, posted day 2026-11-06, "
        "close 2026-11-05 -> 2026-12-05, entry none, installment no",
        f"  unposted txn {w['pending']} card {card}: date 2026-11-04, posted day none, "
        "close 2026-11-05 -> 2026-12-05, entry none, installment no",
        f"  unposted txn {w['plan']} card {card}: date 2026-10-05, posted day none, "
        f"close 2026-10-05 -> 2026-12-05, entry {w['entry']}, installment yes",
    ]
    for key in ("kept", "same", "payment", "bank"):
        assert f"txn {w[key]} " not in out

    # The driver, as the owner runs it: a dry run, then expectations it refuses.
    from sqlalchemy.engine.url import make_url

    parsed = make_url(os.environ["DATABASE_URL"])
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    script = str(BACKEND_DIR / "scripts" / "repair_statement_posting.py")
    base = [sys.executable, script, "--expect-host", parsed.host]
    run = subprocess.run([*base, "--expect-db", parsed.database, "--txn-id", str(w["imported"])],
                         env=env, capture_output=True, text=True, timeout=150)
    assert run.returncode == 0, run.stdout + run.stderr
    assert run.stdout.startswith(f"target: host={parsed.host} db={parsed.database}\n")
    assert "mode: dry run" in run.stdout and "posted rows whose close changes: " in run.stdout
    assert f"posted txn {w['imported']} card {card}:" in run.stdout
    assert f"repair txn {w['imported']}: posted day 2026-10-18" in run.stdout
    assert not any(text in run.stdout for text in AMOUNT_TEXTS)
    assert "password" not in run.stdout
    assert _state(db, [*_ids(w), w["card"], w["checking"]]) == before
    wrong = subprocess.run([*base, "--expect-db", "other_db"], env=env, capture_output=True,
                           text=True, timeout=150)
    assert wrong.returncode == 2 and wrong.stdout.startswith("refused:")
    bare = subprocess.run([*base, "--expect-db", parsed.database, "--apply"], env=env,
                          capture_output=True, text=True, timeout=150)
    assert bare.returncode == 2 and bare.stdout.startswith("refused:")


def _statement_of(db, card_id, txn_id):
    from app.core.access import viewable_account_ids
    from app.models.account import Account
    from app.services.statements import statement_history

    db.expire_all()
    card = db.get(Account, card_id)
    for s in statement_history(db, card, datetime.combine(TODAY, datetime.min.time()),
                               viewable_account_ids(db, card.user_id)):
        if txn_id in [line["transaction"].id for line in s["lines"]]:
            return s["close"].date()
    return None


def test_posting_repair_applies_only_named_row(world, monkeypatch):
    from app.services import statement_posting_repair

    w = world
    db, card = w["db"], w["card"]
    assert _statement_of(db, card, w["imported"]) == date(2026, 11, 5)
    others = [i for i in _ids(w) if i != w["imported"]]
    before = _state(db, [*others, card, w["checking"]])

    # A total that changed around the write rolls the row back.
    real = statement_posting_repair._card_figures
    calls = []

    def drifting(session, account, today):
        total, balance = real(session, account, today)
        calls.append(1)
        return (total + 1 if len(calls) > 1 else total), balance

    monkeypatch.setattr(statement_posting_repair, "_card_figures", drifting)
    lines = _run([w["imported"]], apply=True)
    assert f"repair txn {w['imported']}: REFUSED: the card's statement total or balance " \
           "would change" in lines
    assert _state(db, [w["imported"]])[0][0][2] == datetime(2026, 10, 18)
    monkeypatch.setattr(statement_posting_repair, "_card_figures", real)

    # Anything but a listed posted card row is refused and left unchanged.
    refused = {w["kept"]: "it has no posted day",
               w["same"]: "its posted day does not move it to another statement",
               w["pending"]: "not posted",
               w["payment"]: "not on a credit card",
               w["bank"]: "not on a credit card",
               2_000_000_000: "no such transaction"}
    lines = _run(list(refused), apply=True)
    for txn_id, reason in refused.items():
        assert f"repair txn {txn_id}: REFUSED: {reason}" in lines
    assert _state(db, [*others, card, w["checking"]]) == before

    lines = _run([w["imported"]], apply=True)
    assert f"repair txn {w['imported']}: posted day 2026-10-18 -> its own day, close " \
           "2026-11-05 -> 2026-10-05: written" in lines
    assert lines[-1] == "repairs: 1; refused: 0"
    rows, _ = _state(db, [w["imported"]])
    assert rows[0][1] == rows[0][2] == datetime(2026, 10, 4)  # posting_date = transaction_date
    assert _state(db, [*others, card, w["checking"]]) == before
    assert _statement_of(db, card, w["imported"]) == date(2026, 10, 5)
    # Repaired, it no longer moves.
    assert f"txn {w['imported']} " not in "\n".join(
        _mine(_run([], apply=False), w))

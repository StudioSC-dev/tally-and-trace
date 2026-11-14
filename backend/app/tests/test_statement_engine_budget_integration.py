"""``statement_day`` work per snapshot is linear in the card rows (STU-600, PERF-5 AC2).

Hard gate: one ``GET /dashboard/snapshot`` calls ``statements.statement_day`` at
most 4 times per card row (every row touching one of the caller's cards,
counted once per card it touches): the engine reads each line's day once per
replay. The snapshot replayed five times before PERF-3 (STU-598), four
statement-payable passes (one per ``collect_events`` run, RC2) and one
``statement_summaries`` pass (``statements_due``). With one ``collect_events``
run per request and the stored closed statements (STU-601) it measures under one
call per card row (0.95 at STU-598); the limit keeps headroom below the old
five. Before the single-pass engine the replay called it once per row per
cycle, about 295,000 times on a 2-year history; here that is roughly 36 cycles
x 1,500 rows x 5 passes.

The fixture is seeded (``random.Random``) and self-contained: three years of
history on three cards (closing on the 15th, on the 31st, and a legacy
``due_date``-only card), with charges, refunds, cash advances with fees,
payments from a bank account, rows posted after their close, unposted rows and
two recurring charges on cards. Reference: 2026-11-13, 02:00 UTC (10:00 in
Manila). Skips without a database.

This gate moves to ``test_perf_budgets.py`` (PERF-1) once that module lands.
"""
import random
import sys
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 13, 2, 0)
YEARS = 3
ROWS = 1500
CALLS_PER_CARD_ROW = 4  # passes per snapshot, see the module docstring


def _seed(client, db, who, rng: random.Random):
    """The accounts and ``ROWS`` transactions; returns the card ids."""
    from app.models.transaction import Transaction, TransactionType

    def account(name, kind, balance=0, **extra):
        return sw_post(client, who, "/accounts/", {
            "name": name, "account_type": kind, "balance": balance, **extra})["id"]

    bank = account("Bank", "checking", 500_000)
    cards = [
        account("Card 15", "credit", billing_cycle_start=15, days_until_due_date=21,
                payment_account_id=bank),
        account("Card 31", "credit", billing_cycle_start=31, days_until_due_date=20,
                payment_account_id=bank),
        account("Card legacy", "credit", due_date=5, payment_account_id=bank),
    ]
    for i, card in enumerate(cards[:2]):
        sw_post(client, who, "/budget-entries/", {
            "name": f"Plan {i}", "entry_type": "expense", "amount": 1500, "cadence": "monthly",
            "next_occurrence": f"{(REF + timedelta(days=5 + i)).date()}T00:00:00",
            "account_id": card})

    start = REF - timedelta(days=365 * YEARS)
    rows = []
    for k in range(ROWS):
        when = start + timedelta(minutes=rng.randint(0, 365 * YEARS * 24 * 60))
        card = rng.choice(cards)
        kind = rng.choices(["debit", "refund", "advance", "payment"], [75, 8, 4, 13])[0]
        posted = rng.random() > 0.06
        if not posted and rng.random() < 0.5:
            when = REF + timedelta(days=rng.randint(1, 30))
        extra = {}
        account_id, ttype = card, TransactionType.DEBIT
        amount = Decimal(rng.randint(50, 6000))
        if kind == "refund":
            ttype = TransactionType.CREDIT
        elif kind == "advance":
            ttype = TransactionType.TRANSFER
            extra = {"transfer_from_account_id": card, "transfer_to_account_id": bank,
                     "transfer_fee": Decimal("200")}
        elif kind == "payment":
            ttype, account_id = TransactionType.TRANSFER, bank
            extra = {"transfer_from_account_id": bank, "transfer_to_account_id": card}
        if posted and rng.random() < 0.3:
            extra["posting_date"] = when + timedelta(days=rng.randint(0, 6))
        rows.append(Transaction(
            user_id=who["id"], created_by_actor=who["id"], account_id=account_id, amount=amount,
            transaction_type=ttype, description=f"Row {k}", is_posted=posted,
            transaction_date=when, **{"transfer_fee": Decimal("0"), **extra}))
    db.add_all(rows)
    db.commit()
    return cards


def _count_statement_day(monkeypatch) -> list:
    """Count every call of ``statements.statement_day``, under any module's name for it."""
    from app.services import statements

    original = statements.statement_day
    calls = [0]

    def counted(row, today):
        calls[0] += 1
        return original(row, today)

    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and not name.startswith("app.tests") \
                and getattr(module, "statement_day", None) is original:
            monkeypatch.setattr(module, "statement_day", counted)
    return calls


def test_snapshot_statement_day_calls_are_linear_in_card_rows(sw_client, sw_db, sw_people,
                                                               monkeypatch):
    from app.core.access import viewable_account_ids
    from app.services.statements import _card_rows

    pin_clock(monkeypatch, REF)
    who = sw_people()
    cards = _seed(sw_client, sw_db, who, random.Random(600))
    by_card, _ = _card_rows(sw_db, cards, viewable_account_ids(sw_db, who["id"]))
    card_rows = sum(len(rows) for rows in by_card.values())
    assert card_rows > 1400  # every seeded row touches a card

    calls = _count_statement_day(monkeypatch)
    r = sw_client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["card_statements_due"], "the fixture should owe on a closed statement"

    assert calls[0] <= CALLS_PER_CARD_ROW * card_rows, (
        f"statement_day ran {calls[0]} times for {card_rows} card rows "
        f"(limit {CALLS_PER_CARD_ROW * card_rows})")

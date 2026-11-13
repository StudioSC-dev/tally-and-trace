"""Stored statements equal the replay under random writes and time (STU-601, PERF-6, AC1).

On the realistic dataset (``app/tests/fixtures/realistic.py``), each seed runs a
sequence of random steps through ORM sessions, the way every route and script
writes: create, edit and delete back-dated posted and unposted rows (up to two
years back), toggle ``is_posted``, move ``posting_date`` across a close, move a row
between cards, edit transfer ends and fees, change a card's billing settings,
add and remove a due override, and advance ``today`` by 0 to 40 days. After every
step, every figure read through the store for all four callers equals the replay
(``statements_store_checks.compare_world``).

Each seed starts on the dataset as the previous seeds left it, with the clock back
at the fixture's day. A failure names the seed and step; to replay it, run the same
``PERF6_SEEDS`` (the seeds before it change the data it starts from).

CI runs ``PERF6_SEEDS`` seeds (default 2) of ``PERF6_STEPS`` steps (default 40).
The full run of the plan is ``PERF6_SEEDS=20 PERF6_STEPS=300``.
"""
import os
import random
from datetime import datetime, time, timedelta
from decimal import Decimal

import pytest

from app.tests.conftest import fx_rates, sw_db_reachable
from app.tests.fixtures.realistic import REF, pin_clock
from app.tests.statements_store_checks import card_ids, compare_world

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

SEEDS = int(os.environ.get("PERF6_SEEDS", "2"))
STEPS = int(os.environ.get("PERF6_STEPS", "40"))
CLOSE_DAYS = (1, 5, 12, 15, 20, 28, 30, 31)


def _money(rng) -> Decimal:
    return Decimal(rng.randint(5000, 900000)).scaleb(-2)


def _when(rng, today) -> datetime:
    day = today - timedelta(days=rng.randint(0, 730))
    return datetime.combine(day, time()) + timedelta(minutes=rng.randint(0, 24 * 60 - 1))


class Steps:
    """The random writes, each through an ORM session and committed."""

    def __init__(self, db, world, rng):
        self.db, self.world, self.rng = db, world, rng
        self.cards = card_ids(world)
        self.banks = [world.accounts[k] for k in ("bank0", "bank1", "bank2")]
        self.owner = world.callers["owner"].id

    def _rows(self, **filters):
        from app.models.transaction import Transaction, TransactionType

        from app.core.access import touches_accounts

        q = self.db.query(Transaction).filter(touches_accounts(Transaction, self.cards))
        if filters.get("transfer"):
            q = q.filter(Transaction.transaction_type == TransactionType.TRANSFER)
        if filters.get("plain"):
            q = q.filter(Transaction.transaction_type != TransactionType.TRANSFER,
                         Transaction.account_id.in_(self.cards))
        if filters.get("posted"):
            q = q.filter(Transaction.is_posted.is_(True))
        return q.order_by(Transaction.id).all()

    def _pick(self, **filters):
        rows = self._rows(**filters)
        return self.rng.choice(rows) if rows else None

    def create(self, today):
        from app.models.transaction import Transaction, TransactionType

        rng = self.rng
        card = rng.choice(self.cards)
        when = _when(rng, today)
        posted = rng.random() < 0.85
        kind = rng.choices(["debit", "credit", "advance"], [70, 20, 10])[0]
        row = Transaction(user_id=self.owner, created_by_actor=self.owner, account_id=card,
                          amount=_money(rng), description="Step row", is_posted=posted,
                          transaction_date=when, transfer_fee=Decimal("0"))
        if kind == "advance":
            row.transaction_type = TransactionType.TRANSFER
            row.transfer_from_account_id = card
            row.transfer_to_account_id = rng.choice(self.banks)
            row.transfer_fee = rng.choice([Decimal("0"), Decimal("150.00")])
        else:
            row.transaction_type = (TransactionType.DEBIT if kind == "debit"
                                    else TransactionType.CREDIT)
        if posted and rng.random() < 0.4:
            row.posting_date = datetime.combine(when.date(), time()) + timedelta(
                days=rng.randint(-3, 12), hours=rng.choice([0, 15, 23]))
        self.db.add(row)

    def edit(self, today):
        row = self._pick()
        if row is not None:
            row.amount = _money(self.rng)
            row.transaction_date = _when(self.rng, today)

    def delete(self, today):
        row = self._pick()
        if row is not None:
            self.db.delete(row)

    def toggle_posted(self, today):
        row = self._pick()
        if row is not None:
            row.is_posted = not row.is_posted

    def move_posting_date(self, today):
        from app.models.account import Account
        from app.services.statements import statement_close

        row = self._pick(posted=True, plain=True)
        if row is None:
            return
        card = self.db.get(Account, row.account_id)
        close = statement_close(card, row.transaction_date.date())
        if close is not None:
            row.posting_date = datetime.combine(close, time()) + timedelta(
                days=self.rng.randint(-1, 5), hours=self.rng.choice([0, 17]))

    def move_card(self, today):
        row = self._pick(plain=True)
        if row is not None:
            row.account_id = self.rng.choice([c for c in self.cards if c != row.account_id])

    def edit_transfer(self, today):
        row = self._pick(transfer=True)
        if row is None:
            return
        rng = self.rng
        what = rng.choice(["fee", "from", "to"])
        if what == "fee":
            row.transfer_fee = rng.choice([Decimal("0"), Decimal("75.00"), Decimal("300.00")])
        elif what == "from":
            row.transfer_from_account_id = rng.choice(self.cards + self.banks)
            row.account_id = row.transfer_from_account_id
        else:
            choices = [a for a in self.cards + self.banks if a != row.transfer_from_account_id]
            row.transfer_to_account_id = rng.choice(choices)

    def billing(self, today):
        from app.models.account import Account
        from app.models.card_statement_due_override import CardStatementDueOverride

        card = self.db.get(Account, self.rng.choice(self.cards))
        if card.billing_cycle_start:
            card.billing_cycle_start = self.rng.choice(
                [d for d in CLOSE_DAYS if d != card.billing_cycle_start])
        else:
            card.due_date = self.rng.choice([d for d in (3, 5, 10, 25) if d != card.due_date])
        # The printed dues were for the old closes.
        self.db.query(CardStatementDueOverride).filter(
            CardStatementDueOverride.account_id == card.id).delete(synchronize_session=False)

    def due_override(self, today):
        from app.models.account import Account
        from app.models.card_statement_due_override import CardStatementDueOverride
        from app.services.statements import (
            due_override_conflicts, iter_cycles_from, load_due_overrides,
        )

        card = self.db.get(Account, self.rng.choice(self.cards))
        existing = self.db.query(CardStatementDueOverride).filter(
            CardStatementDueOverride.account_id == card.id).all()
        if existing and self.rng.random() < 0.5:
            self.db.delete(self.rng.choice(existing))
            return
        cycles = list(iter_cycles_from(card, today - timedelta(days=400), datetime.min,
                                       through=today + timedelta(days=40), due_overrides={}))
        cycle = self.rng.choice(cycles)
        close = cycle["close"].date()
        due = max(cycle["computed_due"].date() + timedelta(days=self.rng.randint(-3, 3)),
                  close + timedelta(days=1))
        overrides = load_due_overrides(self.db, [card.id])[card.id]
        if close in overrides or due_override_conflicts(card, {**overrides, close: due}):
            return
        self.db.add(CardStatementDueOverride(account_id=card.id, statement_close=close,
                                             due_date=due, created_by_actor=self.owner))

    OPS = (("create", 22), ("edit", 14), ("delete", 8), ("toggle_posted", 8),
           ("move_posting_date", 10), ("move_card", 8), ("edit_transfer", 8),
           ("billing", 3), ("due_override", 6), ("advance", 13))


@pytest.mark.parametrize("seed", range(SEEDS))
def test_stored_statements_equal_the_replay_under_random_steps(realistic, sw_db, monkeypatch,
                                                                seed):
    rng = random.Random(6010 + seed)
    steps = Steps(sw_db, realistic, rng)
    fx = fx_rates()
    now = REF
    pin_clock(monkeypatch, now)
    names = [name for name, _ in Steps.OPS]
    weights = [weight for _, weight in Steps.OPS]
    compared = 0
    for step in range(STEPS):
        op = rng.choices(names, weights)[0]
        today = (now + timedelta(hours=8)).date()
        if op == "advance":
            now += timedelta(days=rng.randint(0, 40))
            pin_clock(monkeypatch, now)
        else:
            getattr(steps, op)(today)
            sw_db.commit()
        today = (now + timedelta(hours=8)).date()
        compared += compare_world(sw_db, realistic, today, fx, monkeypatch, rng,
                                  where=f"seed={seed} step={step} op={op}")
    assert compared > 0

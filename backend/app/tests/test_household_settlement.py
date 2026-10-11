"""Household coverage settles a card exactly as the statement engine does (STU-233).

``services/household._settle_with_sources`` tracks which payments are in-scope
cash; what each cycle still owes must match ``statements.allocate_payments``
plus ``settle_projected`` on the same inputs, whatever the payment sources.
"""
import random
from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

from app.models.transaction import TransactionType
from app.services.household import _settle_with_sources
from app.services.statements import (
    allocate_payments, settle_projected, statement_balance, unspent_pool,
)

DEBIT, CREDIT = TransactionType.DEBIT, TransactionType.CREDIT


def _cycles(n=5):
    out = []
    for m in range(n):
        start, close = datetime(2026, 1 + m, 15), datetime(2026, 2 + m, 15)
        out.append({"window_start": start, "close": close, "due": close + timedelta(days=21)})
    return out


def _row(day, amount, kind):
    return SimpleNamespace(transaction_date=datetime(2026, 1, 16) + timedelta(days=day),
                           amount=Decimal(amount), transaction_type=kind)


def test_owed_matches_the_engine_on_random_ledgers():
    rng = random.Random(233)
    cycles = _cycles()
    for _ in range(400):
        lines = [_row(rng.randrange(150), rng.randrange(1, 300), rng.choice([DEBIT, DEBIT, CREDIT]))
                 for _ in range(rng.randrange(0, 8))]
        projected = [_row(rng.randrange(150), rng.randrange(1, 300), rng.choice([DEBIT, CREDIT]))
                     for _ in range(rng.randrange(0, 5))]
        payments = sorted(((datetime(2026, 1, 16) + timedelta(days=rng.randrange(150)),
                            Decimal(rng.randrange(1, 400)), rng.random() < 0.5)
                           for _ in range(rng.randrange(0, 5))), key=lambda p: p[0])
        balances = [statement_balance(lines, c["window_start"], c["close"]) for c in cycles]
        paid = [amount for _, amount, _ in payments]
        settled = allocate_payments(balances, paid)
        engine = settle_projected(cycles, settled, unspent_pool(balances, paid, settled),
                                  projected)
        owed, in_scope = _settle_with_sources(cycles, lines, payments, projected)
        assert owed == engine
        assert all(Decimal(0) <= part for part in in_scope)
        assert sum(in_scope) <= sum(amount for _, amount, flag in payments if flag)


def test_in_scope_part_follows_the_payment_order():
    cycles = _cycles(2)
    lines = [_row(1, 100, DEBIT), _row(40, 100, DEBIT)]   # one charge per cycle
    payments = [(datetime(2026, 2, 20), Decimal(100), False),
                (datetime(2026, 2, 21), Decimal(100), True)]
    owed, in_scope = _settle_with_sources(cycles, lines, payments, [])
    assert owed == [0, 0] and in_scope == [0, 100]

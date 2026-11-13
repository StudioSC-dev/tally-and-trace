"""Comparisons shared by the stored-statement tests (STU-601, PERF-6).

``compare_world`` checks, for every caller of the realistic dataset, that every
figure read through the stored statements equals the replay:

- ``statement_summaries`` and ``card_credit.closed_statements`` (stored path)
  against the frozen reference replay (``statements_reference``);
- ``get_statement_payables`` (stored path) against the reference's, with
  projected lines (some ``settles_as_recorded``, some estimated) on every card;
- ``card_credit.statements_due`` and ``card_credit.amount_due`` against the same
  functions with ``STATEMENTS_STORE=off`` (the PERF-5 engine replaying every row,
  itself held to the reference by ``test_statement_engine_oracle.py``).

Comparisons are on ``repr``, so a figure's exact ``Decimal`` (``0`` against
``0.00``) counts too.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import List

from app.core.context import RequestContext
from app.tests import statements_reference as reference

CARD_KEYS = ("card_a", "card_b", "card_c", "card_d")


def first_difference(got: list, want: list) -> str:
    """Where two statement lists first differ (synthetic test data only)."""
    if len(got) != len(want):
        return f"{len(got)} statements, want {len(want)}"
    for i, (a, b) in enumerate(zip(got, want)):
        if repr(a) != repr(b):
            keys = [k for k in sorted(set(a) | set(b)) if repr(a.get(k)) != repr(b.get(k))]
            return f"#{i}: " + ", ".join(f"{k}: {a.get(k)!r} want {b.get(k)!r}" for k in keys)
    return "equal"


def strip(statement: dict) -> dict:
    return {k: v for k, v in statement.items() if k not in ("lines", "unconverted")}


def projected_lines(rng: random.Random, today: date) -> list:
    """Projected lines around ``today``, as the oracle test draws them."""
    from app.models.transaction import TransactionType

    out = []
    for _ in range(rng.randint(0, 4)):
        kind = rng.choice([TransactionType.DEBIT, TransactionType.DEBIT, TransactionType.CREDIT])
        line = SimpleNamespace(
            transaction_date=datetime.combine(today, time()) + timedelta(
                days=rng.randint(-60, 80)),
            amount=Decimal(rng.randint(1000, 500000)).scaleb(-rng.choice([0, 2])),
            transaction_type=kind)
        if rng.random() < 0.4:
            line.settles_as_recorded = True
        out.append(line)
    return out


def _cards_of(db, viewable) -> list:
    from app.models.account import Account, AccountType

    return (db.query(Account).filter(Account.id.in_(list(viewable)),
                                     Account.account_type == AccountType.CREDIT)
            .order_by(Account.id).all())


def compare_world(db, world, today: date, fx, monkeypatch, rng: random.Random,
                  where: str = "") -> int:
    """Every comparison for every caller of ``world`` on ``today``; returns how many
    statements were compared. Fails with ``where`` in the message."""
    from app.core.access import viewable_account_ids
    from app.models.user import User
    from app.services import card_credit, statements_store
    from app.services import statements as engine

    db.expire_all()
    midnight = datetime.combine(today, time())
    compared = 0
    for key, caller in world.callers.items():
        user = db.get(User, caller.id)
        viewable = viewable_account_ids(db, user)
        cards = _cards_of(db, viewable)
        label = f"{where} caller={key} today={today}"
        for card in cards:
            ref = [strip(s) for s in reference.statement_history(db, card, midnight, viewable,
                                                                 fx=fx)]
            got = engine.statement_summaries(db, card, midnight, viewable, fx=fx)
            assert repr(got) == repr(ref), (f"statement_summaries differ: {label} card={card.id}: "
                                            + first_difference(got, ref))
            closed = card_credit.closed_statements(db, user, card, fx)
            assert repr(closed) == repr([s for s in ref if s["close"].date() < today]), \
                f"closed_statements differ: {label} card={card.id}"
            compared += len(ref)
        # The read above caught every card up: the stored path is the one compared.
        stored = statements_store.load(db, cards, today, catch_up_first=False)
        modelled = [c.id for c in cards if statements_store._is_card(c)]
        assert sorted(stored) == sorted(modelled), f"cards not stored: {label}"
        if cards:
            projected = {c.id: projected_lines(rng, today) for c in cards}
            for days in (30, 90):
                end = midnight + timedelta(days=days)
                got = engine.get_statement_payables(db, cards, midnight, end, projected,
                                                    viewable_ids=viewable, fx=fx)
                ref = reference.get_statement_payables(db, cards, midnight, end, projected,
                                                       viewable_ids=viewable, fx=fx)
                assert repr(got) == repr(ref), f"payables differ: {label} window={days}d"
        managed = [c for c in cards if card_credit.can_see_credit(user, c)]
        due, amounts = (card_credit.statements_due(RequestContext(db, user, fx=fx)),
                        card_credit.amount_due(db, user, managed, fx))
        monkeypatch.setenv("STATEMENTS_STORE", "off")
        try:
            due_off, amounts_off = (card_credit.statements_due(RequestContext(db, user, fx=fx)),
                                    card_credit.amount_due(db, user, managed, fx))
        finally:
            monkeypatch.delenv("STATEMENTS_STORE")
        assert repr(due) == repr(due_off), f"statements_due differs: {label}"
        assert repr(amounts) == repr(amounts_off), f"amount_due differs: {label}"
    db.rollback()
    return compared


def card_ids(world) -> List[int]:
    return [world.accounts[k] for k in CARD_KEYS]

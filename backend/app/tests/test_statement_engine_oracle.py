"""The single-pass statement engine equals the frozen replay (STU-600, PERF-5 AC1).

``app.tests.statements_reference`` is a verbatim copy of the statement module
before the single-pass engine (commit 1b2d92c). For 200 seeded random card
histories plus one larger, realistic one, and for 10 ``today``s each (a close
day, the day after a close, month ends, a leap day and days around the
history), the engine's ``statement_summaries``, ``statement_lines``,
``statement_history`` and ``build_statement_payables`` equal the reference's
``statement_history`` and ``build_statement_payables``.

Equality is on ``repr``: same keys in the same order, the same row objects,
and every Decimal with the same digits and exponent, so a figure that is equal
in value but printed differently fails too.

The histories cover posted rows billed after the close (``posting_date``),
unposted rows (past and future), refunds exceeding charges, cash advances and
transfers from a card with fees, payments from cash, from another card and from
a card without cycle settings, stale transfer fields on a debit, close days
29-31 (clamped in short months, February and the leap day), legacy
``due_date``-only cards, due overrides, foreign unposted rows with and without
a stored rate, and projected lines (some ``settles_as_recorded``). Pure: no
database. A failure names the seed and the day, to rerun it alone.
"""
import random
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.models.account import Account, AccountType
from app.models.transaction import Transaction, TransactionType
from app.models.user import CurrencyType
from app.services import statements as engine
from app.services.fx import FxRates, MemoryRateStore, StoredRate
from app.tests import statements_reference as reference

SEEDS = range(200)
CARD, OTHER_CARD, UNBILLED_CARD, CASH = 1, 2, 3, 10
FX_AT = datetime(2026, 11, 2)


def _fx() -> FxRates:
    """USD and PHP rates only: a EUR face has no stored rate (unconverted)."""
    store = MemoryRateStore([
        StoredRate("USD", Decimal("1"), FX_AT.date(), FX_AT, "test"),
        StoredRate("PHP", Decimal("58.00"), FX_AT.date(), FX_AT, "test"),
    ])
    return FxRates(store, None, lambda: FX_AT, lambda: None)


def _card(rng: random.Random, card_id: int, *, realistic: bool = False) -> Account:
    """A card with random cycle settings, legacy ones in about a sixth of draws."""
    days = rng.choice([None, 14, 21, 25])
    if not realistic and rng.random() < 0.17:
        return Account(id=card_id, name=f"Card {card_id}", account_type=AccountType.CREDIT,
                       currency=CurrencyType.PHP, billing_cycle_start=None,
                       due_date=rng.choice([1, 5, 15, 28, 30, 31]), days_until_due_date=days,
                       payment_account_id=CASH)
    close = rng.choice([1, 5, 10, 15, 28, 29, 30, 31])
    currency = CurrencyType.USD if rng.random() < 0.1 else CurrencyType.PHP
    return Account(id=card_id, name=f"Card {card_id}", account_type=AccountType.CREDIT,
                   currency=currency, billing_cycle_start=close, due_date=None,
                   days_until_due_date=days, payment_account_id=CASH)


def _money(rng: random.Random, low: int, high: int) -> Decimal:
    # Mixed exponents (whole pesos, one and two decimals) so a sum's exponent is tested.
    places = rng.choice([0, 1, 2])
    return Decimal(rng.randint(low * 10 ** places, high * 10 ** places)).scaleb(-places)


def _history(rng: random.Random, card: Account, start: datetime, span_days: int, count: int,
             horizon: date) -> list:
    """``count`` random rows touching ``card`` over ``span_days`` from ``start``."""
    rows = []
    for k in range(count):
        when = start + timedelta(minutes=rng.randint(0, span_days * 24 * 60))
        kind = rng.choices(["debit", "refund", "big_refund", "advance", "pay_cash",
                            "pay_card", "pay_unbilled", "advance_out_to_card", "stale_debit"],
                           [55, 10, 3, 4, 13, 4, 3, 4, 4])[0]
        posted = rng.random() > 0.15
        row = Transaction(id=k + 1, user_id=1, account_id=card.id, description=f"Row {k}",
                          transaction_date=when, is_posted=posted, transfer_fee=Decimal("0"),
                          currency=card.currency)
        if kind in ("debit", "stale_debit"):
            row.transaction_type = TransactionType.DEBIT
            row.amount = _money(rng, 1, 9000)
            if kind == "stale_debit":  # transfer fields left from an edit: not a payment
                row.transfer_to_account_id = card.id
                row.transfer_from_account_id = CASH
        elif kind in ("refund", "big_refund"):
            row.transaction_type = TransactionType.CREDIT
            row.amount = _money(rng, 1, 2000) if kind == "refund" else _money(rng, 20000, 60000)
        elif kind in ("advance", "advance_out_to_card"):
            row.transaction_type = TransactionType.TRANSFER
            row.amount = _money(rng, 100, 20000)
            row.transfer_fee = rng.choice([Decimal("0"), Decimal("200"), Decimal("3.5")])
            row.transfer_from_account_id = card.id
            row.transfer_to_account_id = CASH if kind == "advance" else OTHER_CARD
        else:
            source = {"pay_cash": CASH, "pay_card": OTHER_CARD,
                      "pay_unbilled": UNBILLED_CARD}[kind]
            row.transaction_type = TransactionType.TRANSFER
            row.account_id = source
            row.amount = _money(rng, 100, 25000)
            row.transfer_fee = Decimal("15") if source != CASH else Decimal("0")
            row.received_amount = row.amount if rng.random() < 0.3 else None
            row.transfer_from_account_id = source
            row.transfer_to_account_id = card.id
        if posted:
            if rng.random() < 0.4:  # posted later (often across a close), or earlier (ignored)
                shift = rng.randint(-3, 12)
                row.posting_date = datetime.combine(when.date(), time()) + timedelta(
                    days=shift, hours=rng.choice([0, 15, 23]))
        else:
            if rng.random() < 0.4:  # planned in the future
                row.transaction_date = datetime.combine(horizon, time()) + timedelta(
                    days=rng.randint(-30, 60))
            if rng.random() < 0.2:  # a stale posted day on an unposted row
                row.posting_date = row.transaction_date + timedelta(days=5)
            if row.transaction_type in (TransactionType.DEBIT, TransactionType.CREDIT) \
                    and rng.random() < 0.3:
                row.projected_currency = rng.choice([CurrencyType.USD, CurrencyType.EUR])
                row.projected_amount = _money(rng, 1, 500)
        rows.append(row)
    return rows


def _overrides(rng: random.Random, card: Account, first: date, last: date) -> dict:
    """Printed dues on about a fifth of the card's closes, a few days off the computed one."""
    out = {}
    if engine.resolve_cycle_fields(card) is None:
        return out
    for cycle in engine.iter_cycles_from(card, first, datetime.min, through=last,
                                         due_overrides={}):
        if rng.random() < 0.2:
            close = cycle["close"].date()
            due = cycle["computed_due"].date() + timedelta(days=rng.randint(-3, 3))
            out[close] = max(due, close + timedelta(days=1))
    return out


def _todays(rng: random.Random, card: Account, first: date, last: date) -> list:
    """Ten days: a close, the day after one, month ends, a leap day, and spread days."""
    closes = [c["close"].date() for c in engine.iter_cycles_from(
        card, first, datetime.min, through=last, due_overrides={})] or [first]
    close = rng.choice(closes)
    picks = [close, close + timedelta(days=1), date(2024, 2, 29), date(2025, 2, 28),
             date(2024, 4, 30), date(2025, 1, 31), first - timedelta(days=3),
             last + timedelta(days=rng.randint(0, 40))]
    picks += [first + timedelta(days=rng.randint(0, max((last - first).days, 1)))
              for _ in range(2)]
    return picks


def _projected(rng: random.Random, today: date) -> list:
    """Projected lines (budget entries on the card) around ``today``."""
    out = []
    for _ in range(rng.randint(0, 6)):
        kind = rng.choice([TransactionType.DEBIT, TransactionType.DEBIT, TransactionType.CREDIT])
        line = SimpleNamespace(
            transaction_date=datetime.combine(today, time()) + timedelta(days=rng.randint(-40, 80)),
            amount=_money(rng, 10, 5000), transaction_type=kind)
        if rng.random() < 0.3:
            line.settles_as_recorded = True
        if rng.random() < 0.2:
            line.estimate = {"original_amount": Decimal("10.00"), "original_currency": "USD",
                             "rate": _fx().rate("USD", "PHP")}
        out.append(line)
    return out


def _card_rows(rows: list, card_ids) -> dict:
    """``statements._card_rows``'s grouping, without a database."""
    by_card = {cid: [] for cid in card_ids}
    for txn in rows:
        touched = {txn.account_id}
        if txn.transaction_type == TransactionType.TRANSFER:
            touched |= {txn.transfer_to_account_id, txn.transfer_from_account_id}
        for cid in touched & set(card_ids):
            by_card[cid].append(txn)
    return by_card


def _strip(statement: dict) -> dict:
    return {k: v for k, v in statement.items() if k not in ("lines", "unconverted")}


def _check(label: str, card: Account, rows: list, overrides: dict, todays: list,
           rng: random.Random) -> int:
    """Every comparison for one card history; returns the statements compared."""
    unbilled = frozenset({UNBILLED_CARD})
    card_rows = (_card_rows(rows, [card.id]), unbilled)
    viewable = [card.id, CASH, OTHER_CARD, UNBILLED_CARD]
    compared = 0
    for day in todays:
        at = datetime.combine(day, time())
        where = f"{label} today={day.isoformat()}"
        ref = reference.statement_history(None, card, at, viewable, fx=_fx(),
                                          card_rows=card_rows, due_overrides=overrides)
        history = engine.statement_history(None, card, at, viewable, fx=_fx(),
                                           card_rows=card_rows, due_overrides=overrides)
        assert repr(history) == repr(ref), f"statement_history differs: {where}"
        summaries = engine.statement_summaries(None, card, at, viewable, fx=_fx(),
                                               card_rows=card_rows, due_overrides=overrides)
        assert repr(summaries) == repr([_strip(s) for s in ref]), \
            f"statement_summaries differs: {where}"
        for statement in ref:
            lines = engine.statement_lines(None, card, statement["close"].date(), at, viewable,
                                           fx=_fx(), card_rows=card_rows)
            expected = {"lines": statement["lines"], "unconverted": statement["unconverted"]}
            assert repr(lines) == repr(expected), \
                f"statement_lines differs: {where} close={statement['close'].date()}"
        compared += len(ref)

        projected = {card.id: _projected(rng, day)}
        for days in (30, 90):
            end = at + timedelta(days=days)
            args = ([card], card_rows[0], at, end, unbilled)
            ref_events = reference.build_statement_payables(
                *args, projected_by_card=projected,
                normalise=lambda c, lines: reference.normalise_lines(None, c, lines, _fx()),
                due_overrides_by_card={card.id: overrides})
            events = engine.build_statement_payables(
                *args, projected_by_card=projected,
                normalise=lambda c, lines: engine.normalise_lines(None, c, lines, _fx()),
                due_overrides_by_card={card.id: overrides})
            assert repr(events) == repr(ref_events), \
                f"build_statement_payables differs: {where} window={days}d"
            # Without normalise (the default), every stored amount is used as it is.
            plain = ([card], card_rows[0], at, end, unbilled)
            assert repr(engine.build_statement_payables(*plain, projected_by_card=projected)) \
                == repr(reference.build_statement_payables(*plain, projected_by_card=projected)), \
                f"build_statement_payables (no normalise) differs: {where} window={days}d"
    return compared


@pytest.mark.parametrize("seed", SEEDS)
def test_random_history_equals_reference(seed):
    rng = random.Random(seed)
    card = _card(rng, CARD)
    start = datetime(rng.choice([2023, 2024, 2025]), rng.randint(1, 12), rng.randint(1, 28))
    span = rng.randint(20, 900)
    last = (start + timedelta(days=span)).date()
    rows = _history(rng, card, start, span, rng.randint(0, 120), horizon=last)
    overrides = _overrides(rng, card, start.date() - timedelta(days=40),
                           last + timedelta(days=200))
    _check(f"seed={seed}", card, rows, overrides,
           _todays(rng, card, start.date(), last), rng)


def test_realistic_history_equals_reference():
    """Three years, about 2,000 rows on a card closing on the 31st (clamped in
    every short month, including two Februaries and the 2024 leap day)."""
    rng = random.Random(20261113)
    card = Account(id=CARD, name="Card 31", account_type=AccountType.CREDIT,
                   currency=CurrencyType.PHP, billing_cycle_start=31, due_date=None,
                   days_until_due_date=21, payment_account_id=CASH)
    start = datetime(2023, 11, 13)
    span = 3 * 365
    last = (start + timedelta(days=span)).date()
    rows = _history(rng, card, start, span, 2000, horizon=last)
    overrides = _overrides(rng, card, start.date(), last + timedelta(days=60))
    compared = _check("realistic", card, rows, overrides,
                      _todays(rng, card, start.date(), last), rng)
    assert compared > 300  # every cycle of three years, on most of the ten days


def test_two_cards_sharing_rows_equal_reference():
    """A cash advance from one card paid into another is a line on the first and
    a payment on the second; both cards' statements equal the reference."""
    rng = random.Random(4242)
    first = _card(rng, CARD, realistic=True)
    second = Account(id=OTHER_CARD, name="Card 2", account_type=AccountType.CREDIT,
                     currency=CurrencyType.PHP, billing_cycle_start=29, due_date=None,
                     days_until_due_date=None, payment_account_id=CASH)
    start = datetime(2024, 1, 5)
    rows = _history(rng, first, start, 500, 300, horizon=date(2025, 5, 20))
    rows += [row for row in _history(rng, second, start, 500, 200, horizon=date(2025, 5, 20))]
    for k, row in enumerate(rows):
        row.id = k + 1
    for card in (first, second):
        _check(f"two-cards card={card.id}", card, rows,
               _overrides(rng, card, start.date(), date(2025, 9, 1)),
               _todays(rng, card, start.date(), date(2025, 5, 20)), rng)


def test_statement_lines_of_a_close_outside_the_cycles():
    """Not a close of the card, or a card without cycle settings: None."""
    card = Account(id=CARD, name="Card", account_type=AccountType.CREDIT,
                   currency=CurrencyType.PHP, billing_cycle_start=31, due_date=None,
                   days_until_due_date=21)
    at = datetime(2024, 3, 10)
    rows = (_card_rows([], [CARD]), frozenset())
    assert engine.statement_lines(None, card, date(2024, 2, 28), at, [], card_rows=rows) is None
    assert engine.statement_lines(None, card, date(2024, 2, 29), at, [], card_rows=rows) == {
        "lines": [], "unconverted": []}
    bare = Account(id=CARD, name="Card", account_type=AccountType.CREDIT,
                   currency=CurrencyType.PHP, billing_cycle_start=None, due_date=None)
    assert engine.statement_lines(None, bare, date(2024, 2, 29), at, [], card_rows=rows) is None

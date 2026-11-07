"""Unit tests for credit-card statement modelling (pure, no database).

The headline case is the owner's real shape: a card closing on the 24th with a
21-day grace period, whose SOA line items sum to the statement balance, paid from
the biweekly payroll account with the main checking account as overflow.
"""
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace


from app.models.transaction import TransactionType
from app.services.statements import (
    allocate_payments,
    build_statement_payables,
    iter_cycles_from,
    resolve_cycle_fields,
    statement_balance,
    statement_close,
    statement_due_date,
    statement_history,
)

# The day statement balances below are read on (``statement_balance``'s ``today``).
TODAY = date(2026, 8, 1)


def _card(**kw):
    base = dict(
        id=1,
        name="Metrobank CC",
        billing_cycle_start=24,
        days_until_due_date=21,
        due_date=None,
        payment_account_id=10,
        payment_overflow_account_id=20,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _txn(day, amount, kind=TransactionType.DEBIT, month=7, year=2026):
    return SimpleNamespace(
        transaction_date=datetime(year, month, day),
        amount=Decimal(str(amount)),
        transaction_type=kind,
    )


def _pay(day, amount, month=7, year=2026, card_id=1, from_account=10):
    """A transfer from a bank account into the card: a card payment."""
    return SimpleNamespace(
        transaction_date=datetime(year, month, day),
        amount=Decimal(str(amount)),
        transaction_type=TransactionType.TRANSFER,
        account_id=from_account,
        transfer_from_account_id=from_account,
        transfer_to_account_id=card_id,
    )


# ---------------------------------------------------------------------------
# Cycle resolution
# ---------------------------------------------------------------------------

def test_billing_cycle_start_is_the_close_day():
    assert resolve_cycle_fields(_card()) == (24, 21)


def test_days_until_due_defaults_to_21_when_unset():
    assert resolve_cycle_fields(_card(days_until_due_date=None)) == (24, 21)


def test_legacy_due_date_only_works_backwards_to_a_close_day():
    """A card with only due_date=14 and a 21-day grace closes on the 24th."""
    card = _card(billing_cycle_start=None, due_date=14, days_until_due_date=21)
    close_day, days = resolve_cycle_fields(card)
    assert days == 21
    assert close_day == 24
    # Round-trips: close 24 Jul + 21d == due 14 Aug.
    assert (datetime(2026, 7, close_day) + __import__("datetime").timedelta(days=days)).day == 14


def test_billing_cycle_start_wins_over_legacy_due_date():
    card = _card(billing_cycle_start=24, due_date=1)
    assert resolve_cycle_fields(card) == (24, 21)


def test_card_with_no_cycle_fields_is_unmodellable():
    assert resolve_cycle_fields(_card(billing_cycle_start=None, due_date=None)) is None


def test_unmodellable_card_yields_no_cycles():
    card = _card(billing_cycle_start=None, due_date=None)
    assert list(iter_cycles_from(card, date(2026, 7, 1), datetime(2026, 10, 1), due_overrides={})) == []


# ---------------------------------------------------------------------------
# Cycle windows
# ---------------------------------------------------------------------------

def test_cycle_window_and_due_date_for_the_worked_example():
    """Close 24 Jul -> due 14 Aug, covering charges from 25 Jun to 24 Jul."""
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 1), datetime(2026, 8, 31),
                                   due_overrides={}))
    assert len(cycles) == 1
    cycle = cycles[0]
    assert cycle["close"] == datetime(2026, 7, 24)
    assert cycle["due"] == datetime(2026, 8, 14)
    assert cycle["window_start"] == datetime(2026, 6, 24)


def test_walk_starts_at_the_cycle_containing_the_first_day():
    """A first line item after the close day belongs to the next month's cycle."""
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 25), datetime(2026, 10, 1),
                                   due_overrides={}))
    assert [c["close"] for c in cycles] == [datetime(2026, 8, 24)]


def test_due_date_on_the_window_end_is_excluded():
    """Window is half-open [start, end), consistent with the rest of the engine."""
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 1), datetime(2026, 8, 14),
                                   due_overrides={}))
    assert cycles == []


def test_multiple_cycles_across_a_longer_window():
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 1), datetime(2026, 11, 1),
                                   due_overrides={}))
    assert [c["due"] for c in cycles] == [
        datetime(2026, 8, 14),
        datetime(2026, 9, 14),
        datetime(2026, 10, 15),  # 24 Sep + 21d
    ]


def test_close_day_clamps_to_short_months():
    """Day 31 must not explode on February."""
    card = _card(billing_cycle_start=31, days_until_due_date=21)
    cycles = list(iter_cycles_from(card, date(2027, 2, 1), datetime(2027, 3, 31),
                                   due_overrides={}))
    assert cycles[0]["close"] == datetime(2027, 2, 28)


# ---------------------------------------------------------------------------
# Banking-day roll: a due on a weekend or PH holiday moves to the next banking
# day; the close and the window never move.
# ---------------------------------------------------------------------------

def _card_a():
    """Closes on the 4th, due 25 days later."""
    return _card(name="Card A", billing_cycle_start=4, days_until_due_date=25,
                 currency="PHP")


def _cycle_closing(card, close, due_overrides=None):
    return next(c for c in iter_cycles_from(card, close, datetime.min, through=close,
                                            due_overrides=due_overrides or {})
                if c["close"].date() == close)


def test_card_a_nov_2026_due_rolls_past_bonifacio_day():
    """4 Nov + 25d is Sunday 29 Nov; Monday 30 Nov is Bonifacio Day."""
    cycle = _cycle_closing(_card_a(), date(2026, 11, 4))
    assert cycle == {
        "window_start": datetime(2026, 10, 4),
        "close": datetime(2026, 11, 4),
        "due": datetime(2026, 12, 1),
        "computed_due": datetime(2026, 12, 1),
        "due_overridden": False,
    }


def test_card_c_nov_2026_due_unchanged():
    """2 Nov + 21d is Monday 23 Nov, a banking day. The close stays on All
    Souls' Day, itself a PH special non-working day."""
    card = _card(name="Card C", billing_cycle_start=2, days_until_due_date=21)
    cycle = _cycle_closing(card, date(2026, 11, 2))
    assert cycle["close"] == datetime(2026, 11, 2)
    assert cycle["due"] == datetime(2026, 11, 23)


def test_roll_never_moves_close_or_window():
    for close_day, days in ((4, 25), (2, 21), (24, 21), (31, 21), (5, 20)):
        card = _card(billing_cycle_start=close_day, days_until_due_date=days)
        cycles = list(iter_cycles_from(card, date(2026, 1, 1), datetime(2028, 3, 1),
                                       due_overrides={}))
        assert len(cycles) >= 24
        for cycle in cycles:
            close, start = cycle["close"], cycle["window_start"]
            assert close.day == min(close_day, monthrange(close.year, close.month)[1])
            assert start.day == min(close_day, monthrange(start.year, start.month)[1])
            assert (close.year * 12 + close.month) - (start.year * 12 + start.month) == 1
            unrolled = close + timedelta(days=days)
            assert unrolled <= cycle["due"] <= unrolled + timedelta(days=6)
        dues = [c["due"] for c in cycles]
        assert dues == sorted(set(dues))


def test_payable_dated_on_rolled_due():
    card = _card_a()
    txns = {1: [_txn(20, "1000.00", month=10)]}  # 20 Oct, in the 4 Nov statement
    events = build_statement_payables([card], txns, datetime(2026, 11, 5), datetime(2026, 12, 2))
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 12, 1), Decimal("-1000.00"))]
    assert build_statement_payables([card], txns, datetime(2026, 11, 5),
                                    datetime(2026, 12, 1)) == []


def test_history_status_open_on_computed_due_weekend():
    """On Bonifacio Day the 4 Nov statement (computed due Sunday 29 Nov) is not late."""
    card = _card_a()
    row = _txn(20, "1000.00", month=10)
    history = statement_history(None, card, datetime(2026, 11, 30), [card.id],
                                card_rows=({card.id: [row]}, frozenset()), due_overrides={})
    nov = next(s for s in history if s["close"] == datetime(2026, 11, 4))
    assert nov["due"] == datetime(2026, 12, 1)
    assert nov["status"] == "open"


# ---------------------------------------------------------------------------
# Due overrides: the due the bank printed on one statement replaces its rolled
# due; the close and the window never move.
# ---------------------------------------------------------------------------

NOV_4 = date(2026, 11, 4)


def test_due_override_replaces_rolled_due():
    cycle = _cycle_closing(_card_a(), NOV_4, {NOV_4: date(2026, 12, 2)})
    assert cycle["due"] == datetime(2026, 12, 2)
    assert cycle["computed_due"] == datetime(2026, 12, 1)
    assert cycle["due_overridden"] is True
    # Only that statement: the next one keeps its rolled due.
    following = _cycle_closing(_card_a(), date(2026, 12, 4), {NOV_4: date(2026, 12, 2)})
    assert following["due"] == following["computed_due"]
    assert following["due_overridden"] is False


def test_due_override_is_not_rolled():
    """Saturday 5 Dec 2026 is kept as printed, not moved to Monday."""
    saturday = date(2026, 12, 5)
    assert saturday.weekday() == 5
    cycle = _cycle_closing(_card_a(), NOV_4, {NOV_4: saturday})
    assert cycle["due"] == datetime(2026, 12, 5)
    assert statement_due_date(_card_a(), date(2026, 10, 20),
                              due_overrides={NOV_4: saturday}) == datetime(2026, 12, 5)


def test_due_override_leaves_close_and_window_unchanged():
    card = _card_a()
    plain = list(iter_cycles_from(card, date(2026, 9, 1), datetime.min, through=date(2027, 2, 1),
                                  due_overrides={}))
    overridden = list(iter_cycles_from(card, date(2026, 9, 1), datetime.min,
                                       through=date(2027, 2, 1),
                                       due_overrides={NOV_4: date(2026, 12, 3)}))
    assert [(c["window_start"], c["close"], c["computed_due"]) for c in plain] == [
        (c["window_start"], c["close"], c["computed_due"]) for c in overridden]
    assert [c["due"] for c in overridden if c["due_overridden"]] == [datetime(2026, 12, 3)]


def test_payables_dated_on_due_override():
    card = _card_a()
    txns = {1: [_txn(20, "1000.00", month=10)]}  # 20 Oct, in the 4 Nov statement
    overrides = {1: {NOV_4: date(2026, 12, 3)}}
    events = build_statement_payables([card], txns, datetime(2026, 11, 5), datetime(2026, 12, 4),
                                      due_overrides_by_card=overrides)
    assert [(e["date"], e["amount"], e["statement_close"]) for e in events] == [
        (datetime(2026, 12, 3), Decimal("-1000.00"), datetime(2026, 11, 4))]
    # Due on the window end: outside it, though the rolled due (1 Dec) is inside.
    assert build_statement_payables([card], txns, datetime(2026, 11, 5), datetime(2026, 12, 3),
                                    due_overrides_by_card=overrides) == []
    # Overdue: emitted on the start, its printed due as the original date.
    (late,) = build_statement_payables([card], txns, datetime(2026, 12, 4), datetime(2026, 12, 20),
                                       due_overrides_by_card=overrides)
    assert (late["date"], late["original_date"]) == (datetime(2026, 12, 4), datetime(2026, 12, 3))


def test_due_overrides_keyword_is_required():
    import pytest

    with pytest.raises(TypeError):
        list(iter_cycles_from(_card_a(), NOV_4, datetime.min, through=NOV_4))
    with pytest.raises(TypeError):
        list(iter_cycles_from(_card_a(), NOV_4, datetime.min, NOV_4, {}))
    with pytest.raises(TypeError):
        statement_due_date(_card_a(), NOV_4)


def test_statement_close_helper():
    card = _card_a()
    assert statement_close(card, date(2026, 11, 4)) == date(2026, 11, 4)
    assert statement_close(card, date(2026, 10, 5)) == date(2026, 11, 4)
    assert statement_close(card, date(2026, 11, 5)) == date(2026, 12, 4)
    # Clamped to short months, as the walk clamps it.
    end_of_month = _card(billing_cycle_start=31)
    assert statement_close(end_of_month, date(2027, 2, 1)) == date(2027, 2, 28)
    assert statement_close(end_of_month, date(2027, 2, 28)) == date(2027, 2, 28)
    assert statement_close(end_of_month, date(2027, 3, 1)) == date(2027, 3, 31)
    assert statement_close(end_of_month, date(2028, 2, 29)) == date(2028, 2, 29)
    # A legacy card (due day 14, 21 days) closes on the 24th.
    legacy = _card(billing_cycle_start=None, due_date=14, days_until_due_date=21)
    assert statement_close(legacy, date(2026, 7, 24)) == date(2026, 7, 24)
    assert statement_close(legacy, date(2026, 7, 25)) == date(2026, 8, 24)
    assert statement_close(_card(billing_cycle_start=None, due_date=None), NOV_4) is None
    # The walk agrees on every day of two years.
    for day in (date(2026, 1, 1) + timedelta(days=n) for n in range(731)):
        for c in (card, end_of_month, legacy):
            walked = next(iter_cycles_from(c, day, datetime.min, through=day, due_overrides={}))
            assert statement_close(c, day) == walked["close"].date()


# ---------------------------------------------------------------------------
# Statement balance
# ---------------------------------------------------------------------------

def test_balance_sums_purchases_in_the_window():
    txns = [_txn(1, "1000.50"), _txn(15, "2000.25"), _txn(24, "300.25")]
    total = statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY)
    assert total == Decimal("3301.00")


def test_balance_excludes_charges_outside_the_window():
    txns = [
        _txn(24, "500.00", month=6),   # on the previous close -> previous statement
        _txn(25, "100.00", month=6),   # first day of this cycle -> counts
        _txn(25, "700.00", month=7),   # after this close -> next statement
    ]
    total = statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY)
    assert total == Decimal("100.00")


def test_window_is_exclusive_at_start_and_inclusive_at_close():
    """A charge exactly on the previous close belongs to the PREVIOUS statement."""
    on_prev_close = [_txn(24, "999.00", month=6)]
    assert statement_balance(on_prev_close, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("0")

    on_close = [_txn(24, "999.00", month=7)]
    assert statement_balance(on_close, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("999.00")


def test_midday_charge_on_the_closing_day_belongs_to_that_statement():
    """Close is midnight of the 24th, but the whole 24th is inside the statement."""
    noon_on_close = [_txn(24, "12000.00")]
    noon_on_close[0].transaction_date = datetime(2026, 7, 24, 12)
    assert statement_balance(noon_on_close, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("12000.00")
    # ...and therefore NOT in the next one.
    assert statement_balance(noon_on_close, datetime(2026, 7, 24), datetime(2026, 8, 24), today=TODAY) == Decimal("0")


def test_midday_charge_on_the_previous_closing_day_belongs_to_the_previous_statement():
    noon_on_prev_close = [_txn(24, "500.00", month=6)]
    noon_on_prev_close[0].transaction_date = datetime(2026, 6, 24, 12)
    assert statement_balance(noon_on_prev_close, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("0")
    assert statement_balance(noon_on_prev_close, datetime(2026, 5, 24), datetime(2026, 6, 24), today=TODAY) == Decimal("500.00")


def test_midday_closing_day_charge_is_payable_on_that_statements_due_date():
    """Repro: 12,000 at noon on 24 Jul is due 14 Aug, not 14 Sep."""
    txns = {1: [_txn(24, "12000.00")]}
    txns[1][0].transaction_date = datetime(2026, 7, 24, 12)
    events = build_statement_payables([_card()], txns, datetime(2026, 8, 1), datetime(2026, 10, 1))
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 8, 14), Decimal("-12000.00")),
    ]


def test_refunds_reduce_the_balance():
    txns = [_txn(5, "1000.00"), _txn(10, "250.00", kind=TransactionType.CREDIT)]
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("750.00")


def test_transfers_are_not_line_items():
    """A payment is netted against statements by allocation, not summed as a line."""
    txns = [_txn(5, "1000.00"), _pay(10, "1000.00")]
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("1000.00")


def test_balance_is_decimal_exact():
    """Three 0.10 charges must be exactly 0.30, not 0.30000000000000004."""
    txns = [_txn(1, "0.10"), _txn(2, "0.10"), _txn(3, "0.10")]
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24), today=TODAY) == Decimal("0.30")


# ---------------------------------------------------------------------------
# Payable events
# ---------------------------------------------------------------------------

def test_payable_carries_amount_date_and_routing():
    card = _card()
    txns = {1: [_txn(1, "40000.00"), _txn(20, "2310.00")]}
    events = build_statement_payables([card], txns, datetime(2026, 8, 1), datetime(2026, 8, 31))

    assert len(events) == 1
    ev = events[0]
    assert ev["date"] == datetime(2026, 8, 14)
    assert ev["amount"] == Decimal("-42310.00")   # negative == outflow
    assert ev["name"] == "Metrobank CC statement"
    assert ev["source"] == "statement"
    assert ev["source_id"] == card.id
    assert ev["funding_account_id"] == 10
    assert ev["overflow_account_id"] == 20


def test_zero_balance_cycle_produces_no_payable():
    events = build_statement_payables([_card()], {1: []}, datetime(2026, 8, 1), datetime(2026, 8, 31))
    assert events == []


def test_net_credit_cycle_produces_no_payable():
    """A card in credit (refunds exceed charges) isn't a payable."""
    txns = {1: [_txn(5, "100.00"), _txn(10, "500.00", kind=TransactionType.CREDIT)]}
    events = build_statement_payables([_card()], txns, datetime(2026, 8, 1), datetime(2026, 8, 31))
    assert events == []


def test_card_without_routing_still_produces_an_aggregate_payable():
    card = _card(payment_account_id=None, payment_overflow_account_id=None)
    txns = {1: [_txn(5, "500.00")]}
    events = build_statement_payables([card], txns, datetime(2026, 8, 1), datetime(2026, 8, 31))
    assert len(events) == 1
    assert events[0]["funding_account_id"] is None


def test_multiple_cards_each_get_their_own_payable():
    """Cards on different cycles produce independently dated payables."""
    a = _card(id=1, name="Metrobank CC", billing_cycle_start=24)                    # closes 24 Jul, due 14 Aug
    b = _card(id=2, name="BPI CC", billing_cycle_start=5, days_until_due_date=20)   # closes 5 Aug, due 25 Aug
    txns = {
        1: [_txn(10, "1000.00")],              # 10 Jul, inside (24 Jun .. 24 Jul]
        2: [_txn(10, "2000.00")],              # 10 Jul, inside (5 Jul .. 5 Aug]
    }
    events = build_statement_payables([a, b], txns, datetime(2026, 8, 1), datetime(2026, 9, 1))
    by_name = {e["name"]: e for e in events}
    assert by_name["Metrobank CC statement"]["date"] == datetime(2026, 8, 14)
    assert by_name["Metrobank CC statement"]["amount"] == Decimal("-1000.00")
    assert by_name["BPI CC statement"]["date"] == datetime(2026, 8, 25)  # 5 Aug + 20d
    assert by_name["BPI CC statement"]["amount"] == Decimal("-2000.00")


# ---------------------------------------------------------------------------
# Payments netted against statements
#
# The card closes on the 24th, due 21 days later: the 10 Jul charge is on the
# 24 Jul statement, due 14 Aug.
# ---------------------------------------------------------------------------

AUG, SEP = datetime(2026, 8, 1), datetime(2026, 9, 1)


def _owed(rows, start=AUG, end=SEP):
    return [(e["date"], e["amount"]) for e in build_statement_payables([_card()], {1: rows}, start, end)]


def test_full_payment_leaves_no_payable():
    assert _owed([_txn(10, "12000.00"), _pay(10, "12000.00", month=8)]) == []


def test_partial_payment_leaves_the_remainder():
    assert _owed([_txn(10, "12000.00"), _pay(10, "5000.00", month=8)]) == [
        (datetime(2026, 8, 14), Decimal("-7000.00")),
    ]


def test_early_payment_after_close_nets_the_statement():
    assert _owed([_txn(10, "12000.00"), _pay(26, "12000.00")]) == []


def test_payment_before_close_nets_the_statement_it_is_dated_in():
    """Paid 20 Jul, before the 24 Jul close: still pays that statement."""
    assert _owed([_txn(10, "12000.00"), _pay(20, "12000.00")]) == []


def test_late_full_payment_nets_the_statement():
    """Paid 20 Aug, after the 14 Aug due date: the statement is still paid."""
    assert _owed([_txn(10, "12000.00"), _pay(20, "12000.00", month=8)]) == []


def test_late_partial_payment_leaves_the_remainder():
    assert _owed([_txn(10, "12000.00"), _pay(20, "4000.00", month=8)]) == [
        (datetime(2026, 8, 14), Decimal("-8000.00")),
    ]


def test_payment_outside_the_window_still_nets_its_statement():
    """A payment dated after the window end is an allocation, not a window event."""
    assert _owed([_txn(10, "12000.00"), _pay(5, "12000.00", month=10)]) == []


def test_incoming_bank_transfer_is_a_payment_via_transfer_to_account_id():
    """The row's account_id is the bank account; only transfer_to names the card."""
    pay = _pay(10, "3000.00", month=8, from_account=99)
    assert pay.account_id == 99
    assert _owed([_txn(10, "12000.00"), pay]) == [(datetime(2026, 8, 14), Decimal("-9000.00"))]


def test_transfer_into_another_card_does_not_pay_this_one():
    assert _owed([_txn(10, "12000.00"), _pay(10, "12000.00", month=8, card_id=2)]) == [
        (datetime(2026, 8, 14), Decimal("-12000.00")),
    ]


def test_each_payment_is_consumed_once_oldest_outstanding_statement_first():
    """1,500 paid after two statements of 1,000 (Jul) and 2,000 (Aug) clears July
    and leaves 1,500 on August; it is not applied to August in full as well."""
    rows = [_txn(10, "1000.00"), _txn(10, "2000.00", month=8), _pay(1, "1500.00", month=9)]
    assert _owed(rows, start=AUG, end=datetime(2026, 10, 1)) == [
        (datetime(2026, 9, 14), Decimal("-1500.00")),
    ]


def test_overpayment_carries_to_the_next_statement():
    rows = [_txn(10, "1000.00"), _txn(10, "2000.00", month=8), _pay(10, "1800.00", month=8)]
    assert _owed(rows, start=AUG, end=datetime(2026, 10, 1)) == [
        (datetime(2026, 9, 14), Decimal("-1200.00")),
    ]


def test_payment_dated_in_the_window_settles_an_older_unpaid_statement_first():
    """June's 500 (due 15 Jul, before the window) is still owed; an August payment of
    500 settles it, so July's statement stays owed in full."""
    rows = [_txn(10, "500.00", month=6), _txn(10, "12000.00"), _pay(10, "500.00", month=8)]
    assert _owed(rows) == [(datetime(2026, 8, 14), Decimal("-12000.00"))]


def test_allocate_payments_oldest_first():
    """The -50 statement's credit pays like a payment: 150 + 30 + 50 against 300."""
    assert allocate_payments(
        [Decimal("100"), Decimal("0"), Decimal("-50"), Decimal("200")],
        [Decimal("150"), Decimal("30")],
    ) == [Decimal("0"), Decimal("0"), Decimal("0"), Decimal("70")]


def test_net_credit_statement_carries_to_the_next_statement():
    """July nets -400 (refund beyond its charges): August's 1,000 owes 600."""
    rows = [_txn(5, "100.00"), _txn(10, "500.00", kind=TransactionType.CREDIT),
            _txn(10, "1000.00", month=8)]
    assert _owed(rows, start=AUG, end=datetime(2026, 10, 1)) == [
        (datetime(2026, 9, 14), Decimal("-600.00")),
    ]


def test_net_credit_statement_pays_an_older_outstanding_statement_first():
    """June's 500 is unpaid; July's -200 credit leaves 300 of it overdue on 1 Aug."""
    rows = [_txn(10, "500.00", month=6), _txn(10, "200.00", kind=TransactionType.CREDIT)]
    assert _owed(rows) == [(AUG, Decimal("-300.00"))]


# ---------------------------------------------------------------------------
# Overdue statements
# ---------------------------------------------------------------------------

def test_unpaid_statement_due_before_the_window_is_overdue_on_the_window_start():
    start = datetime(2026, 8, 20)
    events = build_statement_payables([_card()], {1: [_txn(10, "12000.00")]}, start, SEP)
    assert [(e["date"], e["amount"], e["overdue"], e["original_date"]) for e in events] == [
        (start, Decimal("-12000.00"), True, datetime(2026, 8, 14)),
    ]


def test_partly_paid_overdue_statement_carries_the_remainder():
    start = datetime(2026, 8, 20)
    rows = [_txn(10, "12000.00"), _pay(10, "9000.00", month=8)]
    events = build_statement_payables([_card()], {1: rows}, start, SEP)
    assert [(e["date"], e["amount"], e["overdue"]) for e in events] == [
        (start, Decimal("-3000.00"), True),
    ]


def test_paid_statement_due_before_the_window_is_not_overdue():
    rows = [_txn(10, "12000.00"), _pay(14, "12000.00", month=8)]
    assert build_statement_payables([_card()], {1: rows}, datetime(2026, 8, 20), SEP) == []


def test_in_window_statement_is_not_marked_overdue():
    (ev,) = build_statement_payables([_card()], {1: [_txn(10, "12000.00")]}, AUG, SEP)
    assert "overdue" not in ev and "original_date" not in ev


# ---------------------------------------------------------------------------
# Cash advances
# ---------------------------------------------------------------------------

def test_cash_advance_is_billed_with_its_fee_on_the_statement_containing_it():
    advance = _pay(10, "3000.00", from_account=1, card_id=10)
    advance.transfer_fee = Decimal("50.00")
    assert _owed([advance]) == [(datetime(2026, 8, 14), Decimal("-3050.00"))]


def test_balance_transfer_charges_the_source_card_and_pays_the_destination():
    move = _pay(10, "2000.00", from_account=1, card_id=2)
    other = _card(id=2, name="BPI CC")
    events = build_statement_payables(
        [_card(), other],
        {1: [move], 2: [_txn(5, "2000.00"), move]},
        AUG, SEP,
    )
    assert [(e["name"], e["amount"]) for e in events] == [
        ("Metrobank CC statement", Decimal("-2000.00")),
    ]


# ---------------------------------------------------------------------------
# Payments from a card without statements
# ---------------------------------------------------------------------------

def _from_unbilled_card(posted=False):
    """12,000 charged on card 1, then 'paid' by a transfer from card 2, which has
    no cycle settings and so no statement that would ever bill the transfer."""
    unbilled = _card(id=2, name="Store card", billing_cycle_start=None, due_date=None)
    move = _pay(10, "12000.00", month=8, from_account=2)
    move.is_posted = posted
    return unbilled, [_txn(10, "12000.00"), move]


def test_payment_from_a_card_without_statements_does_not_net_the_billed_card():
    unbilled, rows = _from_unbilled_card()
    events = build_statement_payables([_card(), unbilled], {1: rows, 2: rows[1:]}, AUG, SEP)
    assert [(e["name"], e["date"], e["amount"]) for e in events] == [
        ("Metrobank CC statement", datetime(2026, 8, 14), Decimal("-12000.00")),
    ]


def test_posted_payment_from_a_card_without_statements_does_not_net_the_billed_card():
    unbilled, rows = _from_unbilled_card(posted=True)
    events = build_statement_payables([_card(), unbilled], {1: rows, 2: rows[1:]}, AUG, SEP)
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 8, 14), Decimal("-12000.00")),
    ]


def test_payment_from_an_unbilled_card_outside_the_cards_list_does_not_net():
    """The source card is another user's (or inactive), so it is not in ``cards``:
    the caller names it as unbilled from the account itself."""
    _, rows = _from_unbilled_card()
    events = build_statement_payables([_card()], {1: rows}, AUG, SEP,
                                      unbilled_sources=frozenset({2}))
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 8, 14), Decimal("-12000.00")),
    ]


# ---------------------------------------------------------------------------
# Window independence
#
# A net-credit cycle due after the window still pays older statements, so a
# payable inside a window must not depend on how far the window reaches.
# ---------------------------------------------------------------------------

def test_refund_in_a_cycle_due_after_the_window_still_pays_the_older_statement():
    """1,000 charged 10 Jul, refunded 28 Jul (the 24 Aug statement, due 14 Sep):
    the 14 Aug statement is settled even in a window ending before 14 Sep."""
    rows = [_txn(10, "1000.00"), _txn(28, "1000.00", kind=TransactionType.CREDIT)]
    assert build_statement_payables([_card()], {1: rows}, AUG, SEP) == []
    assert build_statement_payables([_card()], {1: rows}, AUG, datetime(2026, 10, 1)) == []


def _payables(rows, end, projected=(), start=AUG):
    """Payables for a window whose caller projected the occurrences dated before ``end``."""
    projected = [row for row in projected if row.transaction_date < end]
    return [(e["date"], e["amount"], e.get("overdue", False))
            for e in build_statement_payables([_card()], {1: rows}, start, end,
                                              projected_by_card={1: projected})]


def _assert_window_independent(by_end):
    ends = sorted(by_end)
    for i, short in enumerate(ends):
        for long in ends[i + 1:]:
            assert [e for e in by_end[long] if e[0] < short] == by_end[short], (short, long)


def test_projected_charge_after_the_window_does_not_reopen_a_settled_statement():
    """July's 1,000 is refunded on 28 Aug (24 Sep statement), so July is settled. A
    projected 500 on 5 Sep is billed on its own cycle (due 15 Oct); it does not eat
    the refund that settled July and so leave 500 owed on 14 Aug."""
    rows = [_txn(10, "1000.00"), _txn(28, "1000.00", kind=TransactionType.CREDIT, month=8)]
    projected = [_txn(5, "500.00", month=9)]
    ends = [SEP, datetime(2026, 10, 1), datetime(2026, 11, 1)]
    by_end = {end: _payables(rows, end, projected) for end in ends}
    _assert_window_independent(by_end)
    assert by_end[SEP] == []
    assert by_end[datetime(2026, 11, 1)] == [(datetime(2026, 10, 15), Decimal("-500.00"), False)]


def test_projected_credit_after_a_due_date_does_not_pay_that_statement():
    """A 500 income scheduled on the card for 5 Sep comes after July's 14 Aug due
    date, so July's 1,000 is owed in full in every window."""
    rows = [_txn(10, "1000.00")]
    projected = [_txn(5, "500.00", kind=TransactionType.CREDIT, month=9)]
    ends = [SEP, datetime(2026, 10, 1), datetime(2026, 11, 1)]
    by_end = {end: _payables(rows, end, projected) for end in ends}
    _assert_window_independent(by_end)
    assert by_end[datetime(2026, 11, 1)] == [(datetime(2026, 8, 14), Decimal("-1000.00"), False)]


def _advance(day, amount, fee, month):
    row = _pay(day, amount, month=month, from_account=1, card_id=10)
    row.transfer_fee = Decimal(fee)
    return row


WINDOW_SCENARIO = [
    _txn(10, "5000.00"),                                     # 24 Jul statement
    _pay(20, "1000.00"),                                     # early, before the close
    _txn(28, "1000.00", kind=TransactionType.CREDIT),        # refund, 24 Aug statement
    _advance(5, "2000.00", "50.00", month=8),                # cash advance, 24 Aug
    _pay(20, "500.00", month=8),                             # late for the 14 Aug due date
    _txn(2, "3000.00", kind=TransactionType.CREDIT, month=9),  # net-credit 24 Sep cycle
    _txn(5, "400.00", month=10),                             # 24 Oct statement, due 14 Nov
    _pay(10, "700.00", month=11),                # planned, after the last statement's 14 Nov due date
]


# Budget-entry occurrences on the card, on either side of each window end.
WINDOW_PROJECTED = [
    _txn(20, "600.00", month=8),                              # 24 Aug statement
    _txn(30, "200.00", kind=TransactionType.CREDIT, month=8),  # before the 14 Sep due date
    _txn(3, "300.00", month=9),                               # 24 Sep statement
    _txn(28, "900.00", kind=TransactionType.CREDIT, month=9),  # before the 15 Oct due date
    _txn(2, "250.00", month=10),                              # 24 Oct statement
    _txn(30, "30.00", kind=TransactionType.CREDIT, month=10),  # before the 14 Nov due date
    _txn(3, "150.00", month=11),                              # 24 Nov statement, due 15 Dec
]

WINDOW_ENDS = [SEP, datetime(2026, 10, 1), datetime(2026, 11, 1), datetime(2026, 12, 1)]


def _window_events(end):
    return _payables(WINDOW_SCENARIO, end)


def test_payables_inside_a_window_do_not_depend_on_its_length():
    by_end = {end: _window_events(end) for end in WINDOW_ENDS}
    _assert_window_independent(by_end)
    # 5,000 + 1,050 charged, 3,000 + 1,000 credited, 2,200 paid: the 24 Jul
    # statement is settled and 850 of the 24 Aug one is left, due 14 Sep.
    assert by_end[datetime(2026, 12, 1)] == [
        (datetime(2026, 9, 14), Decimal("-850.00"), False),
        (datetime(2026, 11, 16), Decimal("-400.00"), False),  # 14 Nov is a Saturday
    ]


def test_window_independence_holds_with_projected_occurrences():
    by_end = {end: _payables(WINDOW_SCENARIO, end, WINDOW_PROJECTED) for end in WINDOW_ENDS}
    _assert_window_independent(by_end)
    # Recorded rows settle as above (850 left on 24 Aug, 400 on 24 Oct). Then the
    # projected charges: 24 Aug 1,450, 24 Sep 300, 24 Oct 650, 24 Nov 150. The 200
    # credit pays 24 Aug down to 1,250; the 900 clears 24 Sep and leaves 50 on
    # 24 Oct; the 30 leaves 20 there.
    assert by_end[datetime(2026, 12, 1)] == [
        (datetime(2026, 9, 14), Decimal("-1250.00"), False),
        (datetime(2026, 11, 16), Decimal("-20.00"), False),  # 14 Nov is a Saturday
    ]


def test_window_independence_holds_for_overdue_statements():
    """Starting after the 14 Aug due date, the overdue amount is window-independent."""
    start = datetime(2026, 8, 20)
    for projected in ((), WINDOW_PROJECTED):
        short = _payables(WINDOW_SCENARIO, SEP, projected, start=start)
        long = _payables(WINDOW_SCENARIO, datetime(2026, 12, 1), projected, start=start)
        assert short == [e for e in long if e[0] < SEP]


def test_today_keyword_is_required():
    """``today`` has no default and is keyword-only, so no caller can forget it."""
    import inspect

    import pytest

    from app.services.household import _settle_with_sources

    for fn in (statement_balance, _settle_with_sources):
        param = inspect.signature(fn).parameters["today"]
        assert param.kind is inspect.Parameter.KEYWORD_ONLY
        assert param.default is inspect.Parameter.empty
    with pytest.raises(TypeError):
        statement_balance([_txn(1, "1.00")], datetime(2026, 6, 24), datetime(2026, 7, 24))
    with pytest.raises(TypeError):
        statement_balance([_txn(1, "1.00")], datetime(2026, 6, 24), datetime(2026, 7, 24),
                          None, TODAY)


# ---------------------------------------------------------------------------
# Placing rows by their posted day (statement_day)
#
# "Card 5" closes on the 5th, due 20 days later, read on Saturday 7 Nov 2026
# unless a test says otherwise: the Nov 5 statement is closed, Dec 5 is open.
# ---------------------------------------------------------------------------

NOV_7 = date(2026, 11, 7)


def _card5():
    return _card(id=5, name="Card 5", billing_cycle_start=5, days_until_due_date=20,
                 currency="PHP")


def _row(day, amount="100.00", *, posted=True, posting=None, kind=TransactionType.DEBIT,
         month=11):
    return SimpleNamespace(transaction_date=datetime(2026, month, day),
                           amount=Decimal(amount), transaction_type=kind,
                           is_posted=posted, posting_date=posting)


def _history5(rows, today=NOV_7):
    card = _card5()
    return {s["close"].date(): s for s in statement_history(
        None, card, datetime.combine(today, datetime.min.time()), [card.id],
        card_rows=({card.id: rows}, frozenset()), due_overrides={})}


def _closes5(rows, today=NOV_7):
    """``{close: balance}`` of every statement in the history read on ``today``."""
    return {close: s["balance"] for close, s in _history5(rows, today).items()}


def test_statement_day_posted_without_posting_date():
    from app.services.statements import statement_day

    assert statement_day(_row(4), NOV_7) == date(2026, 11, 4)
    # A row without the fields at all (a projected line) is read the same way.
    assert statement_day(_txn(4, "1.00", month=11), NOV_7) == date(2026, 11, 4)
    assert _closes5([_row(4, "250.00")]) == {date(2026, 11, 5): Decimal("250.00"),
                                             date(2026, 12, 5): Decimal("0")}


def test_statement_day_reads_posting_date_as_manila_day():
    from datetime import timezone

    from app.core.time import manila_day
    from app.services.statements import statement_day

    # A pre-#85 click at 07:00 on Nov 6 in Manila was stored as Nov 5 23:00 UTC.
    instant = datetime(2026, 11, 5, 23, 0)
    assert manila_day(instant) == date(2026, 11, 6)
    assert manila_day(instant.replace(tzinfo=timezone.utc)) == date(2026, 11, 6)
    assert statement_day(_row(4, posting=instant), NOV_7) == date(2026, 11, 6)
    # Rows written since #85 are UTC midnight of the day: they keep it.
    midnight = datetime(2026, 11, 6)
    assert manila_day(midnight) == date(2026, 11, 6)
    assert statement_day(_row(4, posting=midnight), NOV_7) == date(2026, 11, 6)
    # Up to 15:59 UTC is still the same Manila day; 16:00 UTC is the next one.
    assert manila_day(datetime(2026, 11, 5, 15, 59)) == date(2026, 11, 5)
    assert manila_day(datetime(2026, 11, 5, 16, 0)) == date(2026, 11, 6)
    # So the instant moves the row past the Nov 5 close, as the UI shows it.
    assert _closes5([_row(4, "250.00", posting=instant)]) == {
        date(2026, 12, 5): Decimal("250.00")}


def test_statement_day_clamps_early_posting_date():
    from app.services.statements import statement_day

    early = _row(4, posting=datetime(2026, 10, 30))
    assert statement_day(early, NOV_7) == date(2026, 11, 4)
    # It never bills before it happened: an Oct 30 posted day can't pull a
    # Nov 6 charge back into the closed Nov 5 statement.
    assert _closes5([_row(6, "250.00", posting=datetime(2026, 11, 2))]) == {
        date(2026, 12, 5): Decimal("250.00")}


def test_statement_day_unposted_cases():
    from app.services.statements import statement_close, statement_day

    card = _card5()
    # Dated before today in the open cycle: today is in the same cycle.
    nov_3 = date(2026, 11, 3)
    assert statement_day(_row(1, posted=False), nov_3) == nov_3
    assert statement_close(card, nov_3) == statement_close(card, date(2026, 11, 1))
    # In a closed cycle: today, so the open statement.
    assert statement_day(_row(4, posted=False), NOV_7) == NOV_7
    assert _closes5([_row(4, "250.00", posted=False)]) == {date(2026, 12, 5): Decimal("250.00")}
    # A close of today is not closed yet: the row stays on it.
    nov_5 = date(2026, 11, 5)
    assert statement_day(_row(4, posted=False), nov_5) == nov_5
    assert _closes5([_row(4, "250.00", posted=False)], today=nov_5) == {
        date(2026, 11, 5): Decimal("250.00")}
    # Dated after today: its own day.
    assert statement_day(_row(20, posted=False), NOV_7) == date(2026, 11, 20)
    # A stale posted day (from before a revert) is ignored while unposted.
    stale = _row(1, posted=False, posting=datetime(2026, 12, 20))
    assert statement_day(stale, nov_3) == nov_3
    # Posting it today with today's date moves nothing.
    assert statement_day(_row(4, posting=datetime(2026, 11, 7)), NOV_7) == NOV_7


def test_cash_advance_follows_posted_date():
    def advance(**fields):
        row = SimpleNamespace(transaction_date=datetime(2026, 11, 4), amount=Decimal("3000.00"),
                              transfer_fee=Decimal("50.00"),
                              transaction_type=TransactionType.TRANSFER, account_id=5,
                              transfer_from_account_id=5, transfer_to_account_id=10, **fields)
        return row

    nov, dec = date(2026, 11, 5), date(2026, 12, 5)
    posted_late = advance(is_posted=True, posting_date=datetime(2026, 11, 6))
    assert _closes5([posted_late]) == {dec: Decimal("3050.00")}
    history = _history5([posted_late])
    assert [(line["amount"], line["transaction"]) for line in history[dec]["lines"]] == [
        (Decimal("3050.00"), posted_late)]
    # Without a posted day it stays on its own statement; unposted, it rolls.
    assert _closes5([advance(is_posted=True, posting_date=None)])[nov] == Decimal("3050.00")
    assert _closes5([advance(is_posted=False, posting_date=None)]) == {dec: Decimal("3050.00")}
    # The payable follows too, fee included.
    events = build_statement_payables([_card5()], {5: [posted_late]}, datetime(2026, 11, 7),
                                      datetime(2027, 1, 31))
    assert [(e["statement_close"].date(), e["amount"]) for e in events] == [
        (dec, Decimal("-3050.00"))]


def test_refund_follows_posted_date():
    nov, dec = date(2026, 11, 5), date(2026, 12, 5)
    charge = _row(20, "1000.00", month=10)
    refund = _row(3, "400.00", kind=TransactionType.CREDIT, posting=datetime(2026, 11, 6))
    history = _history5([charge, refund])
    assert (history[nov]["balance"], history[dec]["balance"]) == (
        Decimal("1000.00"), Decimal("-400.00"))
    # The later statement's net credit still pays the older one.
    assert (history[nov]["owed"], history[dec]["owed"]) == (Decimal("600.00"), Decimal("0"))
    assert [line["transaction"] for line in history[dec]["lines"]] == [refund]


def test_payment_keeps_transaction_date():
    from app.services.statements import _split_card_rows

    nov, dec = date(2026, 11, 5), date(2026, 12, 5)
    charge = _row(20, "1000.00", month=10)
    # Paid Nov 4, before the close; the bank posted it Nov 6.
    payment = SimpleNamespace(
        transaction_date=datetime(2026, 11, 4), amount=Decimal("700.00"),
        transaction_type=TransactionType.TRANSFER, account_id=10,
        transfer_from_account_id=10, transfer_to_account_id=5, is_posted=True,
        posting_date=datetime(2026, 11, 6))
    assert _split_card_rows(5, [charge, payment])[1] == [
        (datetime(2026, 11, 4), Decimal("700.00"))]
    history = _history5([charge, payment])
    assert history[nov]["owed"] == Decimal("300.00")
    assert history[nov]["outstanding"] == Decimal("300.00")  # paid by the close
    assert history[nov]["paid_since_close"] == Decimal("0")
    assert dec not in history or history[dec]["lines"] == []
    # Unposted, a payment is not rolled either.
    payment.is_posted, payment.posting_date = False, None
    assert _history5([charge, payment])[nov]["outstanding"] == Decimal("300.00")


def test_foreign_lines_follow_statement_day():
    from app.models.transaction import Transaction
    from app.services.fx import Rate

    class Fx:
        def rate(self, base, quote):
            if (base, quote) == ("USD", "PHP"):
                return Rate("USD", "PHP", Decimal("50"), date(2026, 11, 1), "test", False)
            return None

    def foreign(day, currency, amount):
        return Transaction(id=day * 10, account_id=5, transaction_type=TransactionType.DEBIT,
                           amount=Decimal(amount), currency="PHP",
                           projected_amount=Decimal(amount), projected_currency=currency,
                           transaction_date=datetime(2026, 11, day), is_posted=False)

    card = _card5()
    rows = [_row(20, "1000.00", month=10), foreign(3, "USD", "10"), foreign(4, "EUR", "5")]
    nov, dec = date(2026, 11, 5), date(2026, 12, 5)

    def history(today):
        return {s["close"].date(): s for s in statement_history(
            None, card, datetime.combine(today, datetime.min.time()), [card.id], fx=Fx(),
            card_rows=({card.id: rows}, frozenset()), due_overrides={})}

    # Read before the close, both sit on the Nov 5 statement.
    before = history(date(2026, 11, 4))
    assert before[nov]["balance"] == Decimal("1500.00")
    assert before[nov]["incomplete"] is True
    assert [u["transaction"] for u in before[nov]["unconverted"]] == [rows[2]]
    # Read on Nov 7, unposted, both have rolled to Dec 5: the estimate, the
    # unconverted listing and ``incomplete`` all follow.
    after = history(NOV_7)
    assert (after[nov]["balance"], after[nov]["incomplete"], after[nov]["unconverted"]) == (
        Decimal("1000.00"), False, [])
    assert after[dec]["balance"] == Decimal("500.00")
    assert after[dec]["incomplete"] is True
    assert [u["transaction"] for u in after[dec]["unconverted"]] == [rows[2]]
    assert [line["estimate"]["original_amount"] for line in after[dec]["lines"]] == [
        Decimal("10")]
    # The payables label the Dec 5 statement as the estimate, not Nov 5.
    from app.services.statements import normalise_lines

    events = build_statement_payables(
        [card], {5: rows}, datetime(2026, 11, 7), datetime(2027, 1, 31),
        normalise=lambda c, lines: normalise_lines(None, c, lines, Fx()))
    labelled = {e["statement_close"].date(): "line_estimate" in e for e in events}
    assert labelled == {nov: False, dec: True}


def test_row_posted_past_last_date_is_not_dropped():
    nov, dec, jan = date(2026, 11, 5), date(2026, 12, 5), date(2027, 1, 5)
    # Posted with a day past every dated row and past today's cycle.
    far = _row(4, "250.00", posting=datetime(2026, 12, 10))
    assert _closes5([far]) == {jan: Decimal("250.00")}
    # A refund posted that far still pays the older statement in an earlier window.
    charge = _row(1, "1000.00", month=10)
    refund = _row(2, "1000.00", month=10, kind=TransactionType.CREDIT,
                  posting=datetime(2026, 12, 10))
    events = build_statement_payables([_card5()], {5: [charge, refund]},
                                      datetime(2026, 10, 6), datetime(2026, 11, 1))
    assert events == []
    assert _closes5([charge, refund]) == {date(2026, 10, 5): Decimal("1000.00"), nov: Decimal("0"),
                                          dec: Decimal("0"), jan: Decimal("-1000.00")}


def test_rolled_row_keeps_window_independence():
    rows = [_row(20, "1000.00", month=10),                # Nov 5 statement
            _row(4, "250.00", posted=False),              # rolls to Dec 5
            _row(6, "300.00", posting=datetime(2026, 11, 6))]
    start = datetime(2026, 11, 7)

    def payables(end):
        return [(e["statement_close"].date(), e["amount"], e["statement_balance"])
                for e in build_statement_payables([_card5()], {5: rows}, start, end)]

    short = payables(datetime(2027, 1, 1))
    assert short == [(date(2026, 11, 5), Decimal("-1000.00"), Decimal("1000.00")),
                     (date(2026, 12, 5), Decimal("-550.00"), Decimal("550.00"))]
    longer = payables(datetime(2027, 6, 1))
    assert longer[:len(short)] == short


def test_projected_lines_are_not_rolled():
    start, end = datetime(2026, 11, 7), datetime(2027, 1, 31)
    nov = date(2026, 11, 5)
    # A projected charge dated in the closed Nov 5 cycle stays on it.
    projected = SimpleNamespace(transaction_date=datetime(2026, 10, 20), amount=Decimal("80.00"),
                                transaction_type=TransactionType.DEBIT)
    events = build_statement_payables([_card5()], {5: []}, start, end,
                                      projected_by_card={5: [projected]})
    assert [(e["statement_close"].date(), e["amount"]) for e in events] == [
        (nov, Decimal("-80.00"))]
    # A month settled as recorded stays too, and recording it (a posted row
    # with no posted day, as every recorder writes) moves no payable.
    settles = SimpleNamespace(transaction_date=datetime(2026, 10, 20), amount=Decimal("80.00"),
                              transaction_type=TransactionType.DEBIT, settles_as_recorded=True)
    as_projected = build_statement_payables([_card5()], {5: []}, start, end,
                                            projected_by_card={5: [settles]})
    recorded = build_statement_payables([_card5()], {5: [_row(20, "80.00", month=10)]},
                                        start, end)
    assert as_projected == recorded == events

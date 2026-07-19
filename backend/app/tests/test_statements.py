"""Unit tests for credit-card statement modelling (pure, no database).

The headline case is the owner's real shape: a card closing on the 24th with a
21-day grace period, whose SOA line items sum to the statement balance, paid from
the biweekly payroll account with the main checking account as overflow.
"""
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace


from app.models.transaction import TransactionType
from app.services.statements import (
    build_statement_payables,
    iter_statement_cycles,
    resolve_cycle_fields,
    statement_balance,
)


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
    assert list(iter_statement_cycles(card, datetime(2026, 8, 1), datetime(2026, 10, 1))) == []


# ---------------------------------------------------------------------------
# Cycle windows
# ---------------------------------------------------------------------------

def test_cycle_window_and_due_date_for_the_worked_example():
    """Close 24 Jul -> due 14 Aug, covering charges from 25 Jun to 24 Jul."""
    cycles = list(iter_statement_cycles(_card(), datetime(2026, 8, 1), datetime(2026, 8, 31)))
    assert len(cycles) == 1
    cycle = cycles[0]
    assert cycle["close"] == datetime(2026, 7, 24)
    assert cycle["due"] == datetime(2026, 8, 14)
    assert cycle["window_start"] == datetime(2026, 6, 24)


def test_statement_closed_before_the_window_but_due_inside_it_is_included():
    """The cash still leaves in the window -- this is the case a naive walk drops."""
    cycles = list(iter_statement_cycles(_card(), datetime(2026, 8, 10), datetime(2026, 8, 20)))
    assert [c["due"] for c in cycles] == [datetime(2026, 8, 14)]


def test_due_date_on_the_window_end_is_excluded():
    """Window is half-open [start, end), consistent with the rest of the engine."""
    cycles = list(iter_statement_cycles(_card(), datetime(2026, 8, 1), datetime(2026, 8, 14)))
    assert cycles == []


def test_multiple_cycles_across_a_longer_window():
    cycles = list(iter_statement_cycles(_card(), datetime(2026, 8, 1), datetime(2026, 11, 1)))
    assert [c["due"] for c in cycles] == [
        datetime(2026, 8, 14),
        datetime(2026, 9, 14),
        datetime(2026, 10, 15),  # 24 Sep + 21d
    ]


def test_close_day_clamps_to_short_months():
    """Day 31 must not explode on February."""
    card = _card(billing_cycle_start=31, days_until_due_date=21)
    cycles = list(iter_statement_cycles(card, datetime(2027, 3, 1), datetime(2027, 3, 31)))
    assert cycles[0]["close"] == datetime(2027, 2, 28)


# ---------------------------------------------------------------------------
# Statement balance
# ---------------------------------------------------------------------------

def test_balance_sums_purchases_in_the_window():
    txns = [_txn(1, "1000.50"), _txn(15, "2000.25"), _txn(24, "300.25")]
    total = statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24))
    assert total == Decimal("3301.00")


def test_balance_excludes_charges_outside_the_window():
    txns = [
        _txn(24, "500.00", month=6),   # on the previous close -> previous statement
        _txn(25, "100.00", month=6),   # first day of this cycle -> counts
        _txn(25, "700.00", month=7),   # after this close -> next statement
    ]
    total = statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24))
    assert total == Decimal("100.00")


def test_window_is_exclusive_at_start_and_inclusive_at_close():
    """A charge exactly on the previous close belongs to the PREVIOUS statement."""
    on_prev_close = [_txn(24, "999.00", month=6)]
    assert statement_balance(on_prev_close, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("0")

    on_close = [_txn(24, "999.00", month=7)]
    assert statement_balance(on_close, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("999.00")


def test_refunds_reduce_the_balance():
    txns = [_txn(5, "1000.00"), _txn(10, "250.00", kind=TransactionType.CREDIT)]
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("750.00")


def test_transfers_are_ignored():
    """The cash side of a card payment is modelled on the paying account."""
    txns = [_txn(5, "1000.00"), _txn(10, "1000.00", kind=TransactionType.TRANSFER)]
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("1000.00")


def test_balance_is_decimal_exact():
    """Three 0.10 charges must be exactly 0.30, not 0.30000000000000004."""
    txns = [_txn(1, "0.10"), _txn(2, "0.10"), _txn(3, "0.10")]
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("0.30")


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

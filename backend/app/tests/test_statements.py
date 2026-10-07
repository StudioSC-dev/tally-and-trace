"""Unit tests for credit-card statement modelling (pure, no database).

The headline case is the owner's real shape: a card closing on the 24th with a
21-day grace period, whose SOA line items sum to the statement balance, paid from
the biweekly payroll account with the main checking account as overflow.
"""
from datetime import date, datetime
from decimal import Decimal
from types import SimpleNamespace


from app.models.transaction import TransactionType
from app.services.statements import (
    allocate_payments,
    build_statement_payables,
    iter_cycles_from,
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
    assert list(iter_cycles_from(card, date(2026, 7, 1), datetime(2026, 10, 1))) == []


# ---------------------------------------------------------------------------
# Cycle windows
# ---------------------------------------------------------------------------

def test_cycle_window_and_due_date_for_the_worked_example():
    """Close 24 Jul -> due 14 Aug, covering charges from 25 Jun to 24 Jul."""
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 1), datetime(2026, 8, 31)))
    assert len(cycles) == 1
    cycle = cycles[0]
    assert cycle["close"] == datetime(2026, 7, 24)
    assert cycle["due"] == datetime(2026, 8, 14)
    assert cycle["window_start"] == datetime(2026, 6, 24)


def test_walk_starts_at_the_cycle_containing_the_first_day():
    """A first line item after the close day belongs to the next month's cycle."""
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 25), datetime(2026, 10, 1)))
    assert [c["close"] for c in cycles] == [datetime(2026, 8, 24)]


def test_due_date_on_the_window_end_is_excluded():
    """Window is half-open [start, end), consistent with the rest of the engine."""
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 1), datetime(2026, 8, 14)))
    assert cycles == []


def test_multiple_cycles_across_a_longer_window():
    cycles = list(iter_cycles_from(_card(), date(2026, 7, 1), datetime(2026, 11, 1)))
    assert [c["due"] for c in cycles] == [
        datetime(2026, 8, 14),
        datetime(2026, 9, 14),
        datetime(2026, 10, 15),  # 24 Sep + 21d
    ]


def test_close_day_clamps_to_short_months():
    """Day 31 must not explode on February."""
    card = _card(billing_cycle_start=31, days_until_due_date=21)
    cycles = list(iter_cycles_from(card, date(2027, 2, 1), datetime(2027, 3, 31)))
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


def test_midday_charge_on_the_closing_day_belongs_to_that_statement():
    """Close is midnight of the 24th, but the whole 24th is inside the statement."""
    noon_on_close = [_txn(24, "12000.00")]
    noon_on_close[0].transaction_date = datetime(2026, 7, 24, 12)
    assert statement_balance(noon_on_close, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("12000.00")
    # ...and therefore NOT in the next one.
    assert statement_balance(noon_on_close, datetime(2026, 7, 24), datetime(2026, 8, 24)) == Decimal("0")


def test_midday_charge_on_the_previous_closing_day_belongs_to_the_previous_statement():
    noon_on_prev_close = [_txn(24, "500.00", month=6)]
    noon_on_prev_close[0].transaction_date = datetime(2026, 6, 24, 12)
    assert statement_balance(noon_on_prev_close, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("0")
    assert statement_balance(noon_on_prev_close, datetime(2026, 5, 24), datetime(2026, 6, 24)) == Decimal("500.00")


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
    assert statement_balance(txns, datetime(2026, 6, 24), datetime(2026, 7, 24)) == Decimal("750.00")


def test_transfers_are_not_line_items():
    """A payment is netted against statements by allocation, not summed as a line."""
    txns = [_txn(5, "1000.00"), _pay(10, "1000.00")]
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
# Incomplete-history guard
#
# Posted charges of 1,000 (May), 2,000 (Jun) and 3,000 (Jul) with no payments
# recorded. The stored balance (negative = owed) says what the card really owes.
# ---------------------------------------------------------------------------

def _posted(day, amount, month, kind=TransactionType.DEBIT):
    row = _txn(day, amount, kind=kind, month=month)
    row.is_posted = True
    return row


HISTORY = [_posted(10, "1000.00", 5), _posted(10, "2000.00", 6), _posted(10, "3000.00", 7)]


def _guarded(balance, rows, start=AUG, end=SEP):
    events = build_statement_payables([_card(balance=Decimal(balance))], {1: rows}, start, end)
    return [(e["date"], e["amount"], e.get("overdue", False)) for e in events]


def test_unrecorded_payments_leave_only_what_the_stored_balance_owes(caplog):
    """Only July's 3,000 is really owed: May and June are not phantom-overdue."""
    with caplog.at_level("WARNING", logger="app.services.statements"):
        assert _guarded("-3000.00", HISTORY) == [
            (datetime(2026, 8, 14), Decimal("-3000.00"), False),
        ]
    assert "Card 1" in caplog.text


def test_unrecorded_history_is_trimmed_from_the_oldest_statements_first():
    """4,000 owed of 6,000 charged: May (1,000) and half of June are cut."""
    assert _guarded("-4000.00", HISTORY) == [
        (AUG, Decimal("-1000.00"), True),
        (datetime(2026, 8, 14), Decimal("-3000.00"), False),
    ]


def test_open_cycle_charges_are_never_trimmed():
    """July's statement was paid off the books; the 28 Jul charge is on the open
    24 Aug cycle and the stored 500 is exactly that, so only it stays owed."""
    rows = [_posted(10, "3000.00", 7), _posted(28, "500.00", 7)]
    assert _guarded("-500.00", rows, end=datetime(2026, 10, 1)) == [
        (datetime(2026, 9, 14), Decimal("-500.00"), False),
    ]


def test_complete_history_is_untouched_by_the_guard(caplog):
    """May's payment is recorded: the ledger owes 5,000, exactly the stored balance."""
    payment = _pay(14, "1000.00", month=6)
    payment.is_posted = True
    with caplog.at_level("WARNING", logger="app.services.statements"):
        assert _guarded("-5000.00", HISTORY + [payment]) == [
            (AUG, Decimal("-2000.00"), True),
            (datetime(2026, 8, 14), Decimal("-3000.00"), False),
        ]
    assert caplog.text == ""


def test_stored_balance_owing_more_than_the_ledger_adds_no_debt():
    assert _guarded("-9000.00", HISTORY) == [
        (AUG, Decimal("-1000.00"), True),
        (AUG, Decimal("-2000.00"), True),
        (datetime(2026, 8, 14), Decimal("-3000.00"), False),
    ]


def test_unposted_rows_do_not_count_against_the_stored_balance():
    """A planned charge is not in the stored balance, so it is not trimmed."""
    assert _guarded("0.00", [_txn(10, "3000.00")]) == [
        (datetime(2026, 8, 14), Decimal("-3000.00"), False),
    ]


def test_planned_payment_is_not_spent_on_closed_debt_the_stored_balance_says_is_paid():
    """July's 3,000 was paid off the books; the stored 500 is the 28 Jul charge on
    the open cycle. The planned 10 Sep payment of 500 settles that charge, so no
    statement is payable: 500 of cash in all, not the payment plus a 500 payable."""
    rows = [_posted(10, "3000.00", 7), _posted(28, "500.00", 7), _pay(10, "500.00", month=9)]
    assert _guarded("-500.00", rows, end=datetime(2026, 10, 1)) == []


def test_opening_balance_missing_from_the_ledger_absorbs_payments_first():
    """A 5,000 opening balance was never entered as charges; the posted 5,000
    payment settled it, so July's 1,000 charge is still owed (stored -1,000)."""
    payment = _pay(1, "5000.00", month=6)
    payment.is_posted = True
    rows = [payment, _posted(10, "1000.00", 7)]
    assert _guarded("-1000.00", rows) == [
        (datetime(2026, 8, 14), Decimal("-1000.00"), False),
    ]


def test_missing_opening_balance_is_never_billed_itself():
    """Stored -1,500 against a ledger owing 500: the 1,000 opening balance is not a
    payable, it only takes the planned 1,000 payment before July's charge does."""
    rows = [_posted(10, "500.00", 7), _pay(1, "1000.00", month=8)]
    assert _guarded("-1500.00", rows) == [
        (datetime(2026, 8, 14), Decimal("-500.00"), False),
    ]


def test_positive_stored_balance_against_posted_debt_trims_nothing(caplog):
    """+3,000 stored while the posted rows owe 6,000 is most likely a sign entered
    the wrong way round, not 9,000 of unrecorded payments: real debt stays owed."""
    with caplog.at_level("WARNING", logger="app.services.statements"):
        assert _guarded("3000.00", HISTORY) == [
            (AUG, Decimal("-1000.00"), True),
            (AUG, Decimal("-2000.00"), True),
            (datetime(2026, 8, 14), Decimal("-3000.00"), False),
        ]
    assert "trimmed" not in caplog.text


def _from_unbilled_card(posted=False):
    """12,000 charged on card 1, then 'paid' by a transfer from card 2, which has
    no cycle settings and so no statement that would ever bill the transfer."""
    unbilled = _card(id=2, name="Store card", billing_cycle_start=None, due_date=None)
    move = _pay(10, "12000.00", month=8, from_account=2)
    move.is_posted = posted
    return unbilled, [_posted(10, "12000.00", 7), move]


def test_payment_from_a_card_without_statements_does_not_net_the_billed_card():
    unbilled, rows = _from_unbilled_card()
    events = build_statement_payables([_card(), unbilled], {1: rows, 2: rows[1:]}, AUG, SEP)
    assert [(e["name"], e["date"], e["amount"]) for e in events] == [
        ("Metrobank CC statement", datetime(2026, 8, 14), Decimal("-12000.00")),
    ]


def test_posted_payment_from_a_card_without_statements_still_matches_the_stored_balance():
    """Posting raised card 1's stored balance to 0, and the ledger agrees: the
    guard leaves the statement alone, so the 12,000 is still billed."""
    unbilled, rows = _from_unbilled_card(posted=True)
    events = build_statement_payables(
        [_card(balance=Decimal("0.00")), unbilled], {1: rows, 2: rows[1:]}, AUG, SEP)
    assert [(e["date"], e["amount"]) for e in events] == [
        (datetime(2026, 8, 14), Decimal("-12000.00")),
    ]

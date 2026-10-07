"""Unit tests for the unified dated-event projection engine (pure, no database)."""
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from app.models.account import AccountType
from app.models.transaction import TransactionType
from app.services.forecast import (
    _event,
    _leg,
    _route_legs,
    _transfer_event,
    build_timeline,
    is_projection_cash,
    route_accounts,
)


def test_is_projection_cash_excludes_credit_cards_only():
    for t in (AccountType.CASH, AccountType.E_WALLET, AccountType.SAVINGS, AccountType.CHECKING):
        assert is_projection_cash(SimpleNamespace(account_type=t)) is True
    assert is_projection_cash(SimpleNamespace(account_type=AccountType.CREDIT)) is False


# ---------------------------------------------------------------------------
# Transfer legs
# ---------------------------------------------------------------------------

SAVINGS_A, CHECKING_B, CARD_C = 1, 2, 3
NAMES = {SAVINGS_A: "Savings A", CHECKING_B: "Checking B", CARD_C: "Card C"}
CASH = {SAVINGS_A, CHECKING_B}
CARDS = {CARD_C}
OUTSIDE = 4  # an account outside the projection's scope (another entity, or inactive)


def _txn_transfer(day, amount, fee, src, dst):
    return SimpleNamespace(
        id=99, description="Move to B", transaction_type=TransactionType.TRANSFER,
        transaction_date=datetime(2026, 8, day), amount=Decimal(str(amount)),
        transfer_fee=Decimal(str(fee)), account_id=src,
        transfer_from_account_id=src, transfer_to_account_id=dst,
    )


def _payable(day, amount, account_id, name="Bill from B"):
    return _event(
        date=datetime(2026, 8, day), name=name, type="expense", source="budget_entry",
        source_id=7, face_amount=amount, legs=[_leg(account_id, -Decimal(str(amount)))],
    )


def test_transfer_between_cash_accounts_moves_pool_only_by_fee():
    ev = _transfer_event(_txn_transfer(5, 5000, 15, SAVINGS_A, CHECKING_B), CASH, CARDS)
    assert [(leg["account_id"], leg["amount"]) for leg in ev["legs"]] == [
        (SAVINGS_A, Decimal("-5015.00")),
        (CHECKING_B, Decimal("5000.00")),
    ]
    assert ev["amount"] == Decimal("-15.00")
    assert ev["counts_as_cash"] is True
    assert ev["face_amount"] == Decimal("5000.00")


def test_transfer_funds_destination_before_its_payable():
    opening = {SAVINGS_A: Decimal("10000"), CHECKING_B: Decimal("0")}
    events = [
        _transfer_event(_txn_transfer(5, 5000, 15, SAVINGS_A, CHECKING_B), CASH, CARDS),
        _payable(10, 4000, CHECKING_B),
    ]
    assert route_accounts(opening, events, NAMES) == []
    pooled = build_timeline(sum(opening.values()), events)
    assert pooled["closing_balance"] == Decimal("5985.00")  # 10000 - 15 fee - 4000 bill


def test_same_day_transfer_runs_before_the_payable_it_funds():
    opening = {SAVINGS_A: Decimal("10000"), CHECKING_B: Decimal("0")}
    events = [
        _payable(10, 4000, CHECKING_B),
        _transfer_event(_txn_transfer(10, 5000, 0, SAVINGS_A, CHECKING_B), CASH, CARDS),
    ]
    assert route_accounts(opening, events, NAMES) == []


def test_payable_without_the_transfer_is_short():
    opening = {SAVINGS_A: Decimal("10000"), CHECKING_B: Decimal("0")}
    sf = route_accounts(opening, [_payable(10, 4000, CHECKING_B)], NAMES)
    assert len(sf) == 1 and sf[0]["account_id"] == CHECKING_B
    assert sf[0]["short_amount"] == Decimal("4000.00")


def test_transfer_into_a_card_is_listed_but_not_cash():
    """The card's statement payable already models that cash; don't count it twice."""
    ev = _transfer_event(_txn_transfer(5, 3000, 0, CHECKING_B, CARD_C), CASH, CARDS)
    assert ev["counts_as_cash"] is False
    assert ev["legs"][1] == _leg(CARD_C, Decimal("3000"), cash=False)


def test_transfer_from_a_card_is_listed_but_not_cash():
    """A cash advance is repaid through the card, which statements don't model yet."""
    ev = _transfer_event(_txn_transfer(5, 3000, 50, CARD_C, CHECKING_B), CASH, CARDS)
    assert ev["counts_as_cash"] is False
    assert [leg["cash"] for leg in ev["legs"]] == [False, False]
    assert ev["amount"] == Decimal("0")


def test_transfer_out_of_scope_costs_the_pool_amount_and_fee():
    """The destination is not a projection-cash account: the money leaves the pool."""
    ev = _transfer_event(_txn_transfer(5, 5000, 15, SAVINGS_A, OUTSIDE), CASH, CARDS)
    assert [(leg["account_id"], leg["amount"], leg["cash"]) for leg in ev["legs"]] == [
        (SAVINGS_A, Decimal("-5015.00"), True),
    ]
    assert ev["amount"] == Decimal("-5015.00")
    assert ev["counts_as_cash"] is True


def test_transfer_into_scope_from_outside_adds_the_amount():
    """Only the in-scope leg is kept; the outside account is never exposed."""
    ev = _transfer_event(_txn_transfer(5, 5000, 15, OUTSIDE, CHECKING_B), CASH, CARDS)
    assert [(leg["account_id"], leg["amount"], leg["cash"]) for leg in ev["legs"]] == [
        (CHECKING_B, Decimal("5000.00"), True),
    ]
    assert ev["amount"] == Decimal("5000.00")
    assert ev["funding_account_id"] == CHECKING_B


def test_pooled_timeline_and_routing_order_same_day_events_alike():
    """An inbound transfer funds a same-day bill in both views, not only per account."""
    opening = {CHECKING_B: Decimal("0")}
    events = [
        _payable(10, 4000, CHECKING_B),
        _transfer_event(_txn_transfer(10, 5000, 0, OUTSIDE, CHECKING_B), CASH, CARDS),
    ]
    assert route_accounts(opening, events, NAMES) == []
    pooled = build_timeline(sum(opening.values()), events)
    assert pooled["shortfall"] is False
    assert pooled["shortfalls"] == []
    assert pooled["lowest_balance"] == Decimal("0.00")
    assert pooled["trough_date"] is None
    assert [e["name"] for e in pooled["events"]] == ["Move to B", "Bill from B"]


# ---------------------------------------------------------------------------
# Per-account closings and overflow use
# ---------------------------------------------------------------------------

def test_closings_exclude_virtual_overflow_moves_which_are_reported_separately():
    opening = {SAVINGS_A: Decimal("1000"), CHECKING_B: Decimal("100")}
    payable = _event(
        date=datetime(2026, 8, 10), name="Bill from B", type="expense", source="budget_entry",
        source_id=7, face_amount=300, legs=[_leg(CHECKING_B, Decimal("-300"), SAVINGS_A)],
    )
    r = _route_legs(opening, [payable], NAMES)

    assert r["shortfalls"] == []  # overflow covered it
    assert r["overflow_moves"] == [{
        "date": datetime(2026, 8, 10).date(), "name": "Bill from B",
        "from_account_id": SAVINGS_A, "from_account_name": "Savings A",
        "to_account_id": CHECKING_B, "to_account_name": "Checking B",
        "amount": Decimal("200.00"),
    }]
    # Scheduled legs only: B goes to -200, A is untouched by the virtual pull.
    assert r["final"]["by_account"] == {SAVINGS_A: Decimal("1000.00"), CHECKING_B: Decimal("-200.00")}
    assert r["final"]["unassigned"] == Decimal("0")


def test_checkpoint_closings_and_pooled_invariant():
    opening = {SAVINGS_A: Decimal("10000"), CHECKING_B: Decimal("0")}
    events = [
        _transfer_event(_txn_transfer(5, 5000, 15, SAVINGS_A, CHECKING_B), CASH, CARDS),
        _payable(10, 4000, CHECKING_B),
        _event(date=datetime(2026, 9, 3), name="Unrouted income", type="income",
               source="budget_entry", source_id=8, face_amount=700,
               legs=[_leg(None, Decimal("700"))]),
    ]
    r = _route_legs(opening, events, NAMES, checkpoints=[datetime(2026, 9, 1).date()])

    aug = r["closings"][0]
    assert aug["by_account"] == {SAVINGS_A: Decimal("4985.00"), CHECKING_B: Decimal("1000.00")}
    assert aug["unassigned"] == Decimal("0")
    final = r["final"]
    assert final["unassigned"] == Decimal("700.00")
    pooled = build_timeline(sum(opening.values()), events)["closing_balance"]
    assert sum(final["by_account"].values()) + final["unassigned"] == pooled

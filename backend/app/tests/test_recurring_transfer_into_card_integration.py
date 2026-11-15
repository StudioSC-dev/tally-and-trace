"""Recurring transfers into a card are netted against its statements (STU-249).

The API refuses a recurring transfer into a credit card, but converting its
destination into a card later reaches that state: each test does exactly that
through the API. The card closes on the 15th with 21 days to pay (the statement
closing October 15 is due November 5; the one closing November 15 on December 6,
a Sunday, so on Monday December 7) and is routed to the checking account the
transfer comes from.

Each occurrence is a payment the card's statements net, in date order, oldest
statement first among those due on or after its date, after every recorded
payment (``statements.settle_projected``). So the cash of a statement leaves
the checking account once: as the transfer, or as the payable for what the
transfers leave. Today is October 20. Skips without a database.
"""
from datetime import datetime
from decimal import Decimal

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

TODAY = datetime(2026, 10, 20)
END = datetime(2027, 1, 1)
OCT_DUE, NOV_DUE = datetime(2026, 11, 5), datetime(2026, 12, 7)


def _world(client, who):
    """``(checking, card)``: the card starts as a checking account, so a recurring
    transfer into it can be created, and becomes a routed card in ``_to_card``."""
    checking = sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 10_000})["id"]
    card = sw_post(client, who, "/accounts/", {
        "name": "Card", "account_type": "checking", "balance": 0})["id"]
    return checking, card


def _to_card(client, who, card, checking):
    r = client.put(f"{API}/accounts/{card}", headers=who["headers"], json={
        "account_type": "credit", "billing_cycle_start": 15, "days_until_due_date": 21,
        "credit_limit": 50_000, "payment_account_id": checking})
    assert r.status_code == 200, r.text


def _recurring(client, who, frm, to, amount, first, times=1):
    return sw_post(client, who, "/budget-entries/", {
        "name": "Card top-up", "entry_type": "expense", "amount": amount,
        "cadence": "monthly", "next_occurrence": first.isoformat(),
        "account_id": frm, "transfer_to_account_id": to,
        "end_mode": "after_occurrences", "max_occurrences": times})["id"]


def _charge(client, who, card, amount, when):
    sw_post(client, who, "/transactions/", {
        "account_id": card, "amount": amount, "transaction_type": "debit",
        "transaction_date": when.isoformat(), "is_posted": True, "description": "Groceries"})


def _payment(client, who, frm, card, amount, when):
    sw_post(client, who, "/transactions/", {
        "account_id": frm, "amount": amount, "transaction_type": "transfer",
        "transfer_from_account_id": frm, "transfer_to_account_id": card,
        "transaction_date": when.isoformat(), "is_posted": True, "description": "Paid"})


def _events(db, who, end=END):
    from app.services.forecast import collect_events

    db.expire_all()
    return collect_events(db, TODAY, end, user_id=who["id"])


def _outflow(events, account):
    """Projected cash leaving ``account``: its cash legs' outflows, summed."""
    return sum((leg["amount"] for e in events for leg in e["legs"]
                if leg["account_id"] == account and leg["cash"] and leg["amount"] < 0),
               Decimal("0"))


def _statements(events, card):
    return [(e["date"], e["amount"]) for e in events
            if e["source"] == "statement" and e["source_id"] == card]


def _without_netting(monkeypatch):
    """The engine as it was before STU-249: no recurring occurrence nets a statement."""
    import app.services.forecast as forecast

    monkeypatch.setattr(forecast, "_card_recurring_payments", lambda *a, **k: {})


@pytest.fixture
def owner(sw_people):
    return sw_people("Rhea", "Card")


def test_forecast_outflow_once(sw_client, sw_db, owner):
    # AC1: a 100 statement (due November 5) and a recurring 100 transfer into the
    # card on November 1: 100 leaves the checking account, not 200.
    checking, card = _world(sw_client, owner)
    _recurring(sw_client, owner, checking, card, 100, datetime(2026, 11, 1))
    _to_card(sw_client, owner, card, checking)
    _charge(sw_client, owner, card, 100, datetime(2026, 10, 12))

    events = _events(sw_db, owner)
    assert _statements(events, card) == []
    [transfer] = [e for e in events if e["source"] == "budget_entry"]
    assert (transfer["date"], transfer["amount"], transfer.get("card_payment")) == (
        datetime(2026, 11, 1), Decimal("-100.00"), True)
    assert _outflow(events, checking) == Decimal("-100.00")


def test_excess_not_double_counted(sw_client, sw_db, owner):
    # AC3: a 150 transfer on November 1 nets the 100 statement; the excess 50
    # stays a payment, paying the 30 on the next statement (due December 7), and
    # the 150 leaves once. Nothing else is owed.
    checking, card = _world(sw_client, owner)
    _recurring(sw_client, owner, checking, card, 150, datetime(2026, 11, 1))
    _to_card(sw_client, owner, card, checking)
    _charge(sw_client, owner, card, 100, datetime(2026, 10, 12))
    _charge(sw_client, owner, card, 30, datetime(2026, 11, 10))

    events = _events(sw_db, owner)
    assert _statements(events, card) == []
    assert _outflow(events, checking) == Decimal("-150.00")


def test_recurring_transfer_nets_oldest_first(sw_client, sw_db, owner):
    # AC4: one 150 transfer on November 1, before both dues, pays the October
    # statement (100) in full first, then 50 of the November one (80): only 30
    # is left to pay, on December 7.
    checking, card = _world(sw_client, owner)
    _recurring(sw_client, owner, checking, card, 150, datetime(2026, 11, 1))
    _to_card(sw_client, owner, card, checking)
    _charge(sw_client, owner, card, 100, datetime(2026, 10, 12))
    _charge(sw_client, owner, card, 80, datetime(2026, 11, 10))

    events = _events(sw_db, owner)
    assert _statements(events, card) == [(NOV_DUE, Decimal("-30.00"))]
    assert _outflow(events, checking) == Decimal("-180.00")


def test_occurrence_after_a_due_date_pays_only_later_statements(sw_client, sw_db, owner):
    # Monthly 60 on November 10 and December 10: the first comes after the
    # October statement's due date (November 5), so it pays the November
    # statement, and the October one is paid in full on its due date. The
    # December 10 occurrence comes after every due date here: it is an excess
    # payment. A payable in a short window is the same in a longer one.
    checking, card = _world(sw_client, owner)
    _recurring(sw_client, owner, checking, card, 60, datetime(2026, 11, 10), times=2)
    _to_card(sw_client, owner, card, checking)
    _charge(sw_client, owner, card, 100, datetime(2026, 10, 12))
    _charge(sw_client, owner, card, 80, datetime(2026, 11, 12))

    events = _events(sw_db, owner)
    assert _statements(events, card) == [(OCT_DUE, Decimal("-100.00")),
                                         (NOV_DUE, Decimal("-20.00"))]
    assert _outflow(events, checking) == Decimal("-240.00")  # 100 + 20 + 60 + 60
    short = _events(sw_db, owner, end=datetime(2026, 11, 8))
    assert _statements(short, card) == [(OCT_DUE, Decimal("-100.00"))]


def test_posted_only_card_unchanged(sw_client, sw_db, owner, monkeypatch):
    # AC6: a card with no recurring transfer into it keeps its posted-payment
    # settlement: the 100 statement less the posted 40 payment, 60 due November 5,
    # exactly as without the netting.
    checking, card = _world(sw_client, owner)
    _to_card(sw_client, owner, card, checking)
    _charge(sw_client, owner, card, 100, datetime(2026, 10, 12))
    _payment(sw_client, owner, checking, card, 40, datetime(2026, 10, 18))

    events = _events(sw_db, owner)
    assert _statements(events, card) == [(OCT_DUE, Decimal("-60.00"))]
    assert _outflow(events, checking) == Decimal("-60.00")
    _without_netting(monkeypatch)
    assert _events(sw_db, owner) == events


def test_non_card_transfer_unchanged(sw_client, sw_db, owner, monkeypatch):
    # AC6: a recurring transfer between two non-card accounts nets nothing: the
    # card's 100 statement is still due in full, and the transfer still moves
    # 100 from checking to savings, exactly as without the netting.
    checking, card = _world(sw_client, owner)
    savings = sw_post(sw_client, owner, "/accounts/", {
        "name": "Savings", "account_type": "savings", "balance": 0})["id"]
    _recurring(sw_client, owner, checking, savings, 100, datetime(2026, 11, 1))
    _to_card(sw_client, owner, card, checking)
    _charge(sw_client, owner, card, 100, datetime(2026, 10, 12))

    events = _events(sw_db, owner)
    assert _statements(events, card) == [(OCT_DUE, Decimal("-100.00"))]
    [move] = [e for e in events if e["source"] == "budget_entry"]
    assert [(leg["account_id"], leg["amount"]) for leg in move["legs"]] == [
        (checking, Decimal("-100.00")), (savings, Decimal("100.00"))]
    assert _outflow(events, checking) == Decimal("-200.00")
    _without_netting(monkeypatch)
    assert _events(sw_db, owner) == events

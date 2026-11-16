"""The card Pay route from an account in another currency (STU-654).

``POST /cards/{id}/payments`` takes an optional ``received_amount`` (the card's
currency) and hands it to ``add_transaction``, so the cash-transfer rules of
STU-303 judge it: a posted cross-currency payment needs a figure above 0, a
planned one may wait for it (its card side is estimated at the stored rate), and
a same-currency payer is unchanged. Fixture and helpers are STU-303's: a USD
card with a USD 300 charge, paid from PHP Checking (58.00 PHP per USD).
"""
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_share
from app.tests.test_cross_currency_card_payment_integration import (  # noqa: F401
    RATE_TO_USD, _account, _balance, _payable, _statement, _upcoming, cc, frozen,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


def _pay(client, who, card, payer, amount, *, day="2026-11-01", expect=(201,), **extra):
    r = client.post(f"{API}/cards/{card}/payments", headers=who["headers"], json={
        "amount": amount, "from_account_id": payer, "payment_date": day, **extra})
    assert r.status_code in expect, r.text
    return r


def _rows(db, account_id) -> int:
    from app.models.transaction import Transaction

    db.rollback()
    return db.query(Transaction).filter(Transaction.account_id == account_id).count()


def test_pay_route_cross_currency_moves_sent_and_received(sw_client, sw_db, cc, frozen):
    client, db, a = sw_client, sw_db, cc["a"]
    txn = _pay(client, a, cc["card"], cc["php"], 5_800, received_amount=100).json()
    assert (txn["amount"], txn["currency"], txn["received_amount"]) == (5_800, "PHP", 100)
    assert _balance(db, cc["php"]) == Decimal("44200.00")
    assert _balance(db, cc["card"]) == Decimal("-200.00")
    # The card's oldest statement is paid down by the received figure.
    assert _statement(client, a, cc["card"])["amount_due"] == 200.0


@pytest.mark.parametrize("extra, status, detail", [
    pytest.param({}, 400, "Enter the amount received", id="missing"),
    pytest.param({"received_amount": None}, 400, "Enter the amount received", id="null"),
    pytest.param({"received_amount": 0}, 400, "Enter the amount received", id="zero"),
    pytest.param({"received_amount": -5}, 422, None, id="negative"),
])
def test_pay_route_received_amount_validation(sw_client, sw_db, cc, frozen,
                                              extra, status, detail):
    """A posted payment is refused with nothing moved; a planned one (see the
    next test) is allowed to wait, except a negative figure, refused by shape."""
    client, db, a = sw_client, sw_db, cc["a"]
    before = _statement(client, a, cc["card"])
    r = _pay(client, a, cc["card"], cc["php"], 5_800, expect=(status,), **extra)
    if detail:
        assert r.json()["detail"] == detail
    assert _balance(db, cc["php"]) == Decimal("50000.00")
    assert _balance(db, cc["card"]) == Decimal("-300.00")
    assert _rows(db, cc["php"]) == 0
    assert _statement(client, a, cc["card"]) == before
    # The planned counterpart follows the transfer rule for an unposted row.
    r = _pay(client, a, cc["card"], cc["php"], 5_800, day="2026-11-09",
             expect=(422,) if status == 422 else (201,), **extra)
    if status == 201 or r.status_code == 201:
        assert r.json()["received_amount"] is None


def test_pay_route_planned_payment_uses_transfer_estimate(sw_client, sw_db, cc, frozen):
    client, db, a = sw_client, sw_db, cc["a"]
    txn = _pay(client, a, cc["card"], cc["php"], 5_800, day="2026-11-09",
               description="Planned PHP payment").json()
    assert txn["received_amount"] is None
    rows = _upcoming(client, a, "Planned PHP payment")
    assert sorted((i["amount"], i["currency"], bool(i.get("estimated"))) for i in rows) == [
        (100.0, "USD", True), (5_800.0, "PHP", False)]
    (usd_row,) = [i for i in rows if i["currency"] == "USD"]
    assert usd_row["rate"] == RATE_TO_USD
    assert _statement(client, a, cc["card"])["amount_due"] == 200.0
    (payable,) = _payable(client, a, "USD Card")
    assert (payable["amount"], payable["currency"], payable["estimated"]) == (
        11_600.0, "PHP", True)
    assert _balance(db, cc["php"]) == Decimal("50000.00")
    assert _balance(db, cc["card"]) == Decimal("-300.00")


def test_pay_route_same_currency_unchanged(sw_client, sw_db, cc, frozen):
    client, db, a = sw_client, sw_db, cc["a"]
    # Omitted: as before. An equal figure is dropped; a different one refused.
    assert _pay(client, a, cc["card"], cc["usd"], 20).json()["received_amount"] is None
    r = _pay(client, a, cc["card"], cc["usd"], 30, received_amount=30)
    assert r.json()["received_amount"] is None
    r = _pay(client, a, cc["card"], cc["usd"], 40, received_amount=41, expect=(400,))
    assert "same currency" in r.json()["detail"]
    assert _balance(db, cc["usd"]) == Decimal("950.00")
    assert _balance(db, cc["card"]) == Decimal("-250.00")


def test_pay_route_other_rules_unchanged(sw_client, sw_db, sw_people, cc, frozen):
    client, db, a = sw_client, sw_db, cc["a"]
    card, php = cc["card"], cc["php"]
    other_card = _account(client, a, "Other card", "USD", 0, "credit", billing_cycle_start=10)
    r = _pay(client, a, card, other_card, 10, expect=(400,), received_amount=10)
    assert r.json()["detail"] == "Pay a card from a bank, cash or e-wallet account"
    r = _pay(client, a, card, card, 10, expect=(400,))
    assert r.json()["detail"] == "A card cannot pay itself"
    # Payer and card must be active.
    db.execute(text("UPDATE accounts SET is_active = false WHERE id = :i"), {"i": php})
    db.commit()
    r = _pay(client, a, card, php, 5_800, expect=(400,), received_amount=100)
    assert r.json()["detail"] == "This account is inactive"
    db.execute(text("UPDATE accounts SET is_active = true WHERE id = :i"), {"i": php})
    db.execute(text("UPDATE accounts SET is_active = false WHERE id = :i"), {"i": card})
    db.commit()
    r = _pay(client, a, card, php, 5_800, expect=(400,), received_amount=100)
    assert r.json()["detail"] == "This card is inactive"
    db.execute(text("UPDATE accounts SET is_active = true WHERE id = :i"), {"i": card})
    db.commit()
    # A caller who only views the payer (or has no role on the card) gets a 404.
    other = sw_people("Vic", "Viewer")
    theirs = _account(client, other, "Vic PHP", "PHP", 9_000)
    sw_share(db, theirs, a["id"], "viewer", other["id"])
    r = _pay(client, a, card, theirs, 5_800, expect=(404,), received_amount=100)
    assert r.json()["detail"] == "from_account_id account not found"
    r = _pay(client, other, card, theirs, 5_800, expect=(404,), received_amount=100)
    assert r.json()["detail"] == "Account not found"
    assert _rows(db, theirs) == 0
    assert _balance(db, php) == Decimal("50000.00")

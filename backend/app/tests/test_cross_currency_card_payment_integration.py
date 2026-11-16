"""Paying a credit card from an account in another currency (STU-303).

A card payment is a transfer into the card. Across currencies it records both
figures, as a cash transfer does: ``amount`` (sent, in the source account's
currency) and ``received_amount`` (what the card got, in the card's). Balances
move each side by its own figure; the card's statements net the payment in
the card's currency. A planned payment with no ``received_amount`` yet is
estimated at the stored rate (58.00 PHP per USD in the suite), and with no
stored rate it is unconverted and pays nothing, as a cash transfer's inbound
leg is. A card's payment and overflow accounts may be in another currency.
"""
from datetime import datetime
from decimal import Decimal

import pytest

from app.tests.conftest import API, FX_REF, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

REF = FX_REF  # 2026-11-02 00:00, naive UTC
RATE_TO_USD = 0.017241


def _account(client, who, name, currency, balance=0, account_type="checking", **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "currency": currency,
        "balance": balance, **extra})["id"]


def _pay(client, who, src, card, amount, *, day="2026-11-01", posted=True,
         expect=(200, 201), **extra):
    body = {"account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": card,
            "transaction_type": "transfer", "amount": amount, "is_posted": posted,
            "transaction_date": f"{day}T00:00:00", "description": "Card payment", **extra}
    r = client.post(f"{API}/transactions/", json=body, headers=who["headers"])
    assert r.status_code in expect, r.text
    return r


def _balance(db, account_id) -> Decimal:
    from app.models.account import Account

    db.expire_all()
    return Decimal(str(db.get(Account, account_id).balance))


def _effects(client, who, account_id, txn_id):
    r = client.get(f"{API}/accounts/{account_id}/balance", headers=who["headers"])
    assert r.status_code == 200, r.text
    return [round(row["amount"], 2) for row in r.json()["balance_history"]
            if row.get("transaction_id") == txn_id]


def _statement(client, who, card):
    """The card's statement holding the USD 300 charge (closes 19 Nov)."""
    r = client.get(f"{API}/accounts/{card}/statements", headers=who["headers"])
    assert r.status_code == 200, r.text
    (statement,) = [s for s in r.json()["statements"] if s["statement_balance"] == 300.0]
    return statement


def _payable(client, who, card_name):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return [p for p in r.json()["payables"] if p["name"] == f"{card_name} statement"]


def _upcoming(client, who, name):
    r = client.get(f"{API}/forecast/upcoming", headers=who["headers"], params={"days": 30})
    assert r.status_code == 200, r.text
    return [i for i in r.json()["items"] if i.get("name") == name]


# --- AC1: balances --------------------------------------------------------------------------

def test_balances_move_by_sent_and_received(sw_client, sw_db, cc):
    client, db, a = sw_client, sw_db, cc["a"]
    assert _balance(db, cc["card"]) == Decimal("-300.00")
    txn = _pay(client, a, cc["php"], cc["card"], 5_800, transfer_fee=20,
               received_amount=100).json()
    assert (txn["amount"], txn["currency"], txn["received_amount"]) == (5_800, "PHP", 100)
    assert _balance(db, cc["php"]) == Decimal("44180.00")  # sent + fee, in PHP
    assert _balance(db, cc["card"]) == Decimal("-200.00")  # received, in USD
    assert _effects(client, a, cc["php"], txn["id"]) == [-5820.0]
    assert _effects(client, a, cc["card"], txn["id"]) == [100.0]
    # An edit moves each side by its new figure; a delete reverses both.
    r = client.put(f"{API}/transactions/{txn['id']}", headers=a["headers"],
                   json={"amount": 8_700, "received_amount": 150})
    assert r.status_code == 200, r.text
    assert _balance(db, cc["php"]) == Decimal("41280.00")
    assert _balance(db, cc["card"]) == Decimal("-150.00")
    r = client.delete(f"{API}/transactions/{txn['id']}", headers=a["headers"])
    assert r.status_code in (200, 204), r.text
    assert _balance(db, cc["php"]) == Decimal("50000.00")
    assert _balance(db, cc["card"]) == Decimal("-300.00")
    # Posting a planned payment takes the received figure too.
    planned = _pay(client, a, cc["php"], cc["card"], 5_800, day="2026-11-09",
                   posted=False).json()
    assert planned["received_amount"] is None
    assert _balance(db, cc["card"]) == Decimal("-300.00")
    r = client.put(f"{API}/transactions/{planned['id']}", headers=a["headers"],
                   json={"is_posted": True, "received_amount": 100})
    assert r.status_code == 200, r.text
    assert _balance(db, cc["php"]) == Decimal("44200.00")
    assert _balance(db, cc["card"]) == Decimal("-200.00")


# --- AC2: a planned payment's estimate -----------------------------------------------------

def test_pending_payment_shows_estimate(sw_client, sw_db, cc, frozen_fx_ref):
    client, db, a = sw_client, sw_db, cc["a"]
    _pay(client, a, cc["php"], cc["card"], 5_800, day="2026-11-09", posted=False,
         description="Planned PHP payment")
    # Listed in both currencies, the card's figure an estimate at the stored rate.
    rows = _upcoming(client, a, "Planned PHP payment")
    assert sorted((i["amount"], i["currency"], bool(i.get("estimated"))) for i in rows) == [
        (100.0, "USD", True), (5_800.0, "PHP", False)]
    (usd_row,) = [i for i in rows if i["currency"] == "USD"]
    assert (usd_row["rate"], usd_row["original_amount"], usd_row["original_currency"],
            usd_row["rate_stale"]) == (RATE_TO_USD, 5_800.0, "PHP", False)
    # The statement nets the estimate, in USD; its payable is estimated in PHP.
    statement = _statement(client, a, cc["card"])
    assert (statement["amount_due"], statement["currency"]) == (200.0, "USD")
    (payable,) = _payable(client, a, "USD Card")
    assert (payable["amount"], payable["currency"], payable["estimated"]) == (
        11_600.0, "PHP", True)
    # Nothing moves until it is posted.
    assert _balance(db, cc["php"]) == Decimal("50000.00")
    assert _balance(db, cc["card"]) == Decimal("-300.00")


def test_pending_payment_with_no_rate_is_unconverted_and_pays_nothing(sw_client, sw_db, cc,
                                                                      frozen_fx_ref):
    client, a = sw_client, cc["a"]
    _pay(client, a, cc["eur"], cc["card"], 50, day="2026-11-09", posted=False,
         description="Planned EUR payment")
    rows = _upcoming(client, a, "Planned EUR payment")
    (usd_row,) = [i for i in rows if i["currency"] == "USD"]
    assert (usd_row["amount"], usd_row["unconverted"], usd_row["original_amount"],
            usd_row["original_currency"]) == (None, True, 50.0, "EUR")
    statement = _statement(client, a, cc["card"])
    assert statement["amount_due"] == 300.0
    (payable,) = _payable(client, a, "USD Card")
    assert payable["amount"] == 17_400.0


# --- AC3: statements settle in the card's currency ----------------------------------------

def test_statement_settles_in_card_currency(sw_client, sw_db, cc, frozen_fx_ref):
    client, a = sw_client, cc["a"]
    assert _statement(client, a, cc["card"])["amount_due"] == 300.0
    _pay(client, a, cc["php"], cc["card"], 5_800, transfer_fee=20, received_amount=100)
    statement = _statement(client, a, cc["card"])
    # Netted by the USD 100 received, never by the PHP 5,800 sent (which would clear it).
    assert (statement["statement_balance"], statement["amount_due"], statement["currency"],
            statement["status"]) == (300.0, 200.0, "USD", "open")
    (payable,) = _payable(client, a, "USD Card")
    assert (payable["amount"], payable["currency"]) == (11_600.0, "PHP")
    # A second payment with the rest received settles it.
    _pay(client, a, cc["php"], cc["card"], 11_000, received_amount=200)
    statement = _statement(client, a, cc["card"])
    assert (statement["amount_due"], statement["status"]) == (0.0, "paid")
    assert _payable(client, a, "USD Card") == []


def test_card_credit_counts_a_planned_payment_at_its_estimate(sw_client, cc, frozen_fx_ref):
    client, a = sw_client, cc["a"]
    card = _account(client, a, "Limit card", "USD", 0, "credit", billing_cycle_start=20,
                    days_until_due_date=10, payment_account_id=cc["php"], credit_limit=1_000)
    _pay(client, a, cc["php"], card, 5_800, day="2026-11-09", posted=False)
    _pay(client, a, cc["eur"], card, 50, day="2026-11-10", posted=False)
    r = client.get(f"{API}/cards/{card}/credit", headers=a["headers"])
    assert r.status_code == 200, r.text
    # The PHP payment counts as its USD 100 estimate; the EUR one (no rate) not at all.
    assert r.json()["credit"]["planned_payments"] == [
        {"date": "2026-11-09", "amount": 100.0, "counted": True, "reason": None}]


# --- AC4: routing ---------------------------------------------------------------------------

def test_routing_allows_cross_currency(sw_client, sw_db, cc, frozen_fx_ref):
    client, a = sw_client, cc["a"]
    for field in ("payment_account_id", "payment_overflow_account_id"):
        r = client.post(f"{API}/accounts/", headers=a["headers"], json={
            "name": f"Card via {field}", "account_type": "credit", "currency": "USD",
            "billing_cycle_start": 20, "days_until_due_date": 10, field: cc["php"]})
        assert r.status_code in (200, 201), r.text
        assert r.json()[field] == cc["php"]
    card = _account(client, a, "Other USD Card", "USD", 0, "credit", billing_cycle_start=20,
                    days_until_due_date=10, payment_account_id=cc["usd"])
    r = client.put(f"{API}/accounts/{card}", headers=a["headers"],
                   json={"payment_account_id": cc["php"],
                         "payment_overflow_account_id": cc["eur"]})
    assert r.status_code == 200, r.text
    # A routed account (payer, overflow or card) may change currency.
    for account_id, currency in ((cc["eur"], "PHP"), (card, "PHP"), (card, "USD")):
        r = client.put(f"{API}/accounts/{account_id}", headers=a["headers"],
                       json={"currency": currency})
        assert r.status_code == 200, (account_id, r.text)
    # The fixture's USD card, paid from PHP, has its payable estimated in PHP.
    (payable,) = _payable(client, a, "USD Card")
    assert (payable["amount"], payable["currency"], payable["account_id"]) == (
        17_400.0, "PHP", cc["php"])


# --- AC6: same currency ---------------------------------------------------------------------

def test_same_currency_payment_unchanged(sw_client, sw_db, cc, frozen_fx_ref):
    client, db, a = sw_client, sw_db, cc["a"]
    txn = _pay(client, a, cc["usd"], cc["card"], 100, transfer_fee=1).json()
    assert (txn["currency"], txn["received_amount"]) == ("USD", None)
    assert _balance(db, cc["usd"]) == Decimal("899.00")
    assert _balance(db, cc["card"]) == Decimal("-200.00")
    # An equal received figure is dropped, any other refused, as before.
    assert _pay(client, a, cc["usd"], cc["card"], 50,
                received_amount=50).json()["received_amount"] is None
    r = _pay(client, a, cc["usd"], cc["card"], 50, received_amount=49, expect=(400,))
    assert "same currency" in r.json()["detail"]
    _pay(client, a, cc["usd"], cc["card"], 30, day="2026-11-09", posted=False)
    statement = _statement(client, a, cc["card"])
    assert statement["amount_due"] == 120.0  # 300 - 100 - 50 - 30 planned
    # The card Pay route still takes same-currency payers only.
    r = client.post(f"{API}/cards/{cc['card']}/payments", headers=a["headers"],
                    json={"from_account_id": cc["usd"], "amount": 20,
                          "payment_date": "2026-11-01"})
    assert r.status_code == 201, r.text
    assert _balance(db, cc["card"]) == Decimal("-130.00")


# --- AC9: received_amount validation ------------------------------------------------------

POSTED_CASES = [
    pytest.param({}, 400, id="posted-missing"),
    pytest.param({"received_amount": None}, 400, id="posted-null"),
    pytest.param({"received_amount": 0}, 400, id="posted-zero"),
    pytest.param({"received_amount": -5}, 422, id="posted-negative"),
]


@pytest.mark.parametrize("extra, status", POSTED_CASES)
def test_received_amount_validation_and_atomic_failure(sw_client, sw_db, cc, frozen_fx_ref,
                                                       extra, status):
    client, db, a = sw_client, sw_db, cc["a"]
    before = _statement(client, a, cc["card"])
    r = _pay(client, a, cc["php"], cc["card"], 5_800, expect=(status,), **extra)
    if status == 400:
        assert r.json()["detail"] == "Enter the amount received"
    # Posting a planned payment is held to the same rule.
    planned = _pay(client, a, cc["php"], cc["card"], 5_800, day="2026-11-09",
                   posted=False).json()
    r = client.put(f"{API}/transactions/{planned['id']}", headers=a["headers"],
                   json={"is_posted": True, **extra})
    assert r.status_code == status, r.text
    if status == 400:
        assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, cc["php"]) == Decimal("50000.00")
    assert _balance(db, cc["card"]) == Decimal("-300.00")
    # The planned payment still nets only its estimate; the refused ones nothing.
    after = _statement(client, a, cc["card"])
    assert before["amount_due"] == 300.0
    assert after["amount_due"] == 200.0
    client.delete(f"{API}/transactions/{planned['id']}", headers=a["headers"])
    assert _statement(client, a, cc["card"]) == before


@pytest.mark.parametrize("extra", [pytest.param({}, id="pending-missing"),
                                   pytest.param({"received_amount": 0}, id="pending-zero")])
def test_a_planned_payment_may_wait_for_the_amount(sw_client, sw_db, cc, extra):
    txn = _pay(sw_client, cc["a"], cc["php"], cc["card"], 5_800, day="2026-11-09",
               posted=False, **extra).json()
    assert txn["received_amount"] is None
    assert _balance(sw_db, cc["card"]) == Decimal("-300.00")


# --- Household agrees with the statement engine (STU-249) ---------------------------------

def test_household_cover_nets_an_estimated_cross_currency_payment(hh, sw_client, sw_db):
    """A's PHP card holds a pending USD 80 Household charge (PHP 4,640 est.).
    A planned USD 1 payment into it from a Household USD account is netted at
    its PHP 58 estimate, as the statement engine nets it."""
    from app.services.household import household_monthly, household_view

    reference = datetime(2026, 10, 10)
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": hh["a_card"], "transaction_type": "debit", "amount": 80,
        "currency": "PHP", "projected_amount": 80, "projected_currency": "USD",
        "transaction_date": "2026-10-12T00:00:00", "is_posted": False,
        "description": "Household streaming", "tag_ids": [hh["hh_a"]]})
    usd_joint = sw_post(sw_client, hh["a"], "/accounts/", {
        "name": "Joint dollars", "account_type": "checking", "currency": "USD",
        "balance": 500, "tag_ids": [hh["hh_a"]]})["id"]

    def totals():
        sw_db.expire_all()
        grant = household_view(sw_db, hh["a"]["id"], hh["a"]["id"])
        months = household_monthly(sw_db, hh["a"]["id"], grant, datetime(2026, 10, 1),
                                   datetime(2026, 11, 1), reference=reference)
        out = {}
        for month in months:
            for line in month["currencies"]:
                row = out.setdefault(line["currency"], {"expense": 0.0, "paid": 0.0})
                row["expense"] = round(row["expense"] + line["expense"], 2)
                row["paid"] = round(row["paid"] + line["paid_from_other_accounts"], 2)
        return out

    assert totals() == {"PHP": {"expense": 0.0, "paid": 4_640.0}}
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": usd_joint, "transfer_from_account_id": usd_joint,
        "transfer_to_account_id": hh["a_card"], "transaction_type": "transfer", "amount": 1,
        "transaction_date": "2026-11-01T00:00:00", "is_posted": False})
    assert totals() == {"PHP": {"expense": 0.0, "paid": 4_582.0},
                        "USD": {"expense": 1.0, "paid": 0.0}}

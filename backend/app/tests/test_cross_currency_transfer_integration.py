"""Cross-currency transfers record the amount received (STU-236, plan A).

A transfer stores ``amount`` in the source account's currency and a nullable
``received_amount`` in the destination's. Balances move each side by its own
figure: the source by ``amount + transfer_fee``, the destination by
``received_amount`` (or ``amount`` when it is null). Only write validation
reads account currencies, so balances, balance history and deletes keep
moving by the stored figures even after an account's currency changes behind
the API's back.

Also covered: the write rules (same currency: dropped when equal, else 400;
cross-currency posted: required; cards: refused), no payment or overflow
routing across currencies, materialising a cross-currency transfer entry, the
editor's ``shared_full`` and the viewer's limited view, the Household and
period-summary inbound figure, loan payments as they were, and the migration.
"""
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "c9e4a7d2f5b8"
RECEIVED = "d4b8e2f6a1c3"


# --- helpers ------------------------------------------------------------------------------

def _balance(db, account_id) -> Decimal:
    from app.models.account import Account

    db.expire_all()
    return Decimal(str(db.get(Account, account_id).balance))


def _history(client, who, account_id) -> dict:
    r = client.get(f"{API}/accounts/{account_id}/balance", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _effects(client, who, account_id, txn_id=None):
    """The signed effects in the balance history (only ``txn_id``'s when given)."""
    rows = _history(client, who, account_id)["balance_history"]
    if txn_id is not None:
        rows = [r for r in rows if r.get("transaction_id") == txn_id]
    return [round(r["amount"], 2) for r in rows]


def _transfer(client, who, src, dst, amount, *, expect=(200, 201), **extra):
    body = {"account_id": src, "transfer_from_account_id": src, "transfer_to_account_id": dst,
            "transaction_type": "transfer", "amount": amount,
            "transaction_date": "2026-10-07T00:00:00", **extra}
    r = client.post(f"{API}/transactions/", json=body, headers=who["headers"])
    assert r.status_code in expect, r.text
    return r


def _put(client, who, txn_id, body, expect=200):
    r = client.put(f"{API}/transactions/{txn_id}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _account(client, who, name, currency, balance=0, account_type="checking", **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "currency": currency,
        "balance": balance, **extra})["id"]


@pytest.fixture
def xc(sw_client, sw_db, sw_people):
    """Owner A: PHP Checking 50,000, PHP Savings 10,000, USD Savings 1,000, USD Spare 0.

    B is an editor on PHP Checking and USD Savings; V is a viewer on USD Savings.
    """
    client = sw_client
    a = sw_people("Ana", "Owner")
    b = sw_people("Ben", "Editor")
    v = sw_people("Val", "Viewer")
    php = _account(client, a, "PHP Checking", "PHP", 50_000)
    php_sav = _account(client, a, "PHP Savings", "PHP", 10_000)
    usd = _account(client, a, "USD Savings", "USD", 1_000)
    usd_spare = _account(client, a, "USD Spare", "USD", 0)
    sw_share(sw_db, php, b["id"], "editor", a["id"])
    sw_share(sw_db, usd, b["id"], "editor", a["id"])
    sw_share(sw_db, usd, v["id"], "viewer", a["id"])
    return {"a": a, "b": b, "v": v, "php": php, "php_sav": php_sav, "usd": usd,
            "usd_spare": usd_spare}


# --- balances move by each side's own figure -------------------------------------------

def test_posted_create_moves_each_side_by_its_own_figure(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    r = _transfer(client, a, xc["php"], xc["usd"], 10_000, transfer_fee=50, received_amount=170)
    body = r.json()
    assert body["received_amount"] == 170
    assert body["currency"] == "PHP"  # always the source account's
    assert _balance(db, xc["php"]) == Decimal("39950.00")
    assert _balance(db, xc["usd"]) == Decimal("1170.00")
    assert _effects(client, a, xc["php"], body["id"]) == [-10050.0]
    assert _effects(client, a, xc["usd"], body["id"]) == [170.0]
    usd_history = _history(client, a, xc["usd"])
    assert usd_history["calculated_balance"] == pytest.approx(170.0)


def test_currency_is_the_source_accounts_whatever_the_request_says(sw_client, xc):
    r = _transfer(sw_client, xc["a"], xc["usd"], xc["php"], 100, received_amount=5_800,
                  currency="PHP")
    assert r.json()["currency"] == "USD"


def test_update_moves_balances_by_the_new_figures_exactly(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    txn = _transfer(client, a, xc["php"], xc["usd"], 10_000, transfer_fee=50,
                    received_amount=170).json()["id"]

    _put(client, a, txn, {"amount": 12_000, "received_amount": 200})
    assert _balance(db, xc["php"]) == Decimal("37950.00")
    assert _balance(db, xc["usd"]) == Decimal("1200.00")

    _put(client, a, txn, {"received_amount": 210})
    assert _balance(db, xc["php"]) == Decimal("37950.00")
    assert _balance(db, xc["usd"]) == Decimal("1210.00")
    assert _effects(client, a, xc["usd"], txn) == [210.0]

    # Unposted: nothing moves. Posted again with the stored figure.
    _put(client, a, txn, {"is_posted": False})
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["usd"]) == Decimal("1000.00")
    assert _effects(client, a, xc["usd"], txn) == []
    _put(client, a, txn, {"is_posted": True})
    assert _balance(db, xc["php"]) == Decimal("37950.00")
    assert _balance(db, xc["usd"]) == Decimal("1210.00")

    # Another USD destination: the old one is reversed by the old figure.
    _put(client, a, txn, {"transfer_to_account_id": xc["usd_spare"], "received_amount": 205})
    assert _balance(db, xc["usd"]) == Decimal("1000.00")
    assert _balance(db, xc["usd_spare"]) == Decimal("205.00")
    assert _balance(db, xc["php"]) == Decimal("37950.00")

    # Another PHP source.
    _put(client, a, txn, {"account_id": xc["php_sav"], "transfer_from_account_id": xc["php_sav"]})
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["php_sav"]) == Decimal("-2050.00")
    assert _balance(db, xc["usd_spare"]) == Decimal("205.00")

    r = client.delete(f"{API}/transactions/{txn}", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert _balance(db, xc["php_sav"]) == Decimal("10000.00")
    assert _balance(db, xc["usd_spare"]) == Decimal("0.00")


def test_delete_reverses_each_side_by_its_own_figure(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    txn = _transfer(client, a, xc["php"], xc["usd"], 10_000, transfer_fee=50,
                    received_amount=170).json()["id"]
    r = client.delete(f"{API}/transactions/{txn}", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["usd"]) == Decimal("1000.00")


def test_stored_figures_win_after_a_currency_changes_behind_the_api(sw_client, sw_db, xc):
    """``_transfer_sides`` never reads currencies: the stored received amount wins."""
    from app.models.account import Account
    from app.models.user import CurrencyType

    client, db, a = sw_client, sw_db, xc["a"]
    txn = _transfer(client, a, xc["php"], xc["usd"], 10_000, transfer_fee=50,
                    received_amount=170).json()["id"]
    # Raw ORM update: the destination is now in the source's currency.
    db.query(Account).filter(Account.id == xc["usd"]).update({"currency": CurrencyType.PHP})
    db.commit()
    assert _effects(client, a, xc["usd"], txn) == [170.0]
    assert _effects(client, a, xc["php"], txn) == [-10050.0]
    r = client.delete(f"{API}/transactions/{txn}", headers=a["headers"])
    assert r.status_code == 200, r.text
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["usd"]) == Decimal("1000.00")


def test_update_after_a_currency_change_reverses_the_stored_figure(sw_client, sw_db, xc):
    from app.models.account import Account
    from app.models.user import CurrencyType

    client, db, a = sw_client, sw_db, xc["a"]
    txn = _transfer(client, a, xc["php"], xc["usd"], 10_000, transfer_fee=50,
                    received_amount=170).json()["id"]
    db.query(Account).filter(Account.id == xc["usd"]).update({"currency": CurrencyType.EUR})
    db.commit()
    _put(client, a, txn, {"amount": 11_000, "received_amount": 160})
    assert _balance(db, xc["php"]) == Decimal("38950.00")
    assert _balance(db, xc["usd"]) == Decimal("1160.00")
    _put(client, a, txn, {"is_posted": False})
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["usd"]) == Decimal("1000.00")


def test_limited_history_shows_the_received_figure(sw_client, sw_db, xc):
    client = sw_client
    txn = _transfer(client, xc["a"], xc["php"], xc["usd"], 10_000, transfer_fee=50,
                    received_amount=170).json()["id"]
    assert txn
    history = _history(client, xc["v"], xc["usd"])
    (row,) = history["balance_history"]
    assert row["view"] == "limited"
    assert row["amount"] == pytest.approx(170.0)
    assert row["balance_after"] == pytest.approx(170.0)
    assert history["calculated_balance"] == pytest.approx(170.0)


# --- refusals ---------------------------------------------------------------------------

def test_posted_cross_currency_transfer_needs_the_amount_received(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    for extra in ({}, {"received_amount": None}, {"received_amount": 0}):
        r = _transfer(client, a, xc["php"], xc["usd"], 10_000, expect=(400,), **extra)
        assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["usd"]) == Decimal("1000.00")


def test_unposted_cross_currency_transfer_may_wait_for_the_amount(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    r = _transfer(client, a, xc["php"], xc["usd"], 5_800, is_posted=False)
    txn = r.json()
    assert txn["received_amount"] is None
    r = _put(client, a, txn["id"], {"is_posted": True}, expect=400)
    assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["usd"]) == Decimal("1000.00")
    _put(client, a, txn["id"], {"is_posted": True, "received_amount": 100})
    assert _balance(db, xc["php"]) == Decimal("44200.00")
    assert _balance(db, xc["usd"]) == Decimal("1100.00")
    # Clearing it on a posted transfer is refused too.
    r = _put(client, a, txn["id"], {"received_amount": None}, expect=400)
    assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, xc["usd"]) == Decimal("1100.00")


def test_cross_currency_transfer_into_or_out_of_a_card_is_refused(sw_client, sw_db, xc):
    client, a = sw_client, xc["a"]
    usd_card = _account(client, a, "USD Card", "USD", 0, "credit", billing_cycle_start=20,
                        days_until_due_date=10)
    _transfer(client, a, xc["php"], usd_card, 5_800, received_amount=100, expect=(400,))
    _transfer(client, a, usd_card, xc["php"], 100, received_amount=5_800, expect=(400,))
    _transfer(client, a, xc["php"], usd_card, 5_800, received_amount=100, is_posted=False,
              expect=(400,))
    # Same currency stays allowed.
    _transfer(client, a, xc["usd"], usd_card, 100)
    # An edit that makes it cross-currency is refused.
    txn = _transfer(client, a, xc["usd"], usd_card, 50).json()["id"]
    _put(client, a, txn, {"account_id": xc["php"], "transfer_from_account_id": xc["php"],
                          "received_amount": 50}, expect=400)
    assert _balance(sw_db, usd_card) == Decimal("150.00")


def test_card_payment_and_overflow_routing_across_currencies_is_refused(sw_client, xc):
    client, a = sw_client, xc["a"]
    for field in ("payment_account_id", "payment_overflow_account_id"):
        r = client.post(f"{API}/accounts/", headers=a["headers"], json={
            "name": "USD Card", "account_type": "credit", "currency": "USD",
            "billing_cycle_start": 20, "days_until_due_date": 10, field: xc["php"]})
        assert r.status_code == 400, r.text
    card = _account(client, a, "USD Card", "USD", 0, "credit", billing_cycle_start=20,
                    days_until_due_date=10, payment_account_id=xc["usd"])
    for field in ("payment_account_id", "payment_overflow_account_id"):
        r = client.put(f"{API}/accounts/{card}", headers=a["headers"], json={field: xc["php"]})
        assert r.status_code == 400, r.text
    r = client.put(f"{API}/accounts/{card}", headers=a["headers"],
                   json={"payment_overflow_account_id": xc["usd_spare"]})
    assert r.status_code == 200, r.text


def test_entry_overflow_across_currencies_is_refused(sw_client, xc):
    client, a = sw_client, xc["a"]
    base = {"name": "USD rent", "entry_type": "expense", "amount": 1_500, "currency": "USD",
            "next_occurrence": "2026-11-10T00:00:00", "account_id": xc["usd"]}
    r = client.post(f"{API}/budget-entries/", headers=a["headers"],
                    json={**base, "overflow_account_id": xc["php_sav"]})
    assert r.status_code == 400, r.text
    entry = sw_post(client, a, "/budget-entries/", {**base, "overflow_account_id": xc["usd_spare"]})
    r = client.put(f"{API}/budget-entries/{entry['id']}", headers=a["headers"],
                   json={"overflow_account_id": xc["php_sav"]})
    assert r.status_code == 400, r.text
    r = client.put(f"{API}/budget-entries/{entry['id']}", headers=a["headers"],
                   json={"account_id": xc["php"]})
    assert r.status_code == 400, r.text


def test_account_currency_edit_that_would_pair_currencies_is_refused(sw_client, xc):
    client, a = sw_client, xc["a"]
    card = _account(client, a, "PHP Card", "PHP", 0, "credit", billing_cycle_start=15,
                    days_until_due_date=10, payment_account_id=xc["php"],
                    payment_overflow_account_id=xc["php_sav"])
    # The payer, the overflow account or the card itself changing currency.
    for account_id in (xc["php"], xc["php_sav"], card):
        r = client.put(f"{API}/accounts/{account_id}", headers=a["headers"],
                       json={"currency": "USD"})
        assert r.status_code == 400, (account_id, r.text)
    # An entry's overflow pairing too.
    sw_post(client, a, "/budget-entries/", {
        "name": "USD rent", "entry_type": "expense", "amount": 1_500, "currency": "USD",
        "next_occurrence": "2026-11-10T00:00:00", "account_id": xc["usd"],
        "overflow_account_id": xc["usd_spare"]})
    for account_id in (xc["usd"], xc["usd_spare"]):
        r = client.put(f"{API}/accounts/{account_id}", headers=a["headers"],
                       json={"currency": "PHP"})
        assert r.status_code == 400, (account_id, r.text)
    # Resending the stored currency, or changing an unpaired account, is fine.
    r = client.put(f"{API}/accounts/{xc['php']}", headers=a["headers"], json={"currency": "PHP"})
    assert r.status_code == 200, r.text
    spare = _account(client, a, "Unpaired", "PHP", 0)
    r = client.put(f"{API}/accounts/{spare}", headers=a["headers"], json={"currency": "EUR"})
    assert r.status_code == 200, r.text


# --- same-currency rules ----------------------------------------------------------------

def test_same_currency_received_amount_is_dropped_when_equal_and_refused_otherwise(
        sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    r = _transfer(client, a, xc["php"], xc["php_sav"], 1_000, transfer_fee=10,
                  received_amount=1_000)
    txn = r.json()
    assert txn["received_amount"] is None
    assert _balance(db, xc["php"]) == Decimal("48990.00")
    assert _balance(db, xc["php_sav"]) == Decimal("11000.00")
    _transfer(client, a, xc["php"], xc["php_sav"], 1_000, received_amount=999, expect=(400,))
    _put(client, a, txn["id"], {"received_amount": 998}, expect=400)
    r = _put(client, a, txn["id"], {"amount": 1_200, "received_amount": 1_200})
    assert r.json()["received_amount"] is None
    assert _balance(db, xc["php_sav"]) == Decimal("11200.00")


def test_retargeting_to_the_same_currency_clears_the_received_amount(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    txn = _transfer(client, a, xc["php"], xc["usd"], 10_000, received_amount=170).json()["id"]
    r = _put(client, a, txn, {"transfer_to_account_id": xc["php_sav"]})
    assert r.json()["received_amount"] is None
    assert _balance(db, xc["usd"]) == Decimal("1000.00")
    assert _balance(db, xc["php_sav"]) == Decimal("20000.00")
    assert _balance(db, xc["php"]) == Decimal("40000.00")


def test_same_currency_transfers_are_unchanged(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    txn = _transfer(client, a, xc["php"], xc["php_sav"], 1_000, transfer_fee=10).json()
    assert txn["received_amount"] is None
    assert _balance(db, xc["php"]) == Decimal("48990.00")
    assert _balance(db, xc["php_sav"]) == Decimal("11000.00")
    _put(client, a, txn["id"], {"amount": 2_000})
    assert _balance(db, xc["php"]) == Decimal("47990.00")
    assert _balance(db, xc["php_sav"]) == Decimal("12000.00")
    assert _effects(client, a, xc["php_sav"], txn["id"]) == [2000.0]
    client.delete(f"{API}/transactions/{txn['id']}", headers=a["headers"])
    assert _balance(db, xc["php"]) == Decimal("50000.00")
    assert _balance(db, xc["php_sav"]) == Decimal("10000.00")


def test_a_debit_keeps_no_received_amount(sw_client, xc):
    r = sw_client.post(f"{API}/transactions/", headers=xc["a"]["headers"], json={
        "account_id": xc["php"], "transaction_type": "debit", "amount": 100,
        "received_amount": 5, "transaction_date": "2026-10-07T00:00:00"})
    assert r.status_code == 200, r.text
    assert r.json()["received_amount"] is None


# --- materialise -------------------------------------------------------------------------

def test_materialising_a_cross_currency_transfer_entry_needs_the_amount_received(
        sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    entry = sw_post(client, a, "/budget-entries/", {
        "name": "USD to PHP", "entry_type": "expense", "amount": 500, "currency": "USD",
        "next_occurrence": "2026-11-16T00:00:00", "account_id": xc["usd"],
        "transfer_to_account_id": xc["php"]})
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", json={},
                    headers=a["headers"])
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Enter the amount received"
    assert _balance(db, xc["usd"]) == Decimal("1000.00")
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize",
                    json={"received_amount": 29_000}, headers=a["headers"])
    assert r.status_code == 201, r.text
    assert r.json()["received_amount"] == 29_000
    assert r.json()["currency"] == "USD"
    assert _balance(db, xc["usd"]) == Decimal("500.00")
    assert _balance(db, xc["php"]) == Decimal("79000.00")


# --- views ------------------------------------------------------------------------------

def test_editor_sees_the_received_amount_and_a_viewer_does_not(sw_client, xc):
    client = sw_client
    txn = _transfer(client, xc["a"], xc["php"], xc["usd"], 10_000, transfer_fee=50,
                    received_amount=170).json()["id"]
    r = client.get(f"{API}/transactions/{txn}", headers=xc["b"]["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["view"] == "shared_full"
    assert r.json()["received_amount"] == 170

    r = client.get(f"{API}/transactions/{txn}", headers=xc["v"]["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["view"] == "limited"
    assert "received_amount" not in body
    # Today's values: the source amount and currency.
    assert (body["amount"], body["transfer_fee"], body["currency"]) == (10_000, 50, "PHP")
    assert set(body) == {
        "view", "id", "permissions", "created_by", "date", "display_description", "amount",
        "transfer_fee", "currency", "transaction_type", "is_posted", "category_name",
        "account", "counterpart", "tags"}


def test_own_data_export_carries_the_received_amount(sw_client, xc):
    _transfer(sw_client, xc["a"], xc["php"], xc["usd"], 10_000, received_amount=170)
    r = sw_client.get(f"{API}/data/export.json", headers=xc["a"]["headers"])
    assert r.status_code == 200, r.text
    (txn,) = r.json()["transactions"]
    assert txn["received_amount"] == "170.00"


# --- inbound figures in summaries -------------------------------------------------------

def test_period_summary_tops_a_wallet_up_by_the_received_amount(sw_client, xc):
    client, a = sw_client, xc["a"]
    wallet = _account(client, a, "USD Wallet", "USD", 0, is_spending_wallet=True)
    _transfer(client, a, xc["php"], wallet, 10_000, transfer_fee=50, received_amount=170)
    r = client.get(f"{API}/transactions/summary/period", headers=a["headers"], params={
        "start_date": "2026-10-01T00:00:00", "end_date": "2026-10-31T23:59:59"})
    assert r.status_code == 200, r.text
    body = r.json()
    # The top-up is spending of what left PHP (amount + fee) ...
    assert Decimal(str(body["summary"]["total_expenses"])) == Decimal("10050")
    # ... and what arrived in the wallet is its unallocated spend.
    breakdown = body["category_breakdown"]
    assert Decimal(str(breakdown["Unallocated wallet spend"]["expenses"])) == Decimal("170")
    assert Decimal(str(breakdown["Transfer fees"]["expenses"])) == Decimal("50")


def test_household_inbound_leg_uses_the_received_amount(sw_client, sw_db, sw_people):
    """A transfer into the Household scope from outside it counts what arrived."""
    from datetime import datetime

    from app.core.tags import ensure_household_tag
    from app.services.household import household_monthly, household_view

    client, db = sw_client, sw_db
    a = sw_people("Ana", "Owner")
    hh = ensure_household_tag(db, a["id"])
    db.commit()
    outside = _account(client, a, "PHP outside", "PHP", 50_000)
    joint = _account(client, a, "USD joint", "USD", 0, tag_ids=[hh.id])
    _transfer(client, a, outside, joint, 10_000, transfer_fee=50, received_amount=170,
              transaction_date="2026-10-07T00:00:00")
    db.expire_all()
    grant = household_view(db, a["id"], a["id"])
    months = household_monthly(db, a["id"], grant, datetime(2026, 10, 1), datetime(2026, 10, 1),
                               reference=datetime(2026, 10, 20))
    (october,) = months
    rows = {row["currency"]: row for row in october["currencies"]}
    assert set(rows) == {"USD"}
    assert rows["USD"]["moved_in"] == pytest.approx(170.0)


# --- loans stay as they were --------------------------------------------------------------

def test_loan_payment_is_unchanged(sw_client, sw_db, xc):
    client, db, a = sw_client, sw_db, xc["a"]
    loan = sw_post(client, a, "/accounts/", {
        "name": "Car loan", "account_type": "loan", "loan_kind": "auto", "currency": "PHP",
        "balance": -100_000, "loan_annual_rate": 12, "loan_term_months": 24,
        "loan_payment_amount": 5_000, "loan_first_payment_date": "2026-10-20",
        "payment_account_id": xc["php"]})["id"]
    r = client.post(f"{API}/accounts/{loan}/loan-payment", headers=a["headers"], json={
        "principal": 4_000, "interest": 1_000, "transaction_date": "2026-10-20T00:00:00"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["amount"], body["transfer_fee"], body["received_amount"]) == (4_000, 1_000, None)
    assert _balance(db, xc["php"]) == Decimal("45000.00")
    assert _balance(db, loan) == Decimal("-96000.00")
    assert _effects(client, a, loan, body["id"]) == [4000.0]
    # A loan payment from another currency is refused by the loan's own rule.
    r = _transfer(client, a, xc["usd"], loan, 100, received_amount=5_800, expect=(400,))
    assert "currency" in r.json()["detail"]


# --- migration ---------------------------------------------------------------------------

def test_received_amount_follows_tag_shares_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert RECEIVED in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(RECEIVED).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_received_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_received_amount_upgrade_keeps_rows_and_downgrades(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('mig@example.com', 'x', 'Mig', 'Ration') RETURNING id")).scalar_one()
            php, usd = (c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, currency, balance) "
                "VALUES (:u, :n, 'checking', :c, 0) RETURNING id"),
                {"u": user, "n": n, "c": cur}).scalar_one()
                for n, cur in (("PHP", "PHP"), ("USD", "USD")))
            c.execute(text(
                "INSERT INTO transactions (user_id, account_id, amount, currency, transfer_fee, "
                "transaction_type, is_posted, transfer_from_account_id, transfer_to_account_id, "
                "transaction_date) VALUES (:u, :p, 1000, 'PHP', 0, 'transfer', true, :p, :d, "
                "'2026-10-07')"), {"u": user, "p": php, "d": usd})

        _alembic(scratch_url, "upgrade", RECEIVED)
        with engine.begin() as c:
            columns = {col["name"]: col for col in inspect(c).get_columns("transactions")}
            assert columns["received_amount"]["nullable"] is True
            assert (columns["received_amount"]["type"].precision,
                    columns["received_amount"]["type"].scale) == (15, 2)
            assert c.execute(text(
                "SELECT amount, received_amount FROM transactions")).one() == (
                Decimal("1000.00"), None)

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert "received_amount" not in {
                col["name"] for col in inspect(c).get_columns("transactions")}
            assert c.execute(text("SELECT count(*) FROM transactions")).scalar_one() == 1
            assert c.execute(text(
                "SELECT version_num FROM alembic_version")).scalar_one() == PREVIOUS
    finally:
        engine.dispose()

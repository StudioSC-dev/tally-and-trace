"""A wishlist item's installment outlook and the plan's installment list (STU-779).

Owner A (default PHP): a PHP bank, a PHP card with a 50,000 limit closing on the
15th, 40,000 income and 25,000 rent a month, and a card installment already
running on the card: 3,000 a month for six months, from the close in the month
after next month starts. So disposable income is 12,000 a month (the installment
is already subtracted) and the card's available credit is 32,000 (its whole
remaining 18,000 is held). Posted last month on the bank (``fixtures/posted_flow``):
40,000 in and 28,000 out, so net flow and free flow are 12,000 a month too: the
disposable check compares an item with that rate (STU-789). Exchange rates: USD
and PHP only (no EUR). Skips without a database.
"""
from datetime import date

import pytest

from app.core.time import manila_today
from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.fixtures import posted_flow

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


def _month(offset: int) -> date:
    today = manila_today()
    index = today.year * 12 + today.month - 1 + offset
    return date(index // 12, index % 12 + 1, 1)


def _entry(client, who, name, amount, account_id, entry_type="expense", **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": entry_type, "amount": amount, "currency": "PHP",
        "cadence": "monthly", "account_id": account_id,
        "next_occurrence": f"{_month(1).isoformat()}T00:00:00Z", **extra})["id"]


@pytest.fixture
def ol(sw_client, sw_db, sw_people):
    client = sw_client
    a = sw_people("Olive", "Outlook")
    bank = sw_post(client, a, "/accounts/", {
        "name": "Bank", "account_type": "checking", "balance": 100_000})["id"]
    card = sw_post(client, a, "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 15,
        "days_until_due_date": 10, "payment_account_id": bank, "credit_limit": 50_000})["id"]
    _entry(client, a, "Salary", 40_000, bank, "income")
    _entry(client, a, "Rent", 25_000, bank)
    existing = _entry(client, a, "Phone", 3_000, card, end_mode="after_occurrences",
                      max_occurrences=6,
                      next_occurrence=f"{_month(1).replace(day=6).isoformat()}T00:00:00Z")
    posted_flow.flow(sw_db, a["id"], bank, income=40_000, spending=28_000)
    return {"a": a, "bank": bank, "card": card, "existing": existing}


def _item(client, who, cost, currency="PHP", **fields):
    return sw_post(client, who, "/wishlist/", {
        "name": "Laptop", "estimated_cost": cost, "currency": currency, **fields})["id"]


def _outlook(client, who, item_id, expect=200):
    r = client.get(f"{API}/wishlist/{item_id}/outlook", headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def test_installment_amounts_and_months(sw_client, ol):
    item = _item(sw_client, ol["a"], 20_000, payment_plan="installment", installment_months=24,
                 account_id=ol["card"])
    body = _outlook(sw_client, ol["a"], item)
    # The shared split: 20,000 / 24 = 833.33 a month, the last 833.41.
    assert (body["monthly_amount"], body["final_amount"]) == (833.33, 833.41)
    assert (body["currency"], body["payment_plan"], body["installment_months"]) == (
        "PHP", "installment", 24)
    months = body["months"]
    # From next month through the later of the term (24) and 12 months.
    assert [m["month"] for m in months] == [_month(1 + i).strftime("%Y-%m") for i in range(24)]
    assert [m["this_item"] for m in months] == [833.33] * 23 + [833.41]
    # The running installment: 3,000 in each of its six months, from next month.
    assert [m["existing_installments"] for m in months] == [3_000.0] * 6 + [0.0] * 18
    assert months[0]["total"] == 3_833.33
    assert months[23]["total"] == 833.41
    assert body["note"] is None


def test_a_full_payment_shows_twelve_months(sw_client, ol):
    item = _item(sw_client, ol["a"], 1_500, account_id=ol["bank"])
    body = _outlook(sw_client, ol["a"], item)
    assert (body["monthly_amount"], body["final_amount"], body["credit_check"]) == (
        None, None, None)
    assert len(body["months"]) == 12
    assert [m["this_item"] for m in body["months"]] == [1_500.0] + [0.0] * 11


def test_disposable_compares_only_this_item(sw_client, ol):
    client, a = sw_client, ol["a"]
    # 10,000 a month fits a 12,000 free flow, though with the running 3,000
    # installment the month totals 13,000: the months are context only.
    fits = _outlook(client, a, _item(client, a, 120_000, payment_plan="installment",
                                     installment_months=12, account_id=ol["card"]))
    assert fits["disposable_check"] == {
        "status": "fits", "currency": "PHP", "amount": 10_000.0,
        "monthly_disposable": 12_000.0, "after_purchase": 2_000.0, "reason": None,
        "basis": "free_flow", "available": 12_000.0}
    assert fits["months"][0]["total"] == 13_000.0
    over = _outlook(client, a, _item(client, a, 156_000, payment_plan="installment",
                                     installment_months=12, account_id=ol["card"]))
    assert over["disposable_check"]["status"] == "over"
    assert over["disposable_check"]["after_purchase"] == -1_000.0
    # A full payment compares the whole price.
    full = _outlook(client, a, _item(client, a, 12_000.01, account_id=ol["bank"]))
    assert (full["disposable_check"]["status"], full["disposable_check"]["amount"]) == (
        "over", 12_000.01)
    assert _outlook(client, a, _item(client, a, 12_000))["disposable_check"]["status"] == "fits"


def test_credit_compares_the_full_price_with_available_now(sw_client, ol):
    client, a = sw_client, ol["a"]
    fits = _outlook(client, a, _item(client, a, 32_000, payment_plan="installment",
                                     installment_months=12, account_id=ol["card"]))
    assert fits["credit_check"] == {
        "status": "fits", "currency": "PHP", "amount": 32_000.0, "available": 32_000.0,
        "limit": 50_000.0, "reason": None}
    over = _outlook(client, a, _item(client, a, 32_000.01, payment_plan="installment",
                                     installment_months=12, account_id=ol["card"]))
    assert over["credit_check"]["status"] == "over"
    # A full payment on the card is checked too.
    full = _outlook(client, a, _item(client, a, 40_000, account_id=ol["card"]))
    assert full["credit_check"]["status"] == "over"


def test_a_card_with_no_limit_is_unknown(sw_client, ol):
    client, a = sw_client, ol["a"]
    bare = sw_post(client, a, "/accounts/", {
        "name": "Bare card", "account_type": "credit", "balance": 0, "billing_cycle_start": 15,
        "days_until_due_date": 10, "payment_account_id": ol["bank"]})["id"]
    body = _outlook(client, a, _item(client, a, 1_000, payment_plan="installment",
                                     installment_months=2, account_id=bare))
    assert body["credit_check"] == {"status": "unknown", "currency": None, "amount": None,
                                    "available": None, "limit": None,
                                    "reason": "This card has no credit limit set"}


def test_a_missing_rate_is_unknown_with_a_reason(sw_client, ol):
    client, a = sw_client, ol["a"]
    body = _outlook(client, a, _item(client, a, 300, "EUR", payment_plan="installment",
                                     installment_months=3, account_id=ol["card"]))
    assert body["credit_check"]["status"] == "unknown"
    assert body["credit_check"]["reason"] == "No exchange rate from EUR to PHP is stored yet"
    # No EUR disposable row either.
    check = body["disposable_check"]
    assert (check["status"], check["monthly_disposable"]) == ("unknown", None)
    assert "EUR" in check["reason"]
    # The running PHP installment has no rate into EUR: those months have no total.
    assert [m["existing_installments"] for m in body["months"][:7]] == [None] * 6 + [0.0]
    assert body["months"][0]["total"] is None
    assert "EUR" in body["note"]
    # With a stored rate (58 PHP per USD) the price is converted into the card's currency.
    usd = _outlook(client, a, _item(client, a, 100, "USD", payment_plan="installment",
                                    installment_months=2, account_id=ol["card"]))
    assert (usd["credit_check"]["status"], usd["credit_check"]["amount"]) == ("fits", 5_800.0)
    assert usd["months"][0]["existing_installments"] == round(3_000 / 58, 2)


def test_no_income_is_unknown(sw_client, sw_db, sw_people):
    client = sw_client
    b = sw_people("Nell", "NoIncome")
    bank = sw_post(client, b, "/accounts/", {
        "name": "Bank", "account_type": "checking", "balance": 1_000})["id"]
    _entry(client, b, "Rent", 500, bank)
    posted_flow.flow(sw_db, b["id"], bank, spending=500)   # no income posted
    body = _outlook(client, b, _item(client, b, 100, account_id=bank))
    assert body["disposable_check"] == {
        "status": "unknown", "currency": "PHP", "amount": 100.0, "monthly_disposable": None,
        "after_purchase": None, "basis": "free_flow", "available": None,
        "reason": "No projected income or expenses in PHP, so this can't be judged yet."}


def test_household_roles_and_ownership(sw_client, sw_db, sw):
    client = sw_client
    item = _item(client, sw["a"], 1_000, payment_plan="installment", installment_months=2,
                 account_id=sw["a_card"])
    # Only the owner reads an item's outlook.
    for who in (sw["b"], sw["v"], sw["d"], sw["s"]):
        _outlook(client, who, item, expect=404)
    owner = _outlook(client, sw["a"], item)["credit_check"]
    assert (owner["status"], owner["limit"]) == ("fits", 77_777.0)
    # The card shared: an editor plans on it but may not see its credit; an admin may.
    sw_share(sw_db, sw["a_card"], sw["b"]["id"], "editor", sw["a"]["id"])
    sw_share(sw_db, sw["a_card"], sw["d"]["id"], "admin", sw["a"]["id"])
    b_item = _item(client, sw["b"], 1_000, payment_plan="installment", installment_months=2,
                   account_id=sw["a_card"])
    assert _outlook(client, sw["b"], b_item)["credit_check"] == {
        "status": "unknown", "currency": None, "amount": None, "available": None,
        "limit": None,
        "reason": "Only the card's owner or an admin can see its available credit"}
    d_item = _item(client, sw["d"], 1_000, payment_plan="installment", installment_months=2,
                   account_id=sw["a_card"])
    d_credit = _outlook(client, sw["d"], d_item)["credit_check"]
    assert (d_credit["status"], d_credit["limit"]) == ("fits", 77_777.0)


def test_plan_lists_installments_apart_from_the_queue(sw_client, ol):
    client, a = sw_client, ol["a"]
    _item(client, a, 6_000, priority="critical")
    inst = _item(client, a, 10_000, payment_plan="installment", installment_months=3,
                 account_id=ol["card"], priority="high")
    _item(client, a, 12_000, priority="medium")
    r = client.get(f"{API}/wishlist/plan", headers=a["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    # The save-up queue: the critical item at a 12,000 net flow, 1 month; the want
    # behind it at a 12,000 free flow, 1 + 1 months.
    assert [(i["estimated_cost"], i["cumulative_months"]) for i in body["items"]] == [
        (6_000.0, 1), (12_000.0, 2)]
    assert body["installments"] == [{
        "item_id": inst, "name": "Laptop", "estimated_cost": 10_000.0, "currency": "PHP",
        "account_id": ol["card"], "installment_months": 3, "monthly_amount": 3_333.33,
        "final_amount": 3_333.34}]

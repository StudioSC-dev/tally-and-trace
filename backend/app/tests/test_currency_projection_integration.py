"""Projections split by account currency (STU-236, plan C, D, B5-B7; criteria 1-8, 10, 15-18).

The fixture (criterion 1) is written through the ORM with no balance effects, at
``FX_REF`` (2026-11-02), with the suite's rates (58.00 PHP per USD, fresh). Every
projection endpoint runs under a clock frozen at ``FX_REF``. Each currency is
projected on its own: legs keep their account's currency, a figure in another
currency is estimated at the stored rate, and nothing is added across currencies.
"""
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.tests.conftest import API, FX_REF, sw_db_reachable, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

REF = FX_REF  # 2026-11-02 00:00, naive UTC
RATE_TO_PHP, RATE_TO_USD = 58.0, 0.017241
RATE_AS_OF = (FX_REF - timedelta(hours=1)).date().isoformat()  # 2026-11-01
LABELS = ("estimated", "original_amount", "original_currency", "rate", "rate_as_of",
          "rate_stale", "unconverted", "received_amount", "unconverted_lines")


# --- helpers ------------------------------------------------------------------------------

def _d(day, month=11, year=2026):
    return datetime(year, month, day)


def _acct(db, uid, name, kind, currency, balance, **kw):
    from app.models.account import Account, AccountType
    from app.models.user import CurrencyType

    a = Account(user_id=uid, name=name, account_type=AccountType(kind),
                currency=CurrencyType(currency), balance=Decimal(str(balance)), **kw)
    db.add(a)
    db.commit()
    return a.id


def _entry(db, uid, name, kind, amount, currency, when, account=None, **kw):
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency
    from app.models.user import CurrencyType

    e = BudgetEntry(user_id=uid, name=name, entry_type=BudgetEntryType(kind),
                    amount=Decimal(str(amount)), currency=CurrencyType(currency),
                    cadence=RecurrenceFrequency.MONTHLY, next_occurrence=when,
                    account_id=account, **kw)
    db.add(e)
    db.commit()
    return e.id


def _txn(db, uid, account, kind, amount, when, currency, posted=False, **kw):
    from app.models.transaction import Transaction, TransactionType
    from app.models.user import CurrencyType

    for key in ("projected_currency", "original_currency"):
        if kw.get(key) is not None:
            kw[key] = CurrencyType(kw[key])
    for key in ("projected_amount", "original_amount", "received_amount", "transfer_fee"):
        if kw.get(key) is not None:
            kw[key] = Decimal(str(kw[key]))
    t = Transaction(user_id=uid, account_id=account, transaction_type=TransactionType(kind),
                    amount=Decimal(str(amount)), currency=CurrencyType(currency),
                    transaction_date=when, is_posted=posted, **kw)
    db.add(t)
    db.commit()
    return t.id


def _transfer(db, uid, src, dst, amount, when, currency, posted=False, **kw):
    return _txn(db, uid, src, "transfer", amount, when, currency, posted=posted,
                transfer_from_account_id=src, transfer_to_account_id=dst, **kw)


@pytest.fixture
def frozen(monkeypatch):
    """Every clock a projection, statement or Household route reads, frozen at REF."""
    from app.core import time as time_module
    from app.routers import accounts as accounts_router
    from app.routers import household as household_router
    from app.services import forecast as forecast_module

    for module in (time_module, accounts_router, household_router, forecast_module):
        monkeypatch.setattr(module, "naive_utc_now", lambda: REF)
    return REF


@pytest.fixture
def cx(sw_people, sw_db):
    """Criterion 1's fixture, for owner A (default currency PHP)."""
    from app.models.category import Category, CategoryKind
    from app.models.user import CurrencyType, User

    db = sw_db
    a = sw_people("Cora", "Currency")
    uid = a["id"]
    db.get(User, uid).default_currency = CurrencyType.PHP
    db.commit()
    php = _acct(db, uid, "PHP Checking", "checking", "PHP", 50_000)
    php_sav = _acct(db, uid, "PHP Savings", "savings", "PHP", 10_000)
    usd = _acct(db, uid, "USD Savings", "savings", "USD", 1_000)
    usd_card = _acct(db, uid, "USD Card", "credit", "USD", -300, billing_cycle_start=20,
                     days_until_due_date=10, payment_account_id=usd)
    php_card = _acct(db, uid, "PHP Card", "credit", "PHP", 0, billing_cycle_start=15,
                     days_until_due_date=10, payment_account_id=php)
    food = Category(user_id=uid, name="Food", kind=CategoryKind.EXPENSE, is_expense=True)
    db.add(food)
    db.commit()
    ids = {"php": php, "php_sav": php_sav, "usd": usd, "usd_card": usd_card,
           "php_card": php_card, "food": food.id}
    ids["usd_card_charge"] = _txn(db, uid, usd_card, "debit", 300, _d(25, 10), "USD",
                                  posted=True, category_id=food.id, description="Diner")
    # A reverted row: amount 12 kept, face projected USD 10.
    ids["php_card_charge"] = _txn(db, uid, php_card, "debit", 12, _d(3), "PHP",
                                  projected_amount=10, projected_currency="USD",
                                  description="Card charge")
    ids["rent"] = _entry(db, uid, "PHP rent", "expense", 25_000, "PHP", _d(5), php)
    ids["income"] = _entry(db, uid, "PHP income", "income", 40_000, "PHP", _d(15), php)
    ids["usd_rent"] = _entry(db, uid, "USD rent", "expense", 1_500, "USD", _d(10), usd,
                             overflow_account_id=php_sav)
    ids["subscription"] = _entry(db, uid, "Subscription", "expense", 20, "USD", _d(12), php)
    ids["accountless"] = _entry(db, uid, "Accountless", "expense", 50, "USD", _d(20))
    ids["usd_to_php"] = _entry(db, uid, "USD to PHP", "expense", 500, "USD", _d(16), usd,
                               transfer_to_account_id=php)
    ids["foreign_debit"] = _txn(db, uid, php, "debit", 80, _d(8), "PHP",
                                projected_amount=80, projected_currency="USD",
                                description="Foreign purchase")
    ids["php_to_usd"] = _transfer(db, uid, php, usd, 5_800, _d(9), "PHP",
                                  description="Pending PHP to USD")
    ids["oct_php"] = _txn(db, uid, php, "debit", 1_000, _d(5, 10), "PHP", posted=True,
                          category_id=food.id, description="Groceries")
    ids["oct_usd"] = _txn(db, uid, usd, "debit", 30, _d(6, 10), "USD", posted=True,
                          category_id=food.id, description="Lunch")
    ids["oct_transfer"] = _transfer(db, uid, php, usd, 10_000, _d(7, 10), "PHP", posted=True,
                                    transfer_fee=50, received_amount=170,
                                    description="Posted PHP to USD")
    return {"a": a, **ids}


def _get(client, who, path, expect=200, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == expect, (path, r.status_code, r.text)
    return r.json()


def _row(body, currency):
    (row,) = [r for r in body["by_currency"] if r["currency"] == currency]
    return row


def _events(row):
    return [(e["date"], e["amount"], bool(e.get("estimated"))) for e in row["events"]]


def _closings(row, names):
    return {names[a["account_id"]]: a["closing_balance"] for a in row["by_account"]}


def _names(cx):
    return {cx["php"]: "PHP Checking", cx["php_sav"]: "PHP Savings", cx["usd"]: "USD Savings"}


# --- criterion 7: an independent checker -------------------------------------------------

def _close(a, b):
    return abs(a - b) < 0.005


def check_timeline_row(row):
    """opening + sum of deltas == closing; sum of account closings + unassigned == closing."""
    total = row["opening_balance"] + sum(
        e["amount"] if "amount" in e else e["cash_delta"] for e in row["events"])
    assert _close(total, row["closing_balance"]), row["currency"]
    accounts = sum(a["closing_balance"] for a in row["by_account"]) + row["unassigned_closing"]
    assert _close(accounts, row["closing_balance"]), row["currency"]


def check_cashflow_row(row):
    net = (row["income"] - row["expenses"] - row["unposted_expenses"]
           - row["statement_payables"] + row["moved_in"] - row["moved_out"]
           + row["loan_payables"])
    assert _close(net, row["net"]), row["currency"]
    assert _close(row["opening_balance"] + row["net"], row["closing_balance"]), row["currency"]
    accounts = sum(a["closing_balance"] for a in row["by_account"]) + row["unassigned_closing"]
    assert _close(accounts, row["closing_balance"]), row["currency"]


def check_disposable_row(row):
    assert _close(row["monthly_income"] - row["monthly_expenses"] + row["moved_in"]
                  - row["moved_out"], row["monthly_disposable"]), row["currency"]


def check_summary_row(row):
    assert _close(row["total_income"] - row["total_expenses"] + row["moved_in"]
                  - row["moved_out"], row["net_flow"]), row["currency"]


# --- criterion 2: the timeline -----------------------------------------------------------

def test_timeline_projects_each_currency_on_its_own(sw_client, cx, frozen):
    a, names = cx["a"], _names(cx)
    body = _get(sw_client, a, "/forecast/timeline", days=30)
    assert body["currencies"] == ["PHP", "USD"]
    assert [r["currency"] for r in body["by_currency"]] == ["PHP", "USD"]

    php = _row(body, "PHP")
    assert php["opening_balance"] == 60_000.0
    assert _events(php) == [
        ("2026-11-05", -25_000.0, False), ("2026-11-08", -4_640.0, True),
        ("2026-11-09", -5_800.0, False), ("2026-11-12", -1_160.0, True),
        ("2026-11-15", 40_000.0, False), ("2026-11-16", 29_000.0, True),
        ("2026-11-25", -580.0, True)]
    assert (php["lowest_balance"], php["trough_date"]) == (23_400.0, "2026-11-12")
    assert php["closing_balance"] == 91_820.0
    assert _closings(php, names) == {"PHP Checking": 81_820.0, "PHP Savings": 10_000.0}
    assert php["unassigned_closing"] == 0.0
    assert (php["shortfall"], php["shortfalls"], php["account_shortfalls"]) == (False, [], [])

    usd = _row(body, "USD")
    assert usd["opening_balance"] == 1_000.0
    assert _events(usd) == [
        ("2026-11-09", 100.0, True), ("2026-11-10", -1_500.0, False),
        ("2026-11-16", -500.0, False), ("2026-11-20", -50.0, False),
        ("2026-11-30", -300.0, False)]
    assert [e["running_balance"] for e in usd["events"]] == [
        1_100.0, -400.0, -900.0, -950.0, -1_250.0]
    assert usd["closing_balance"] == -1_250.0
    assert [(s["date"], s["balance_after"], s["currency"]) for s in usd["shortfalls"]] == [
        ("2026-11-10", -400.0, "USD"), ("2026-11-16", -900.0, "USD"),
        ("2026-11-20", -950.0, "USD"), ("2026-11-30", -1_250.0, "USD")]
    assert [(s["date"], s["account_id"], s["short_amount"], s["overflow_used"], s["currency"])
            for s in usd["account_shortfalls"]] == [
        ("2026-11-10", cx["usd"], 400.0, 0.0, "USD"),
        ("2026-11-16", cx["usd"], 900.0, 0.0, "USD"),
        ("2026-11-30", cx["usd"], 1_200.0, 0.0, "USD")]
    assert usd["overflow_moves"] == []
    assert _closings(usd, names) == {"USD Savings": -1_200.0}
    assert usd["unassigned_closing"] == -50.0

    # The scalars are the default currency's row.
    for key in ("opening_balance", "lowest_balance", "trough_date", "closing_balance",
                "shortfall", "shortfalls", "account_shortfalls", "by_account",
                "unassigned_closing", "overflow_moves", "events"):
        assert body[key] == php[key], key
    for row in body["by_currency"]:
        check_timeline_row(row)


# --- criterion 3: the monthly cash flow --------------------------------------------------

def test_cashflow_rows_per_currency(sw_client, cx, frozen):
    body = _get(sw_client, cx["a"], "/forecast/cashflow", months=1)
    (period,) = body["periods"]
    assert body["currencies"] == ["PHP", "USD"]
    php, usd = _row(period, "PHP"), _row(period, "USD")
    fields = ("income", "expenses", "unposted_expenses", "statement_payables", "moved_in",
              "moved_out", "loan_payables", "net", "closing_balance")
    assert {k: php[k] for k in fields} == {
        "income": 40_000.0, "expenses": 26_160.0, "unposted_expenses": 4_640.0,
        "statement_payables": 580.0, "moved_in": 29_000.0, "moved_out": 5_800.0,
        "loan_payables": 0.0, "net": 31_820.0, "closing_balance": 91_820.0}
    assert {k: usd[k] for k in fields} == {
        "income": 0.0, "expenses": 1_550.0, "unposted_expenses": 0.0,
        "statement_payables": 300.0, "moved_in": 100.0, "moved_out": 500.0,
        "loan_payables": 0.0, "net": -2_250.0, "closing_balance": -1_250.0}
    assert usd["unassigned_closing"] == -50.0
    for key in ("opening_balance", "income", "expenses", "unposted_expenses",
                "statement_payables", "net", "closing_balance", "by_account",
                "unassigned_closing", "overflow_moves"):
        assert period[key] == php[key], key
    for row in period["by_currency"]:
        check_cashflow_row(row)


# --- criterion 4: disposable income ------------------------------------------------------

def test_disposable_income_per_currency(sw_client, cx, frozen):
    body = _get(sw_client, cx["a"], "/forecast/disposable")
    php, usd = _row(body, "PHP"), _row(body, "USD")
    assert (php["monthly_income"], php["monthly_expenses"], php["moved_in"],
            php["moved_out"], php["monthly_disposable"]) == (
        40_000.0, 26_160.0, 29_000.0, 0.0, 42_840.0)
    assert (usd["monthly_income"], usd["monthly_expenses"], usd["moved_in"],
            usd["moved_out"], usd["monthly_disposable"]) == (0.0, 1_550.0, 0.0, 500.0, -2_050.0)
    assert {k: body[k] for k in ("monthly_income", "monthly_expenses", "monthly_disposable")} == {
        k: php[k] for k in ("monthly_income", "monthly_expenses", "monthly_disposable")}
    assert body["currencies"] == ["PHP", "USD"]
    for row in body["by_currency"]:
        check_disposable_row(row)


def test_disposable_service_keeps_its_three_keys(sw_db, cx):
    from app.services.forecast import get_disposable_income

    assert get_disposable_income(sw_db, cx["a"]["id"]) == {
        "monthly_income": 40_000.0, "monthly_expenses": 26_160.0, "monthly_disposable": 42_840.0}


# --- criterion 5: the snapshot -----------------------------------------------------------

def test_snapshot_totals_and_closings_per_currency(sw_client, cx, frozen):
    body = _get(sw_client, cx["a"], "/dashboard/snapshot")
    assert body["currencies"] == ["PHP", "USD"]
    assert body["balances"]["total"] == 60_000.0
    assert body["balances"]["by_currency"] == [
        {"currency": "PHP", "total": 60_000.0, "available_cash": 60_000.0},
        {"currency": "USD", "total": 700.0, "available_cash": 1_000.0}]
    assert body["available_cash"] == 60_000.0
    names = _names(cx)
    closings = {c["period_start"][:7]: c for c in body["account_closings"]}
    assert set(closings) == {"2026-11", "2026-12", "2027-01"}
    nov = {r["currency"]: r for r in closings["2026-11"]["by_currency"]}
    assert _closings(nov["USD"], names) == {"USD Savings": -1_200.0}
    assert nov["USD"]["unassigned_closing"] == -50.0
    jan = {r["currency"]: r for r in closings["2027-01"]["by_currency"]}
    assert _closings(jan["USD"], names) == {"USD Savings": -5_200.0}
    assert jan["USD"]["unassigned_closing"] == -150.0
    # Each closing keeps its default-currency fields.
    assert _closings(closings["2026-11"], names) == _closings(nov["PHP"], names)
    for period in body["forecast_next_3_months"]:
        for row in period["by_currency"]:
            check_cashflow_row(row)
    for row in body["monthly_summary"]["by_currency"]:
        check_disposable_row(row)
    assert all("currency" in p for p in body["payables"] if p.get("view") != "limited")
    assert all("currency" in i for i in body["upcoming_this_month"]
               if i.get("view") != "limited")


# --- criterion 6: the period summary -----------------------------------------------------

def test_period_summary_per_account_currency(sw_client, cx):
    body = _get(sw_client, cx["a"], "/transactions/summary/period",
                start_date="2026-10-01T00:00:00", end_date="2026-10-31T23:59:59")
    rows = {r["currency"]: r for r in body["by_currency"]}
    assert list(rows) == ["PHP", "USD"]
    php, usd = rows["PHP"], rows["USD"]
    assert (php["total_income"], php["total_expenses"], php["moved_in"], php["moved_out"],
            php["net_flow"]) == (0, 1_050, 0, 10_000, -11_050)
    assert php["category_breakdown"] == {
        "Food": {"income": 0, "expenses": 1_000}, "Transfer fees": {"income": 0, "expenses": 50}}
    assert (usd["total_income"], usd["total_expenses"], usd["moved_in"], usd["moved_out"],
            usd["net_flow"]) == (0, 330, 170, 0, -160)
    assert usd["category_breakdown"] == {"Food": {"income": 0, "expenses": 330}}
    assert body["category_breakdown"] == php["category_breakdown"]
    assert body["summary"]["net_flow"] == -11_050
    assert body["summary"]["transaction_count"] == 4
    for row in rows.values():
        check_summary_row(row)


# --- criterion 8: labels -----------------------------------------------------------------

def _labels(item):
    return (item["rate"], item["rate_as_of"], item["rate_stale"], item["original_amount"],
            item["original_currency"])


def test_estimated_rows_carry_their_labels(sw_client, cx, frozen):
    body = _get(sw_client, cx["a"], "/forecast/upcoming", days=30)
    items = [i for i in body["items"] if i.get("view") != "limited"]
    by_name = {}
    for i in items:
        by_name.setdefault(i["name"], []).append(i)
    estimated = [i for i in items if i.get("estimated")]
    assert sorted((i["name"], i["amount"], i["currency"]) for i in estimated) == sorted([
        ("Card charge", 580.0, "PHP"), ("Foreign purchase", 4_640.0, "PHP"),
        ("Subscription", 1_160.0, "PHP"), ("USD to PHP", 29_000.0, "PHP"),
        ("Pending PHP to USD", 100.0, "USD"), ("PHP Card statement", 580.0, "PHP")])
    for i in estimated:
        assert i["rate_stale"] is False and i["rate_as_of"] == RATE_AS_OF
        assert i["rate"] in (RATE_TO_PHP, RATE_TO_USD)
    assert _labels(by_name["Card charge"][0]) == (RATE_TO_PHP, RATE_AS_OF, False, 10.0, "USD")
    assert _labels(by_name["Foreign purchase"][0]) == (RATE_TO_PHP, RATE_AS_OF, False, 80.0, "USD")
    # The Nov 9 transfer is two rows, one per currency.
    assert sorted((i["amount"], i["currency"], bool(i.get("estimated")))
                  for i in by_name["Pending PHP to USD"]) == [
        (100.0, "USD", True), (5_800.0, "PHP", False)]
    (usd_row,) = [i for i in by_name["Pending PHP to USD"] if i["currency"] == "USD"]
    assert _labels(usd_row) == (RATE_TO_USD, RATE_AS_OF, False, 5_800.0, "PHP")
    # Every full row has a currency; unlabelled rows carry no label fields.
    assert all("currency" in i for i in items)
    for i in items:
        if not i.get("estimated"):
            assert not set(LABELS) & set(i), i
    assert sorted((r["base"], r["quote"], r["rate"], r["as_of"], r["stale"])
                  for r in body["fx"]["rates"]) == [
        ("PHP", "USD", RATE_TO_USD, RATE_AS_OF, False),
        ("USD", "PHP", RATE_TO_PHP, RATE_AS_OF, False)]
    assert body["fx"]["unconverted_count"] == 0

    timeline = _get(sw_client, cx["a"], "/forecast/timeline", days=30)
    nov9 = [(r["currency"], e["amount"]) for r in timeline["by_currency"] for e in r["events"]
            if e["date"] == "2026-11-09"]
    assert sorted(nov9) == [("PHP", -5_800.0), ("USD", 100.0)]
    for row in timeline["by_currency"]:
        for e in row["events"]:
            if e.get("view") == "limited":
                continue
            assert e["currency"] == row["currency"]
            if e.get("estimated"):
                assert e["rate_stale"] is False and e["rate"] in (RATE_TO_PHP, RATE_TO_USD)


def test_payables_carry_currency_and_estimates(sw_client, cx, frozen):
    payables = _get(sw_client, cx["a"], "/dashboard/snapshot")["payables"]
    rows = sorted((p["due_date"], p["name"], p["amount"], p["currency"],
                   bool(p.get("estimated"))) for p in payables)
    assert rows == [
        ("2026-11-05", "PHP rent", 25_000.0, "PHP", False),
        ("2026-11-08", "Foreign purchase", 4_640.0, "PHP", True),
        ("2026-11-10", "USD rent", 1_500.0, "USD", False),
        ("2026-11-12", "Subscription", 1_160.0, "PHP", True),
        ("2026-11-20", "Accountless", 50.0, "USD", False),
        ("2026-11-25", "PHP Card statement", 580.0, "PHP", True),
        ("2026-11-30", "USD Card statement", 300.0, "USD", False)]


def test_a_statement_estimated_from_several_currencies_names_no_original(sw_client, sw_db, cx,
                                                                          frozen):
    """Pending USD 10 and EUR 9 on the PHP card: one estimated PHP 1,160 statement,
    with no single original figure, so ``original_*`` are left out (not null)."""
    from app.main import app
    from app.services import fx
    from app.tests.conftest import FX_STORE, FxNoNetwork, fx_clock, fx_rates

    fetched = FX_REF - timedelta(hours=1)
    with_eur = fx.MemoryRateStore([*FX_STORE.all().values(), fx.StoredRate(
        "EUR", Decimal("0.9"), fetched.date(), fetched, "test")])
    _txn(sw_db, cx["a"]["id"], cx["php_card"], "debit", 9, _d(4), "PHP", projected_amount=9,
         projected_currency="EUR", description="Euro charge")
    app.dependency_overrides[fx.get_fx] = lambda: fx.FxRates(
        with_eur, provider=FxNoNetwork(), clock=fx_clock, on_stale=lambda: None)
    try:
        payables = _get(sw_client, cx["a"], "/dashboard/snapshot")["payables"]
        timeline = _get(sw_client, cx["a"], "/forecast/timeline", days=30)
    finally:
        app.dependency_overrides[fx.get_fx] = fx_rates
    (payable,) = [p for p in payables if p["name"] == "PHP Card statement"]
    (event,) = [e for e in _row(timeline, "PHP")["events"] if e["name"] == "PHP Card statement"]
    assert payable["amount"] == 1_160.0 and event["amount"] == -1_160.0
    for row in (payable, event):
        assert (row["currency"], row["estimated"], row["rate_stale"]) == ("PHP", True, False)
        assert "original_amount" not in row and "original_currency" not in row


def test_a_statement_over_a_fresh_and_a_stale_rate_reports_both(sw_client, sw_db, cx,
                                                                 frozen, eur_fx):
    """Pending USD 10 (fresh rate) and EUR 9 (a week-old rate) on the PHP card:
    the statement is stale because one of its rates is, it names no single
    ``rate``, and both pairs are in ``fx.rates``."""
    eur_fx(stale=True)
    _txn(sw_db, cx["a"]["id"], cx["php_card"], "debit", 9, _d(4), "PHP", projected_amount=9,
         projected_currency="EUR", description="Euro charge")
    snapshot = _get(sw_client, cx["a"], "/dashboard/snapshot")
    timeline = _get(sw_client, cx["a"], "/forecast/timeline", days=30)
    (payable,) = [p for p in snapshot["payables"] if p["name"] == "PHP Card statement"]
    (event,) = [e for e in _row(timeline, "PHP")["events"] if e["name"] == "PHP Card statement"]
    assert payable["amount"] == 1_160.0 and event["amount"] == -1_160.0
    for row in (payable, event):
        assert (row["currency"], row["estimated"], row["rate_stale"]) == ("PHP", True, True)
        assert row["rate_as_of"] == (FX_REF - timedelta(days=7)).date().isoformat()
        assert not set(row) & {"rate", "original_amount", "original_currency"}
    for body in (snapshot, timeline):
        pairs = {(r["base"], r["quote"]): r["stale"] for r in body["fx"]["rates"]}
        assert pairs[("USD", "PHP")] is False and pairs[("EUR", "PHP")] is True


def test_disposable_keeps_the_leg_it_can_convert(sw_db, cx):
    """The recurring USD 500 -> PHP transfer with no PHP row: USD still moves 500
    out; only the PHP leg (and the USD 20 subscription in PHP) is left out."""
    from app.services.forecast import disposable_by_currency
    from app.services.fx import FxRates, MemoryRateStore
    from app.tests.conftest import FX_STORE, FxNoNetwork, fx_clock

    no_php = MemoryRateStore([r for c, r in FX_STORE.all().items() if c != "PHP"])
    body = disposable_by_currency(sw_db, cx["a"]["id"],
                                  fx=FxRates(no_php, FxNoNetwork(), fx_clock, lambda: None))
    usd, php = _row(body, "USD"), _row(body, "PHP")
    assert (usd["monthly_expenses"], usd["moved_out"], usd["monthly_disposable"]) == (
        1_550.0, 500.0, -2_050.0)
    assert (php["monthly_income"], php["monthly_expenses"], php["moved_in"]) == (
        40_000.0, 25_000.0, 0.0)
    for row in body["by_currency"]:
        check_disposable_row(row)


@pytest.fixture
def eur_fx(monkeypatch):
    """The suite's rates plus EUR (0.9 per USD), fresh unless ``stale`` names it:
    ``eur_fx(stale=True)`` stores the EUR row a week old."""
    from app.main import app
    from app.services import fx
    from app.tests.conftest import FX_STORE, FxNoNetwork, fx_clock, fx_rates

    def install(stale=False):
        fetched = FX_REF - (timedelta(days=7) if stale else timedelta(hours=1))
        store = fx.MemoryRateStore([*FX_STORE.all().values(), fx.StoredRate(
            "EUR", Decimal("0.9"), fetched.date(), fetched, "test")])

        def rates():
            return fx.FxRates(store, provider=FxNoNetwork(), clock=fx_clock,
                              on_stale=lambda: None)

        app.dependency_overrides[fx.get_fx] = rates
        monkeypatch.setattr(fx, "_offline_factory", lambda db: rates())
        return rates

    yield install
    app.dependency_overrides[fx.get_fx] = fx_rates


def test_an_entry_on_an_account_outside_the_scope_keeps_its_record_currency(
        sw_client, sw_db, sw_people, frozen, eur_fx):
    """The creator's USD 80 entry on an EUR account they no longer view: its
    account's currency is never read, so no EUR reaches ``currencies``,
    ``by_currency`` or ``fx``; it counts at its face, under USD, as before."""
    from app.models.account_share import AccountShare
    from app.models.user import CurrencyType, User

    eur_fx()
    owner, creator = sw_people("Ola", "Owner"), sw_people("Cid", "Creator")
    for who in (owner, creator):
        sw_db.get(User, who["id"]).default_currency = CurrencyType.PHP
    sw_db.commit()
    eur = _acct(sw_db, owner["id"], "Euro bank", "checking", "EUR", 1_000)
    _acct(sw_db, creator["id"], "Peso bank", "checking", "PHP", 1_000)
    share = sw_share(sw_db, eur, creator["id"], "editor", owner["id"])
    _entry(sw_db, creator["id"], "Revoked bill", "expense", 80, "USD", _d(10), eur)
    sw_db.delete(sw_db.get(AccountShare, share))  # the creator loses access
    sw_db.commit()

    disposable = _get(sw_client, creator, "/forecast/disposable")
    snapshot = _get(sw_client, creator, "/dashboard/snapshot")
    for body in (disposable, snapshot["monthly_summary"]):
        assert [r["currency"] for r in body["by_currency"]] == ["PHP", "USD"]
        assert _row(body, "USD")["monthly_expenses"] == 80.0
        assert body["monthly_expenses"] == 0.0
    for body in (disposable, snapshot):
        assert "EUR" not in body["currencies"]
        assert not any("EUR" in (r["base"], r["quote"]) for r in body["fx"]["rates"])
    assert "EUR" not in repr(disposable) and "EUR" not in repr(snapshot)


def test_limited_public_ids_are_unique_across_currency_rows(sw_client, sw_db, sw_people,
                                                           frozen):
    """A viewer's timeline over the owner's PHP and USD bills: one Limited row
    in each currency row, numbered once per response (never ``e1`` twice);
    the scalars (the default row) reuse that row's ids."""
    from app.models.user import CurrencyType, User

    owner, viewer = sw_people("Oda", "Owner"), sw_people("Vic", "Viewer")
    for who in (owner, viewer):
        sw_db.get(User, who["id"]).default_currency = CurrencyType.PHP
    sw_db.commit()
    php = _acct(sw_db, owner["id"], "Peso bank", "checking", "PHP", 10_000)
    usd = _acct(sw_db, owner["id"], "Dollar bank", "checking", "USD", 1_000)
    for account in (php, usd):
        sw_share(sw_db, account, viewer["id"], "viewer", owner["id"])
    _entry(sw_db, owner["id"], "Peso bill", "expense", 500, "PHP", _d(5), php,
           end_mode="after_occurrences", max_occurrences=1)
    _entry(sw_db, owner["id"], "Dollar bill", "expense", 20, "USD", _d(6), usd,
           end_mode="after_occurrences", max_occurrences=1)

    timeline = _get(sw_client, viewer, "/forecast/timeline", days=30)
    ids = {r["currency"]: [e["public_id"] for e in r["events"]] for r in timeline["by_currency"]}
    assert ids == {"PHP": ["e1"], "USD": ["e2"]}
    assert [e["public_id"] for e in timeline["events"]] == ["e1"]


# --- criterion 10 (integration): no stored rate ------------------------------------------

@pytest.fixture
def recording_fx():
    """``get_fx`` over the suite's store, with ``on_stale`` counted."""
    from app.main import app
    from app.services import fx
    from app.tests.conftest import FX_STORE, FxNoNetwork, fx_clock, fx_rates

    calls = []
    app.dependency_overrides[fx.get_fx] = lambda: fx.FxRates(
        FX_STORE, provider=FxNoNetwork(), clock=fx_clock, on_stale=lambda: calls.append(1))
    try:
        yield calls
    finally:
        app.dependency_overrides[fx.get_fx] = fx_rates


def test_a_pair_with_no_rate_is_unconverted_and_left_out(sw_client, sw_db, cx, frozen,
                                                          recording_fx):
    uid = cx["a"]["id"]
    _txn(sw_db, uid, cx["php"], "debit", 1_000, _d(4), "PHP", projected_amount=1_000,
         projected_currency="JPY", description="Yen purchase")
    timeline = _get(sw_client, cx["a"], "/forecast/timeline", days=30)
    php = _row(timeline, "PHP")
    assert php["closing_balance"] == 91_820.0  # unchanged: the yen row is not in it
    assert "Yen purchase" not in [e["name"] for e in php["events"]]
    assert timeline["fx"]["unconverted_count"] == 1
    assert recording_fx  # a refresh was asked for
    upcoming = _get(sw_client, cx["a"], "/forecast/upcoming", days=30)
    (yen,) = [i for i in upcoming["items"] if i.get("name") == "Yen purchase"]
    assert (yen["amount"], yen["unconverted"], yen["currency"], yen["original_amount"],
            yen["original_currency"]) == (None, True, "PHP", 1_000.0, "JPY")
    assert upcoming["fx"]["unconverted_count"] == 1
    assert not any(p.get("name") == "Yen purchase"
                   for p in _get(sw_client, cx["a"], "/dashboard/snapshot")["payables"])


def test_nothing_to_convert_asks_for_no_rate(sw_client, sw_db, sw_people, frozen, recording_fx):
    a = sw_people("Pia", "Peso")
    php = _acct(sw_db, a["id"], "Peso bank", "checking", "PHP", 1_000)
    _entry(sw_db, a["id"], "Bill", "expense", 100, "PHP", _d(5), php)
    body = _get(sw_client, a, "/forecast/timeline", days=30)
    assert body["fx"] == {"rates": [], "unconverted_count": 0}
    assert recording_fx == []


# --- criterion 15: edge users ------------------------------------------------------------

def test_a_php_default_user_holding_only_usd(sw_client, sw_db, sw_people, frozen):
    from app.models.user import CurrencyType, User

    a = sw_people("Uma", "Usd")
    sw_db.get(User, a["id"]).default_currency = CurrencyType.PHP
    sw_db.commit()
    usd = _acct(sw_db, a["id"], "Dollar bank", "checking", "USD", 400)
    _entry(sw_db, a["id"], "Dollar bill", "expense", 100, "USD", _d(5), usd)
    timeline = _get(sw_client, a, "/forecast/timeline", days=30)
    assert timeline["currencies"] == ["USD"]
    assert [r["currency"] for r in timeline["by_currency"]] == ["PHP", "USD"]
    php = _row(timeline, "PHP")
    assert (php["opening_balance"], php["closing_balance"], php["events"]) == (0.0, 0.0, [])
    assert timeline["opening_balance"] == 0.0
    assert _row(timeline, "USD")["closing_balance"] == 300.0
    snapshot = _get(sw_client, a, "/dashboard/snapshot")
    assert snapshot["currencies"] == ["USD"]
    assert snapshot["balances"]["by_currency"][0] == {
        "currency": "PHP", "total": 0.0, "available_cash": 0.0}


def test_a_null_default_with_php_and_usd(sw_client, sw_db, sw_people, frozen, monkeypatch):
    # ``users.default_currency`` is NOT NULL in the schema, so a null default
    # can only reach the projection from a row read without one: the user is
    # served with the attribute read as None.
    from app.models.user import User
    from app.services import forecast

    a = sw_people("Ned", "Null")
    _acct(sw_db, a["id"], "Peso bank", "checking", "PHP", 1_000)
    _acct(sw_db, a["id"], "Dollar bank", "checking", "USD", 400)
    unset = type("Unset", (), {"default_currency": None})()
    real_get = forecast.Session.get

    def get(self, model, ident, *args, **kw):
        return unset if model is User and ident == a["id"] else real_get(
            self, model, ident, *args, **kw)

    monkeypatch.setattr(forecast.Session, "get", get)
    assert forecast.default_currency(sw_db, a["id"]) == "PHP"
    timeline = _get(sw_client, a, "/forecast/timeline", days=30)
    assert timeline["currencies"] == ["PHP", "USD"]
    assert timeline["opening_balance"] == 1_000.0
    assert _row(timeline, "USD")["opening_balance"] == 400.0


# --- criterion 16: legacy mismatches -----------------------------------------------------

def test_a_legacy_usd_card_paid_from_php_is_estimated_in_php(sw_client, sw_db, cx, frozen):
    uid = cx["a"]["id"]
    legacy = _acct(sw_db, uid, "Legacy card", "credit", "USD", -50, billing_cycle_start=20,
                   days_until_due_date=10, payment_account_id=cx["php"])
    _txn(sw_db, uid, legacy, "debit", 50, _d(25, 10), "USD", posted=True,
         description="Legacy charge")
    payables = _get(sw_client, cx["a"], "/dashboard/snapshot")["payables"]
    (row,) = [p for p in payables if p["name"] == "Legacy card statement"]
    assert (row["due_date"], row["amount"], row["currency"], row["account_id"]) == (
        "2026-11-30", 2_900.0, "PHP", cx["php"])
    assert (row["estimated"], row["original_amount"], row["original_currency"], row["rate"]) == (
        True, 50.0, "USD", RATE_TO_PHP)


def _loan_world(db, cx):
    from datetime import date

    from app.models.transaction import TransactionType  # noqa: F401  (ORM import order)

    uid = cx["a"]["id"]
    loan = _acct(db, uid, "PHP loan", "loan", "PHP", -100_000, loan_kind="personal",
                 loan_annual_rate=Decimal("0"), loan_term_months=12,
                 loan_payment_amount=Decimal("10000"), loan_first_payment_date=date(2026, 11, 20),
                 loan_amortization="fixed", payment_account_id=cx["php"])
    _transfer(db, uid, cx["usd"], loan, 100, _d(18), "USD", description="USD cover")
    _entry(db, uid, "USD recurring cover", "expense", 50, "USD", _d(19), cx["usd"],
           transfer_to_account_id=loan, end_mode="after_occurrences", max_occurrences=1)
    return loan


def _loan_payable(db, uid, loan, fx):
    from app.services.forecast import collect_events

    db.expire_all()
    events = collect_events(db, REF, REF + timedelta(days=30), user_id=uid, fx=fx)
    (payable,) = [e for e in events if e["source"] == "loan"]
    return payable["amount"]


def test_legacy_loan_covers_are_normalised_into_the_loan_currency(sw_db, cx):
    from app.services.fx import FxRates, MemoryRateStore
    from app.tests.conftest import FX_STORE, FxNoNetwork, fx_clock, fx_rates

    loan = _loan_world(sw_db, cx)
    uid = cx["a"]["id"]
    assert _loan_payable(sw_db, uid, loan, fx_rates()) == Decimal("-1300.00")
    no_usd = MemoryRateStore([r for c, r in FX_STORE.all().items() if c != "USD"])
    fx = FxRates(no_usd, provider=FxNoNetwork(), clock=fx_clock, on_stale=lambda: None)
    assert _loan_payable(sw_db, uid, loan, fx) == Decimal("-10000.00")


# --- criterion 17: statement history -----------------------------------------------------

def test_statement_history_normalises_lines_into_the_card_currency(sw_client, sw_db, sw_people,
                                                                   cx, frozen):
    uid = cx["a"]["id"]
    _txn(sw_db, uid, cx["php_card"], "debit", 1_000, _d(4), "PHP", projected_amount=1_000,
         projected_currency="JPY", description="Yen charge")
    full = _get(sw_client, cx["a"], f"/accounts/{cx['php_card']}/statements")
    (nov,) = [s for s in full["statements"] if s["close_date"].startswith("2026-11-15")]
    assert nov["statement_balance"] == 580.0
    assert nov["amount_due"] == 580.0
    (line,) = nov["lines"]
    assert (line["amount"], line["estimated"], line["original_amount"],
            line["original_currency"], line["rate"]) == (580.0, True, 10.0, "USD", RATE_TO_PHP)
    (yen,) = nov["unconverted_lines"]
    assert (yen["original_amount"], yen["original_currency"], yen["unconverted"]) == (
        1_000.0, "JPY", True)
    assert nov["incomplete"] is True

    viewer = sw_people("Vera", "Viewer")
    sw_share(sw_db, cx["php_card"], viewer["id"], "viewer", uid)
    limited = _get(sw_client, viewer, f"/accounts/{cx['php_card']}/statements")
    (nov,) = [s for s in limited["statements"] if s["close_date"].startswith("2026-11-15")]
    assert set(nov) == {"close_date", "due_date", "amount_due", "currency", "status", "lines",
                        "incomplete"}
    assert nov["incomplete"] is True
    assert [(line["amount"], set(line)) for line in nov["lines"]] == [
        (580.0, {"date", "display_description", "amount"})]
    assert "JPY" not in repr(limited) and "1000" not in repr(limited)


def test_an_unconverted_line_keeps_a_card_from_being_deactivated(sw_client, sw_db, cx, frozen):
    uid = cx["a"]["id"]
    card = _acct(sw_db, uid, "Yen card", "credit", "PHP", 0, billing_cycle_start=15,
                 days_until_due_date=10, payment_account_id=cx["php"])
    _txn(sw_db, uid, card, "debit", 1_000, _d(4), "PHP", projected_amount=1_000,
         projected_currency="JPY", description="Yen only")
    r = sw_client.delete(f"{API}/accounts/{card}", headers=cx["a"]["headers"])
    assert r.status_code == 400, r.text
    from app.routers.accounts import CARD_OPEN_STATEMENT_DETAIL

    assert r.json()["detail"] == CARD_OPEN_STATEMENT_DETAIL


# --- criterion 18: Household cover in the card's currency --------------------------------

def test_household_cover_settles_in_the_card_currency(hh, sw_client, sw_db):
    from app.services.household import household_monthly, household_view

    from app.tests.conftest import sw_post

    projected = datetime(2026, 10, 10)
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": hh["a_card"], "transaction_type": "debit", "amount": 80,
        "currency": "PHP", "projected_amount": 80, "projected_currency": "USD",
        "transaction_date": "2026-10-12T00:00:00", "is_posted": False,
        "description": "Household streaming", "tag_ids": [hh["hh_a"]]})

    def totals(who):
        sw_db.expire_all()
        grant = household_view(sw_db, who["id"], hh["a"]["id"])
        months = household_monthly(sw_db, who["id"], grant, datetime(2026, 10, 1),
                                   datetime(2026, 11, 1), reference=projected)
        out = {}
        for month in months:
            for line in month["currencies"]:
                row = out.setdefault(line["currency"], {"expense": 0.0, "paid": 0.0})
                row["expense"] = round(row["expense"] + line["expense"], 2)
                row["paid"] = round(row["paid"] + line["paid_from_other_accounts"], 2)
        return out

    assert totals(hh["a"]) == {"PHP": {"expense": 0.0, "paid": 4_640.0}}
    assert totals(hh["c"]) == {"PHP": {"expense": 0.0, "paid": 80.0}}
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": hh["joint"], "transfer_from_account_id": hh["joint"],
        "transfer_to_account_id": hh["a_card"], "transaction_type": "transfer", "amount": 40,
        "transaction_date": "2026-11-01T00:00:00", "is_posted": False})
    assert totals(hh["a"]) == {"PHP": {"expense": 40.0, "paid": 4_600.0}}
    assert totals(hh["c"]) == {"PHP": {"expense": 40.0, "paid": 79.31}}


def test_household_occurrence_off_a_billed_card_is_estimated_in_full_view(hh, sw_client, sw_db):
    """A pending USD 80 Household debit on A's private PHP wallet (no card to
    settle on): A, who reads it in full, sees PHP 4,640 est. and counts 4,640
    in the PHP month; C, who reads it Limited, keeps its face and record
    currency (PHP 80) with no new fields, as before."""
    from app.services.household import household_monthly, household_upcoming, household_view

    from app.tests.conftest import sw_post

    reference = datetime(2026, 10, 10)
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": hh["a_wallet"], "transaction_type": "debit", "amount": 80,
        "currency": "PHP", "projected_amount": 80, "projected_currency": "USD",
        "transaction_date": "2026-10-12T00:00:00", "is_posted": False,
        "description": "Household delivery", "tag_ids": [hh["hh_a"]]})

    def view(who):
        sw_db.expire_all()
        grant = household_view(sw_db, who["id"], hh["a"]["id"])
        months = household_monthly(sw_db, who["id"], grant, datetime(2026, 10, 1),
                                   datetime(2026, 11, 1), reference=reference)
        paid = {line["currency"]: line["paid_from_other_accounts"]
                for month in months for line in month["currencies"]}
        (item,) = [i for i in household_upcoming(sw_db, who["id"], grant, reference,
                                                 datetime(2026, 11, 1))
                   if i.get("name") == "Household delivery"
                   or i.get("display_name") == "Household delivery"]
        return paid, item

    paid, item = view(hh["a"])
    assert paid == {"PHP": 4_640.0}
    assert (item["amount"], item["currency"], item["estimated"], item["original_amount"],
            item["original_currency"], item["rate"]) == (4_640.0, "PHP", True, 80.0, "USD",
                                                         RATE_TO_PHP)
    paid, item = view(hh["c"])
    assert paid == {"PHP": 80.0}
    assert (item["view"], item["face_amount"], item["currency"]) == ("limited", 80.0, "PHP")
    assert not set(item) & set(LABELS)


def test_a_limited_reader_who_views_the_card_keeps_the_record_face(hh, sw_client, sw_db):
    """C, a viewer on A's PHP card, reads A's pending USD 80 Household charge
    Limited: its listed row keeps its face and record currency (PHP 80, plan
    G1), but the month buckets it as D4 does for a caller who views the card:
    in the card's currency at the card figure's remainder (PHP 4,640)."""
    from app.services.household import household_monthly, household_upcoming, household_view

    from app.tests.conftest import sw_post

    reference = datetime(2026, 10, 10)
    sw_share(sw_db, hh["a_card"], hh["c"]["id"], "viewer", hh["a"]["id"])
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": hh["a_card"], "transaction_type": "debit", "amount": 80,
        "currency": "PHP", "projected_amount": 80, "projected_currency": "USD",
        "transaction_date": "2026-10-12T00:00:00", "is_posted": False,
        "description": "Household streaming", "tag_ids": [hh["hh_a"]]})
    sw_db.expire_all()
    grant = household_view(sw_db, hh["c"]["id"], hh["a"]["id"])
    months = household_monthly(sw_db, hh["c"]["id"], grant, datetime(2026, 10, 1),
                               datetime(2026, 11, 1), reference=reference)
    assert {line["currency"]: line["paid_from_other_accounts"]
            for month in months for line in month["currencies"]} == {"PHP": 4_640.0}
    (item,) = [i for i in household_upcoming(sw_db, hh["c"]["id"], grant, reference,
                                             datetime(2026, 11, 1))
               if i.get("display_name") == "Household streaming"]
    assert (item["view"], item["face_amount"], item["currency"]) == ("limited", 80.0, "PHP")
    assert not set(item) & set(LABELS)


def test_full_household_credits_and_income_on_a_card_are_estimated(hh, sw_client, sw_db):
    """A pending projected USD 10 refund and a USD 10 recurring income on A's
    private PHP card, both Household: A, who reads them in full, sees each as
    PHP 580 est., like a debit; C, who reads them Limited, keeps their faces."""
    from app.services.household import household_upcoming, household_view

    from app.tests.conftest import sw_post

    reference = datetime(2026, 10, 10)
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": hh["a_card"], "transaction_type": "credit", "amount": 10,
        "currency": "PHP", "projected_amount": 10, "projected_currency": "USD",
        "transaction_date": "2026-10-12T00:00:00", "is_posted": False,
        "description": "Household refund", "tag_ids": [hh["hh_a"]]})
    sw_post(sw_client, hh["a"], "/budget-entries/", {
        "name": "Household cashback", "entry_type": "income", "amount": 10, "currency": "USD",
        "next_occurrence": "2026-10-14T00:00:00", "account_id": hh["a_card"],
        "end_mode": "after_occurrences", "max_occurrences": 1, "tag_ids": [hh["hh_a"]]})

    def items(who):
        sw_db.expire_all()
        grant = household_view(sw_db, who["id"], hh["a"]["id"])
        return {i.get("name") or i.get("display_name"): i for i in household_upcoming(
            sw_db, who["id"], grant, reference, datetime(2026, 11, 1))}

    full = items(hh["a"])
    for name in ("Household refund", "Household cashback"):
        item = full[name]
        assert (item["amount"], item["currency"], item["estimated"], item["original_amount"],
                item["original_currency"], item["rate"]) == (580.0, "PHP", True, 10.0, "USD",
                                                             RATE_TO_PHP), name
    limited = items(hh["c"])
    assert (limited["Household refund"]["face_amount"],
            limited["Household refund"]["currency"]) == (10.0, "PHP")
    assert (limited["Household cashback"]["face_amount"],
            limited["Household cashback"]["currency"]) == (10.0, "USD")
    for name in ("Household refund", "Household cashback"):
        assert not set(limited[name]) & set(LABELS), name


def test_a_legacy_payable_keeps_every_contributing_rate(sw_client, sw_db, cx, frozen, eur_fx):
    """A legacy USD card paid from PHP Checking with a pending EUR 9 charge: the
    statement is estimated EUR -> USD (a week-old rate), then the payable USD
    -> PHP (a fresh one). It is stale, dated by the older rate, names no single
    ``rate`` or original figure, and both pairs are in ``fx.rates``."""
    eur_fx(stale=True)
    uid = cx["a"]["id"]
    legacy = _acct(sw_db, uid, "Legacy card", "credit", "USD", 0, billing_cycle_start=20,
                   days_until_due_date=10, payment_account_id=cx["php"])
    _txn(sw_db, uid, legacy, "debit", 9, _d(4), "USD", projected_amount=9,
         projected_currency="EUR", description="Euro charge")
    snapshot = _get(sw_client, cx["a"], "/dashboard/snapshot")
    timeline = _get(sw_client, cx["a"], "/forecast/timeline", days=30)
    (payable,) = [p for p in snapshot["payables"] if p["name"] == "Legacy card statement"]
    (event,) = [e for e in _row(timeline, "PHP")["events"]
                if e["name"] == "Legacy card statement"]
    assert payable["amount"] == 580.0 and event["amount"] == -580.0
    for row in (payable, event):
        assert (row["currency"], row["estimated"], row["rate_stale"]) == ("PHP", True, True)
        assert row["rate_as_of"] == (FX_REF - timedelta(days=7)).date().isoformat()
        assert not set(row) & {"rate", "original_amount", "original_currency"}
    for body in (snapshot, timeline):
        pairs = {(r["base"], r["quote"]): r["stale"] for r in body["fx"]["rates"]}
        assert pairs[("EUR", "USD")] is True and pairs[("USD", "PHP")] is False


def test_limited_public_ids_are_shared_across_snapshot_lists(sw_client, sw_db, sw_people,
                                                             frozen):
    """A viewer's snapshot over the owner's income (Nov 5) and bill (Nov 6):
    upcoming lists both, payables only the bill. Numbered once per response,
    the bill keeps one id in both lists and the income has another."""
    from app.models.user import CurrencyType, User

    owner, viewer = sw_people("Ona", "Owner"), sw_people("Val", "Viewer")
    for who in (owner, viewer):
        sw_db.get(User, who["id"]).default_currency = CurrencyType.PHP
    sw_db.commit()
    php = _acct(sw_db, owner["id"], "Peso bank", "checking", "PHP", 10_000)
    sw_share(sw_db, php, viewer["id"], "viewer", owner["id"])
    _entry(sw_db, owner["id"], "Pay", "income", 900, "PHP", _d(5), php,
           end_mode="after_occurrences", max_occurrences=1)
    _entry(sw_db, owner["id"], "Bill", "expense", 300, "PHP", _d(6), php,
           end_mode="after_occurrences", max_occurrences=1)

    snapshot = _get(sw_client, viewer, "/dashboard/snapshot")
    upcoming = {i["date"]: i["public_id"] for i in snapshot["upcoming_this_month"]
                if i.get("view") == "limited"}
    payables = {p["date"]: p["public_id"] for p in snapshot["payables"]
                if p.get("view") == "limited"}
    assert upcoming == {"2026-11-05": "e1", "2026-11-06": "e2"}
    assert payables == {"2026-11-06": "e2"}
    # A single-list response keeps numbering from e1.
    alone = _get(sw_client, viewer, "/forecast/upcoming", days=30)["items"]
    assert [i["public_id"] for i in alone if i.get("view") == "limited"] == ["e1", "e2"]


def test_a_mixed_statement_with_an_unconverted_line(sw_client, sw_db, cx, frozen):
    """The PHP card's Nov 15 statement over a PHP 100 line, the USD 10 line
    (estimated) and a JPY 1,000 line with no stored rate: the statement is
    estimated over what it can convert (PHP 680), the yen line is listed in
    ``unconverted_lines`` and left out of every total, and nothing fails."""
    uid = cx["a"]["id"]
    _txn(sw_db, uid, cx["php_card"], "debit", 100, _d(4), "PHP", description="Peso charge")
    _txn(sw_db, uid, cx["php_card"], "debit", 1_000, _d(5), "PHP", projected_amount=1_000,
         projected_currency="JPY", description="Yen charge")
    history = _get(sw_client, cx["a"], f"/accounts/{cx['php_card']}/statements")
    (nov,) = [s for s in history["statements"] if s["close_date"].startswith("2026-11-15")]
    assert (nov["statement_balance"], nov["amount_due"], nov["incomplete"]) == (
        680.0, 680.0, True)
    assert sorted((line["amount"], bool(line.get("estimated"))) for line in nov["lines"]) == [
        (100.0, False), (580.0, True)]
    (yen,) = nov["unconverted_lines"]
    assert (yen["original_amount"], yen["original_currency"], yen["unconverted"]) == (
        1_000.0, "JPY", True)

    snapshot = _get(sw_client, cx["a"], "/dashboard/snapshot")
    (payable,) = [p for p in snapshot["payables"] if p["name"] == "PHP Card statement"]
    assert (payable["amount"], payable["currency"], payable["estimated"]) == (680.0, "PHP", True)
    assert (payable["original_amount"], payable["original_currency"], payable["rate"]) == (
        10.0, "USD", RATE_TO_PHP)
    assert not any(p.get("name") == "Yen charge" for p in snapshot["payables"])


def test_a_refund_nets_against_the_statement_original(sw_client, sw_db, cx, frozen):
    """The PHP card's pending USD 10 charge and a pending USD 2 refund: the
    payable is PHP 464 ((10 - 2) x 58), and its original is USD 8, the
    refund's face subtracted, never added."""
    _txn(sw_db, cx["a"]["id"], cx["php_card"], "credit", 2, _d(4), "PHP", projected_amount=2,
         projected_currency="USD", description="Card refund")
    snapshot = _get(sw_client, cx["a"], "/dashboard/snapshot")
    timeline = _get(sw_client, cx["a"], "/forecast/timeline", days=30)
    (payable,) = [p for p in snapshot["payables"] if p["name"] == "PHP Card statement"]
    (event,) = [e for e in _row(timeline, "PHP")["events"] if e["name"] == "PHP Card statement"]
    assert payable["amount"] == 464.0 and event["amount"] == -464.0
    for row in (payable, event):
        assert (row["currency"], row["estimated"], row["original_amount"],
                row["original_currency"], row["rate"]) == ("PHP", True, 8.0, "USD", RATE_TO_PHP)


def test_snapshot_currencies_list_the_monthly_summary_currencies(sw_client, sw_db, sw_people,
                                                                 frozen):
    """A PHP-only account and an accountless USD 50 recurring expense whose next
    occurrence is past the forecast window: the monthly summary has a USD row,
    so the snapshot's ``currencies`` names USD too. Nothing is listed, so
    ``fx.rates`` stays empty."""
    from app.models.user import CurrencyType, User

    a = sw_people("Mona", "Monthly")
    sw_db.get(User, a["id"]).default_currency = CurrencyType.PHP
    sw_db.commit()
    _acct(sw_db, a["id"], "Peso bank", "checking", "PHP", 1_000)
    _entry(sw_db, a["id"], "Dollar dues", "expense", 50, "USD", _d(1, 6, 2027))
    snapshot = _get(sw_client, a, "/dashboard/snapshot")
    assert _row(snapshot["monthly_summary"], "USD")["monthly_expenses"] == 50.0
    assert snapshot["upcoming_this_month"] == [] and snapshot["payables"] == []
    assert snapshot["currencies"] == ["PHP", "USD"]
    assert snapshot["fx"]["rates"] == []

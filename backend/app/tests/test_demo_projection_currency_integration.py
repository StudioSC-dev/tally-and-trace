"""The demo under projections split by currency (STU-236, plan H, criterion 13).

Shape 5 puts the demo's foreign rows in the form's convention (the pending
salary and Netflix rows at their foreign figure, the ended "Streaming
Subscription" entry inactive), and every projection is split by account
currency at the suite's rate (58.00 PHP per USD). Each test reseeds the demo
first, so figures never depend on what other tests did to it, and freezes the
clock at ``FX_REF`` (2026-11-02).

``DIFF`` holds each figure that shape 8 (STU-308) changes, as (shape 7, shape 8),
and is pinned as that explicit diff. ``v8`` reads the shape 8 figure.

Shape 8 (STU-308) gives the demo a believable salary (USD 1,500.00 a month, 87,000.00
PHP at the suite's rate) and a household budget to match: the Electric Bill, Gym
Membership, Brokerage Auto-Deposit, Rent and Internet amounts are re-set so the demo's
months still read as one November surplus and a December and January shortfall.

Shape 6 (STU-217) moves the "Gym Membership" installment's next payment to
2 Dec 2026, so its 45.00 is a December event: in the timeline, the 30-day
payables, the 60-day closing, and each month's expenses from December on.
"""
import sys
from datetime import datetime

import pytest

from app.tests.conftest import API, FX_REF, sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

RATE_AS_OF = "2026-11-01"

# The shape 8 demo figures (STU-308), proposed in the PR for the owner's approval.
SALARY_USD = 1_500.0  # Monthly Salary: 87,000.00 PHP at 58.00
ELECTRIC = 4_800.0
BROKERAGE = 30_000.0
RENT = 48_000.0
GYM = 2_800.0
INTERNET = 2_500.0  # the card statement due 2026-11-23, and in the December statement
PENDING_SALARY_USD = 1_500.0  # the seeded pending salary transaction, 87,000.00 PHP at 58.00

# figure: (shape 7, shape 8)
DIFF = {
    "timeline opening (PHP scalar)": (21_700.0, 21_700.0),
    "timeline closing, 60 days (PHP scalar)": (24_335.58, 156_430.58),
    "overdue pending salary at window start": (3_190.0, 87_000.0),
    "Monthly Salary, Nov 11": (3_190.0, 87_000.0),
    "Monthly Salary, Dec 11": (3_190.0, 87_000.0),
    "overdue card statement payable from the Joint Account": (869.42, 869.42),
    "Netflix line, statement closing 2025-10-01": (869.42, 869.42),
    "statement balance, closing 2025-10-01": (869.42, 869.42),
    "cash-flow income, each month (PHP)": (3_190.0, 87_000.0),
    "cash-flow net, November 2026 (PHP)": (3_750.58, 135_830.58),
    "cash-flow net, December 2026 and January 2027 (PHP)": (-1_115.0, -1_100.0),
    "Aug 2025 summary income": (2_942.50, 80_250.00),
    "Aug 2025 summary net flow": (2_017.00, 79_324.50),
    "disposable monthly_income": (3_190.0, 87_000.0),
    "disposable monthly_expenses": (4_305.00, 88_100.0),
    "disposable monthly_disposable": (-1_115.00, -1_100.0),
    "snapshot balances.total (PHP)": (21_200.0, 21_200.0),
    "snapshot available_cash (PHP)": (21_700.0, 21_700.0),
}


def v8(name):
    return DIFF[name][1]


# The demo's two card examples (the posted-date rule, ``statements.statement_day``).
# The pending Netflix row (USD 14.99, 869.42 at 58.00) is dated on the reset day,
# and an unposted row is read on the day anyway, so it sits on the open statement
# closing 2026-12-01 (due 2026-12-22), beside that cycle's Internet charge. The overdue
# example is the posted Shopee charge of Sept 2025 on the statement closing
# 2025-10-01 (due 2025-10-22, unpaid): 120.00.
NETFLIX = v8("Netflix line, statement closing 2025-10-01")
OVERDUE = 120.0
OPEN_DUE = "2026-12-22"


@pytest.fixture
def demo_at(sw_client, sw_db, monkeypatch):
    """A factory: reseed the demo with every clock frozen at the given naive UTC
    instant, log in, and return the ``get`` helper."""
    from app.core import seed
    from app.models.demo_state import DemoState

    def build(now):
        for name, module in list(sys.modules.items()):
            if name.startswith("app.") and hasattr(module, "naive_utc_now"):
                monkeypatch.setattr(module, "naive_utc_now", lambda: now)
        sw_db.query(DemoState).delete()
        sw_db.commit()
        seed.seed_database()
        r = sw_client.post(f"{API}/auth/login",
                           json={"email": "demo@example.com", "password": "password123"})
        assert r.status_code == 200, r.text
        headers = {"Authorization": f"Bearer {r.json()['access_token']}"}

        def get(path, **params):
            r = sw_client.get(f"{API}{path}", headers=headers, params=params)
            assert r.status_code == 200, (path, r.text)
            return r.json()

        return get

    return build


@pytest.fixture
def demo(demo_at):
    """A freshly seeded demo, logged in, with every clock frozen at FX_REF."""
    return demo_at(FX_REF)


def test_the_shape_is_eight():
    from app.core.seed import DEMO_SHAPE_VERSION

    assert DEMO_SHAPE_VERSION == 8


def _estimated(item, original):
    return (item.get("estimated"), item.get("original_amount"), item.get("original_currency"),
            item.get("rate"), item.get("rate_as_of"), item.get("rate_stale")) == (
        True, original, "USD", 58.0, RATE_AS_OF, False)


def test_timeline(demo):
    body = demo("/forecast/timeline", days=60)
    assert body["currencies"] == ["PHP", "USD"]
    assert body["opening_balance"] == v8("timeline opening (PHP scalar)")
    assert body["closing_balance"] == round(
        v8("timeline closing, 60 days (PHP scalar)") - OVERDUE, 2)
    php, usd = body["by_currency"]
    assert php["currency"] == "PHP" and php["opening_balance"] == 21_700.0
    assert (usd["currency"], usd["opening_balance"], usd["events"], usd["closing_balance"]) == (
        "USD", 150.0, [], 150.0)

    salary = [e for e in body["events"] if "alary" in e["name"]]
    assert [(e["date"], e["name"], e["amount"]) for e in salary] == [
        ("2026-11-02", "Projected salary deposit (awaiting conversion)",
         v8("overdue pending salary at window start")),
        ("2026-11-11", "Monthly Salary", v8("Monthly Salary, Nov 11")),
        ("2026-12-11", "Monthly Salary", v8("Monthly Salary, Dec 11"))]
    assert _estimated(salary[0], PENDING_SALARY_USD)
    assert all(_estimated(e, SALARY_USD) for e in salary[1:])
    (overdue,) = [e for e in body["events"]
                  if e["name"] == "Credit Card statement" and e["date"] == "2026-11-02"]
    assert overdue["amount"] == -OVERDUE
    (statement,) = [e for e in body["events"]
                    if e["name"] == "Credit Card statement" and e["date"] == OPEN_DUE]
    assert statement["amount"] == -round(INTERNET + NETFLIX, 2)
    assert _estimated(statement, 14.99)
    # Every other event is as on main.
    others = [(e["date"], e["name"], e["amount"]) for e in body["events"]
              if e not in salary and e is not statement and e is not overdue]
    assert others == [
        ("2026-11-02", "Projected September electric bill", 0.0),
        ("2026-11-15", "Brokerage Auto-Deposit", -BROKERAGE),
        ("2026-11-20", "Electric Bill", -ELECTRIC),
        ("2026-11-23", "Credit Card statement", -INTERNET),
        ("2026-12-01", "Rent", -RENT),
        ("2026-12-02", "Gym Membership", -GYM),
        ("2026-12-15", "Brokerage Auto-Deposit", -BROKERAGE),
        ("2026-12-20", "Electric Bill", -ELECTRIC)]
    assert [(r["base"], r["quote"], r["rate"]) for r in body["fx"]["rates"]] == [
        ("USD", "PHP", 58.0)]


def _sign(x):
    return (x > 0) - (x < 0)


def test_demo_rebalanced_projection_story(demo):
    """STU-308: the believable salary and the rebalanced budget tell shape 7's story."""
    timeline = demo("/forecast/timeline", days=60)
    assert timeline["currencies"] == ["PHP", "USD"]
    php, usd = timeline["by_currency"]
    assert (usd["opening_balance"], usd["events"], usd["closing_balance"]) == (150.0, [], 150.0)
    assert php["opening_balance"] == 21_700.0
    snapshot = demo("/dashboard/snapshot")
    assert snapshot["balances"]["total"] == 21_200.0
    assert snapshot["balances"]["by_currency"][1] == {
        "currency": "USD", "total": 150.0, "available_cash": 150.0}

    # The same events on the same dates.
    assert sorted((e["date"], e["name"]) for e in timeline["events"]) == [
        ("2026-11-02", "Credit Card statement"),
        ("2026-11-02", "Projected September electric bill"),
        ("2026-11-02", "Projected salary deposit (awaiting conversion)"),
        ("2026-11-11", "Monthly Salary"), ("2026-11-15", "Brokerage Auto-Deposit"),
        ("2026-11-20", "Electric Bill"), ("2026-11-23", "Credit Card statement"),
        ("2026-12-01", "Rent"), ("2026-12-02", "Gym Membership"),
        ("2026-12-11", "Monthly Salary"), ("2026-12-15", "Brokerage Auto-Deposit"),
        ("2026-12-20", "Electric Bill"), ("2026-12-22", "Credit Card statement")]
    salary = [e for e in timeline["events"] if e["name"] == "Monthly Salary"]
    assert [e["date"] for e in salary] == ["2026-11-11", "2026-12-11"]
    assert all(_estimated(e, SALARY_USD) for e in salary)
    assert all(e["amount"] == round(SALARY_USD * 58.0, 2) for e in salary)

    # The overdue card statement and the card statement history are as in shape 7.
    (overdue,) = [e for e in timeline["events"]
                  if e["name"] == "Credit Card statement" and e["date"] == "2026-11-02"]
    assert overdue["amount"] == -OVERDUE

    # Each month's net keeps its sign: a November surplus, then a shortfall.
    periods = demo("/forecast/cashflow", months=3)["periods"]
    shape7_nets = [DIFF["cash-flow net, November 2026 (PHP)"][0] - OVERDUE + NETFLIX,
                   DIFF["cash-flow net, December 2026 and January 2027 (PHP)"][0] - NETFLIX,
                   DIFF["cash-flow net, December 2026 and January 2027 (PHP)"][0]]
    assert [_sign(p["net"]) for p in periods] == [_sign(n) for n in shape7_nets] == [1, -1, -1]

    # Disposable income: income is positive, and the figures keep shape 7's sign (a
    # small shortfall: the January net is the monthly disposable figure).
    body = demo("/forecast/disposable")
    assert 0 < body["monthly_income"] == v8("disposable monthly_income")
    assert body["monthly_disposable"] < body["monthly_income"]
    assert _sign(body["monthly_disposable"]) == _sign(DIFF["disposable monthly_disposable"][0])
    assert body["monthly_disposable"] == periods[2]["net"]


def test_snapshot(demo):
    body = demo("/dashboard/snapshot")
    assert body["currencies"] == ["PHP", "USD"]
    assert body["balances"]["total"] == v8("snapshot balances.total (PHP)")
    assert body["available_cash"] == v8("snapshot available_cash (PHP)")
    assert body["balances"]["by_currency"] == [
        {"currency": "PHP", "total": 21_200.0, "available_cash": 21_700.0},
        {"currency": "USD", "total": 150.0, "available_cash": 150.0}]
    summary = body["monthly_summary"]
    assert (summary["monthly_income"], summary["monthly_expenses"],
            summary["monthly_disposable"]) == (
        v8("disposable monthly_income"), v8("disposable monthly_expenses"),
        v8("disposable monthly_disposable"))
    # The overdue statement (Sept 2025 purchase) is first; the pending Netflix
    # row is on the statement due Dec 22, beyond these 30 days (test_timeline).
    assert [(p["due_date"], p["name"], p["amount"], p["account_name"], p["currency"])
            for p in body["payables"]] == [
        ("2026-11-02", "Credit Card statement", OVERDUE, "Joint Account", "PHP"),
        ("2026-11-15", "Brokerage Auto-Deposit", BROKERAGE, "Main Checking Account", "PHP"),
        ("2026-11-20", "Electric Bill", ELECTRIC, "Main Checking Account", "PHP"),
        ("2026-11-23", "Credit Card statement", INTERNET, "Joint Account", "PHP"),
        ("2026-12-01", "Rent", RENT, "Joint Account", "PHP"),
        ("2026-12-02", "Gym Membership", GYM, "Main Checking Account", "PHP")]


def test_cashflow(demo):
    periods = demo("/forecast/cashflow", months=3)["periods"]
    # The Netflix line leaves in December, not November.
    assert [(p["period_label"], p["income"], p["expenses"], p["net"]) for p in periods] == [
        ("November 2026", v8("cash-flow income, each month (PHP)"), BROKERAGE + ELECTRIC,
         round(v8("cash-flow net, November 2026 (PHP)") + NETFLIX - OVERDUE, 2)),
        ("December 2026", v8("cash-flow income, each month (PHP)"), BROKERAGE + RENT + ELECTRIC + GYM,
         round(v8("cash-flow net, December 2026 and January 2027 (PHP)") - NETFLIX, 2)),
        ("January 2027", v8("cash-flow income, each month (PHP)"), BROKERAGE + RENT + ELECTRIC + GYM,
         v8("cash-flow net, December 2026 and January 2027 (PHP)"))]
    for p in periods:
        usd = next(r for r in p["by_currency"] if r["currency"] == "USD")
        assert (usd["opening_balance"], usd["net"], usd["closing_balance"]) == (150.0, 0.0, 150.0)


def test_disposable(demo):
    body = demo("/forecast/disposable")
    assert (body["monthly_income"], body["monthly_expenses"], body["monthly_disposable"]) == (
        v8("disposable monthly_income"), v8("disposable monthly_expenses"),
        v8("disposable monthly_disposable"))


def test_ended_streaming_subscription_does_not_affect_disposable(demo, sw_db):
    """STU-305: the "Streaming Subscription" entry ended in March 2026, so the
    disposable figures are the same whether the seed leaves it inactive (shape 5)
    or it is still active: the dashboard's, ``/forecast/disposable``'s and the
    scalar the wishlist reads."""
    from app.models.budget_entry import BudgetEntry
    from app.models.user import User
    from app.services.forecast import get_disposable_income

    keys = ("monthly_income", "monthly_expenses", "monthly_disposable")
    uid = sw_db.query(User.id).filter(User.email == "demo@example.com").scalar()
    (entry,) = sw_db.query(BudgetEntry).filter(BudgetEntry.user_id == uid,
                                               BudgetEntry.name == "Streaming Subscription")
    assert (entry.end_mode, entry.end_date.replace(tzinfo=None), entry.is_active) == (
        "on_date", datetime(2026, 3, 5, 8, 0), False)

    def figures():
        sw_db.expire_all()
        dashboard = demo("/dashboard/snapshot")["monthly_summary"]
        body = demo("/forecast/disposable")
        scalar = get_disposable_income(sw_db, uid, today=FX_REF.date())
        return ({k: dashboard[k] for k in keys}, {k: body[k] for k in keys},
                body["by_currency"], {k: scalar[k] for k in keys})

    inactive = figures()
    assert inactive[1] == dict(zip(keys, (v8("disposable monthly_income"),
                                          v8("disposable monthly_expenses"),
                                          v8("disposable monthly_disposable"))))
    entry.is_active = True
    sw_db.commit()
    assert figures() == inactive


def test_card_statement_history(demo):
    accounts = {a["name"]: a["id"] for a in demo("/accounts/", limit=1000)["items"]}
    statements = demo(f"/accounts/{accounts['Credit Card']}/statements")["statements"]
    (sept,) = [s for s in statements if s["close_date"].startswith("2025-10-01")]
    assert (sept["statement_balance"], sept["amount_due"], sept["status"]) == (
        OVERDUE, OVERDUE, "overdue")
    (shopee,) = sept["lines"]
    assert (shopee["date"][:10], shopee["display_description"], shopee["amount"]) == (
        "2025-09-12", "Online purchase - Shopee", OVERDUE)
    (dec,) = [s for s in statements if s["close_date"].startswith("2026-12-01")]
    assert (dec["statement_balance"], dec["amount_due"], dec["status"]) == (
        NETFLIX, NETFLIX, "open")
    (line,) = dec["lines"]
    assert (line["date"][:10], line["display_description"], line["amount"]) == (
        "2026-11-02", "Netflix subscription (auto-pay)", NETFLIX)
    assert _estimated(line, 14.99)
    (aug,) = [s for s in statements if s["close_date"].startswith("2025-09-01")]
    assert (aug["statement_balance"], [(ln["display_description"], ln["amount"])
                                       for ln in aug["lines"]]) == (
        235.0, [("Online purchase - Amazon", 150.0), ("Household groceries", 85.0)])
    assert aug["status"] == "paid"


def test_august_2025_summary(demo):
    body = demo("/transactions/summary/period", start_date="2025-08-01T00:00:00",
                end_date="2025-08-31T23:59:59")
    assert body["summary"] == {
        "total_income": v8("Aug 2025 summary income"), "total_expenses": 925.5,
        "net_flow": v8("Aug 2025 summary net flow"), "transaction_count": 11}



# Reset days (naive UTC instant, Manila day, close of the cycle holding the row,
# status of that statement). The card closes on the 1st.
RESET_DAYS = [
    pytest.param(datetime(2026, 11, 2, 17, 0), "2026-11-03", "2026-12-01", id="17:00 UTC is next Manila day"),
    pytest.param(datetime(2026, 12, 1, 4, 0), "2026-12-01", "2026-12-01", id="on the close day"),
    pytest.param(datetime(2026, 12, 2, 4, 0), "2026-12-02", "2027-01-01", id="the day after close"),
]


@pytest.mark.parametrize("now, manila_day_, close", RESET_DAYS)
def test_pending_netflix_is_dated_on_the_manila_reset_day(demo_at, now, manila_day_, close):
    get = demo_at(now)
    accounts = {a["name"]: a["id"] for a in get("/accounts/", limit=1000)["items"]}
    statements = get(f"/accounts/{accounts['Credit Card']}/statements")["statements"]
    (line_statement,) = [s for s in statements
                         if any(ln["display_description"] == "Netflix subscription (auto-pay)"
                                for ln in s["lines"])]
    (line,) = [ln for ln in line_statement["lines"]
               if ln["display_description"] == "Netflix subscription (auto-pay)"]
    assert line["date"][:10] == manila_day_
    assert line_statement["close_date"].startswith(close)
    assert line_statement["status"] == "open"
    # Pending: the seeded transaction itself is unposted.
    (netflix,) = [t for t in get("/transactions/", limit=1000)["items"]
                  if t.get("description") == "Netflix subscription (auto-pay)"]
    assert netflix["is_posted"] is False
    # The overdue example holds.
    (sept,) = [s for s in statements if s["close_date"].startswith("2025-10-01")]
    assert (sept["statement_balance"], sept["status"]) == (OVERDUE, "overdue")

"""The demo under projections split by currency (STU-236, plan H, criterion 13).

Shape 5 puts the demo's foreign rows in the form's convention (USD 55.00
salary, the pending salary and Netflix rows at their foreign figure, the ended
"Streaming Subscription" entry inactive), and every projection is split by
account currency at the suite's rate (58.00 PHP per USD). Each test reseeds
the demo first, so figures never depend on what other tests did to it, and
freezes the clock at ``FX_REF`` (2026-11-02).

``TODAY`` holds each figure as ``main`` gives it (recorded on main, shape 4,
same clock); ``V4`` holds it now. Every figure that changes is listed, and is
pinned as that explicit diff.
"""
import sys

import pytest

from app.tests.conftest import API, FX_REF, sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

RATE_AS_OF = "2026-11-01"

# figure: (today on main, v4)
DIFF = {
    "timeline opening (PHP scalar)": (21_850.0, 21_700.0),
    "timeline closing, 60 days (PHP scalar)": (24_330.0, 24_380.58),
    "overdue pending salary at window start": (2_950.0, 3_190.0),
    "Monthly Salary, Nov 11": (3_200.0, 3_190.0),
    "Monthly Salary, Dec 11": (3_200.0, 3_190.0),
    "overdue card statement payable from the Joint Account": (850.0, 869.42),
    "Netflix line, statement closing 2025-10-01": (850.0, 869.42),
    "statement balance, closing 2025-10-01": (850.0, 869.42),
    "cash-flow income, each month (PHP)": (3_200.0, 3_190.0),
    "cash-flow net, November 2026 (PHP)": (3_540.0, 3_750.58),
    "cash-flow net, December 2026 and January 2027 (PHP)": (-1_060.0, -1_070.0),
    "Aug 2025 summary income": (3_000.0, 2_942.50),
    "Aug 2025 summary net flow": (2_074.50, 2_017.00),
    "disposable monthly_income": (3_200.0, 3_190.0),
    "disposable monthly_expenses": (4_319.99, 4_305.00),
    "disposable monthly_disposable": (-1_119.99, -1_115.00),
    "snapshot balances.total (PHP)": (21_350.0, 21_200.0),
    "snapshot available_cash (PHP)": (21_850.0, 21_700.0),
}


def v4(name):
    return DIFF[name][1]


@pytest.fixture
def demo(sw_client, sw_db, monkeypatch):
    """A freshly seeded demo, logged in, with every clock frozen at FX_REF."""
    from app.core import seed
    from app.models.demo_state import DemoState

    sw_db.query(DemoState).delete()
    sw_db.commit()
    seed.seed_database()
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: FX_REF)
    r = sw_client.post(f"{API}/auth/login",
                       json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}

    def get(path, **params):
        r = sw_client.get(f"{API}{path}", headers=headers, params=params)
        assert r.status_code == 200, (path, r.text)
        return r.json()

    return get


def test_the_shape_is_five():
    from app.core.seed import DEMO_SHAPE_VERSION

    assert DEMO_SHAPE_VERSION == 5


def _estimated(item, original):
    return (item.get("estimated"), item.get("original_amount"), item.get("original_currency"),
            item.get("rate"), item.get("rate_as_of"), item.get("rate_stale")) == (
        True, original, "USD", 58.0, RATE_AS_OF, False)


def test_timeline(demo):
    body = demo("/forecast/timeline", days=60)
    assert body["currencies"] == ["PHP", "USD"]
    assert body["opening_balance"] == v4("timeline opening (PHP scalar)")
    assert body["closing_balance"] == v4("timeline closing, 60 days (PHP scalar)")
    php, usd = body["by_currency"]
    assert php["currency"] == "PHP" and php["opening_balance"] == 21_700.0
    assert (usd["currency"], usd["opening_balance"], usd["events"], usd["closing_balance"]) == (
        "USD", 150.0, [], 150.0)

    salary = [e for e in body["events"] if "alary" in e["name"]]
    assert [(e["date"], e["name"], e["amount"]) for e in salary] == [
        ("2026-11-02", "Projected salary deposit (awaiting conversion)",
         v4("overdue pending salary at window start")),
        ("2026-11-11", "Monthly Salary", v4("Monthly Salary, Nov 11")),
        ("2026-12-11", "Monthly Salary", v4("Monthly Salary, Dec 11"))]
    assert all(_estimated(e, 55.0) for e in salary)
    (statement,) = [e for e in body["events"]
                    if e["name"] == "Credit Card statement" and e["date"] == "2026-11-02"]
    assert statement["amount"] == -v4("overdue card statement payable from the Joint Account")
    assert _estimated(statement, 14.99)
    # Every other event is as on main.
    others = [(e["date"], e["name"], e["amount"]) for e in body["events"]
              if e not in salary and e is not statement]
    assert others == [
        ("2026-11-02", "Projected September electric bill", 0.0),
        ("2026-11-15", "Brokerage Auto-Deposit", -500.0),
        ("2026-11-20", "Electric Bill", -1_200.0),
        ("2026-11-22", "Credit Card statement", -60.0),
        ("2026-12-01", "Rent", -2_500.0),
        ("2026-12-15", "Brokerage Auto-Deposit", -500.0),
        ("2026-12-20", "Electric Bill", -1_200.0),
        ("2026-12-22", "Credit Card statement", -60.0)]
    assert [(r["base"], r["quote"], r["rate"]) for r in body["fx"]["rates"]] == [
        ("USD", "PHP", 58.0)]


def test_snapshot(demo):
    body = demo("/dashboard/snapshot")
    assert body["currencies"] == ["PHP", "USD"]
    assert body["balances"]["total"] == v4("snapshot balances.total (PHP)")
    assert body["available_cash"] == v4("snapshot available_cash (PHP)")
    assert body["balances"]["by_currency"] == [
        {"currency": "PHP", "total": 21_200.0, "available_cash": 21_700.0},
        {"currency": "USD", "total": 150.0, "available_cash": 150.0}]
    summary = body["monthly_summary"]
    assert (summary["monthly_income"], summary["monthly_expenses"],
            summary["monthly_disposable"]) == (
        v4("disposable monthly_income"), v4("disposable monthly_expenses"),
        v4("disposable monthly_disposable"))
    assert [(p["due_date"], p["name"], p["amount"], p["account_name"], p["currency"])
            for p in body["payables"]] == [
        ("2026-11-02", "Credit Card statement",
         v4("overdue card statement payable from the Joint Account"), "Joint Account", "PHP"),
        ("2026-11-15", "Brokerage Auto-Deposit", 500.0, "Main Checking Account", "PHP"),
        ("2026-11-20", "Electric Bill", 1_200.0, "Main Checking Account", "PHP"),
        ("2026-11-22", "Credit Card statement", 60.0, "Joint Account", "PHP"),
        ("2026-12-01", "Rent", 2_500.0, "Joint Account", "PHP")]
    assert _estimated(body["payables"][0], 14.99)


def test_cashflow(demo):
    periods = demo("/forecast/cashflow", months=3)["periods"]
    assert [(p["period_label"], p["income"], p["expenses"], p["net"]) for p in periods] == [
        ("November 2026", v4("cash-flow income, each month (PHP)"), 1_700.0,
         v4("cash-flow net, November 2026 (PHP)")),
        ("December 2026", v4("cash-flow income, each month (PHP)"), 4_200.0,
         v4("cash-flow net, December 2026 and January 2027 (PHP)")),
        ("January 2027", v4("cash-flow income, each month (PHP)"), 4_200.0,
         v4("cash-flow net, December 2026 and January 2027 (PHP)"))]
    for p in periods:
        usd = next(r for r in p["by_currency"] if r["currency"] == "USD")
        assert (usd["opening_balance"], usd["net"], usd["closing_balance"]) == (150.0, 0.0, 150.0)


def test_disposable(demo):
    body = demo("/forecast/disposable")
    assert (body["monthly_income"], body["monthly_expenses"], body["monthly_disposable"]) == (
        v4("disposable monthly_income"), v4("disposable monthly_expenses"),
        v4("disposable monthly_disposable"))


def test_card_statement_history(demo):
    accounts = {a["name"]: a["id"] for a in demo("/accounts/", limit=1000)["items"]}
    statements = demo(f"/accounts/{accounts['Credit Card']}/statements")["statements"]
    (sept,) = [s for s in statements if s["close_date"].startswith("2025-10-01")]
    assert sept["statement_balance"] == v4("statement balance, closing 2025-10-01")
    (line,) = sept["lines"]
    assert (line["display_description"], line["amount"]) == (
        "Netflix subscription (auto-pay)", v4("Netflix line, statement closing 2025-10-01"))
    assert _estimated(line, 14.99)
    (aug,) = [s for s in statements if s["close_date"].startswith("2025-09-01")]
    assert (aug["statement_balance"], [(ln["display_description"], ln["amount"])
                                       for ln in aug["lines"]]) == (
        235.0, [("Online purchase - Amazon", 150.0), ("Household groceries", 85.0)])


def test_august_2025_summary(demo):
    body = demo("/transactions/summary/period", start_date="2025-08-01T00:00:00",
                end_date="2025-08-31T23:59:59")
    assert body["summary"] == {
        "total_income": v4("Aug 2025 summary income"), "total_expenses": 925.5,
        "net_flow": v4("Aug 2025 summary net flow"), "transaction_count": 11}


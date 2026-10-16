"""The cash-flow timeline's Account column and main-account scope (STU-326, plan section 3).

Reuses ``test_currency_projection_integration``'s ``cx`` fixture (PHP Checking
50,000, PHP Savings 10,000, USD Savings 1,000, two cards) on its frozen clock,
plus a pending same-currency transfer with a fee, PHP Checking -> PHP Savings.

Every full timeline event names the accounts it moves cash on (``accounts``,
one per cash leg in any currency); limited events keep their exact shape.
Skips without a database.
"""
from decimal import Decimal

import pytest

from app.tests.conftest import sw_db_reachable
from app.tests.test_currency_projection_integration import (  # noqa: F401  (fixtures)
    _d, _get, _row, _transfer, check_timeline_row, cx, frozen,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

DAYS = 30
FULL_KEYS = {"date", "name", "amount", "type", "source", "source_id", "running_balance",
             "currency", "accounts"}
LABELS = {"estimated", "original_amount", "original_currency", "rate", "rate_as_of",
          "rate_stale", "unconverted"}
MOVE, FEE = 2_000, 25


@pytest.fixture
def mx(cx, sw_db):  # noqa: F811
    """``cx`` plus a pending PHP Checking -> PHP Savings transfer with a fee."""
    uid = cx["a"]["id"]
    cx["move"] = _transfer(sw_db, uid, cx["php"], cx["php_sav"], MOVE, _d(7), "PHP",
                           transfer_fee=FEE, description="Top up savings")
    return cx


def _timeline(client, who, expect=200, **params):
    return _get(client, who, "/forecast/timeline", expect=expect, days=DAYS, **params)


def _event(row, name):
    (e,) = [e for e in row["events"] if e["name"] == name]
    return e


def _sides(e):
    return [(a["account_name"], a["amount"], a["currency"]) for a in e["accounts"]]


def test_pooled_full_events_name_their_accounts(sw_client, frozen, mx):  # noqa: F811
    body = _timeline(sw_client, mx["a"])
    php, usd = _row(body, "PHP"), _row(body, "USD")
    for row in (php, usd):
        check_timeline_row(row)
        for e in row["events"]:
            assert isinstance(e["accounts"], list), e
            assert set(e) - LABELS == FULL_KEYS, e
            if e["accounts"]:
                in_row = [a["amount"] for a in e["accounts"] if a["currency"] == row["currency"]]
                assert abs(sum(in_row) - e["amount"]) < 0.005, e

    move = _event(php, "Top up savings")
    assert move["amount"] == -FEE
    assert _sides(move) == [("PHP Checking", -(MOVE + FEE), "PHP"),
                            ("PHP Savings", MOVE, "PHP")]
    assert [a["account_id"] for a in move["accounts"]] == [mx["php"], mx["php_sav"]]

    rent = _event(php, "PHP rent")
    assert _sides(rent) == [("PHP Checking", -25_000, "PHP")]

    (accountless,) = [e for e in usd["events"] if e["name"] == "Accountless"]
    assert accountless["accounts"] == [
        {"account_id": None, "account_name": None, "amount": -50.0, "currency": "USD"}]

    # A cross-currency transfer names both sides, each in its own currency, in both rows.
    out, into = _event(php, "Pending PHP to USD"), _event(usd, "Pending PHP to USD")
    assert _sides(out) == _sides(into) == [("PHP Checking", -5_800, "PHP"),
                                            ("USD Savings", 100, "USD")]
    assert out["amount"] == -5_800 and into["amount"] == 100


def test_pooled_scalars_are_the_default_row_with_accounts(sw_client, frozen, mx):  # noqa: F811
    body = _timeline(sw_client, mx["a"])
    assert body["events"] == _row(body, "PHP")["events"]
    assert body["opening_balance"] == 60_000


def test_card_payment_names_only_the_paying_account(sw_client, frozen, mx):  # noqa: F811
    body = _timeline(sw_client, mx["a"])
    statements = [e for e in _row(body, "USD")["events"] if e["source"] == "statement"]
    assert statements, "the USD card's statement is due in the window"
    for e in statements:
        assert [a["account_id"] for a in e["accounts"]] == [mx["usd"]]


def test_unchanged_figures_against_the_engine(sw_client, sw_db, frozen, mx):  # noqa: F811
    """The events' amounts and running balances are the engine's, untouched."""
    from app.services import forecast as forecast_svc
    from app.tests.conftest import fx_rates

    body = _timeline(sw_client, mx["a"])
    start, end = forecast_svc._timeline_window(DAYS, None)
    p = forecast_svc.Projection(sw_db, mx["a"]["id"], start, end, fx=fx_rates())
    result = forecast_svc._timeline(p, "PHP", start, end, rows=True)
    assert [Decimal(str(e["running_balance"])) for e in _row(body, "PHP")["events"]] == [
        e["running_balance"] for e in result["events"]]

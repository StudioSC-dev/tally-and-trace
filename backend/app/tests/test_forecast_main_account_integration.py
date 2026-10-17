"""The cash-flow timeline's Account column and main-account scope (STU-326, plan section 3).

Reuses ``test_currency_projection_integration``'s ``cx`` fixture (PHP Checking
50,000, PHP Savings 10,000, USD Savings 1,000, two cards) on its frozen clock,
plus a pending same-currency transfer with a fee, PHP Checking -> PHP Savings.

Every full timeline event names the accounts it moves cash on (``accounts``,
one per cash leg in any currency); limited events keep their exact shape.
``?account_id=`` walks one active projection-cash account the caller holds a
direct role on: its own opening and cash legs, in its currency, with
``account`` echoing the scope. A card, loan or wallet is a 400; a hidden,
inactive or unknown account a 404. Skips without a database.
"""
from decimal import Decimal

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_currency_projection_integration import (  # noqa: F401  (fixtures)
    _acct, _d, _entry, _get, _row, _transfer, check_timeline_row, cx, frozen,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

DAYS = 30
FULL_KEYS = {"date", "name", "amount", "type", "source", "source_id", "event_id", "running_balance",
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


# --- one pinned account (plan section 3) -----------------------------------------------------

LIMITED_EVENT_KEYS = {"view", "public_id", "date", "original_date", "overdue", "display_name",
                      "face_amount", "cash_delta", "currency", "account", "kind"}


def _closing_of(row, account_id):
    (a,) = [a for a in row["by_account"] if a["account_id"] == account_id]
    return a["closing_balance"]


def test_pooled_response_echoes_no_account(sw_client, frozen, mx):  # noqa: F811
    assert _timeline(sw_client, mx["a"])["account"] is None


def test_pinned_php_checking_walks_its_own_book(sw_client, frozen, mx):  # noqa: F811
    pooled = _timeline(sw_client, mx["a"])
    body = _timeline(sw_client, mx["a"], account_id=mx["php"])
    assert body["account"] == {"account_id": mx["php"], "account_name": "PHP Checking",
                               "currency": "PHP"}
    assert body["currencies"] == ["PHP"]
    assert [r["currency"] for r in body["by_currency"]] == ["PHP"]
    row = _row(body, "PHP")
    assert body["events"] == row["events"]
    assert body["opening_balance"] == row["opening_balance"] == 50_000
    assert _event(row, "Top up savings")["amount"] == -(MOVE + FEE)
    assert _event(row, "Pending PHP to USD")["amount"] == -5_800
    assert body["closing_balance"] == _closing_of(_row(pooled, "PHP"), mx["php"])
    assert [a["account_id"] for a in body["by_account"]] == [mx["php"]]
    assert body["by_account"][0]["closing_balance"] == body["closing_balance"]
    assert body["unassigned_closing"] == 0
    # Every event has a cash leg on PHP Checking; the walk adds up.
    for e in body["events"]:
        assert mx["php"] in [a["account_id"] for a in e["accounts"]], e
    total = body["opening_balance"] + sum(e["amount"] for e in body["events"])
    assert abs(total - body["closing_balance"]) < 0.005
    names = {e["name"] for e in body["events"]}
    assert "Accountless" not in names and "USD rent" not in names


def test_pinned_usd_savings_is_in_usd(sw_client, frozen, mx):  # noqa: F811
    pooled = _timeline(sw_client, mx["a"])
    body = _timeline(sw_client, mx["a"], account_id=mx["usd"])
    assert body["account"]["currency"] == "USD"
    assert body["currencies"] == ["USD"]
    assert [r["currency"] for r in body["by_currency"]] == ["USD"]
    assert body["opening_balance"] == 1_000
    into = _event(_row(body, "USD"), "Pending PHP to USD")
    assert into["amount"] == 100
    assert _sides(into) == [("PHP Checking", -5_800, "PHP"), ("USD Savings", 100, "USD")]
    assert body["closing_balance"] == _closing_of(_row(pooled, "USD"), mx["usd"])


def test_pinned_errors(sw_client, sw_db, sw_people, frozen, mx):  # noqa: F811
    uid = mx["a"]["id"]
    loan = _acct(sw_db, uid, "Car loan", "loan", "PHP", -100_000, loan_kind="auto")
    wallet = _acct(sw_db, uid, "Pocket", "cash", "PHP", 500, is_spending_wallet=True)
    closed = _acct(sw_db, uid, "Closed bank", "savings", "PHP", 100, is_active=False)
    stranger = sw_people("Stan", "Stranger")
    theirs = sw_post(sw_client, stranger, "/accounts/", {
        "name": "Stan bank", "account_type": "checking", "balance": 1_000})["id"]
    for account_id in (mx["php_card"], mx["usd_card"], loan, wallet):
        body = _timeline(sw_client, mx["a"], expect=400, account_id=account_id)
        assert body["detail"] == "Only a cash account can be the main account"
    for account_id in (closed, theirs, 987_654_321):
        body = _timeline(sw_client, mx["a"], expect=404, account_id=account_id)
        assert body["detail"] == "Account not found"
    _timeline(sw_client, mx["a"], expect=422, account_id=0)


def test_account_lost_after_the_pin_check_is_a_404(sw_db, frozen, mx):  # noqa: F811
    """Deactivated between ``require_main_account`` and the projection: a 404, not a 500."""
    from fastapi import HTTPException

    from app.models.account import Account
    from app.models.user import User
    from app.services import forecast as forecast_svc
    from app.tests.conftest import fx_rates

    uid = mx["a"]["id"]
    forecast_svc.require_main_account(sw_db, sw_db.get(User, uid), mx["php_sav"])
    sw_db.get(Account, mx["php_sav"]).is_active = False
    sw_db.flush()
    with pytest.raises(HTTPException) as caught:
        forecast_svc.timeline_by_currency(sw_db, uid, days=DAYS, fx=fx_rates(),
                                          account_id=mx["php_sav"])
    assert (caught.value.status_code, caught.value.detail) == (404, "Account not found")


def test_tag_and_account_together(sw_client, frozen, mx):  # noqa: F811
    a = mx["a"]
    trip = sw_post(sw_client, a, "/tags/", {"name": "Trip"})["id"]
    for account, amount in ((mx["php"], 700), (mx["php_sav"], 300)):
        sw_post(sw_client, a, "/transactions/", {
            "account_id": account, "amount": amount, "transaction_type": "debit",
            "transaction_date": "2026-11-06T00:00:00", "is_posted": False,
            "description": "Trip spend", "tag_ids": [trip]})
    body = _timeline(sw_client, a, account_id=mx["php"], tag=trip)
    assert body["opening_balance"] == 50_000  # the account's full balance
    assert [(e["name"], e["amount"]) for e in body["events"]] == [("Trip spend", -700)]
    assert body["closing_balance"] == 49_300


def test_pinned_overflow_follows_the_scheduled_book(sw_client, sw_db, frozen, mx):  # noqa: F811
    uid = mx["a"]["id"]
    _entry(sw_db, uid, "Tuition", "expense", 30_000, "PHP", _d(10), mx["php"],
           overflow_account_id=mx["php_sav"])
    pooled = _row(_timeline(sw_client, mx["a"]), "PHP")
    body = _timeline(sw_client, mx["a"], account_id=mx["php"])
    # 50,000 - 25,000 rent - 2,025 move - 80 foreign - 5,800 transfer - 30,000 tuition
    tuition = _event(_row(body, "PHP"), "Tuition")
    assert tuition["running_balance"] < 0
    assert body["shortfall"] is True
    (short,) = [s for s in body["account_shortfalls"] if s["name"] == "Tuition"]
    assert short["account_id"] == mx["php"] and short["overflow_used"] > 0
    assert [m["from_account_id"] for m in body["overflow_moves"]] == [mx["php_sav"]]
    assert all(m["to_account_id"] == mx["php"] for m in body["overflow_moves"])
    assert body["closing_balance"] == _closing_of(pooled, mx["php"])
    assert body["account_shortfalls"] == [s for s in pooled["account_shortfalls"]
                                          if s["account_id"] == mx["php"]]

    # Each move names the event it covers by id, never by name.
    tuition_id = _event(_row(body, "PHP"), "Tuition")["event_id"]
    assert {m["event_id"] for m in body["overflow_moves"]} == {tuition_id}

    # Pinned to the overflow account: the move shows where money was pulled from.
    sav = _timeline(sw_client, mx["a"], account_id=mx["php_sav"])
    assert [m["to_account_id"] for m in sav["overflow_moves"]] == [mx["php"]]
    assert sav["closing_balance"] == _closing_of(pooled, mx["php_sav"])


def test_viewer_pinned_to_a_shared_account_keeps_limited_events(sw, sw_client, frozen):  # noqa: F811
    a, b = sw["a"], sw["b"]
    # A's private loan paid from the joint account: limited for B.
    sw_post(sw_client, a, "/transactions/", {
        "account_id": sw["joint"], "amount": 4000, "transaction_type": "transfer",
        "transaction_date": "2026-11-10T00:00:00", "is_posted": False,
        "description": "Plain", "transfer_from_account_id": sw["joint"],
        "transfer_to_account_id": sw["a_loan"], "transfer_fee": 500})
    # B's own deposit from their private bank into the joint account: full for B.
    sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["b_private"], "amount": 250, "transaction_type": "transfer",
        "transaction_date": "2026-11-12T00:00:00", "is_posted": False,
        "description": "Deposit", "transfer_from_account_id": sw["b_private"],
        "transfer_to_account_id": sw["joint"]})
    body = _get(sw_client, b, "/forecast/timeline", days=DAYS, account_id=sw["joint"])
    assert body["account"]["account_name"] == "Joint account"
    assert body["opening_balance"] == 10_000
    limited = [e for e in body["events"] if e.get("view") == "limited"]
    assert limited, body["events"]
    for e in limited:
        assert set(e) == LIMITED_EVENT_KEYS | {"running_balance"}
    (payment,) = [e for e in limited if e["kind"] == "loan_payment"]
    assert payment["cash_delta"] == -4_500
    (deposit,) = [e for e in body["events"] if e.get("name") == "Deposit"]
    assert deposit["amount"] == 250
    assert body["closing_balance"] == 10_000 - 4_500 + 250


def test_main_account_pin_never_applies_implicitly(sw_client, frozen, mx):  # noqa: F811
    r = sw_client.put(f"{API}/auth/me", json={"main_account_id": mx["php"]},
                      headers=mx["a"]["headers"])
    assert r.status_code == 200, r.text
    body = _timeline(sw_client, mx["a"])
    assert body["account"] is None
    assert [r["currency"] for r in body["by_currency"]] == ["PHP", "USD"]

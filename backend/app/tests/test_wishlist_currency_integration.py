"""Wishlist affordability per currency (STU-304, STU-649), on free flow (STU-789).

An item is judged against the free-flow row of its own currency, never the
default currency's. The caller (``cur``, default PHP) posted last month: PHP
income 50,000 and spending 28,580, so a PHP free flow of 21,420 a month; USD
income 100, so a USD free flow of 100; and has no EUR account, so no EUR row.
A PHP reading would call a USD 1,000 item affordable now.
"""
from datetime import timedelta

import pytest

from app.core.time import utc_now
from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.fixtures import posted_flow

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


@pytest.fixture
def cur(sw_client, sw_db, sw_people):
    a = sw_people("Multi", "Currency")
    php = posted_flow.account(sw_db, a["id"], "checking", "PHP")
    usd = posted_flow.account(sw_db, a["id"], "checking", "USD")
    posted_flow.flow(sw_db, a["id"], php, income=50_000, spending=28_580)
    posted_flow.post(sw_db, a["id"], usd, "credit", 100)
    return {"a": a}


def _item(client, who, name, cost, currency, priority="medium"):
    return sw_post(client, who, "/wishlist/", {
        "name": name, "estimated_cost": cost, "currency": currency,
        "priority": priority})["id"]


def _get(client, who, path):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _due(months):
    return (utc_now() + timedelta(days=months * 30)).date().isoformat()


def test_readiness_uses_item_currency_row(sw_client, cur):
    a = cur["a"]
    usd = _get(sw_client, a, f"/wishlist/{_item(sw_client, a, 'Dollar gadget', 1_000, 'USD')}/readiness")
    # The USD row's free flow is 100 a month: not affordable now, whatever PHP holds.
    assert usd["currency"] == "USD"
    assert (usd["savings_rate"], usd["months_needed"], usd["affordable_now"]) == (
        100.0, 10, False)
    assert usd["note"] is None

    php = _get(sw_client, a, f"/wishlist/{_item(sw_client, a, 'Peso gadget', 1_000, 'PHP')}/readiness")
    assert php["currency"] == "PHP"
    assert (php["savings_rate"], php["months_needed"], php["affordable_now"]) == (
        21_420.0, 1, True)


def test_readiness_no_row_for_currency(sw_client, cur):
    a = cur["a"]
    body = _get(sw_client, a, f"/wishlist/{_item(sw_client, a, 'Euro gadget', 10, 'EUR')}/readiness")
    assert body["currency"] == "EUR"
    assert body["affordable_now"] is False
    assert (body["monthly_disposable"], body["savings_rate"], body["months_needed"]) == (
        0.0, 0.0, 9999)
    assert body["projection_status"] == "no_projection"
    assert "EUR" in body["note"]


def test_dashboard_wishlist_uses_item_currency(sw_client, cur):
    a = cur["a"]
    ids = {name: _item(sw_client, a, name, cost, currency, prio)
           for name, cost, currency, prio in (
               ("Peso gadget", 21_420, "PHP", "critical"),
               ("Dollar gadget", 1_000, "USD", "high"),
               ("Euro gadget", 10, "EUR", "medium"))}
    items = {i["id"]: i for i in _get(sw_client, a, "/dashboard/snapshot")["wishlist_next_up"]}
    assert set(items) == set(ids.values())
    peso, dollar, euro = (items[ids[n]] for n in ("Peso gadget", "Dollar gadget", "Euro gadget"))
    # PHP: a 21,420 critical item at a net flow of 21,420 a month is one month away.
    assert peso["affordable_by"] == _due(1)
    assert peso["note"] is None
    # USD: its own row, 100 a month, puts 1,000 ten months away.
    assert dollar["affordable_by"] == _due(10)
    assert dollar["note"] is None
    # EUR: no row, so no date, and it says so.
    assert euro["affordable_by"] is None and "EUR" in euro["note"]


# --- the purchase plan (STU-649) ---------------------------------------------------------

def _plan(client, who):
    body = _get(client, who, "/wishlist/plan")
    return body, {i["name"]: i for i in body["items"]}


def test_plan_uses_item_currency_row(sw_client, cur):
    a = cur["a"]
    _item(sw_client, a, "Peso gadget", 50_000, "PHP", "critical")
    _item(sw_client, a, "Dollar gadget", 1_000, "USD", "high")
    body, items = _plan(sw_client, a)
    # PHP: net flow 21,420 a month, so 50,000 takes ceil(2.33) = 3 months.
    assert items["Peso gadget"]["cumulative_months"] == 3
    assert items["Peso gadget"]["estimated_purchase_date"] == _due(3)
    # USD: its own free flow, 100 a month, so 1,000 takes 10 months.
    assert items["Dollar gadget"]["cumulative_months"] == 10
    assert items["Dollar gadget"]["estimated_purchase_date"] == _due(10)
    assert items["Dollar gadget"]["note"] is None


def test_plan_cumulative_per_currency(sw_client, cur):
    a = cur["a"]
    _item(sw_client, a, "Peso one", 21_420, "PHP", "critical")
    _item(sw_client, a, "Dollar gadget", 1_000, "USD", "high")
    _item(sw_client, a, "Peso two", 42_840, "PHP", "medium")
    _, items = _plan(sw_client, a)
    assert items["Peso one"]["cumulative_months"] == 1
    # 1 + 2 months, with the USD item's 10 months ignored.
    assert items["Peso two"]["cumulative_months"] == 3
    assert items["Peso two"]["estimated_purchase_date"] == _due(3)
    assert items["Dollar gadget"]["cumulative_months"] == 10


def test_plan_no_row_for_currency(sw_client, cur):
    a = cur["a"]
    _item(sw_client, a, "Peso one", 21_420, "PHP", "critical")
    _item(sw_client, a, "Euro gadget", 10, "EUR", "high")
    _item(sw_client, a, "Peso two", 21_420, "PHP", "medium")
    _, items = _plan(sw_client, a)
    euro = items["Euro gadget"]
    assert euro["estimated_purchase_date"] is None
    assert euro["cumulative_months"] == 0
    assert "EUR" in euro["note"]
    assert (items["Peso one"]["cumulative_months"], items["Peso two"]["cumulative_months"]) == (1, 2)
    assert items["Peso two"]["estimated_purchase_date"] == _due(2)
    assert items["Peso one"]["note"] is None


def test_plan_single_currency_unchanged(sw_client, cur):
    a = cur["a"]
    _item(sw_client, a, "Peso one", 21_420, "PHP", "critical")
    _item(sw_client, a, "Peso two", 50_000, "PHP", "low")
    body, items = _plan(sw_client, a)
    # No recurring entries: the kept recurring figure is 0; the rate is PHP free flow.
    assert (body["monthly_disposable"], body["savings_rate"]) == (0.0, 21_420.0)
    assert [(i["name"], i["cumulative_months"], i["estimated_purchase_date"], i["note"])
            for i in body["items"]] == [
        ("Peso one", 1, _due(1), None), ("Peso two", 4, _due(4), None)]


def test_plan_computes_free_flow_once(sw_client, cur, monkeypatch):
    from app.services import free_flow

    a = cur["a"]
    for n in range(4):
        _item(sw_client, a, f"Peso {n}", 1_000, "PHP")
    _item(sw_client, a, "Dollar gadget", 100, "USD")
    _item(sw_client, a, "Euro gadget", 10, "EUR")
    real, calls = free_flow._compute, []

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(free_flow, "_compute", counting)
    body = _get(sw_client, a, "/wishlist/plan")
    assert len(body["items"]) == 6
    assert len(calls) == 1

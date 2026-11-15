"""Wishlist affordability per currency (STU-304).

An item is judged against the ``by_currency`` disposable row of its own currency,
never the default-currency scalars. The fixture is ``test_currency_projection``'s
(owner A, default PHP): PHP disposable +42,840.00 a month, USD -2,050.00, and no
EUR row. A PHP-scalar reading would call a USD 100 item affordable.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests import test_currency_projection_integration as _projection

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

cx, frozen = _projection.cx, _projection.frozen  # the projection suite's fixtures


def _item(client, who, name, cost, currency, priority="medium"):
    return sw_post(client, who, "/wishlist/", {
        "name": name, "estimated_cost": cost, "currency": currency,
        "priority": priority})["id"]


def _get(client, who, path):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def test_readiness_uses_item_currency_row(sw_client, cx, frozen):
    a = cx["a"]
    usd = _get(sw_client, a, f"/wishlist/{_item(sw_client, a, 'Dollar gadget', 100, 'USD')}/readiness")
    # The USD row is -2,050 a month: not affordable, whatever the PHP scalar says.
    assert usd["currency"] == "USD"
    assert usd["monthly_disposable"] == -2_050.0
    assert (usd["savings_rate"], usd["months_needed"], usd["affordable_now"]) == (
        -1_025.0, 9999, False)
    assert usd["note"] is None

    php = _get(sw_client, a, f"/wishlist/{_item(sw_client, a, 'Peso gadget', 1_000, 'PHP')}/readiness")
    assert php["currency"] == "PHP"
    assert php["monthly_disposable"] == 42_840.0
    assert (php["savings_rate"], php["months_needed"], php["affordable_now"]) == (
        21_420.0, 1, True)


def test_readiness_no_row_for_currency(sw_client, cx, frozen):
    a = cx["a"]
    body = _get(sw_client, a, f"/wishlist/{_item(sw_client, a, 'Euro gadget', 10, 'EUR')}/readiness")
    assert body["currency"] == "EUR"
    assert body["affordable_now"] is False
    assert (body["monthly_disposable"], body["savings_rate"], body["months_needed"]) == (
        0.0, 0.0, 9999)
    assert "EUR" in body["note"]


def test_dashboard_wishlist_uses_item_currency(sw_client, cx, frozen):
    a = cx["a"]
    ids = {name: _item(sw_client, a, name, cost, cur, prio)
           for name, cost, cur, prio in (
               ("Peso gadget", 21_420, "PHP", "critical"),
               ("Dollar gadget", 100, "USD", "high"),
               ("Euro gadget", 10, "EUR", "medium"))}
    items = {i["id"]: i for i in _get(sw_client, a, "/dashboard/snapshot")["wishlist_next_up"]}
    assert set(items) == set(ids.values())
    peso, dollar, euro = (items[ids[n]] for n in ("Peso gadget", "Dollar gadget", "Euro gadget"))
    # PHP: a 21,420 item at a savings rate of 21,420 a month is one month away.
    from datetime import timedelta

    from app.core.time import utc_now
    assert peso["affordable_by"] == (utc_now() + timedelta(days=30)).date().isoformat()
    assert peso["note"] is None
    # USD: its own row is negative, so the floor rate (0.01) puts it a long way off.
    assert dollar["affordable_by"] > peso["affordable_by"]
    assert dollar["note"] is None
    # EUR: no row, so no date, and it says so.
    assert euro["affordable_by"] is None and "EUR" in euro["note"]

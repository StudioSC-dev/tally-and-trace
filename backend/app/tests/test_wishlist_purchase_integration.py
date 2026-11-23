"""Marking an installment wishlist item purchased creates its card installment (STU-779).

The entry is an expense on the item's card, monthly, ``after_occurrences`` with the
item's months, in the card's currency, first charged on the statement close that
holds the purchase day, linked through ``installment_entry_id``. Repeated and
concurrent requests create exactly one. A purchase in another currency with no
stored rate is refused (409) and the item stays unpurchased. Un-marking leaves the
entry and says so. Uses the ``sw`` household (A's card closes on the 15th, limit
77,777; rates: USD and PHP only). Skips without a database.
"""
import os
import threading
import time

import pytest
from sqlalchemy import create_engine, text

from app.core.time import manila_today
from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

PROBE_DEADLINE = 10
JOIN_TIMEOUT = 30


def _item(client, who, cost=10_000, currency="PHP", months=3, account_id=None, **fields):
    return sw_post(client, who, "/wishlist/", {
        "name": "Laptop", "estimated_cost": cost, "currency": currency,
        "payment_plan": "installment", "installment_months": months,
        "account_id": account_id, **fields})["id"]


def _put(client, who, item_id, expect=200, **fields):
    r = client.put(f"{API}/wishlist/{item_id}", json=fields, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _get(client, who, path):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _entries_named(db, user_id, name="Laptop"):
    return db.execute(text(
        "SELECT id FROM budget_entries WHERE user_id = :u AND name = :n ORDER BY id"),
        {"u": user_id, "n": name}).scalars().all()


def _close_of(db, card_id):
    from app.models.account import Account
    from app.services.statements import resolve_cycle_fields, statement_close

    card = db.get(Account, card_id)
    return statement_close(card, manila_today()), resolve_cycle_fields(card)[0]


def test_purchase_creates_one_card_installment(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = _item(client, a, account_id=sw["a_card"])
    body = _put(client, a, item, is_purchased=True)
    entry_id = body["installment_entry_id"]
    assert entry_id is not None and body["is_purchased"] is True
    assert body["notice"] == ("Created a card installment of 3 monthly payments in PHP; "
                              "it is in Recurring and the forecast")
    entry = _get(client, a, f"/budget-entries/{entry_id}")
    close, close_day = _close_of(sw_db, sw["a_card"])
    assert (entry["name"], entry["entry_type"], entry["cadence"], entry["end_mode"],
            entry["max_occurrences"], entry["currency"], entry["account_id"]) == (
        "Laptop", "expense", "monthly", "after_occurrences", 3, "PHP", sw["a_card"])
    # The shared split: 3,333.33 twice, then 3,333.34.
    assert (entry["amount"], entry["final_amount"]) == (3_333.33, 3_333.34)
    # Charged on the statement close holding the purchase day, like any card installment.
    assert entry["next_occurrence"][:10] == close.isoformat()
    assert entry["anchor_day"] == close_day
    assert entry["kind"] == "installment"
    assert _entries_named(sw_db, a["id"]) == [entry_id]

    # Again: nothing new, the same link.
    again = _put(client, a, item, is_purchased=True)
    assert (again["installment_entry_id"], again["notice"]) == (entry_id, None)
    assert _entries_named(sw_db, a["id"]) == [entry_id]


def test_unmarking_keeps_the_entry_and_says_so(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = _item(client, a, account_id=sw["a_card"])
    entry_id = _put(client, a, item, is_purchased=True)["installment_entry_id"]
    body = _put(client, a, item, is_purchased=False)
    assert (body["is_purchased"], body["installment_entry_id"]) == (False, entry_id)
    assert body["notice"] == ("The card installment keeps running in Recurring and the "
                              "forecast; delete it there if this purchase did not happen")
    assert _get(client, a, f"/budget-entries/{entry_id}")["is_active"] is True
    # Marked purchased again: still the one entry.
    assert _put(client, a, item, is_purchased=True)["installment_entry_id"] == entry_id
    assert _entries_named(sw_db, a["id"]) == [entry_id]
    # Its payment terms are fixed now; resending them unchanged passes.
    _put(client, a, item, expect=409, installment_months=6)
    _put(client, a, item, expect=409, payment_plan="full")
    _put(client, a, item, installment_months=3, account_id=sw["a_card"])
    # The outlook counts it once: out of the running installments, nothing more checked.
    outlook = _get(client, a, f"/wishlist/{item}/outlook")
    assert outlook["months"][0]["existing_installments"] == 0.0
    assert outlook["disposable_check"]["amount"] == 0.0
    assert outlook["credit_check"]["amount"] == 0.0


def test_a_full_payment_creates_nothing(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = sw_post(client, a, "/wishlist/", {
        "name": "Laptop", "estimated_cost": 500, "account_id": sw["a_card"]})["id"]
    body = _put(client, a, item, is_purchased=True)
    assert (body["installment_entry_id"], body["notice"]) == (None, None)
    assert _entries_named(sw_db, a["id"]) == []


def test_another_currency_is_converted_into_the_cards(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = _item(client, a, cost=100, currency="USD", months=2, account_id=sw["a_card"])
    entry_id = _put(client, a, item, is_purchased=True)["installment_entry_id"]
    entry = _get(client, a, f"/budget-entries/{entry_id}")
    # 100 USD at 58 PHP per USD: 5,800 PHP over two months.
    assert (entry["currency"], entry["amount"], entry["final_amount"]) == (
        "PHP", 2_900.0, 2_900.0)


def test_no_rate_refuses_the_purchase(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = _item(client, a, cost=100, currency="EUR", months=2, account_id=sw["a_card"])
    r = client.put(f"{API}/wishlist/{item}", json={"is_purchased": True}, headers=a["headers"])
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == ("No exchange rate from EUR to PHP is stored yet, so the "
                                  "installment can't be created; try again later")
    body = _get(client, a, f"/wishlist/{item}")
    assert (body["is_purchased"], body["purchased_at"], body["installment_entry_id"]) == (
        False, None, None)
    assert _entries_named(sw_db, a["id"]) == []


def test_household_editor_purchases_on_a_shared_card(sw_client, sw_db, sw):
    client, b = sw_client, sw["b"]
    share = sw_share(sw_db, sw["a_card"], b["id"], "editor", sw["a"]["id"])
    item = _item(client, b, account_id=sw["a_card"])
    other = _item(client, b, account_id=sw["a_card"])
    entry_id = _put(client, b, item, is_purchased=True)["installment_entry_id"]
    assert _get(client, b, f"/budget-entries/{entry_id}")["account_id"] == sw["a_card"]
    assert _entries_named(sw_db, b["id"]) == [entry_id]  # B's own entry
    # Once B may no longer edit the card, purchasing on it is refused and nothing changes.
    sw_db.execute(text("DELETE FROM account_shares WHERE id = :s"), {"s": share})
    sw_db.commit()
    r = client.put(f"{API}/wishlist/{other}", json={"is_purchased": True}, headers=b["headers"])
    assert r.status_code == 404, r.text
    assert _get(client, b, f"/wishlist/{other}")["is_purchased"] is False
    # Nobody else can mark B's item.
    for who in (sw["a"], sw["v"], sw["d"]):
        _put(client, who, other, expect=404, is_purchased=True)
    assert _entries_named(sw_db, b["id"]) == [entry_id]


# --- concurrency --------------------------------------------------------------------

class Worker:
    def __init__(self, fn):
        self.fn, self.result, self.error = fn, None, None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            self.result = self.fn()
        except BaseException as exc:  # re-raised in the test thread
            self.error = exc


def _waiting_on(engine, pid: int) -> int:
    """How many backends wait on the holder, directly or queued behind another
    waiter (Postgres queues the second request behind the first)."""
    with engine.connect() as probe:
        return probe.execute(text(
            "WITH RECURSIVE waits(pid) AS ("
            " SELECT pid FROM pg_stat_activity"
            " WHERE pg_blocking_pids(pid) @> ARRAY[CAST(:p AS integer)]"
            " UNION SELECT a.pid FROM pg_stat_activity a JOIN waits w"
            " ON pg_blocking_pids(a.pid) @> ARRAY[w.pid])"
            " SELECT count(*) FROM waits"), {"p": pid}).scalar()


def test_concurrent_purchases_create_exactly_one_entry(sw_client, sw_db, sw):
    """Two purchase requests wait on a held lock on the item, then race: the one
    that goes second reads the first's committed link and creates nothing."""
    from app.core import locking
    from app.core.database import SessionLocal

    client, a = sw_client, sw["a"]
    item = _item(client, a, account_id=sw["a_card"])
    engine = create_engine(os.environ["DATABASE_URL"])
    holder = SessionLocal()
    workers = [Worker(lambda: client.put(f"{API}/wishlist/{item}", json={"is_purchased": True},
                                         headers=a["headers"])) for _ in range(2)]
    try:
        assert locking.lock_wishlist_item(holder, item) is not None
        pid = holder.execute(text("SELECT pg_backend_pid()")).scalar()
        for w in workers:
            w.thread.start()
        deadline = time.monotonic() + PROBE_DEADLINE
        while _waiting_on(engine, pid) < 2 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert _waiting_on(engine, pid) == 2, "both requests should wait on the item lock"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        for w in workers:
            w.thread.join(JOIN_TIMEOUT)
        engine.dispose()
    for w in workers:
        assert not w.thread.is_alive()
        if w.error is not None:
            raise w.error
        assert w.result.status_code == 200, w.result.text
    links = {w.result.json()["installment_entry_id"] for w in workers}
    assert len(links) == 1 and None not in links
    assert _entries_named(sw_db, a["id"]) == list(links)


# --- after the purchase (audit fixes) -------------------------------------------------

def test_a_linked_items_price_and_currency_are_fixed(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = _item(client, a, account_id=sw["a_card"])
    _put(client, a, item, is_purchased=True)
    for change in ({"estimated_cost": 20_000}, {"estimated_cost": 10_000.01},
                   {"estimated_cost": None}, {"currency": "USD"}):
        r = client.put(f"{API}/wishlist/{item}", json=change, headers=a["headers"])
        assert r.status_code == 409, (change, r.text)
    # The stored values resent pass, and other fields still change.
    body = _put(client, a, item, estimated_cost=10_000, currency="PHP", name="Laptop Pro")
    assert (body["estimated_cost"], body["currency"], body["name"]) == (
        10_000.0, "PHP", "Laptop Pro")
    # Before the purchase the price may change freely.
    other = _item(client, a, account_id=sw["a_card"])
    assert _put(client, a, other, estimated_cost=12_000)["estimated_cost"] == 12_000.0


def test_an_explicit_null_purchase_date_means_now(sw_client, sw_db, sw):
    client, a = sw_client, sw["a"]
    item = _item(client, a, account_id=sw["a_card"])
    body = _put(client, a, item, is_purchased=True, purchased_at=None)
    assert body["is_purchased"] is True and body["purchased_at"] is not None
    assert body["installment_entry_id"] is not None
    assert _entries_named(sw_db, a["id"]) == [body["installment_entry_id"]]


def test_a_purchased_items_months_follow_its_entry(sw_client, sw_db, sw):
    """A card closing today: the first payment falls this month, before the
    outlook's first row, so the rows show the entry's second and last payments
    and no third month, not the plan's split from next month."""
    client, a = sw_client, sw["a"]
    card = sw_post(client, a, "/accounts/", {
        "name": "Today card", "account_type": "credit", "balance": 0,
        "billing_cycle_start": manila_today().day, "days_until_due_date": 10,
        "payment_account_id": sw["a_private"], "credit_limit": 50_000})["id"]
    item = _item(client, a, account_id=card)
    before = _get(client, a, f"/wishlist/{item}/outlook")["months"]
    assert [m["this_item"] for m in before[:4]] == [3_333.33, 3_333.33, 3_333.34, 0.0]

    entry_id = _put(client, a, item, is_purchased=True)["installment_entry_id"]
    entry = _get(client, a, f"/budget-entries/{entry_id}")
    assert entry["next_occurrence"][:10] == manila_today().isoformat()
    after = _get(client, a, f"/wishlist/{item}/outlook")
    months = after["months"]
    assert [m["this_item"] for m in months[:4]] == [3_333.33, 3_333.34, 0.0, 0.0]
    assert [m["existing_installments"] for m in months[:4]] == [0.0] * 4
    assert [m["total"] for m in months[:3]] == [3_333.33, 3_333.34, 0.0]
    # The plan's own amounts are unchanged.
    assert (after["monthly_amount"], after["final_amount"]) == (3_333.33, 3_333.34)

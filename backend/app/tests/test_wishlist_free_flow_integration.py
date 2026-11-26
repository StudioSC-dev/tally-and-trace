"""The wishlist on free flow (STU-789): plan, outlook, readiness and dashboard next-up.

Plan: ``.claude/plans/wishlist-net-flow-plan.md`` section 3; each test name
carries the acceptance criterion it pins (``ac1`` ... ``ac15``).

On the real clock. ``fixtures/posted_flow`` writes the rows: an anchor two
months back and everything else last month, so the window is last month alone
and every figure is last month's total. The standard caller (``standard``):

    PHP checking: income 30,000, spending 10,000, 5,000 moved to own savings
    net_flow 20,000, saved 5,000, no goals: free_flow 15,000

Every user is made fresh by ``sw_people`` and removed with everything they made.
Skips without a database.
"""
from datetime import timedelta

import pytest

from app.core.time import utc_now
from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.fixtures import posted_flow

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

NET, FREE = 20_000, 15_000


def due(months: int) -> str:
    return (utc_now() + timedelta(days=months * 30)).date().isoformat()


def get(client, who, path):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def item(client, who, name, cost, priority="medium", currency="PHP", **fields):
    return sw_post(client, who, "/wishlist/", {
        "name": name, "estimated_cost": cost, "currency": currency, "priority": priority,
        **fields})["id"]


def plan(client, who):
    body = get(client, who, "/wishlist/plan")
    return body, {i["name"]: i for i in body["items"]}


def surfaces(client, who, item_id):
    """The item on all four surfaces: (plan item, readiness, outlook, next-up)."""
    _, by_name = plan(client, who)
    (planned,) = [i for i in by_name.values() if i["item_id"] == item_id]
    readiness = get(client, who, f"/wishlist/{item_id}/readiness")
    outlook = get(client, who, f"/wishlist/{item_id}/outlook")
    next_up = {i["id"]: i for i in get(client, who, "/dashboard/snapshot")["wishlist_next_up"]}
    return planned, readiness, outlook, next_up.get(item_id)


@pytest.fixture
def standard(sw_client, sw_db, sw_people):
    me = sw_people("Wish", "Flow")
    bank = posted_flow.account(sw_db, me["id"], "checking")
    savings = posted_flow.account(sw_db, me["id"], "savings")
    posted_flow.flow(sw_db, me["id"], bank, income=30_000, spending=10_000, saved=5_000,
                     savings_id=savings)
    return {"me": me, "bank": bank, "savings": savings}


# --- AC1: the rate by priority -------------------------------------------------------------

def test_ac1_critical_uses_net_flow_and_a_want_uses_free_flow(sw_client, standard):
    me = standard["me"]
    crit = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Repair', 1_000, 'critical')}/readiness")
    want = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Lamp', 1_000, 'low')}/readiness")
    assert (crit["savings_rate"], crit["basis"]) == (NET, "net_flow")
    assert (want["savings_rate"], want["basis"]) == (FREE, "free_flow")
    # 20,000 at net flow is one month; at free flow two.
    big_crit = item(sw_client, me, "Roof", 20_000, "critical")
    big_want = item(sw_client, me, "Sofa", 20_000, "high")
    assert get(sw_client, me, f"/wishlist/{big_crit}/readiness")["months_needed"] == 1
    assert get(sw_client, me, f"/wishlist/{big_want}/readiness")["months_needed"] == 2


def test_ac1_no_rate_unless_the_currency_row_is_ok(sw_client, sw_db, standard):
    me = standard["me"]
    # USD: spending only, so its row is ``no_projection``.
    usd = posted_flow.account(sw_db, me["id"], "checking", "USD")
    posted_flow.post(sw_db, me["id"], usd, "debit", 50)
    for prio in ("critical", "high"):
        body = get(sw_client, me, f"/wishlist/{item(sw_client, me, prio, 10, prio, 'USD')}/readiness")
        assert (body["projection_status"], body["savings_rate"], body["affordable_now"]) == (
            "no_projection", 0.0, False)


# --- AC2: each status, its note and their precedence ----------------------------------------

def test_ac2_dated_no_room_and_beyond_horizon(sw_client, sw_db, sw_people, standard):
    me = standard["me"]
    dated = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Lamp', 1_000)}/readiness")
    assert (dated["projection_status"], dated["projection_note"], dated["note"]) == (
        "dated", None, None)
    # 60 months of free flow is the last dated month; one peso more is beyond it.
    edge = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Edge', 60 * FREE)}/readiness")
    assert (edge["projection_status"], edge["months_needed"]) == ("dated", 60)
    far = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Far', 60 * FREE + 1)}/readiness")
    assert (far["projection_status"], far["projection_note"]) == (
        "beyond_horizon", "More than 5 years away")

    # No room: a want with all net flow saved, a critical item with no net flow.
    tight = sw_people("Tight", "Saver")
    bank = posted_flow.account(sw_db, tight["id"])
    savings = posted_flow.account(sw_db, tight["id"], "savings")
    posted_flow.flow(sw_db, tight["id"], bank, income=30_000, spending=10_000, saved=20_000,
                     savings_id=savings)
    want = get(sw_client, tight, f"/wishlist/{item(sw_client, tight, 'Lamp', 10)}/readiness")
    assert (want["projection_status"], want["projection_note"], want["savings_rate"]) == (
        "no_room", "Nothing is left after your savings goals", 0.0)
    crit = get(sw_client, tight, f"/wishlist/{item(sw_client, tight, 'Fix', 10, 'critical')}/readiness")
    assert crit["projection_status"] == "dated"

    broke = sw_people("Broke", "Spender")
    bank = posted_flow.account(sw_db, broke["id"])
    posted_flow.flow(sw_db, broke["id"], bank, income=10_000, spending=12_000)
    crit = get(sw_client, broke, f"/wishlist/{item(sw_client, broke, 'Fix', 10, 'critical')}/readiness")
    assert (crit["projection_status"], crit["projection_note"], crit["savings_rate"]) == (
        "no_room", "Your net flow does not cover this", 0.0)


def test_ac2_no_projection_note(sw_client, standard):
    me = standard["me"]
    body = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Euro', 10, currency='EUR')}/readiness")
    assert (body["projection_status"], body["projection_note"]) == (
        "no_projection", "No projected income or expenses in EUR, so this can't be judged yet.")
    assert body["note"] == body["projection_note"]


def test_ac2_precedence_paid_from_savings_first(sw_client, sw_db, sw_people):
    # A new user (not_estimated) with an item paid from their own savings account.
    me = sw_people("New", "Saver")
    savings = posted_flow.account(sw_db, me["id"], "savings", balance=1_000)
    paid = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Bike', 500, account_id=savings)}/readiness")
    assert (paid["projection_status"], paid["projection_note"]) == (
        "paid_from_savings", "Paid from a savings account, so it is not estimated")
    other = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Hat', 5)}/readiness")
    assert (other["projection_status"], other["projection_note"]) == (
        "not_estimated", "Needs one full month of history")


def test_ac2_precedence_incomplete_before_no_projection(sw_client, sw_db, sw_people):
    me = sw_people("Cross", "Currency")
    php = posted_flow.account(sw_db, me["id"], "checking", "PHP")
    usd = posted_flow.account(sw_db, me["id"], "checking", "USD")
    savings = posted_flow.account(sw_db, me["id"], "savings")
    posted_flow.flow(sw_db, me["id"], php, income=30_000, spending=10_000)
    posted_flow.transfer(sw_db, me["id"], php, usd, 100)   # between own currencies
    for name, currency, fields in (("Peso", "PHP", {}), ("Euro", "EUR", {}),
                                   ("Saved", "PHP", {"account_id": savings})):
        body = get(sw_client, me, f"/wishlist/{item(sw_client, me, name, 10, currency=currency, **fields)}/readiness")
        want = "paid_from_savings" if fields else "incomplete"
        assert body["projection_status"] == want, name
    euro = get(sw_client, me, "/wishlist/plan")["items"]
    assert {i["name"]: i["projection_note"] for i in euro}["Euro"] == (
        "Money in more than one currency is involved, so this cannot be estimated yet")


# --- AC3: one rate and status on all four surfaces ------------------------------------------

def test_ac3_a_full_payment_item_matches_on_all_four_surfaces(sw_client, sw_db, standard):
    me = standard["me"]
    cases = {
        "dated": item(sw_client, me, "Dated", 30_000, "high"),
        "beyond_horizon": item(sw_client, me, "Far", 61 * FREE, "low"),
        "no_projection": item(sw_client, me, "Euro", 10, currency="EUR"),
    }
    for status, item_id in cases.items():
        planned, readiness, outlook, next_up = surfaces(sw_client, me, item_id)
        assert {planned["projection_status"], readiness["projection_status"],
                outlook["projection_status"], next_up["projection_status"]} == {status}, status
        assert planned["basis"] == readiness["basis"] == outlook["disposable_check"]["basis"]
        rate = readiness["savings_rate"] if status != "no_projection" else None
        assert outlook["disposable_check"]["available"] == rate
    # The dated item is alone in the wants queue: the same date everywhere.
    planned, readiness, outlook, next_up = surfaces(sw_client, me, cases["dated"])
    assert (planned["estimated_purchase_date"], readiness["estimated_date"],
            next_up["affordable_by"]) == (due(2),) * 3
    assert readiness["savings_rate"] == FREE


# --- AC4: only a dated item has a date; no rate floor ---------------------------------------

def test_ac4_only_a_dated_item_has_a_date(sw_client, sw_db, sw_people):
    me = sw_people("Tight", "Saver")
    bank = posted_flow.account(sw_db, me["id"])
    savings = posted_flow.account(sw_db, me["id"], "savings")
    posted_flow.flow(sw_db, me["id"], bank, income=30_000, spending=10_000, saved=20_000,
                     savings_id=savings)
    item(sw_client, me, "Lamp", 10)   # a want with free_flow 0: no room
    item(sw_client, me, "Euro", 10, currency="EUR")
    item(sw_client, me, "Fix", 10, "critical")   # dated
    body, items = plan(sw_client, me)
    for i in body["items"]:
        assert (i["estimated_purchase_date"] is not None) == (i["projection_status"] == "dated")
    # No 0.01 floor: a zero rate is no rate and no million-month date.
    lamp = items["Lamp"]
    assert (lamp["projection_status"], lamp["estimated_purchase_date"]) == ("no_room", None)
    assert body["savings_rate"] == 0.0
    for item_id in (i["item_id"] for i in body["items"]):
        assert (get(sw_client, me, f"/wishlist/{item_id}/readiness")["months_needed"]
                in (1, 9999))
    for i in get(sw_client, me, "/dashboard/snapshot")["wishlist_next_up"]:
        assert (i["affordable_by"] is not None) == (i["projection_status"] == "dated")


# --- AC5: paid from savings ------------------------------------------------------------------

def test_ac5_paid_from_own_savings_on_all_four_surfaces(sw_client, standard):
    me = standard["me"]
    paid = item(sw_client, me, "Car", 50_000, "critical", account_id=standard["savings"])
    want = item(sw_client, me, "Lamp", 15_000, "high")
    planned, readiness, outlook, next_up = surfaces(sw_client, me, paid)
    note = "Paid from a savings account, so it is not estimated"
    assert (planned["projection_status"], planned["estimated_purchase_date"],
            planned["cumulative_months"], planned["note"]) == ("paid_from_savings", None, 0, note)
    # AC8 still holds ("each critical item whose row is ``ok``, dated or not"), by hand:
    # 20,000 - 50,000; 50,000 - ceil(50,000 / 20,000) * 15,000.
    assert (planned["net_flow_after"], planned["from_saving"]) == (-30_000.0, 5_000.0)
    assert (readiness["estimated_date"], readiness["affordable_now"], readiness["savings_rate"],
            readiness["months_needed"]) == (None, False, 0.0, 9999)
    check = outlook["disposable_check"]
    assert (check["status"], check["available"], check["reason"]) == ("unknown", None, note)
    assert (next_up["affordable_by"], next_up["note"]) == (None, note)
    # It adds nothing to the queue and holds no want up: the want is one month away.
    _, items = plan(sw_client, me)
    assert (items["Lamp"]["cumulative_months"], items["Lamp"]["estimated_purchase_date"]) == (
        1, due(1))
    assert items["Lamp"]["item_id"] == want


def test_ac5_a_savings_account_the_caller_does_not_own_is_not_read(
        sw_client, sw_db, sw_people, standard):
    me = standard["me"]
    partner = sw_people("Partner", "Saver")
    theirs = posted_flow.account(sw_db, partner["id"], "savings", balance=99_999)
    sw_share(sw_db, theirs, me["id"], "editor", partner["id"])
    shared = item(sw_client, me, "Couch", 15_000, "high", account_id=theirs)
    planned, readiness, outlook, next_up = surfaces(sw_client, me, shared)
    # Treated like any other item: dated from the caller's own free flow.
    assert {planned["projection_status"], readiness["projection_status"],
            outlook["projection_status"], next_up["projection_status"]} == {"dated"}
    assert planned["estimated_purchase_date"] == due(1)
    # Nothing about the partner's account reaches the response.
    assert "99999" not in str((planned, readiness, outlook, next_up))


# --- AC6 and AC7: the plan queue --------------------------------------------------------------

def test_ac6_ac8_queue_critical_block_added_once_and_hand_worked_figures(sw_client, standard):
    me = standard["me"]
    # Wants first by creation, to show the queue orders by priority, not by creation.
    item(sw_client, me, "Medium want", 15_000, "medium")
    item(sw_client, me, "High want", 30_000, "high")
    item(sw_client, me, "First need", 50_000, "critical")
    item(sw_client, me, "Second need", 10_000, "critical")
    body, items = plan(sw_client, me)
    assert [i["name"] for i in body["items"]] == [
        "First need", "Second need", "High want", "Medium want"]
    # Critical: ceil(50,000 / 20,000) = 3, then ceil(60,000 / 20,000) = 3.
    # Block 3; wants: 3 + ceil(30,000 / 15,000) = 5, then 3 + ceil(45,000 / 15,000) = 6.
    assert [(i["name"], i["cumulative_months"], i["estimated_purchase_date"])
            for i in body["items"]] == [
        ("First need", 3, due(3)), ("Second need", 3, due(3)),
        ("High want", 5, due(5)), ("Medium want", 6, due(6))]
    assert all(i["queue_note"] is None and i["note"] is None for i in body["items"])
    # AC8, by hand. First need: 20,000 - 50,000; 50,000 - ceil(50,000 / 20,000) * 15,000.
    # Second need, on its own: 20,000 - 10,000; 10,000 - 1 * 15,000 is below 0.
    assert (items["First need"]["net_flow_after"], items["First need"]["from_saving"]) == (
        -30_000.0, 5_000.0)
    assert (items["Second need"]["net_flow_after"], items["Second need"]["from_saving"]) == (
        10_000.0, 0.0)
    for want in ("High want", "Medium want"):
        assert (items[want]["net_flow_after"], items[want]["from_saving"]) == (None, None)
    assert body["savings_rate"] == FREE
    (php,) = [r for r in body["net_flow"] if r["currency"] == "PHP"]
    assert (php["status"], php["net_flow"], php["free_flow"]) == ("ok", NET, FREE)


def test_ac6_a_null_created_at_queues_last_and_never_raises(sw_client, sw_db, standard):
    from app.models.wishlist_item import WishlistItem

    me = standard["me"]
    # ``wishlist_items.created_at`` allows null (it has only a server default).
    undated_need = item(sw_client, me, "Old need", 20_000, "critical")
    item(sw_client, me, "New need", 20_000, "critical")
    undated_want = item(sw_client, me, "Old want", 15_000, "high")
    item(sw_client, me, "New want", 15_000, "high")
    for item_id in (undated_need, undated_want):
        sw_db.get(WishlistItem, item_id).created_at = None
    sw_db.commit()
    _, items = plan(sw_client, me)
    # Nulls queue last in their group: critical 1 then 2; block 2; wants 2 + 1, then 2 + 2.
    assert [(name, items[name]["cumulative_months"])
            for name in ("New need", "Old need", "New want", "Old want")] == [
        ("New need", 1), ("Old need", 2), ("New want", 3), ("Old want", 4)]


def test_ac6_critical_block_is_zero_in_a_currency_with_no_critical_item(
        sw_client, sw_db, standard):
    me = standard["me"]
    usd = posted_flow.account(sw_db, me["id"], "checking", "USD")
    posted_flow.post(sw_db, me["id"], usd, "credit", 1_000)   # USD free flow 1,000
    item(sw_client, me, "Peso need", 50_000, "critical")
    item(sw_client, me, "Dollar want", 900, "high", "USD")
    _, items = plan(sw_client, me)
    # The PHP critical block (3) is not added to a USD want.
    assert (items["Dollar want"]["cumulative_months"],
            items["Dollar want"]["estimated_purchase_date"]) == (1, due(1))


def test_ac6_ac7_ac8_an_undated_critical_item_holds_every_want(sw_client, sw_db, standard):
    me = standard["me"]
    item(sw_client, me, "Huge need", 2_000_000, "critical")   # 100 months: past the horizon
    item(sw_client, me, "Lamp", 15_000, "high")
    usd = posted_flow.account(sw_db, me["id"], "checking", "USD")
    posted_flow.post(sw_db, me["id"], usd, "credit", 1_000)
    item(sw_client, me, "Dollar want", 900, "high", "USD")
    _, items = plan(sw_client, me)
    huge, lamp = items["Huge need"], items["Lamp"]
    # AC7: a queued item past the horizon keeps its count and has no date.
    assert (huge["projection_status"], huge["cumulative_months"],
            huge["estimated_purchase_date"]) == ("beyond_horizon", 100, None)
    # AC6: the want is dated on its own, but waits behind the undated need.
    assert (lamp["projection_status"], lamp["cumulative_months"],
            lamp["estimated_purchase_date"]) == ("dated", 101, None)
    assert lamp["queue_note"] == "Waits behind an urgent need that has no date yet"
    assert lamp["note"] == lamp["queue_note"]
    # Another currency is not held.
    assert items["Dollar want"]["estimated_purchase_date"] == due(1)
    # AC8: an undated critical item still returns its figures, by hand:
    # 20,000 - 2,000,000; 2,000,000 - 100 * 15,000.
    assert (huge["net_flow_after"], huge["from_saving"]) == (-1_980_000.0, 500_000.0)


def test_ac6_wants_past_the_horizon_behind_earlier_items(sw_client, standard):
    me = standard["me"]
    item(sw_client, me, "Big want", 59 * FREE, "high")
    item(sw_client, me, "Small want", 2 * FREE, "low")
    _, items = plan(sw_client, me)
    assert items["Big want"]["estimated_purchase_date"] == due(59)
    small = items["Small want"]
    assert (small["projection_status"], small["cumulative_months"],
            small["estimated_purchase_date"], small["queue_note"]) == (
        "dated", 61, None, "More than 5 years away behind earlier items")


def test_ac6_ac7_with_free_flow_zero_every_want_is_undated(sw_client, sw_db, sw_people):
    me = sw_people("Tight", "Saver")
    bank = posted_flow.account(sw_db, me["id"])
    savings = posted_flow.account(sw_db, me["id"], "savings")
    posted_flow.flow(sw_db, me["id"], bank, income=30_000, spending=10_000, saved=20_000,
                     savings_id=savings)
    item(sw_client, me, "Fix", 20_000, "critical")
    item(sw_client, me, "Lamp", 10, "high")
    item(sw_client, me, "Mug", 10, "low")
    body, items = plan(sw_client, me)
    assert items["Fix"]["estimated_purchase_date"] == due(1)
    for want in ("Lamp", "Mug"):
        w = items[want]
        assert (w["projection_status"], w["estimated_purchase_date"], w["queue_note"]) == (
            "no_room", None, None)
        # A queued item with no rate has no count (open question: see the report).
        assert w["cumulative_months"] == 0
    # The critical item, by hand: 20,000 - 20,000 after it, and with free flow 0 all
    # of it comes out of saving: 20,000 - ceil(20,000 / 20,000) * 0.
    assert (items["Fix"]["net_flow_after"], items["Fix"]["from_saving"]) == (0.0, 20_000.0)


def test_ac7_cumulative_months_is_zero_outside_the_queue(sw_client, standard):
    me = standard["me"]
    item(sw_client, me, "Euro", 10, currency="EUR")
    item(sw_client, me, "Car", 50_000, account_id=standard["savings"])
    item(sw_client, me, "Lamp", 15_000)
    _, items = plan(sw_client, me)
    assert items["Euro"]["cumulative_months"] == 0
    assert items["Car"]["cumulative_months"] == 0
    assert items["Lamp"]["cumulative_months"] == 1


# --- AC9: cross-currency and new callers ----------------------------------------------------

def test_ac9_a_cross_currency_callers_items_are_all_incomplete(sw_client, sw_db, sw_people):
    me = sw_people("Cross", "Currency")
    php = posted_flow.account(sw_db, me["id"], "checking", "PHP")
    usd = posted_flow.account(sw_db, me["id"], "checking", "USD")
    posted_flow.flow(sw_db, me["id"], php, income=30_000, spending=10_000)
    posted_flow.post(sw_db, me["id"], usd, "credit", 1_000)
    posted_flow.transfer(sw_db, me["id"], usd, php, 10)
    for name, prio, currency in (("A", "critical", "PHP"), ("B", "low", "USD"),
                                 ("C", "high", "EUR")):
        item(sw_client, me, name, 10, prio, currency)
    body, _ = plan(sw_client, me)
    assert {i["projection_status"] for i in body["items"]} == {"incomplete"}
    assert all(i["estimated_purchase_date"] is None and i["cumulative_months"] == 0
               for i in body["items"])
    assert body["savings_rate"] == 0.0
    assert {i["projection_status"]
            for i in get(sw_client, me, "/dashboard/snapshot")["wishlist_next_up"]} == {
        "incomplete"}


def test_ac9_a_new_users_items_are_all_not_estimated(sw_client, sw_db, sw_people):
    me = sw_people("Brand", "New")
    posted_flow.account(sw_db, me["id"], "checking", balance=10_000)
    for name, prio, currency in (("A", "critical", "PHP"), ("B", "low", "USD"),
                                 ("C", "high", "EUR")):
        item(sw_client, me, name, 10, prio, currency)
    body, _ = plan(sw_client, me)
    assert {i["projection_status"] for i in body["items"]} == {"not_estimated"}
    assert {i["note"] for i in body["items"]} == {"Needs one full month of history"}
    assert {i["projection_status"]
            for i in get(sw_client, me, "/dashboard/snapshot")["wishlist_next_up"]} == {
        "not_estimated"}


# --- AC10: the outlook ----------------------------------------------------------------------

def test_ac10_outlook_disposable_check_against_the_rate(sw_client, standard):
    me = standard["me"]
    fits = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Lamp', 15_000)}/outlook")
    assert fits["disposable_check"] == {
        "status": "fits", "currency": "PHP", "amount": 15_000.0, "monthly_disposable": None,
        "after_purchase": 0.0, "reason": None, "basis": "free_flow", "available": 15_000.0}
    over = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Sofa', 15_000.01)}/outlook")
    assert (over["disposable_check"]["status"], over["disposable_check"]["after_purchase"]) == (
        "over", -0.01)
    crit = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Fix', 20_000, 'critical')}/outlook")
    assert (crit["disposable_check"]["status"], crit["disposable_check"]["basis"],
            crit["disposable_check"]["available"]) == ("fits", "net_flow", 20_000.0)
    euro = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Euro', 1, currency='EUR')}/outlook")
    assert (euro["disposable_check"]["status"], euro["disposable_check"]["available"]) == (
        "unknown", None)
    assert "EUR" in euro["disposable_check"]["reason"]


def test_ac10_status_keeps_its_three_values(sw_client, standard):
    me = standard["me"]
    seen = set()
    for cost, currency in ((1, "PHP"), (10**6, "PHP"), (1, "EUR")):
        seen.add(get(sw_client, me, f"/wishlist/{item(sw_client, me, 'X', cost, currency=currency)}/outlook")[
            "disposable_check"]["status"])
    assert seen == {"fits", "over", "unknown"}


def card_of(client, standard):
    return sw_post(client, standard["me"], "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 15,
        "days_until_due_date": 10, "payment_account_id": standard["bank"],
        "credit_limit": 100_000})["id"]


def test_ac10_a_linked_installment_is_compared_at_its_monthly_amount(sw_client, standard):
    me = standard["me"]
    inst = item(sw_client, me, "Phone", 30_000, "high", payment_plan="installment",
                installment_months=3, account_id=card_of(sw_client, standard))
    r = sw_client.put(f"{API}/wishlist/{inst}", json={"is_purchased": True},
                      headers=me["headers"])
    assert r.status_code == 200 and r.json()["installment_entry_id"] is not None, r.text
    body = get(sw_client, me, f"/wishlist/{inst}/outlook")
    # No "already counts in your plan" shortcut: 10,000 a month against 15,000.
    assert body["disposable_check"] == {
        "status": "fits", "currency": "PHP", "amount": 10_000.0, "monthly_disposable": None,
        "after_purchase": 5_000.0, "reason": None, "basis": "free_flow",
        "available": 15_000.0}
    # The credit check is unchanged: the linked entry is already held on the card.
    assert body["credit_check"]["amount"] == 0.0
    assert body["credit_check"]["reason"] == "This item's installment already counts in your plan"


# --- AC11: readiness ------------------------------------------------------------------------

def test_ac11_readiness_estimated_date_and_legacy_fields(sw_client, standard):
    me = standard["me"]
    dated = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Lamp', 30_000)}/readiness")
    assert (dated["estimated_date"], dated["months_needed"], dated["estimated_purchase_date"],
            dated["affordable_now"]) == (due(2), 2, due(2), False)
    now = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Mug', 15_000)}/readiness")
    assert (now["estimated_date"], now["affordable_now"]) == (due(1), True)
    far = get(sw_client, me, f"/wishlist/{item(sw_client, me, 'Far', 10**7)}/readiness")
    # Not dated: no estimated_date; the legacy fields keep their zero-rate values.
    assert (far["estimated_date"], far["months_needed"], far["estimated_purchase_date"]) == (
        None, 9999, due(9999))
    assert isinstance(far["months_needed"], int) and isinstance(far["estimated_purchase_date"], str)


def test_ac11_legacy_readiness_fields_are_deprecated_in_the_schema():
    from app.schemas.wishlist import WishlistReadiness

    props = WishlistReadiness.model_json_schema()["properties"]
    assert props["months_needed"].get("deprecated") is True
    assert props["estimated_purchase_date"].get("deprecated") is True
    assert props["months_needed"]["type"] == "integer"
    assert props["estimated_purchase_date"]["type"] == "string"
    assert "deprecated" not in props["estimated_date"]
    # And as the API publishes it.
    from app.main import app

    props = app.openapi()["components"]["schemas"]["WishlistReadiness"]["properties"]
    assert props["months_needed"].get("deprecated") is True
    assert props["estimated_purchase_date"].get("deprecated") is True
    assert props["months_needed"]["type"] == "integer"
    assert props["estimated_purchase_date"]["type"] == "string"
    assert "deprecated" not in props["estimated_date"]


# --- AC12: the dashboard --------------------------------------------------------------------

def test_ac12_dashboard_top_three_and_notes(sw_client, standard):
    me = standard["me"]
    item(sw_client, me, "Need", 50_000, "critical")
    item(sw_client, me, "Euro", 10, "high", "EUR")
    item(sw_client, me, "Far", 10**7, "medium")
    item(sw_client, me, "Fourth", 10, "low")
    next_up = get(sw_client, me, "/dashboard/snapshot")["wishlist_next_up"]
    assert [i["name"] for i in next_up] == ["Need", "Euro", "Far"]
    # Each on its own: no queue (the need is ceil(50,000 / 20,000) = 3 months).
    assert [(i["projection_status"], i["affordable_by"]) for i in next_up] == [
        ("dated", due(3)), ("no_projection", None), ("beyond_horizon", None)]
    assert [i["note"] for i in next_up] == [
        None, "No projected income or expenses in EUR, so this can't be judged yet.",
        "More than 5 years away"]
    assert all(i["note"] == i["projection_note"] for i in next_up)


def test_ac12_a_tag_filter_does_not_change_affordable_by(sw_client, standard):
    me = standard["me"]
    item(sw_client, me, "Need", 50_000, "critical")
    item(sw_client, me, "Lamp", 15_000, "high")
    plain = get(sw_client, me, "/dashboard/snapshot")["wishlist_next_up"]
    # An id that is not a usable tag filters every projected list to nothing.
    tagged = get(sw_client, me, "/dashboard/snapshot?tag=999999999")["wishlist_next_up"]
    assert tagged == plain
    assert [i["affordable_by"] for i in plain] == [due(3), due(1)]


# --- AC13: installment items keep today's handling -----------------------------------------

def test_ac13_installment_items_keep_todays_handling(sw_client, sw_db, standard):
    me = standard["me"]
    card = card_of(sw_client, standard)
    inst = item(sw_client, me, "Phone", 30_000, "high", payment_plan="installment",
                installment_months=3, account_id=card)
    item(sw_client, me, "Lamp", 15_000, "medium")
    body, items = plan(sw_client, me)
    # Plan: listed apart, not queued, holds nothing up.
    assert [i["item_id"] for i in body["installments"]] == [inst]
    assert "Phone" not in items
    assert items["Lamp"]["cumulative_months"] == 1
    # Readiness and dashboard: the full cost at its rate, ceil(30,000 / 15,000) = 2.
    readiness = get(sw_client, me, f"/wishlist/{inst}/readiness")
    assert (readiness["months_needed"], readiness["estimated_date"]) == (2, due(2))
    (dash,) = [i for i in get(sw_client, me, "/dashboard/snapshot")["wishlist_next_up"]
               if i["id"] == inst]
    assert dash["affordable_by"] == due(2)
    # Outlook: its monthly installment against the rate.
    check = get(sw_client, me, f"/wishlist/{inst}/outlook")["disposable_check"]
    assert (check["status"], check["amount"], check["available"]) == ("fits", 10_000.0, 15_000.0)

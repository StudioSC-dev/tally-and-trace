"""Available credit per card (STU-343 Plan C, section 2.2 and 4.1 commit 4).

``available_now = limit - (balance_owed + pending_total + installment_hold +
missed_total)``, then a walk over the 30 days from Manila midnight with a
check per charge. Foreign figures use the live stored rate plus 3%. Owner and
admin only: everyone else gets no credit key and a 404. Skips without a
database.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila); the window is
Mar 18 to Apr 17 inclusive. Rates: USD 1, PHP 63.00, fresh.
"""
import json
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.tests.conftest import (
    API, FX_REF, PRIVATE, FxNoNetwork, fx_clock, hh_household, hh_tag_share,
    sw_db_reachable, sw_leaks, sw_post, sw_share,
)
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2027, 3, 18, 2, 0)

CREDIT_KEYS = {"account_id", "currency", "limit", "as_of", "available_now",
               "available_with_planned", "planned_by", "complete", "uncounted_shared",
               "unknown_count", "opening", "missed", "planned_payments", "checks", "fx",
               "fx_buffer_pct"}
CHECK_KEYS = {"source", "source_id", "date", "occurrence_date", "kind", "amount",
              "available_after", "available_after_without_planned", "status",
              "relies_on_planned"}
DETAIL_KEYS = {"account_id", "name", "currency", "credit", "rule", "statements", "open_cycle"}


def _rates(hours_old=1):
    from app.services.fx import FxRates, MemoryRateStore, StoredRate

    fetched = FX_REF - timedelta(hours=hours_old)
    store = MemoryRateStore([
        StoredRate("USD", Decimal("1"), fetched.date(), fetched, "test"),
        StoredRate("PHP", Decimal("63.00"), fetched.date(), fetched, "test"),
    ])
    return lambda: FxRates(store, provider=FxNoNetwork(), clock=fx_clock, on_stale=lambda: None)


@pytest.fixture(autouse=True)
def fx63(monkeypatch):
    from app.main import app
    from app.services.fx import get_fx

    monkeypatch.setitem(app.dependency_overrides, get_fx, _rates())


# --- helpers ----------------------------------------------------------------------------------

def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, name="Card C", limit=128_000, payer=None, **extra):
    body = {"billing_cycle_start": 24, "days_until_due_date": 21, **extra}
    if limit is not None:
        body["credit_limit"] = limit
    if payer is not None:
        body["payment_account_id"] = payer
    return _account(client, who, name, "credit", 0, **body)


def _entry(client, who, account_id, next_day, amount, name, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})


def _debit(client, who, account_id, day, amount, description, posted=False, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": posted, **extra})["id"]


def _transfer(client, who, src, dst, day, amount, fee=0, description="Transfer"):
    return sw_post(client, who, "/transactions/", {
        "account_id": src, "transaction_type": "transfer", "transfer_from_account_id": src,
        "transfer_to_account_id": dst, "amount": amount, "transfer_fee": fee,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": False})["id"]


def _foreign_debit(client, who, card, day, amount, currency, description):
    return _debit(client, who, card, day, amount, description, currency="PHP",
                  projected_amount=amount, projected_currency=currency)


def _set_row(db, txn_id, **values):
    from app.models.transaction import Transaction

    db.query(Transaction).filter(Transaction.id == txn_id).update(values)
    db.commit()


def _detail(client, who, card, expect=200):
    r = client.get(f"{API}/cards/{card}/credit", headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _credit(client, who, card):
    body = _detail(client, who, card)
    assert set(body) == DETAIL_KEYS
    credit = body["credit"]
    assert set(credit) == CREDIT_KEYS
    for check in credit["checks"]:
        assert set(check) == CHECK_KEYS
    return credit


def _listed(client, who):
    r = client.get(f"{API}/cards/credit", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _snapshot(client, who):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _section(body, card):
    return next((c for c in body["card_charges"] if c["account_id"] == card), None)


def _checks(credit, source=None, source_id=None):
    return [c for c in credit["checks"]
            if (source is None or c["source"] == source)
            and (source_id is None or c["source_id"] == source_id)]


def _world(client, people, monkeypatch, music_next="2027-04-10"):
    """Checking ₱50,000, Savings ₱100,000 and Card C (limit ₱128,000) with its
    three recurring entries; the clock pinned at the reference."""
    pin_clock(monkeypatch, REF)
    me = people()
    checking = _account(client, me, "Checking", balance=50_000)
    savings = _account(client, me, "Savings", "savings", balance=100_000)
    card = _card(client, me, payer=checking)
    utilities = sw_post(client, me, "/categories/", {"name": "Utilities"})["id"]
    cloud = _entry(client, me, card, "2027-03-20", 20, "Cloud Tools", currency="USD")
    music = _entry(client, me, card, music_next, 549, "Music Plus")
    phone = _entry(client, me, card, "2027-04-12", 1_799, "Phone Plan", category_id=utilities)
    assert (cloud["kind"], music["kind"], phone["kind"]) == ("subscription", "subscription",
                                                            "bill")
    return {"client": client, "me": me, "checking": checking, "savings": savings,
            "card": card, "utilities": utilities, "cloud": cloud["id"], "music": music["id"],
            "phone": phone["id"]}


def _walk_rows(w, db):
    """The walk test's rows: posted ₱24,000, three pending rows (one USD 10 at a
    stored 58) and the 20-month Fridge."""
    client, me, card = w["client"], w["me"], w["card"]
    _debit(client, me, card, "2027-03-01", 24_000, "Rent on card", posted=True)
    w["hardware"] = _debit(client, me, card, "2027-03-15", 1_000, "Hardware store")
    w["p500"] = _debit(client, me, card, "2027-03-18", 500, "Pharmacy")
    w["online"] = _foreign_debit(client, me, card, "2027-03-22", 10, "USD", "Online shop")
    _set_row(db, w["online"], exchange_rate=Decimal("58"))
    fridge = _entry(client, me, card, "2027-04-05", 5_000, "Fridge",
                    end_mode="after_occurrences", max_occurrences=20)
    assert fridge["kind"] == "installment"
    w["fridge"] = fridge["id"]
    return w


@pytest.fixture
def world(sw_client, sw_people, monkeypatch):
    return _world(sw_client, sw_people, monkeypatch)


@pytest.fixture
def walk(world, sw_db):
    return _walk_rows(world, sw_db)


def _row(check):
    return (check["date"], check["kind"], check["amount"], check["available_after"],
            check["available_after_without_planned"], check["status"],
            check["relies_on_planned"])


# --- the walk ---------------------------------------------------------------------------------

def test_available_credit_walk(walk, sw_db):
    from app.models.transaction import Transaction

    w = walk
    client, me, card = w["client"], w["me"], w["card"]
    assert sw_db.get(Transaction, w["online"]).exchange_rate == Decimal("58")
    _transfer(client, me, w["checking"], card, "2027-04-01", 10_000, description="Pay card")

    credit = _credit(client, me, card)
    assert (credit["account_id"], credit["currency"], credit["limit"], credit["as_of"]) == (
        card, "PHP", 128_000.0, "2027-03-18")
    assert credit["opening"] == {"balance_owed": 24_000.0, "pending_total": 2_148.9,
                                 "installment_hold": 100_000.0, "missed_total": 0.0}
    assert credit["available_now"] == 1_851.1
    assert (credit["available_with_planned"], credit["planned_by"]) == (11_851.1, "2027-04-01")
    assert (credit["complete"], credit["uncounted_shared"], credit["unknown_count"],
            credit["missed"]) == (True, 0, 0, [])
    assert credit["planned_payments"] == [
        {"date": "2027-04-01", "amount": 10_000.0, "counted": True, "reason": None}]
    assert [(c["source"], c["source_id"]) for c in credit["checks"]] == [
        ("transaction", w["p500"]), ("budget_entry", w["cloud"]), ("transaction", w["online"]),
        ("budget_entry", w["fridge"]), ("budget_entry", w["music"]),
        ("budget_entry", w["phone"])]
    assert [_row(c) for c in credit["checks"]] == [
        ("2027-03-18", "pending", 500.0, 1_851.1, 1_851.1, "ok", None),
        ("2027-03-20", "subscription", 1_297.8, 553.3, 553.3, "ok", None),
        ("2027-03-22", "pending", 648.9, 553.3, 553.3, "ok", None),
        ("2027-04-05", "installment", 5_000.0, 10_553.3, 553.3, "installment", None),
        ("2027-04-10", "subscription", 549.0, 10_004.3, 4.3, "ok", None),
        ("2027-04-12", "bill", 1_799.0, 8_205.3, -1_794.7, "ok_with_planned", "2027-04-01"),
    ]
    assert [c["occurrence_date"] for c in credit["checks"]] == [
        None, "2027-03-20", None, "2027-04-05", "2027-04-10", "2027-04-12"]
    assert credit["fx"] == [{"base": "USD", "quote": "PHP", "rate": 63.0,
                             "buffered_rate": 64.89, "as_of": credit["fx"][0]["as_of"],
                             "stale": False}]
    assert credit["fx_buffer_pct"] == 3

    # The same object on the snapshot and in the list.
    section = _section(_snapshot(client, me), card)
    assert section["credit"] == credit
    assert [c["account_id"] for c in _listed(client, me)["items"]] == [card]
    assert _listed(client, me)["items"][0] == credit


def test_pending_row_after_the_window_is_reserved(walk):
    w = walk
    late = _debit(w["client"], w["me"], w["card"], "2027-04-25", 700, "Late order")
    credit = _credit(w["client"], w["me"], w["card"])
    assert credit["available_now"] == 1_151.1
    assert credit["opening"]["pending_total"] == 2_848.9
    assert _checks(credit, "transaction", late) == []


def test_expired_planned_payment_does_not_count(walk):
    w = walk
    _transfer(w["client"], w["me"], w["checking"], w["card"], "2027-03-10", 10_000)
    credit = _credit(w["client"], w["me"], w["card"])
    assert credit["planned_payments"] == [
        {"date": "2027-03-10", "amount": 10_000.0, "counted": False, "reason": "before_today"}]
    assert (credit["available_now"], credit["available_with_planned"],
            credit["planned_by"]) == (1_851.1, 1_851.1, None)
    (phone,) = _checks(credit, "budget_entry", w["phone"])
    assert (phone["status"], phone["available_after"],
            phone["available_after_without_planned"]) == ("at_risk", -1_794.7, -1_794.7)


def test_payment_after_the_window_is_listed_not_counted(walk):
    w = walk
    _transfer(w["client"], w["me"], w["checking"], w["card"], "2027-04-20", 10_000)
    credit = _credit(w["client"], w["me"], w["card"])
    assert credit["planned_payments"] == [
        {"date": "2027-04-20", "amount": 10_000.0, "counted": False, "reason": "after_window"}]
    assert (credit["available_now"], credit["available_with_planned"],
            credit["planned_by"]) == (1_851.1, 1_851.1, None)
    (phone,) = _checks(credit, "budget_entry", w["phone"])
    assert (phone["status"], phone["available_after"]) == ("at_risk", -1_794.7)


# --- missed months ----------------------------------------------------------------------------

def test_missed_subscription_reduces_available_now(sw_client, sw_people, sw_db, monkeypatch):
    w = _world(sw_client, sw_people, monkeypatch)
    assert _credit(sw_client, w["me"], w["card"])["available_now"] == 128_000.0

    w = _world(sw_client, sw_people, monkeypatch, music_next="2027-02-10")
    credit = _credit(sw_client, w["me"], w["card"])
    assert credit["missed"] == [{"entry_id": w["music"], "name": "Music Plus",
                                 "kind": "subscription", "count": 2, "total": 1_098.0}]
    assert credit["opening"]["missed_total"] == 1_098.0
    assert credit["available_now"] == 128_000.0 - 1_098.0

    # A pending row for the Mar 10 occurrence, whatever its date: 549 missed, 549 pending.
    for day, has_check in (("2027-03-12", False), ("2027-04-20", False),
                           ("2027-03-25", True)):
        w = _world(sw_client, sw_people, monkeypatch, music_next="2027-02-10")
        row = _debit(sw_client, w["me"], w["card"], day, 549, "Music Plus",
                     budget_entry_id=w["music"])
        _set_row(sw_db, row, occurrence_date=datetime(2027, 3, 10))
        credit = _credit(sw_client, w["me"], w["card"])
        assert [(m["count"], m["total"]) for m in credit["missed"]] == [(1, 549.0)], day
        assert credit["opening"]["pending_total"] == 549.0, day
        assert credit["available_now"] == 128_000.0 - 1_098.0, day
        checks = _checks(credit, "transaction", row)
        assert bool(checks) is has_check, day
        if has_check:
            index = credit["checks"].index(checks[0])
            before = credit["checks"][index - 1]
            assert checks[0]["available_after"] == before["available_after"]
            assert checks[0]["amount"] == 549.0


def test_missed_capped_bill_is_counted(world):
    w = world
    water = _entry(w["client"], w["me"], w["card"], "2027-02-12", 1_500, "Water",
                   end_mode="after_occurrences", max_occurrences=5, billing_kind="bill")
    assert water["kind"] == "bill"
    credit = _credit(w["client"], w["me"], w["card"])
    assert [(m["entry_id"], m["kind"], m["count"], m["total"]) for m in credit["missed"]] == [
        (water["id"], "bill", 2, 3_000.0)]
    assert credit["available_now"] == 128_000.0 - 3_000.0
    assert [(c["date"], c["amount"]) for c in _checks(credit, "budget_entry", water["id"])] == [
        ("2027-04-12", 1_500.0)]


def test_clamped_semi_monthly_counts_each_day_once(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    semi = {"cadence": "semi_monthly", "semi_monthly_day_1": 30, "semi_monthly_day_2": 31,
            "end_mode": "after_occurrences", "max_occurrences": 4}
    gym = _entry(client, me, card, "2027-01-30", 100, "Gym", billing_kind="bill", **semi)
    assert gym["kind"] == "bill"
    credit = _credit(client, me, card)
    (missed,) = credit["missed"]
    assert (missed["entry_id"], missed["count"], missed["total"]) == (gym["id"], 3, 300.0)
    assert [c["date"] for c in _checks(credit, "budget_entry", gym["id"])] == ["2027-03-30"]
    before = credit["available_now"]

    r = client.post(f"{API}/budget-entries/{gym['id']}/materialize",
                    json={"occurrence_date": "2027-01-30T00:00:00"}, headers=me["headers"])
    assert r.status_code == 201, r.text
    credit = _credit(client, me, card)
    assert credit["opening"]["balance_owed"] == 100.0
    assert credit["available_now"] == before

    # A capped installment on the same days holds 4 occurrences, Feb 28 once.
    plan = _entry(client, me, card, "2027-01-30", 100, "Plan", **semi)
    assert plan["kind"] == "installment"
    credit = _credit(client, me, card)
    assert credit["opening"]["installment_hold"] == 400.0
    assert [(c["date"], c["status"]) for c in _checks(credit, "budget_entry", plan["id"])] == [
        ("2027-03-30", "installment")]
    before = credit["available_now"]

    # One linked row on the clamped Feb 28 hides that one occurrence, no more.
    _debit(client, me, card, "2027-02-28", 100, "Plan", budget_entry_id=plan["id"])
    credit = _credit(client, me, card)
    assert credit["opening"]["installment_hold"] == 300.0
    assert credit["opening"]["pending_total"] == 100.0
    assert credit["available_now"] == before


# --- installments -----------------------------------------------------------------------------

def _bike(client, people, monkeypatch, sw_db, row_day="2027-04-05"):
    pin_clock(monkeypatch, REF)
    me = people()
    card = _card(client, me, "Card B", limit=100_000)
    bike = _entry(client, me, card, "2027-04-05", 5_000, "Bike",
                  end_mode="after_occurrences", max_occurrences=2)
    assert bike["kind"] == "installment"
    row = _debit(client, me, card, row_day, 5_000, "Bike", budget_entry_id=bike["id"])
    _set_row(sw_db, row, occurrence_date=datetime(2027, 4, 5))
    return me, card, bike["id"], row


def test_posting_an_installment_month_leaves_available_credit_unchanged(
        sw_client, sw_people, sw_db, monkeypatch):
    client = sw_client
    me, card, bike, row = _bike(client, sw_people, monkeypatch, sw_db)
    credit = _credit(client, me, card)
    assert credit["opening"] == {"balance_owed": 0.0, "pending_total": 5_000.0,
                                 "installment_hold": 5_000.0, "missed_total": 0.0}
    assert credit["available_now"] == 90_000.0
    (check,) = _checks(credit, "transaction", row)
    assert (check["kind"], check["status"], check["date"]) == (
        "installment", "installment", "2027-04-05")
    assert _checks(credit, "budget_entry", bike) == []

    r = client.put(f"{API}/transactions/{row}", json={"is_posted": True}, headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _credit(client, me, card)["available_now"] == 90_000.0

    r = client.post(f"{API}/budget-entries/{bike}/materialize",
                    json={"occurrence_date": "2027-04-05T00:00:00"}, headers=me["headers"])
    assert r.status_code == 200, r.text
    assert r.headers["X-Occurrence-Outcome"] == "already_posted"
    r = client.get(f"{API}/budget-entries/{bike}", headers=me["headers"])
    assert r.json()["max_occurrences"] == 1
    assert _credit(client, me, card)["available_now"] == 90_000.0

    # The pending row dated before the window, linked to Apr 5: the same.
    me, card, bike, row = _bike(client, sw_people, monkeypatch, sw_db, row_day="2027-03-10")
    credit = _credit(client, me, card)
    assert credit["available_now"] == 90_000.0
    assert _checks(credit, "transaction", row) == []

    # Deactivating Bike: the pending row stays reserved and nothing is held.
    me, card, bike, row = _bike(client, sw_people, monkeypatch, sw_db)
    r = client.put(f"{API}/budget-entries/{bike}", json={"is_active": False},
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    credit = _credit(client, me, card)
    assert (credit["available_now"], credit["opening"]["pending_total"],
            credit["opening"]["installment_hold"]) == (95_000.0, 5_000.0, 0.0)


# --- advances, transfers, refunds -------------------------------------------------------------

def test_pending_advance_reserves_amount_plus_fee(sw_client, sw_people, monkeypatch):
    for day, has_check in (("2027-03-25", True), ("2027-03-10", False)):
        w = _world(sw_client, sw_people, monkeypatch)
        adv = _transfer(sw_client, w["me"], w["card"], w["checking"], day, 2_000, fee=100,
                        description="Cash advance")
        credit = _credit(sw_client, w["me"], w["card"])
        assert credit["opening"]["pending_total"] == 2_100.0, day
        assert credit["available_now"] == 125_900.0, day
        checks = _checks(credit, "transaction", adv)
        assert bool(checks) is has_check, day
        if has_check:
            (check,) = checks
            # After Cloud Tools on Mar 20; the advance itself subtracts nothing more.
            assert (check["kind"], check["amount"], check["available_after"]) == (
                "advance", 2_100.0, 125_900.0 - 1_297.8)


def test_card_to_card_transfer_consumes_source_and_plans_destination(world):
    w = world
    client, me = w["client"], w["me"]
    card_d = _card(client, me, "Card D", limit=50_000)
    move = _transfer(client, me, w["card"], card_d, "2027-03-25", 3_000,
                     description="Balance move")
    c = _credit(client, me, w["card"])
    assert c["available_now"] == 125_000.0
    assert [ch["kind"] for ch in _checks(c, "transaction", move)] == ["advance"]
    d = _credit(client, me, card_d)
    assert d["planned_payments"] == [
        {"date": "2027-03-25", "amount": 3_000.0, "counted": True, "reason": None}]
    assert (d["available_now"], d["available_with_planned"], d["planned_by"]) == (
        50_000.0, 53_000.0, "2027-03-25")


def test_pending_refund_is_not_counted(walk):
    w = walk
    client, me = w["client"], w["me"]
    refund = sw_post(client, me, "/transactions/", {
        "account_id": w["card"], "transaction_type": "credit", "amount": 400,
        "description": "Refund", "transaction_date": "2027-03-20T00:00:00",
        "is_posted": False})["id"]
    assert _credit(client, me, w["card"])["available_now"] == 1_851.1
    r = client.put(f"{API}/transactions/{refund}", json={"is_posted": True},
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _credit(client, me, w["card"])["available_now"] == 2_251.1


# --- rates ------------------------------------------------------------------------------------

def test_unknown_rate_makes_checks_incomplete(sw_client, sw_people, sw_db, monkeypatch):
    for day, has_check in (("2027-03-20", True), ("2027-03-10", False), ("2027-04-25", False)):
        w = _walk_rows(_world(sw_client, sw_people, monkeypatch), sw_db)
        euro = _foreign_debit(sw_client, w["me"], w["card"], day, 10, "EUR", "Euro shop")
        credit = _credit(sw_client, w["me"], w["card"])
        assert (credit["unknown_count"], credit["complete"]) == (1, False), day
        assert credit["available_now"] == 1_851.1, day
        checks = _checks(credit, "transaction", euro)
        assert bool(checks) is has_check, day
        if has_check:
            (check,) = checks
            assert (check["status"], check["amount"], check["available_after"]) == (
                "unchecked", None, None)
        others = [c for c in credit["checks"] if c["source_id"] != euro]
        statuses = {c["status"] for c in others}
        assert "ok" not in statuses and "ok_with_planned" not in statuses, day
        assert statuses == {"incomplete", "installment", "at_risk"}, day


def test_stale_rate_is_labelled_stale(walk, monkeypatch):
    from app.main import app
    from app.services.fx import get_fx

    monkeypatch.setitem(app.dependency_overrides, get_fx, _rates(hours_old=30))
    w = walk
    credit = _credit(w["client"], w["me"], w["card"])
    assert [(r["base"], r["rate"], r["stale"]) for r in credit["fx"]] == [("USD", 63.0, True)]
    assert credit["available_now"] == 1_851.1


def test_credit_uses_the_manila_day(world, monkeypatch):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    _transfer(client, me, w["checking"], card, "2027-03-17", 2_000)
    p500 = _debit(client, me, card, "2027-03-17", 500, "Late night")

    pin_clock(monkeypatch, datetime(2027, 3, 17, 15, 59))
    credit = _credit(client, me, card)
    assert credit["opening"]["pending_total"] == 500.0
    assert credit["planned_payments"] == [
        {"date": "2027-03-17", "amount": 2_000.0, "counted": True, "reason": None}]
    assert len(_checks(credit, "transaction", p500)) == 1

    pin_clock(monkeypatch, datetime(2027, 3, 17, 16, 1))
    credit = _credit(client, me, card)
    assert credit["opening"]["pending_total"] == 500.0
    assert credit["planned_payments"] == [
        {"date": "2027-03-17", "amount": 2_000.0, "counted": False, "reason": "before_today"}]
    assert _checks(credit, "transaction", p500) == []


# --- what each caller gets --------------------------------------------------------------------

def _joint_card(client, db, sw, limit=77_777, tagged=False):
    a = sw["a"]
    extra = {"tag_ids": [hh_household(db, a)]} if tagged else {}
    card = _card(client, a, "Joint card", limit=limit, payer=sw["joint"], **extra)
    for who, role in ((sw["b"], "editor"), (sw["d"], "admin"), (sw["v"], "viewer")):
        sw_share(db, card, who["id"], role, a["id"])
    return card


def test_limited_rows_are_not_counted_and_mark_incomplete(sw, sw_client, sw_db, monkeypatch):
    client, db = sw_client, sw_db
    a, b = sw["a"], sw["b"]
    pin_clock(monkeypatch, REF)
    card = _joint_card(client, db, sw)
    utilities = sw_post(client, a, "/categories/", {"name": "Utilities"})["id"]
    p500 = _debit(client, a, card, "2027-03-18", 500, "Pharmacy")
    cloud = _entry(client, a, card, "2027-03-20", 20, "Cloud Tools", currency="USD")["id"]
    music = _entry(client, a, card, "2027-04-10", 549, "Music Plus")["id"]
    phone = _entry(client, a, card, "2027-04-12", 1_799, "Phone Plan",
                   category_id=utilities)["id"]

    clean = _credit(client, a, card)
    assert clean["complete"] is True
    assert {c["status"] for c in clean["checks"]} == {"ok"}

    # B's entry touching B's private bank is Limited for A: only checks after its
    # first occurrence in the window (Apr 11) become incomplete.
    secret = _entry(client, b, card, "2027-04-11", 4_321.09, f"{PRIVATE} gym",
                    overflow_account_id=sw["b_private"])["id"]
    credit = _credit(client, a, card)
    assert (credit["uncounted_shared"], credit["complete"]) == (1, False)
    assert credit["available_now"] == clean["available_now"]
    assert [(c["source_id"], c["status"]) for c in credit["checks"]] == [
        (p500, "ok"), (cloud, "ok"), (music, "ok"), (phone, "incomplete")]
    for body in (credit, _section(_snapshot(client, a), card)["credit"]):
        assert sw_leaks(body, private_ids=[secret], numbers=[4_321.09]) == []

    # B's unposted advance from the joint card into B's private bank: Limited for A,
    # left out of the opening, so every ok is incomplete.
    advance = _transfer(client, b, card, sw["b_private"], "2027-03-25", 2_000, fee=100,
                        description="Advance")
    credit = _credit(client, a, card)
    assert (credit["uncounted_shared"], credit["complete"]) == (2, False)
    assert credit["opening"]["pending_total"] == 500.0
    assert _checks(credit, "transaction", advance) == []
    assert {c["status"] for c in credit["checks"]} == {"incomplete"}
    assert sw_leaks(credit, private_ids=[secret, advance], numbers=[4_321.09, 2_100]) == []

    # Editors still receive no credit key.
    section = _section(_snapshot(client, b), card)
    assert section is not None and "credit" not in section


def test_card_without_limit_has_no_credit(sw_client, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=50_000)
    card = _card(sw_client, me, limit=None, payer=checking)
    _entry(sw_client, me, card, "2027-03-20", 549, "Music Plus")

    section = _section(_snapshot(sw_client, me), card)
    assert section is not None and "credit" not in section
    assert _listed(sw_client, me)["items"] == []
    body = _detail(sw_client, me, card)
    assert (body["credit"], body["rule"], body["statements"]) == (None, None, [])
    assert body["open_cycle"] == {"close_date": "2027-03-24", "due_date": "2027-04-14"}


def test_card_credit_detail_refuses_a_non_card(sw_client, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=50_000)
    r = sw_client.get(f"{API}/cards/{checking}/credit", headers=me["headers"])
    assert r.status_code == 400, r.text


def test_credit_per_role(sw, sw_client, sw_db, sw_people, monkeypatch):
    client, db = sw_client, sw_db
    a, b, v, d = sw["a"], sw["b"], sw["v"], sw["d"]
    c = sw_people("Cal", "Third")
    pin_clock(monkeypatch, REF)
    card = _joint_card(client, db, sw, tagged=True)
    hh_tag_share(db, a, c)
    _entry(client, a, card, "2027-04-05", 3_333, "Bike",
           end_mode="after_occurrences", max_occurrences=3)
    _debit(client, a, card, "2027-03-20", 1_000.01, "Pharmacy")
    _debit(client, a, card, "2027-03-25", 234.55, "Bakery")

    mine = _credit(client, a, card)
    assert (mine["limit"], mine["opening"]["installment_hold"],
            mine["opening"]["pending_total"], mine["available_now"]) == (
        77_777.0, 9_999.0, 1_234.56, 66_543.44)
    numbers = [77_777, mine["available_now"], mine["opening"]["installment_hold"],
               mine["opening"]["pending_total"]]

    for who in (a, d):
        section = _section(_snapshot(client, who), card)
        assert section["credit"]["limit"] == 77_777.0
        assert section["credit"]["available_now"] == mine["available_now"]
        assert card in [i["account_id"] for i in _listed(client, who)["items"]]
        assert _credit(client, who, card)["available_now"] == mine["available_now"]

    for who in (b, v):
        section = _section(_snapshot(client, who), card)
        assert section is not None and "credit" not in section
    assert _section(_snapshot(client, c), card) is None

    for who in (b, v, c):
        assert card not in [i["account_id"] for i in _listed(client, who)["items"]]
        _detail(client, who, card, expect=404)
        snapshot = _snapshot(client, who)
        accounts = client.get(f"{API}/accounts/", headers=who["headers"])
        assert accounts.status_code == 200, accounts.text
        for body in (snapshot, accounts.json(), _listed(client, who)):
            assert sw_leaks(body, numbers=numbers) == [], who
        assert "available_now" not in json.dumps(snapshot)

"""Available credit across a shared credit limit (PR 2 of the shared limit).

BDO Amex holds the 480,000 limit (the primary); BDO Platinum Mastercard is
linked to it (``shares_limit_with_account_id``) and has no limit of its own.
Both cards report one figure: the limit less what both owe, have pending, hold
for installments and missed, with one date-ordered walk over both cards'
charges and payments; each card keeps the checks for its own charges.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila); the window is
Mar 18 to Apr 17 inclusive. Skips without a database.
"""
import pytest

from app.tests.conftest import (
    API, PRIVATE, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share,
)
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_card_credit_integration import (  # noqa: F401  (fx63: autouse fixture)
    REF, _credit, _debit, _detail, _entry, _listed, _section, _snapshot, fx63,
)

pytestmark = [pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable"),
              pytest.mark.usefixtures("legacy_card_installments")]

FIELD = "shares_limit_with_account_id"
LIMIT = 480_000.0
AMEX, PLATINUM = "BDO Amex", "BDO Platinum Mastercard"


def _transfer(client, who, src, dst, day, amount, posted=False):
    return sw_post(client, who, "/transactions/", {
        "account_id": src, "transaction_type": "transfer", "transfer_from_account_id": src,
        "transfer_to_account_id": dst, "amount": amount, "transfer_fee": 0,
        "description": "Card payment", "transaction_date": f"{day}T00:00:00",
        "is_posted": posted})["id"]


def _pair(client, who, bank, amex_name=AMEX, platinum_name=PLATINUM, **extra):
    """The Amex (480,000, closes on the 4th) and the Platinum linked to it
    (closes on the 14th), both due 25 days later and paid from ``bank``."""
    amex = sw_post(client, who, "/accounts/", {
        "name": amex_name, "account_type": "credit", "balance": 0, "credit_limit": LIMIT,
        "billing_cycle_start": 4, "days_until_due_date": 25,
        "payment_account_id": bank, **extra})["id"]
    platinum = sw_post(client, who, "/accounts/", {
        "name": platinum_name, "account_type": "credit", "balance": 0,
        "billing_cycle_start": 14, "days_until_due_date": 25,
        "payment_account_id": bank, FIELD: amex, **extra})["id"]
    return amex, platinum


@pytest.fixture
def pair(sw_client, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people("Seth", "Owner")
    bank = sw_post(sw_client, me, "/accounts/", {
        "name": "Security Bank", "account_type": "checking", "balance": 500_000})["id"]
    amex, platinum = _pair(sw_client, me, bank)
    return {"client": sw_client, "me": me, "bank": bank, "amex": amex, "platinum": platinum}


def _both(w):
    return _credit(w["client"], w["me"], w["amex"]), _credit(w["client"], w["me"], w["platinum"])


GROUP_KEYS = ("limit", "available_now", "available_with_planned", "planned_by",
              "planned_charges_total", "opening", "missed", "planned_payments", "complete",
              "uncounted_shared", "unknown_count", "fx")


def _same_headline(amex, platinum):
    for key in GROUP_KEYS:
        assert amex[key] == platinum[key], key


# --- 1 ------------------------------------------------------------------------------------------

def test_shared_limit_both_cards_same_available(pair):
    w = pair
    _debit(w["client"], w["me"], w["amex"], "2027-03-01", 100_000, "Amex spend", posted=True)
    _debit(w["client"], w["me"], w["platinum"], "2027-03-02", 50_000, "Platinum spend",
           posted=True)
    amex, platinum = _both(w)
    for credit, card in ((amex, w["amex"]), (platinum, w["platinum"])):
        assert (credit["account_id"], credit["currency"], credit["limit"],
                credit["available_now"]) == (card, "PHP", LIMIT, 330_000.0)
        assert credit["opening"]["balance_owed"] == 150_000.0
    _same_headline(amex, platinum)
    assert amex["shared_with"] == [{"account_id": w["platinum"], "name": PLATINUM}]
    assert platinum["shared_with"] == [{"account_id": w["amex"], "name": AMEX}]


# --- 2 ------------------------------------------------------------------------------------------

def test_spend_on_either_lowers_both(pair):
    w = pair
    assert [c["available_now"] for c in _both(w)] == [LIMIT, LIMIT]
    _debit(w["client"], w["me"], w["platinum"], "2027-03-18", 10_000, "Platinum today")
    assert [c["available_now"] for c in _both(w)] == [470_000.0, 470_000.0]
    _debit(w["client"], w["me"], w["amex"], "2027-03-18", 10_000, "Amex today")
    amex, platinum = _both(w)
    assert [amex["available_now"], platinum["available_now"]] == [460_000.0, 460_000.0]
    assert amex["opening"]["pending_total"] == platinum["opening"]["pending_total"] == 20_000.0


# --- 3 ------------------------------------------------------------------------------------------

def test_payment_on_either_raises_both(pair):
    w = pair
    client, me = w["client"], w["me"]
    _debit(client, me, w["amex"], "2027-03-01", 100_000, "Amex spend", posted=True)
    _debit(client, me, w["platinum"], "2027-03-02", 50_000, "Platinum spend", posted=True)
    _transfer(client, me, w["bank"], w["platinum"], "2027-03-10", 20_000, posted=True)
    assert [c["available_now"] for c in _both(w)] == [350_000.0, 350_000.0]
    _transfer(client, me, w["bank"], w["amex"], "2027-03-11", 30_000, posted=True)
    assert [c["available_now"] for c in _both(w)] == [380_000.0, 380_000.0]

    # Planned payments into either card raise available_with_planned on both.
    _transfer(client, me, w["bank"], w["amex"], "2027-03-25", 5_000)
    _transfer(client, me, w["bank"], w["platinum"], "2027-04-02", 7_000)
    amex, platinum = _both(w)
    _same_headline(amex, platinum)
    assert (amex["available_now"], amex["available_with_planned"], amex["planned_by"]) == (
        380_000.0, 392_000.0, "2027-04-02")
    assert [(p["date"], p["amount"]) for p in amex["planned_payments"]] == [
        ("2027-03-25", 5_000.0), ("2027-04-02", 7_000.0)]


# --- 4 ------------------------------------------------------------------------------------------

def test_opening_sums_to_headline(pair):
    w = pair
    client, me = w["client"], w["me"]
    _debit(client, me, w["amex"], "2027-03-01", 100_000, "Amex spend", posted=True)
    _debit(client, me, w["platinum"], "2027-03-15", 10_000, "Platinum pending")
    _entry(client, me, w["platinum"], "2027-04-05", 2_000, "Laptop",
           end_mode="after_occurrences", max_occurrences=5)
    _entry(client, me, w["amex"], "2027-03-10", 500, "Streaming")
    amex, platinum = _both(w)
    for credit in (amex, platinum):
        assert credit["opening"] == {"balance_owed": 100_000.0, "pending_total": 10_000.0,
                                     "installment_hold": 10_000.0, "missed_total": 500.0}
        assert credit["limit"] - sum(credit["opening"].values()) == credit["available_now"]
        assert credit["available_now"] == 359_500.0
    _same_headline(amex, platinum)


# --- 5 ------------------------------------------------------------------------------------------

def test_merged_walk_checks_per_card(pair):
    w = pair
    client, me = w["client"], w["me"]
    _debit(client, me, w["amex"], "2027-03-01", 100_000, "Amex spend", posted=True)
    big = _debit(client, me, w["amex"], "2027-03-20", 400_000, "Amex planned charge")
    _transfer(client, me, w["bank"], w["amex"], "2027-03-21", 30_000)
    sub = _entry(client, me, w["platinum"], "2027-03-22", 1_000, "Platinum sub")
    assert sub["kind"] == "subscription"
    amex, platinum = _both(w)
    _same_headline(amex, platinum)
    assert amex["available_now"] == 380_000.0

    assert [(c["source"], c["source_id"], c["available_after"],
             c["available_after_without_planned"], c["status"])
            for c in amex["checks"]] == [
        ("transaction", big, -20_000.0, -20_000.0, "at_risk")]
    # The Platinum subscription sees the Amex charge taken off, and the Amex
    # planned payment carries it.
    assert [(c["source"], c["source_id"], c["available_after"],
             c["available_after_without_planned"], c["status"], c["relies_on_planned"])
            for c in platinum["checks"]] == [
        ("budget_entry", sub["id"], 9_000.0, -21_000.0, "ok_with_planned", "2027-03-21")]


# --- 6 ------------------------------------------------------------------------------------------

def test_secondary_hold_and_missed_count(pair):
    w = pair
    client, me = w["client"], w["me"]
    laptop = _entry(client, me, w["platinum"], "2027-04-01", 2_000, "Laptop",
                    end_mode="after_occurrences", max_occurrences=6)
    assert laptop["kind"] == "installment"
    gym = _entry(client, me, w["platinum"], "2027-03-10", 800, "Gym")
    amex, platinum = _both(w)
    for credit in (amex, platinum):
        assert (credit["opening"]["installment_hold"], credit["opening"]["missed_total"]) == (
            12_000.0, 800.0)
        assert credit["available_now"] == LIMIT - 12_800.0
        assert credit["missed"] == [{"entry_id": gym["id"], "name": "Gym",
                                     "kind": "subscription", "count": 1, "total": 800.0}]
    assert amex["checks"] == []
    assert [(c["source_id"], c["date"], c["kind"]) for c in platinum["checks"]] == [
        (laptop["id"], "2027-04-01", "installment"), (gym["id"], "2027-04-10", "subscription")]


# --- 7 ------------------------------------------------------------------------------------------

def test_secondary_served_everywhere(pair):
    w = pair
    client, me = w["client"], w["me"]
    _debit(client, me, w["platinum"], "2027-03-02", 50_000, "Platinum spend", posted=True)
    listed = {c["account_id"]: c for c in _listed(client, me)["items"]}
    assert [c["account_id"] for c in _listed(client, me)["items"]] == [w["amex"], w["platinum"]]
    detail = _detail(client, me, w["platinum"])
    assert detail["credit"] == listed[w["platinum"]]
    assert detail["credit"]["available_now"] == 430_000.0
    snapshot = _snapshot(client, me)
    for card in (w["amex"], w["platinum"]):
        assert _section(snapshot, card)["credit"] == listed[card]


# --- 8 ------------------------------------------------------------------------------------------

def test_group_credit_gate(sw, sw_client, sw_db, sw_people, monkeypatch):
    client, db = sw_client, sw_db
    a, b, v, d = sw["a"], sw["b"], sw["v"], sw["d"]
    c = sw_people("Cal", "Third")
    pin_clock(monkeypatch, REF)
    amex, platinum = _pair(client, a, sw["joint"], amex_name="Joint Amex",
                           platinum_name="Joint Platinum",
                           tag_ids=[hh_household(db, a)])
    hh_tag_share(db, a, c)
    _debit(client, a, platinum, "2027-03-18", 1_234.56, "Bakery")
    for who, role in ((b, "editor"), (d, "admin"), (v, "viewer")):
        sw_share(db, platinum, who["id"], role, a["id"])
    assert _credit(client, a, platinum)["available_now"] == LIMIT - 1_234.56

    def served(who):
        listed = [i["account_id"] for i in _listed(client, who)["items"]]
        snapshot = _snapshot(client, who)
        return listed, snapshot

    # Dee administers the Platinum only: no credit for it on any surface.
    listed, snapshot = served(d)
    assert platinum not in listed and amex not in listed
    assert _detail(client, d, platinum)["credit"] is None
    section = _section(snapshot, platinum)
    assert section is None or "credit" not in section
    # Nor for the Amex, through an admin role on it alone.
    sw_share(db, amex, b["id"], "admin", a["id"])
    listed, snapshot = served(b)
    assert amex not in listed and platinum not in listed
    assert _detail(client, b, amex)["credit"] is None
    section = _section(snapshot, amex)
    assert section is None or "credit" not in section

    # Once Dee administers both cards, both are served.
    sw_share(db, amex, d["id"], "admin", a["id"])
    listed, snapshot = served(d)
    assert [i for i in listed if i in (amex, platinum)] == [amex, platinum]
    assert _detail(client, d, platinum)["credit"]["available_now"] == LIMIT - 1_234.56
    assert _section(snapshot, platinum)["credit"]["available_now"] == LIMIT - 1_234.56

    # An editor of the Platinum (Bea, admin of the Amex), a viewer and a tag viewer:
    # unchanged, 404 or absent.
    for who in (b, v):
        _detail(client, who, platinum, expect=404)
        section = _section(_snapshot(client, who), platinum)
        assert section is not None and "credit" not in section
    _detail(client, c, platinum, expect=404)
    assert _section(_snapshot(client, c), platinum) is None
    for who in (b, v, c):
        assert platinum not in [i["account_id"] for i in _listed(client, who)["items"]]


# --- 9 ------------------------------------------------------------------------------------------

def test_limited_row_on_other_member(sw, sw_client, sw_db, monkeypatch):
    client, db = sw_client, sw_db
    a, b = sw["a"], sw["b"]
    pin_clock(monkeypatch, REF)
    amex, platinum = _pair(client, a, sw["joint"], amex_name="Joint Amex",
                           platinum_name="Joint Platinum")
    sw_share(db, amex, b["id"], "editor", a["id"])
    early = _entry(client, a, platinum, "2027-04-10", 549, "Music Plus")["id"]
    late = _entry(client, a, platinum, "2027-04-12", 1_799, "Phone Plan")["id"]
    clean = _credit(client, a, platinum)
    assert (clean["complete"], clean["uncounted_shared"]) == (True, 0)

    # Bea's entry on the Amex touching her private bank is Limited for Alice: the
    # Platinum's headline is "at most", and its checks from Apr 11 are incomplete.
    _entry(client, b, amex, "2027-04-11", 4_321.09, f"{PRIVATE} gym",
           overflow_account_id=sw["b_private"])
    credit = _credit(client, a, platinum)
    assert (credit["complete"], credit["uncounted_shared"]) == (False, 1)
    assert credit["available_now"] == clean["available_now"]
    assert [(c["source_id"], c["status"]) for c in credit["checks"]] == [
        (early, "ok"), (late, "incomplete")]
    assert PRIVATE not in str(credit)

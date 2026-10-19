"""Upcoming charges by card on ``/dashboard/snapshot`` (STU-343, plan section 2.5).

Each card the caller holds a direct role on lists its recurring expenses'
occurrences, unposted debits (overdue ones included) and cash advances over the
next 30 days from Manila midnight. Only a recurring entry's charge offers Mark
paid; a Limited one keeps six keys and the response's shared public id. No
credit-derived figure is returned. Skips without a database.
"""
import json
import sys
from datetime import datetime

import pytest

from app.tests.conftest import (
    API, PRIVATE, hh_household, hh_tag_share, sw_db_reachable, sw_leaks, sw_post, sw_share,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)

LIMITED_KEYS = {"view", "public_id", "date", "original_date", "overdue", "display_name"}
CARD_KEYS = {"account_id", "account_name", "currency", "statement_cycle", "missed", "charges"}
FULL_KEYS = {"view", "date", "original_date", "overdue", "occurrence_date", "name", "kind",
             "source", "source_id", "amount", "currency", "can_mark_paid"}
LABEL_KEYS = {"estimated", "unconverted", "original_amount", "original_currency", "rate",
              "rate_as_of", "rate_stale"}
MISSED_KEYS = {"entry_id", "name", "kind", "count", "due_count", "oldest", "can_mark_paid"}
CREDIT_WORDS = ("credit", "limit", "available", "hold", "utiliz", "buffer", "total")


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking, name="Card C", **extra):
    return _account(client, who, name, "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking, **extra)


def _entry(client, who, account_id, next_day, amount, name, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})["id"]


def _debit(client, who, account_id, day, amount, description, posted=False, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": posted, **extra})["id"]


def _advance(client, who, card, to, day, amount, fee, description):
    return sw_post(client, who, "/transactions/", {
        "account_id": card, "transaction_type": "transfer", "transfer_from_account_id": card,
        "transfer_to_account_id": to, "amount": amount, "transfer_fee": fee,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": False})["id"]


def _snapshot(client, who, **params):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"], params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _card_of(body, card_id):
    return next((c for c in body["card_charges"] if c["account_id"] == card_id), None)


def _assert_shapes(card_charges):
    for card in card_charges:
        assert set(card) == CARD_KEYS
        for item in card["missed"]:
            assert set(item) == MISSED_KEYS
        for charge in card["charges"]:
            if charge["view"] == "limited":
                assert set(charge) == LIMITED_KEYS
            else:
                assert FULL_KEYS <= set(charge) <= FULL_KEYS | LABEL_KEYS
    # No credit-derived key anywhere (Plan C owns them).
    keys = set()

    def walk(node):
        if isinstance(node, dict):
            keys.update(node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(card_charges)
    assert not [k for k in keys if any(w in k for w in CREDIT_WORDS)], keys


@pytest.fixture
def card_c(sw_client, sw_people):
    """Checking ₱50,000 and Card C (closes on the 24th, due 21 days later) with the
    plan's seven records."""
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    utilities = sw_post(client, me, "/categories/", {"name": "Utilities"})["id"]
    ids = {
        "claude": _entry(client, me, card, "2026-10-20", 20, "Claude", currency="USD"),
        "netflix": _entry(client, me, card, "2026-11-10", 549, "Netflix"),
        "iphone": _entry(client, me, card, "2026-11-05", 5_000, "iPhone",
                         end_mode="after_occurrences", max_occurrences=12),
        "globe": _entry(client, me, card, "2026-11-12", 1_799, "Globe", category_id=utilities),
        "lazada": _debit(client, me, card, "2026-10-25", 1_000, "Lazada"),
        "groceries": _debit(client, me, card, "2026-10-12", 300, "Groceries"),
        "advance": _advance(client, me, card, checking, "2026-10-28", 2_000, 100,
                            "Cash advance"),
    }
    return {"client": client, "me": me, "checking": checking, "card": card, **ids}


def test_snapshot_lists_card_charges_by_card_not_as_payables(card_c, monkeypatch):
    client, me, card = card_c["client"], card_c["me"], card_c["card"]
    pin_clock(monkeypatch, REF)

    body = _snapshot(client, me)
    _assert_shapes(body["card_charges"])
    assert [c["account_id"] for c in body["card_charges"]] == [card]
    section = _card_of(body, card)
    assert (section["account_name"], section["currency"], section["statement_cycle"],
            section["missed"]) == ("Card C", "PHP", True, [])
    charges = section["charges"]
    assert [(c["date"], c["original_date"], c["name"], c["kind"], c["amount"])
            for c in charges] == [
        ("2026-10-18", "2026-10-12", "Groceries", "pending", 300.0),
        ("2026-10-20", None, "Claude", "subscription", 1160.0),
        ("2026-10-25", None, "Lazada", "pending", 1000.0),
        ("2026-10-28", None, "Cash advance", "advance", 2100.0),
        ("2026-11-05", None, "iPhone", "installment", 5000.0),
        ("2026-11-10", None, "Netflix", "subscription", 549.0),
        ("2026-11-12", None, "Globe", "bill", 1799.0),
    ]
    by_name = {c["name"]: c for c in charges}
    assert all(c["view"] == "full" and c["currency"] == "PHP" for c in charges)

    groceries = by_name["Groceries"]
    assert (groceries["overdue"], groceries["can_mark_paid"], groceries["source"],
            groceries["source_id"], groceries["occurrence_date"]) == (
        True, False, "transaction", card_c["groceries"], None)
    assert not any(by_name[n]["overdue"] for n in by_name if n != "Groceries")

    claude = by_name["Claude"]
    assert (claude["estimated"], claude["rate"], claude["original_amount"],
            claude["original_currency"], claude["occurrence_date"]) == (
        True, 58.0, 20.0, "USD", "2026-10-20")

    for name in ("Lazada", "Cash advance"):
        assert by_name[name]["can_mark_paid"] is False
        assert by_name[name]["source"] == "transaction"
    assert by_name["Cash advance"]["source_id"] == card_c["advance"]
    for name, key in (("iPhone", "iphone"), ("Netflix", "netflix"), ("Globe", "globe")):
        assert by_name[name]["can_mark_paid"] is True
        assert (by_name[name]["source"], by_name[name]["source_id"]) == (
            "budget_entry", card_c[key])
    assert by_name["Netflix"]["occurrence_date"] == "2026-11-10"
    assert "estimated" not in by_name["Netflix"]

    # Nothing here is a payable of its own: the card's statement carries them.
    record_ids = {("budget_entry", card_c[k]) for k in ("claude", "netflix", "iphone", "globe")}
    record_ids |= {("transaction", card_c[k]) for k in ("lazada", "groceries", "advance")}
    assert not [p for p in body["payables"]
                if (p.get("source"), p.get("source_id")) in record_ids]


def test_transaction_charges_never_offer_mark_paid(card_c, monkeypatch):
    client, me, card = card_c["client"], card_c["me"], card_c["card"]
    pin_clock(monkeypatch, REF)

    charges = _card_of(_snapshot(client, me), card)["charges"]
    from_transactions = [c for c in charges if c["source"] == "transaction"]
    assert len(from_transactions) == 3
    assert all(c["can_mark_paid"] is False for c in from_transactions)
    assert all(c["can_mark_paid"] is True for c in charges if c["source"] == "budget_entry")


def test_missed_subscriptions_are_counted_and_cleared_by_post_due(sw_client, sw_people,
                                                                   monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    utilities = sw_post(client, me, "/categories/", {"name": "Utilities"})["id"]
    netflix = _entry(client, me, card, "2026-08-10", 549, "Netflix")
    meralco = _entry(client, me, card, "2026-09-18", 2_500, "Meralco", category_id=utilities)
    # Capped and cash expenses are never "missed".
    _entry(client, me, card, "2026-08-05", 5_000, "iPhone",
           end_mode="after_occurrences", max_occurrences=12)
    _entry(client, me, checking, "2026-08-01", 20_000, "Rent")
    pin_clock(monkeypatch, REF)

    section = _card_of(_snapshot(client, me), card)
    _assert_shapes([section])
    assert section["missed"] == [
        {"entry_id": netflix, "name": "Netflix", "kind": "subscription", "count": 3,
         "due_count": 3, "oldest": "2026-08-10", "can_mark_paid": True},
        {"entry_id": meralco, "name": "Meralco", "kind": "bill", "count": 1,
         "due_count": 2, "oldest": "2026-09-18", "can_mark_paid": True},
    ]

    r = client.post(f"{API}/budget-entries/{netflix}/materialize-due", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == 3

    section = _card_of(_snapshot(client, me), card)
    assert [m["entry_id"] for m in section["missed"]] == [meralco]
    assert [c["date"] for c in section["charges"]
            if c["source"] == "budget_entry" and c["source_id"] == netflix] == ["2026-11-10"]


def test_missed_count_walks_a_decades_stale_schedule_completely(sw_client, sw_people,
                                                                monkeypatch):
    """Past the projection's guard (2000 weekly steps): the missed count is the
    complete one, the same as ``GET /occurrences``' ``due_unposted``."""
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    laundry = _entry(client, me, card, "1985-01-06", 100, "Laundry", cadence="weekly")
    pin_clock(monkeypatch, REF)

    [missed] = _card_of(_snapshot(client, me), card)["missed"]
    assert (missed["entry_id"], missed["count"], missed["due_count"], missed["oldest"]) == (
        laundry, 2180, 2181, "1985-01-06")
    r = client.get(f"{API}/budget-entries/{laundry}/occurrences", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["due_unposted"] == missed["due_count"]


def test_no_cycle_card_charge_is_listed_and_stays_a_payable(sw_client, sw_people, monkeypatch):
    client, me = sw_client, sw_people()
    _account(client, me)
    card = _account(client, me, "Store card", "credit", 0)
    spotify = _entry(client, me, card, "2026-10-30", 279, "Spotify")
    pin_clock(monkeypatch, REF)

    body = _snapshot(client, me)
    section = _card_of(body, card)
    assert section["statement_cycle"] is False
    assert [(c["date"], c["name"], c["kind"], c["amount"], c["can_mark_paid"],
             c["occurrence_date"]) for c in section["charges"]] == [
        ("2026-10-30", "Spotify", "subscription", 279.0, True, "2026-10-30")]
    assert [(p["due_date"], p["amount"]) for p in body["payables"]
            if p.get("source") == "budget_entry" and p.get("source_id") == spotify] == [
        ("2026-10-30", 279.0)]


def test_unconverted_foreign_occurrence_is_listed_without_amount(sw_client, sw_people,
                                                                 monkeypatch):
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    entry = _entry(client, me, card, "2026-10-30", 1_000, "Yen app", currency="JPY")
    pin_clock(monkeypatch, REF)

    body = _snapshot(client, me)
    (charge,) = _card_of(body, card)["charges"]
    assert (charge["source_id"], charge["amount"], charge["currency"], charge["unconverted"],
            charge["original_amount"], charge["original_currency"]) == (
        entry, None, "PHP", True, 1000.0, "JPY")
    assert "estimated" not in charge
    assert body["fx"]["unconverted_count"] >= 1


def test_card_charges_per_role(sw, sw_client, sw_db, sw_people, monkeypatch):
    client, db = sw_client, sw_db
    a, b, v, d = sw["a"], sw["b"], sw["v"], sw["d"]
    c = sw_people("Cal", "Third")
    hh_a = hh_household(db, a)
    joint_card = _card(client, a, sw["joint"], "Joint card", credit_limit=77_777,
                       tag_ids=[hh_a])
    for who, role in ((b, "editor"), (d, "admin"), (v, "viewer")):
        sw_share(db, joint_card, who["id"], role, a["id"])
    hh_tag_share(db, a, c)

    netflix = _entry(client, a, joint_card, "2026-10-10", 549, "Netflix")
    _debit(client, b, joint_card, "2026-10-15", 700, "Bea lunch", posted=True)
    pharmacy = _debit(client, a, joint_card, "2026-10-10", 450, "Pharmacy")
    advance = _advance(client, a, joint_card, sw["a_private"], "2026-10-28", 2_000, 100,
                       f"Advance to {PRIVATE}")
    pin_clock(monkeypatch, REF)

    def charges(body):
        section = _card_of(body, joint_card)
        out = {}
        for ch in section["charges"]:
            if ch["view"] != "limited":
                out[(ch["source"], ch["source_id"])] = ch
        return section, out

    bodies = {k: _snapshot(client, w) for k, w in (("a", a), ("b", b), ("d", d), ("v", v),
                                                     ("c", c))}
    for k, body in bodies.items():
        _assert_shapes(body["card_charges"])
        assert "77777" not in json.dumps(body["card_charges"])
        if k != "a":
            assert sw_leaks(body["card_charges"], numbers=[77_777]) == []

    # A: everything in full, and Netflix's Oct 10 is missed.
    section, full = charges(bodies["a"])
    assert {key: ch["view"] for key, ch in full.items()} == {
        ("budget_entry", netflix): "full", ("transaction", pharmacy): "full",
        ("transaction", advance): "full"}
    assert full[("transaction", advance)]["amount"] == 2100.0
    assert [(m["entry_id"], m["count"]) for m in section["missed"]] == [(netflix, 1)]

    # B and D: shared_full, but the advance into A's private bank is Limited.
    for k in ("b", "d"):
        section, full = charges(bodies[k])
        assert set(full) == {("budget_entry", netflix), ("transaction", pharmacy)}
        assert full[("budget_entry", netflix)]["view"] == "shared_full"
        ph = full[("transaction", pharmacy)]
        assert (ph["view"], ph["amount"], ph["date"], ph["original_date"], ph["overdue"],
                ph["can_mark_paid"]) == (
            "shared_full", 450.0, "2026-10-18", "2026-10-10", True, False)
        limited = [ch for ch in section["charges"] if ch["view"] == "limited"]
        assert [ch["date"] for ch in limited] == ["2026-10-28"]
        (adv,) = limited
        upcoming = [u for u in bodies[k]["upcoming_this_month"]
                    if u.get("view") == "limited" and u["public_id"] == adv["public_id"]]
        assert len(upcoming) == 1 and upcoming[0]["date"] == "2026-10-28"

    # V: every charge Limited, Pharmacy by its name; nothing missed is shown.
    section = _card_of(bodies["v"], joint_card)
    assert section["missed"] == []
    assert all(ch["view"] == "limited" for ch in section["charges"])
    by_date = {ch["date"]: ch for ch in section["charges"]}
    assert set(by_date) == {"2026-10-18", "2026-10-28", "2026-11-10"}
    assert (by_date["2026-10-18"]["display_name"], by_date["2026-10-18"]["overdue"],
            by_date["2026-10-18"]["original_date"]) == ("Pharmacy", True, "2026-10-10")
    ids = [ch["public_id"] for ch in section["charges"]]
    assert len(set(ids)) == 3
    for when in ("2026-10-28", "2026-11-10"):
        upcoming = [u for u in bodies["v"]["upcoming_this_month"]
                    if u.get("view") == "limited" and u["public_id"] == by_date[when]["public_id"]]
        assert len(upcoming) == 1 and upcoming[0]["date"] == when

    # C sees the card only through A's Household tag: not a card of theirs here.
    assert _card_of(bodies["c"], joint_card) is None
    for k in ("b", "d", "v", "c"):
        assert PRIVATE not in json.dumps(bodies[k]["card_charges"])


def test_card_charges_ignore_the_tag_filter(card_c, monkeypatch):
    client, me = card_c["client"], card_c["me"]
    tag = sw_post(client, me, "/tags/", {"name": "Streaming"}, expect=(201,))["id"]
    r = client.put(f"{API}/budget-entries/{card_c['netflix']}", json={"tag_ids": [tag]},
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    pin_clock(monkeypatch, REF)

    whole = _snapshot(client, me)
    tagged = _snapshot(client, me, tag=tag)
    assert len(_card_of(whole, card_c["card"])["charges"]) == 7
    assert tagged["card_charges"] == whole["card_charges"]


def test_card_charges_window_starts_at_manila_midnight(sw_client, sw_people, monkeypatch):
    """16:30 UTC on Oct 18 is 00:30 on Oct 19 in Manila: the card window runs from
    Oct 19 to Nov 18 inclusive, while the (UTC) upcoming window still starts Oct 18."""
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    bookstore = _debit(client, me, card, "2026-10-18", 250, "Bookstore")
    late = _debit(client, me, card, "2026-11-18", 90, "Late item")
    spotify = _entry(client, me, card, "2026-10-18", 279, "Spotify")

    def listed(body):
        return [(ch["date"], ch["original_date"], ch["overdue"], ch["name"])
                for ch in _card_of(body, card)["charges"]]

    pin_clock(monkeypatch, datetime(2026, 10, 18, 16, 30))
    body = _snapshot(client, me)
    assert listed(body) == [
        ("2026-10-19", "2026-10-18", True, "Bookstore"),
        ("2026-11-18", None, False, "Late item"),
        ("2026-11-18", None, False, "Spotify"),
    ]
    assert _card_of(body, card)["missed"] == [
        {"entry_id": spotify, "name": "Spotify", "kind": "subscription", "count": 1,
         "due_count": 1, "oldest": "2026-10-18", "can_mark_paid": True}]
    upcoming = [u for u in body["upcoming_this_month"]
                if u.get("source") == "transaction" and u.get("source_id") == bookstore]
    assert [u["due_date"] for u in upcoming] == ["2026-10-18"]

    pin_clock(monkeypatch, REF)
    body = _snapshot(client, me)
    assert listed(body) == [
        ("2026-10-18", None, False, "Bookstore"),
        ("2026-10-18", None, False, "Spotify"),
    ]
    assert _card_of(body, card)["missed"] == []
    assert late not in [ch["source_id"] for ch in _card_of(body, card)["charges"]]


def test_missed_count_counts_a_clamped_semi_monthly_day_once(sw_client, sw_people, monkeypatch):
    """Days 30/31 clamp onto Feb 28: missed counts it once, as ``due_unposted`` does."""
    client, me = sw_client, sw_people()
    checking = _account(client, me)
    card = _card(client, me, checking)
    gym = _entry(client, me, card, "2027-01-30", 100, "Gym", cadence="semi_monthly",
                 semi_monthly_day_1=30, semi_monthly_day_2=31)
    pin_clock(monkeypatch, datetime(2027, 3, 31, 2, 0))

    [missed] = _card_of(_snapshot(client, me), card)["missed"]
    assert (missed["entry_id"], missed["count"], missed["due_count"], missed["oldest"]) == (
        gym, 4, 5, "2027-01-30")
    r = client.get(f"{API}/budget-entries/{gym}/occurrences", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["due_unposted"] == missed["due_count"]

"""Each managed card's owed closed statement in the snapshot (STU-343 Plan C, W2).

``card_statements_due`` lists, for each active credit card the caller owns or
administers (with or without a limit), its latest closed statement L when L's
``clear_through`` is above 0 and the oldest owed closed statement is due inside
the 30-day window or overdue. The figure is the Pay dialog's Full: recorded
rows only, in the card's currency, from the same selection
(``card_credit.closed_statements``). The payables are unchanged. Skips without
a database.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). Card M and Card M2
as in ``test_statement_minimum_integration``; every card here has an explicit
payment account.
"""
from datetime import datetime

import pytest

from app.tests.conftest import API, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_statement_minimum_integration import REF, _account, _card, _card_m, _debit, _m2

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

ITEM_KEYS = {"account_id", "name", "currency", "close_date", "due_date", "clear_through",
             "statement_count", "oldest_due", "overdue", "incomplete", "unposted_installments",
             "unposted_postable"}

# The public shape of a Limited row (``forecast.limited_event``).
LIMITED_KEYS = {"view", "public_id", "date", "original_date", "overdue", "display_name",
                "face_amount", "cash_delta", "currency", "account", "kind"}
# A full payable as ``payables_by_currency`` builds it, before any snapshot field.
PAYABLE_KEYS = {"due_date", "name", "amount", "source", "source_id", "account_id",
                "account_name", "overflow_account_id", "overflow_account_name", "currency"}
STATEMENT_PAYABLE_KEYS = PAYABLE_KEYS | {"statement_close"}
ENTRY_PAYABLE_KEYS = PAYABLE_KEYS | {"occurrence_date", "overdue"}
# The snapshot adds the row permissions to full budget-entry rows (missed.entry_row_fields).
SNAPSHOT_ENTRY_PAYABLE_KEYS = ENTRY_PAYABLE_KEYS | {"kind", "can_mark_paid"}


# --- helpers ----------------------------------------------------------------------------------

def _snapshot(client, who):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    for item in body["card_statements_due"]:
        assert set(item) == ITEM_KEYS
    return body


def _due(client, who):
    return {i["account_id"]: i for i in _snapshot(client, who)["card_statements_due"]}


def _latest(client, who, card):
    """L from the Pay dialog's source, asserted to exist."""
    r = client.get(f"{API}/cards/{card}/credit", headers=who["headers"])
    assert r.status_code == 200, r.text
    statements = r.json()["statements"]
    assert statements, "the card has no closed statement"
    return statements[-1]


def _set_payer(client, who, card, payer):
    r = client.put(f"{API}/accounts/{card}", json={"payment_account_id": payer},
                   headers=who["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["payment_account_id"] == payer


def _subscription(client, who, card, next_day, amount, name):
    entry = sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": card})
    assert entry["kind"] == "subscription"
    return entry["id"]


def _pay_full(client, who, card, payer, amount):
    r = client.post(f"{API}/cards/{card}/payments", json={
        "amount": amount, "from_account_id": payer, "payment_date": "2027-03-18"},
        headers=who["headers"])
    assert r.status_code == 201, r.text


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=100_000)
    savings = _account(sw_client, me, "Savings", "savings", balance=100_000)
    card = _card_m(sw_client, me, savings)
    _set_payer(sw_client, me, card, checking)
    return {"client": sw_client, "db": sw_db, "me": me, "checking": checking,
            "savings": savings, "card": card, "people": sw_people}


# --- what is listed ---------------------------------------------------------------------------

def test_lists_the_latest_closed_statement(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    m2 = _m2(w)
    _set_payer(client, me, m2, w["checking"])

    latest = _latest(client, me, card)
    assert (latest["close_date"], latest["due_date"]) == ("2027-03-03", "2027-03-24")
    m2_latest = _latest(client, me, m2)
    assert m2_latest["close_date"] == "2027-03-03"

    due = _due(client, me)
    assert list(due) == [card, m2]  # by name
    assert due[card] == {
        "account_id": card, "name": "Card M", "currency": "PHP", "close_date": "2027-03-03",
        "due_date": "2027-03-24", "clear_through": latest["clear_through"],
        "statement_count": 1, "oldest_due": "2027-03-24", "overdue": False,
        "incomplete": False, "unposted_installments": 0, "unposted_postable": 0}
    assert latest["clear_through"] == 55_000.0
    assert due[m2] == {
        "account_id": m2, "name": "Card M2", "currency": "PHP", "close_date": "2027-03-03",
        "due_date": "2027-03-24", "clear_through": m2_latest["clear_through"],
        "statement_count": 2, "oldest_due": "2027-01-24", "overdue": True,
        "incomplete": False, "unposted_installments": 0, "unposted_postable": 0}
    assert m2_latest["clear_through"] == 21_000.0


def test_recorded_figure_ignores_projected_lines(world):
    from app.services import forecast as fc

    w = world
    client, me, card, db = w["client"], w["me"], w["card"], w["db"]
    # An unrecorded subscription occurrence inside the cycle closing Mar 3.
    stream = _subscription(client, me, card, "2027-02-28", 500, "Streaming")
    clear_through = _latest(client, me, card)["clear_through"]
    assert clear_through == 55_000.0

    db.expire_all()
    payables = fc.payables_by_currency(db, me["id"], days=30)
    (march,) = [p for p in payables if p and p.get("source") == "statement"
                and p["source_id"] == card and p["statement_close"] == "2027-03-03"]
    assert march["amount"] > clear_through

    assert _due(client, me)[card]["clear_through"] == clear_through

    _pay_full(client, me, card, w["checking"], clear_through)
    body = _snapshot(client, me)
    assert card not in {i["account_id"] for i in body["card_statements_due"]}
    (charges,) = [c for c in body["card_charges"] if c["account_id"] == card]
    (missed,) = [m for m in charges["missed"] if m["entry_id"] == stream]
    assert missed["unlinked_count"] > 0


def test_projected_only_closed_cycle_is_not_listed(world):
    w = world
    client, me = w["client"], w["me"]
    card = _card(client, me, "Card P")
    _set_payer(client, me, card, w["checking"])
    stream = _subscription(client, me, card, "2027-02-28", 500, "Projected only")

    body = _snapshot(client, me)
    assert card not in {i["account_id"] for i in body["card_statements_due"]}
    # The occurrence is real: the card lists it as missed.
    (charges,) = [c for c in body["card_charges"] if c["account_id"] == card]
    assert stream in {m["entry_id"] for m in charges["missed"]}


def test_foreign_funding_keeps_the_card_currency(world):
    from app.models.account import Account

    w = world
    client, me, card, db = w["client"], w["me"], w["card"], w["db"]
    usd = _account(client, me, "Dollars", "savings", balance=5_000, currency="USD")
    # The API refuses routing across currencies now, so this is a route stored
    # before that rule, written directly. The conftest rates hold USD and PHP.
    db.query(Account).filter(Account.id == card).update({"payment_account_id": usd})
    db.commit()
    clear_through = _latest(client, me, card)["clear_through"]

    body = _snapshot(client, me)
    (item,) = [i for i in body["card_statements_due"] if i["account_id"] == card]
    assert (item["currency"], item["clear_through"]) == ("PHP", clear_through)
    assert clear_through == 55_000.0
    # The statement payable, by contrast, is in the paying account's currency.
    (payable,) = [p for p in body["payables"] if p.get("source") == "statement"
                  and p["source_id"] == card and p["statement_close"] == "2027-03-03"]
    assert payable["currency"] == "USD"


def test_overdue_turns_at_manila_midnight(world, monkeypatch):
    w = world
    client, me, card = w["client"], w["me"], w["card"]

    pin_clock(monkeypatch, datetime(2027, 3, 24, 15, 59))
    assert _latest(client, me, card)["close_date"] == "2027-03-03"
    item = _due(client, me)[card]
    assert (item["overdue"], item["oldest_due"]) == (False, "2027-03-24")

    pin_clock(monkeypatch, datetime(2027, 3, 24, 16, 1))
    item = _due(client, me)[card]
    assert (item["overdue"], item["oldest_due"], item["close_date"]) == (
        True, "2027-03-24", "2027-03-03")


# --- who gets it ------------------------------------------------------------------------------

def test_per_role(sw_client, sw_db, sw_people, monkeypatch):
    from app.models.account import Account

    client, db = sw_client, sw_db
    pin_clock(monkeypatch, REF)
    a = sw_people("Alice", "Owner")
    b = sw_people("Bea", "Editor")
    v = sw_people("Vic", "Viewer")
    d = sw_people("Dee", "Admin")
    c = sw_people("Cal", "Third")
    # A's Checking is A's alone; D administers the card only.
    a_checking = _account(client, a, "Alice checking", balance=50_000)
    joint = sw_post(client, a, "/accounts/", {
        "name": "Joint card", "account_type": "credit", "balance": 0, "credit_limit": 77_777,
        "billing_cycle_start": 3, "days_until_due_date": 21, "payment_account_id": a_checking,
        "tag_ids": [hh_household(db, a)]})["id"]
    _debit(client, a, joint, "2027-02-20", 5_000)
    for who, role in ((b, "editor"), (d, "admin"), (v, "viewer")):
        sw_share(db, joint, who["id"], role, a["id"])
    hh_tag_share(db, a, c)

    latest = _latest(client, a, joint)
    assert (latest["close_date"], latest["clear_through"]) == ("2027-03-03", 5_000.0)

    for who in (a, d):
        item = _due(client, who)[joint]
        assert (item["clear_through"], item["statement_count"], item["overdue"]) == (
            5_000.0, 1, False)
    for who in (b, v, c):
        assert _snapshot(client, who)["card_statements_due"] == []

    # An owner's card with no limit is listed; an inactive one is not.
    no_limit = _card(client, a, "No-limit card", limit=None)
    _set_payer(client, a, no_limit, a_checking)
    _debit(client, a, no_limit, "2027-02-20", 700)
    inactive = _card(client, a, "Old card")
    _set_payer(client, a, inactive, a_checking)
    _debit(client, a, inactive, "2027-02-20", 900)
    assert _latest(client, a, inactive)["clear_through"] == 900.0
    db.query(Account).filter(Account.id == inactive).update({"is_active": False})
    db.commit()
    due = _due(client, a)
    assert list(due) == [joint, no_limit]
    assert due[no_limit]["clear_through"] == 700.0


# --- the payables are unchanged ---------------------------------------------------------------

def test_payables_unchanged(sw, sw_client, sw_db, monkeypatch):
    from app.services import forecast as fc

    client, db = sw_client, sw_db
    a, v = sw["a"], sw["v"]
    pin_clock(monkeypatch, REF)
    card = sw_post(client, a, "/accounts/", {
        "name": "Joint card", "account_type": "credit", "balance": 0, "credit_limit": 50_000,
        "billing_cycle_start": 3, "days_until_due_date": 21,
        "payment_account_id": sw["joint"]})["id"]
    sw_share(db, card, v["id"], "viewer", a["id"])
    _debit(client, a, card, "2027-02-20", 5_000)
    rent = sw_post(client, a, "/budget-entries/", {
        "name": "Joint rent", "entry_type": "expense", "amount": 1_000, "cadence": "monthly",
        "next_occurrence": "2027-03-25T00:00:00", "account_id": sw["joint"]})["id"]
    assert _latest(client, a, card)["clear_through"] == 5_000.0

    def by_source(rows, source, source_id):
        return [p for p in rows if p and p.get("source") == source and p["source_id"] == source_id]

    db.expire_all()
    direct = fc.payables_by_currency(db, a["id"], days=30)
    (statement,) = by_source(direct, "statement", card)
    (entry,) = by_source(direct, "budget_entry", rent)
    assert set(statement) == STATEMENT_PAYABLE_KEYS
    assert set(entry) == ENTRY_PAYABLE_KEYS

    body = _snapshot(client, a)
    assert body["card_statements_due"][0]["account_id"] == card
    (statement,) = by_source(body["payables"], "statement", card)
    (entry,) = by_source(body["payables"], "budget_entry", rent)
    assert set(statement) == STATEMENT_PAYABLE_KEYS
    assert set(entry) == SNAPSHOT_ENTRY_PAYABLE_KEYS

    # The viewer sees the joint account's rows Limited, in their public shape.
    db.expire_all()
    limited = [p for p in fc.payables_by_currency(db, v["id"], days=30)
               if p.get("view") == "limited"]
    snapshot_limited = [p for p in _snapshot(client, v)["payables"] if p.get("view") == "limited"]
    assert limited and snapshot_limited
    assert all(set(p) == LIMITED_KEYS for p in limited + snapshot_limited)

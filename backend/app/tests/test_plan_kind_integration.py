"""``plan_kind`` (STU-511): which Transactions card tab lists a recurring
entry's occurrences, on every row shape that carries ``kind`` from an entry.

``installment`` for a card installment (capped, not a bill); ``subscription``
for an open-ended card subscription, or an open-ended bank expense the user
marked ``billing_kind`` subscription; null otherwise (Due and Upcoming). The
shapes: a card charge, a card missed row, ``snapshot.missed``, a snapshot
``payables`` row, a snapshot ``upcoming_this_month`` row and an upcoming
occurrence. Limited rows and transaction-sourced charges carry none. Skips
without a database.
"""
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_recurring_missed_integration import _account, _card, _put, pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
# Every entry is due monthly from Sep 28: one missed month (Sep 28) and one in
# the next 30 days (Oct 28), so each shape that lists the entry has a row.
NEXT = "2026-09-28"
CAPPED = {"end_mode": "after_occurrences", "max_occurrences": 6}
ON_DATE = {"end_mode": "on_date", "end_date": "2027-06-30T00:00:00"}


def _entry(client, who, account_id, name, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": 1_000, "cadence": "monthly",
        "next_occurrence": f"{NEXT}T00:00:00", "account_id": account_id, **extra})["id"]


def _set(db, entry_id, **values) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in values)
    db.execute(text(f"UPDATE budget_entries SET {sets} WHERE id = :id"),
               {**values, "id": entry_id})
    db.commit()


def _get(client, who, path, **params) -> dict:
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _shapes(client, who) -> dict:
    """``{entry id: {shape: [plan_kind, ...]}}`` over every shape that lists the
    entry. ``row["plan_kind"]`` (not ``.get``): a row without the key fails."""
    snap = _get(client, who, "/dashboard/snapshot")
    upcoming = _get(client, who, "/budget-entries/upcoming-occurrences",
                    start_date="2026-10-19T00:00:00Z", end_date="2026-11-17T23:59:59Z",
                    limit=500)
    out: dict = {}

    def add(entry_id, shape, row):
        out.setdefault(entry_id, {}).setdefault(shape, []).append(row["plan_kind"])

    for card in snap["card_charges"]:
        for row in card["charges"]:
            if row.get("view") != "limited" and row["source"] == "budget_entry":
                add(row["source_id"], "card_charge", row)
        for row in card["missed"]:
            add(row["entry_id"], "card_missed", row)
    for row in snap["missed"]:
        add(row["entry_id"], "missed", row)
    for shape in ("payables", "upcoming_this_month"):
        for row in snap[shape]:
            if row.get("source") == "budget_entry" and row.get("view") != "limited":
                add(row["source_id"], shape, row)
    for row in upcoming["items"]:
        add(row["entry_id"], "upcoming_occurrence", row)
    return out


@pytest.fixture
def me(sw_client, sw_people, sw_db, monkeypatch):
    who = sw_people()
    checking = _account(sw_client, who)
    savings = _account(sw_client, who, "Savings", "savings", 0)
    card = _card(sw_client, who, checking)
    pin_clock(monkeypatch, REF)
    return SimpleNamespace(client=sw_client, db=sw_db, who=who, checking=checking,
                           savings=savings, card=card)


CARD_SHAPES = {"card_charge", "card_missed", "upcoming_this_month", "upcoming_occurrence"}
CAPPED_CARD_SHAPES = {"card_charge", "missed", "upcoming_this_month", "upcoming_occurrence"}
BANK_SHAPES = {"missed", "payables", "upcoming_this_month", "upcoming_occurrence"}


def test_plan_kind_on_every_shape(me):
    client, db, who, card, bank = me.client, me.db, me.who, me.card, me.checking
    utilities = sw_post(client, who, "/categories/", {"name": "Utilities"})["id"]
    netflix = _entry(client, who, card, "Netflix")
    _set(db, netflix, billing_kind=None)  # null and not Utilities: still a subscription
    asics = _entry(client, who, card, "Asics", **ON_DATE)
    meralco = _entry(client, who, card, "Meralco", category_id=utilities)
    tablet = _entry(client, who, card, "Tablet", **CAPPED)
    globe = _entry(client, who, card, "Globe", billing_kind="bill", **CAPPED)
    rent = _entry(client, who, bank, "Rent")
    spotify = _entry(client, who, bank, "Spotify", billing_kind="subscription")
    gym = _entry(client, who, bank, "Gym", billing_kind="subscription", **ON_DATE)
    cleared = _entry(client, who, bank, "Cleared", billing_kind="subscription")
    _put(client, who, cleared, {"billing_kind": None})
    salary = _entry(client, who, bank, "Salary", entry_type="income")
    save = _entry(client, who, bank, "Save", transfer_to_account_id=me.savings)

    expected = {
        netflix: ("subscription", CARD_SHAPES),
        asics: (None, CARD_SHAPES),
        meralco: (None, CARD_SHAPES),
        tablet: ("installment", CAPPED_CARD_SHAPES),
        globe: (None, CAPPED_CARD_SHAPES),
        rent: (None, BANK_SHAPES),
        spotify: ("subscription", BANK_SHAPES),
        gym: (None, BANK_SHAPES),
        cleared: (None, BANK_SHAPES),
        salary: (None, BANK_SHAPES - {"payables"}),  # income and transfers are no payables
        save: (None, BANK_SHAPES - {"payables"}),
    }
    shapes = _shapes(client, who)
    for entry_id, (plan_kind, listed) in expected.items():
        assert set(shapes.get(entry_id, {})) == listed, (entry_id, shapes.get(entry_id))
        for shape, values in shapes[entry_id].items():
            assert values and all(v == plan_kind for v in values), (entry_id, shape, values)


def test_a_bank_subscription_mark_is_kept_and_cleared(me):
    """Parent-passing guard: the API already stores ``billing_kind`` as sent on a
    bank entry and clears it on a PUT with null, so commit 7b needs no API change."""
    client, who = me.client, me.who
    created = sw_post(client, who, "/budget-entries/", {
        "name": "Spotify", "entry_type": "expense", "amount": 279, "cadence": "monthly",
        "next_occurrence": "2026-11-01T00:00:00", "account_id": me.checking,
        "billing_kind": "subscription"})
    assert (created["billing_kind"], created["kind"]) == ("subscription", "cash")
    assert _get(client, who, f"/budget-entries/{created['id']}")["billing_kind"] == "subscription"
    cleared = _put(client, who, created["id"], {"billing_kind": None})
    assert (cleared["billing_kind"], cleared["kind"]) == (None, "cash")
    assert _get(client, who, f"/budget-entries/{created['id']}")["billing_kind"] is None


def test_transaction_sourced_card_charges_carry_null(me):
    client, who, card = me.client, me.who, me.card
    netflix = _entry(client, who, card, "Netflix")
    pending = sw_post(client, who, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": 1_000,
        "description": "Netflix extra", "transaction_date": "2026-10-21T00:00:00",
        "is_posted": False, "budget_entry_id": netflix})["id"]
    loose = sw_post(client, who, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": 50,
        "description": "Coffee", "transaction_date": "2026-10-20T00:00:00",
        "is_posted": False})["id"]

    snap = _get(client, who, "/dashboard/snapshot")
    rows = {row["source_id"]: row for c in snap["card_charges"] for row in c["charges"]
            if row["source"] == "transaction"}
    assert rows[pending]["recurring"] is True and rows[loose]["recurring"] is False
    assert (rows[pending]["plan_kind"], rows[loose]["plan_kind"]) == (None, None)
    entry_rows = [row for c in snap["card_charges"] for row in c["charges"]
                  if row["source"] == "budget_entry" and row["source_id"] == netflix]
    assert entry_rows and all(row["plan_kind"] == "subscription" for row in entry_rows)


def test_limited_rows_carry_no_plan_kind(sw, sw_client, monkeypatch):
    client, a, v = sw_client, sw["a"], sw["v"]
    rent = _entry(client, a, sw["joint"], "Joint rent")
    sw_post(client, a, "/budget-entries/", {
        "name": "Joint stream", "entry_type": "expense", "amount": 300, "cadence": "monthly",
        "next_occurrence": "2026-10-25T00:00:00", "account_id": sw["joint"],
        "billing_kind": "subscription"})
    pin_clock(monkeypatch, REF)

    full = _get(client, a, "/dashboard/snapshot")
    assert [row["plan_kind"] for row in full["payables"]
            if row.get("source") == "budget_entry" and row["source_id"] == rent]
    snap = _get(client, v, "/dashboard/snapshot")
    for shape in ("payables", "upcoming_this_month"):
        limited = [row for row in snap[shape] if row.get("view") == "limited"]
        assert limited, shape
        assert all("plan_kind" not in row for row in limited), shape

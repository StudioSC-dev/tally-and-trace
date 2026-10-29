"""A held installment month is counted once, as its possible duplicate
(STU-343 Plan B, B2 commit 6). Skips without a database.

Reference Sunday 2026-10-18, 10:00 in Manila. O owns Checking (50,000) and Card
C (closes on the 24th, due 21 days later, paid from Checking, limit 128,000,
tagged with O's Household tag). "Tablet" is O's 5,000 on the 5th, capped at
24, next 2026-07-05. Jul 5 is recorded, so Tablet is at Aug 5 with 23 left,
and O typed a 5,000 charge on Aug 7 by hand: Aug 5 is held by it.

The reviewed flag is written straight to the row. Linking the charge and
posting anyway go through the real review endpoint (``GET`` then ``POST
/budget-entries/{id}/auto-post-review``), so a change to the router's
``hold_duplicates`` argument fails them.
"""
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, hh_household, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)    # Sunday, 10:00 in Manila
WALL = datetime(2026, 10, 18, 10, 0)  # the same instant on Manila's wall clock
START = datetime(2026, 10, 18)        # the window start: Manila midnight
TODAY = date(2026, 10, 18)
FIVE = Decimal("5000")
AUG_5 = date(2026, 8, 5)


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name, account_type, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _installment(client, who, card, name="Tablet", next_day="2026-07-05", remaining=24):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": remaining})["id"]


def _charge(client, who, card, when, is_posted=True):
    return sw_post(client, who, "/transactions/", {
        "account_id": card, "amount": 5_000, "transaction_type": "debit",
        "description": "Typed from the statement", "is_posted": is_posted,
        "transaction_date": f"{when}T00:00:00"})["id"]


def _reviewed(db, entry_id, reviewed=True):
    db.execute(text("UPDATE budget_entries SET installment_reviewed_at = "
                    "CASE WHEN :r THEN now() ELSE NULL END, auto_post_enabled = :r "
                    "WHERE id = :id"), {"r": reviewed, "id": entry_id})
    db.commit()


def _locked(db, who, entry_id):
    from app.core import locking
    from app.models.user import User

    db.rollback()
    db.expire_all()
    locking.lock_owner_budgets(db, who["id"])
    return locking.lock_entry(db, entry_id), db.get(User, who["id"])


def _record(db, who, entry_id, day):
    """Mark paid on ``day`` (``record_occurrence`` under the locks)."""
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services import posting

    entry, actor = _locked(db, who, entry_id)
    outcome = posting.record_occurrence(db, entry, actor, BudgetEntryMaterialize(),
                                        datetime.combine(day, datetime.min.time())).outcome
    db.commit()
    return outcome


def _review_post(w, entry_id, links=()):
    """The review as the endpoint runs it: the GET (which must list the Aug 7
    charge as Aug 5's candidate), then the POST with the GET's token and the
    chosen links. Returns the POST's outcomes."""
    client, o = w["client"], w["o"]
    r = client.get(f"{API}/budget-entries/{entry_id}/auto-post-review", headers=o["headers"])
    assert r.status_code == 200, r.text
    review = r.json()
    assert [(c["occurrence_date"], [t["date"] for t in c["transactions"]])
            for c in review["candidates"]] == [("2026-08-05", ["2026-08-07"])]
    body = {"entry_version": review["entry_version"], "review_token": review["review_token"],
            "links": [{"transaction_id": t, "occurrence_date": d.isoformat()}
                      for t, d in links]}
    r = client.post(f"{API}/budget-entries/{entry_id}/auto-post-review", json=body,
                    headers=o["headers"])
    assert r.status_code == 200, r.text
    return [o_["outcome"] for o_ in r.json()["outcomes"]]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    client, db = sw_client, sw_db
    o = sw_people("Olive", "Owner")
    checking = _account(client, o, "Checking", "checking", 50_000)
    card = _account(client, o, "Card C", "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking,
                    credit_limit=128_000, tag_ids=[hh_household(db, o)])
    pin_clock(monkeypatch, REF)
    tablet = _installment(client, o, card)
    return {"client": client, "db": db, "o": o, "checking": checking, "card": card,
            "tablet": tablet}


def _held_world(w, *, reviewed=True, is_posted=True):
    """Tablet reviewed (or not), Jul 5 recorded, and O's own Aug 7 charge."""
    db, o = w["db"], w["o"]
    _reviewed(db, w["tablet"], reviewed)
    assert _record(db, o, w["tablet"], date(2026, 7, 5)).value == "created"
    return _charge(w["client"], o, w["card"], "2026-08-07", is_posted=is_posted)


def _statements(db, who, days=60):
    """Card C's statement payables: ``(due_date, statement_close, amount)``."""
    from app.services.forecast import payables_by_currency

    db.rollback()
    db.expire_all()
    return [(p["due_date"], p["statement_close"], Decimal(str(p["amount"])))
            for p in payables_by_currency(db, who["id"], days=days, reference=WALL)
            if p["source"] == "statement"]


def _opening(client, who, card):
    r = client.get(f"{API}/cards/{card}/credit", headers=who["headers"])
    assert r.status_code == 200, r.text
    credit = r.json()["credit"]
    return {**credit["opening"], "available_now": credit["available_now"]}


def _held(db, entry_id):
    from app.models.budget_entry import BudgetEntry
    from app.services.installment_duplicates import held_occurrences

    db.rollback()
    db.expire_all()
    return {key for key in held_occurrences(db, [db.get(BudgetEntry, entry_id)], TODAY)
            if key[0] == entry_id}


# Jul 5 recorded, the Aug 7 charge, Sep 5 and Oct 5 projected (due, settled as
# recorded), Nov 5 projected. Aug 5 is held, so the Aug 24 statement has only
# the charge: 5,000, not 10,000.
HELD_ONCE = [
    ("2026-10-18", "2026-07-24", FIVE),
    ("2026-10-18", "2026-08-24", FIVE),
    ("2026-10-18", "2026-09-24", FIVE),
    ("2026-11-14", "2026-10-24", FIVE),
    ("2026-12-15", "2026-11-24", FIVE),
]


def test_held_month_is_counted_once_in_payables(world):
    w = world
    db, o = w["db"], w["o"]
    charge = _held_world(w)
    assert _held(db, w["tablet"]) == {(w["tablet"], AUG_5)}

    before = _statements(db, o)
    assert before == HELD_ONCE

    # The review links the charge to Aug 5 and records the rest: nothing moves.
    assert _review_post(w, w["tablet"], [(charge, AUG_5)]) == [
        "already_posted", "created", "created"]
    assert _statements(db, o) == before
    assert _held(db, w["tablet"]) == set()


@pytest.mark.parametrize("is_posted", [True, False], ids=["posted", "pending"])
def test_held_month_is_counted_once_in_the_hold(world, is_posted):
    """Tablet's 23 remaining months less the held Aug 5 are held: 110,000. The
    charge is counted once where it stands: the balance when posted, or
    ``pending_total`` while pending (dated Aug 7, before today, so ``now``;
    STU-404's placement)."""
    w = world
    client, o, card = w["client"], w["o"], w["card"]
    _held_world(w, is_posted=is_posted)

    expected = {
        "balance_owed": 10_000.0 if is_posted else 5_000.0,
        "pending_total": 0.0 if is_posted else 5_000.0,
        "installment_hold": 110_000.0,
        "missed_total": 0.0,
        "available_now": 8_000.0,
    }
    assert _opening(client, o, card) == expected


def test_household_view_counts_a_held_month_once(world, monkeypatch):
    """The household settlement of Card C owes, per statement, what the statement
    payables say: the Aug 24 statement owes the charge alone."""
    from app.core.access import RecordAccess, own_household_grant, viewable_account_ids
    from app.services import household

    w = world
    client, db, o = w["client"], w["db"], w["o"]
    _held_world(w)
    client.put(f"{API}/budget-entries/{w['tablet']}", json={"tag_ids": [hh_household(db, o)]},
               headers=o["headers"]).raise_for_status()

    settled = []
    real = household._settle_with_sources

    def spy(cycles, *args, **kwargs):
        owed, in_scope = real(cycles, *args, **kwargs)
        settled.append((cycles, owed))
        return owed, in_scope

    monkeypatch.setattr(household, "_settle_with_sources", spy)
    end = START + timedelta(days=61)
    db.rollback()
    db.expire_all()
    occurrences = household.household_occurrences(
        db, own_household_grant(db, o["id"]), [], START, end, recorded=False,
        viewable_ids=viewable_account_ids(db, o["id"]), access=RecordAccess(db, o["id"]))

    # The first settlement is the window's own; later ones are per-due covers.
    cycles, owed = settled[0]
    by_close = {c["close"].date().isoformat(): amount
                for c, amount in zip(cycles, owed) if amount > 0 and c["due"] < end}
    assert by_close == {close: amount for _, close, amount in _statements(db, o)}
    assert by_close["2026-08-24"] == FIVE
    listed = [occ.date for occ in occurrences if occ.record.id == w["tablet"]]
    assert listed == [datetime(2026, 11, 5), datetime(2026, 12, 5)]


def test_posting_anyway_adds_the_month(world):
    """The review with no link records the uncut walk: Aug 5 is posted beside
    the charge, and the Aug 24 statement (due Sep 14, overdue) rises by 5,000."""
    w = world
    client, db, o, card = w["client"], w["db"], w["o"], w["card"]
    _held_world(w)
    assert _statements(db, o) == HELD_ONCE

    assert _review_post(w, w["tablet"]) == ["created", "created", "created"]

    after = _statements(db, o)
    assert after == [
        ("2026-10-18", "2026-07-24", FIVE),
        ("2026-10-18", "2026-08-24", Decimal("10000")),
        *HELD_ONCE[2:],
    ]
    # Both are on the card now; the hold has Nov 5 onward (20 months).
    assert _opening(client, o, card) == {
        "balance_owed": 25_000.0, "pending_total": 0.0, "installment_hold": 100_000.0,
        "missed_total": 0.0, "available_now": 3_000.0}


def test_unreviewed_entries_are_unaffected_by_the_held_rule(world):
    """Guard (passes at the parent too): an unreviewed Tablet is outside every
    universe, so nothing is held and Plan C's figures stand. Its lapsed Aug 5
    is dropped by the lapsed rule, and the hold keeps all 23 months."""
    w = world
    client, db, o, card = w["client"], w["db"], w["o"], w["card"]
    _held_world(w, reviewed=False)

    assert _held(db, w["tablet"]) == set()
    assert _statements(db, o) == [
        ("2026-10-18", "2026-07-24", FIVE),
        ("2026-10-18", "2026-08-24", FIVE),
        ("2026-11-14", "2026-10-24", FIVE),
        ("2026-12-15", "2026-11-24", FIVE),
    ]
    assert _opening(client, o, card) == {
        "balance_owed": 10_000.0, "pending_total": 0.0, "installment_hold": 115_000.0,
        "missed_total": 0.0, "available_now": 3_000.0}

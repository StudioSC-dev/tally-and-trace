"""New card installments are charged on the statement close (PR3).

A card installment created on a card with a statement cycle is stored monthly,
anchored on the card's close day, with ``next_occurrence`` moved to the close
of the statement that holds the submitted day. An update never converts a row:
it is refused (422) only when it would take an entry already on the close off
it. A card close-day change is refused (409) while installments with payments
left remain on the card. Skips without a database.

Reference: Wednesday 2026-11-04, 02:00 UTC (10:00 in Manila). "Card C" closes
on the 2nd with its due 21 days later; "Card A" closes on the 4th with its due
25 days later (4 Nov's computed due, Sun 29 Nov, rolls past Bonifacio Day to
Tue 1 Dec).
"""
import os
import threading
import time
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 4, 2, 0)
CLOSE_MESSAGE = "This installment is charged on the statement close"
MONTHLY_MESSAGE = "A card installment is charged monthly on the statement close"


# --- helpers ----------------------------------------------------------------------------------

def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, close=2, days=21, name="Card C", **extra):
    return _account(client, who, name, "credit", 0, billing_cycle_start=close,
                    days_until_due_date=days, credit_limit=200_000, **extra)


def _create(client, who, account_id, day, *, expect=201, payments=3, **extra):
    body = {"name": "Laptop plan", "entry_type": "expense", "amount": 1_000,
            "cadence": "monthly", "next_occurrence": f"{day}T00:00:00",
            "account_id": account_id, "end_mode": "after_occurrences",
            "max_occurrences": payments, **extra}
    body = {k: v for k, v in body.items() if v is not None or k in extra}
    r = client.post(f"{API}/budget-entries/", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _put(client, who, entry_id, body, expect=200):
    r = client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _form_payload(stored, **changes):
    """What ``RecurringEntryFormModal`` sends on an edit with nothing but ``changes``:
    the schedule fields re-sent as loaded, the day fields omitted (unchanged)."""
    body = {
        "name": stored["name"], "entry_type": stored["entry_type"], "amount": stored["amount"],
        "currency": stored["currency"], "account_id": stored["account_id"],
        "overflow_account_id": None, "transfer_to_account_id": None,
        "cadence": stored["cadence"], "next_occurrence": stored["next_occurrence"],
        "lead_time_days": stored["lead_time_days"], "is_autopay": stored["is_autopay"],
        "is_active": stored["is_active"], "end_mode": stored["end_mode"],
        "max_occurrences": stored["max_occurrences"],
    }
    body.update(changes)
    return body


def _schedule(entry):
    return (entry["next_occurrence"][:10], entry["anchor_day"], entry["day_rule"],
            entry["cadence"], entry["max_occurrences"], entry["occurrences_paid_offset"])


def _update_card(client, who, card, body, expect=200):
    r = client.put(f"{API}/accounts/{card}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    savings = _account(sw_client, me, "Savings", "savings", balance=100_000)
    card = _card(sw_client, me, payment_account_id=savings)
    return {"client": sw_client, "db": sw_db, "me": me, "savings": savings, "card": card,
            "people": sw_people, "monkeypatch": monkeypatch}


# --- create -----------------------------------------------------------------------------------

def test_create_snaps_to_close(world):
    client, me, card = world["client"], world["me"], world["card"]
    entry = _create(client, me, card, "2026-11-25")
    assert _schedule(entry) == ("2026-12-02", 2, None, "monthly", 3, 0)
    # The submitted time of day is kept.
    later = _create(client, me, card, "2026-11-25", next_occurrence="2026-11-25T09:30:00")
    assert later["next_occurrence"].startswith("2026-12-02T09:30:00")


def test_create_on_close_is_kept(world):
    client, me, card = world["client"], world["me"], world["card"]
    entry = _create(client, me, card, "2026-12-02")
    assert _schedule(entry) == ("2026-12-02", 2, None, "monthly", 3, 0)
    # A day before the close is on that same statement.
    assert _schedule(_create(client, me, card, "2026-11-30"))[0] == "2026-12-02"
    # The anchor the form's "Same as date" sends for a close date is accepted too.
    assert _schedule(_create(client, me, card, "2026-12-02", anchor_day=2))[:3] == (
        "2026-12-02", 2, None)


def test_create_keeps_max_occurrences_and_offset(world):
    client, me, card = world["client"], world["me"], world["card"]
    entry = _create(client, me, card, "2026-11-25", payments=3)
    assert (entry["max_occurrences"], entry["occurrences_paid_offset"]) == (3, 0)
    offset = _create(client, me, card, "2026-11-25", payments=5, occurrences_paid_offset=2)
    assert (offset["max_occurrences"], offset["occurrences_paid_offset"]) == (5, 2)


def test_create_non_monthly_card_installment_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    for cadence in ("weekly", "semi_monthly", "quarterly"):
        r = _create(client, me, card, "2026-11-25", cadence=cadence, expect=422)
        assert r["detail"] == MONTHLY_MESSAGE


def test_create_with_day_rule_or_other_anchor_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    assert _create(client, me, card, "2026-11-30", day_rule="last_weekday",
                   expect=422)["detail"] == CLOSE_MESSAGE
    # What an older form sends: the submitted day as the anchor.
    assert _create(client, me, card, "2026-11-25", anchor_day=25, day_rule=None,
                   expect=422)["detail"] == CLOSE_MESSAGE
    # Explicit nulls are read as not sent.
    entry = _create(client, me, card, "2026-11-25", anchor_day=None, day_rule=None)
    assert _schedule(entry)[:3] == ("2026-12-02", 2, None)


def test_create_predicate_excludes_income_transfer_and_bill(world):
    client, me, card, savings = world["client"], world["me"], world["card"], world["savings"]
    income = _create(client, me, card, "2026-11-25", entry_type="income")
    assert _schedule(income)[:3] == ("2026-11-25", 25, None)
    bill = _create(client, me, card, "2026-11-25", billing_kind="bill")
    assert _schedule(bill)[:3] == ("2026-11-25", 25, None)
    checking = _account(client, me, "Checking", balance=10_000)
    transfer = _create(client, me, checking, "2026-11-25", transfer_to_account_id=savings)
    assert _schedule(transfer)[:3] == ("2026-11-25", 25, None)
    # Open-ended on the card: a subscription, stored as sent.
    open_ended = _create(client, me, card, "2026-11-25", end_mode="indefinite",
                         max_occurrences=None)
    assert _schedule(open_ended)[:3] == ("2026-11-25", 25, None)
    # Non-monthly non-installments are not refused.
    _create(client, me, card, "2026-11-25", entry_type="income", cadence="weekly")


def test_create_on_card_without_cycle_is_unchanged(world):
    client, me = world["client"], world["me"]
    plain = _account(client, me, "Plain card", "credit", 0, credit_limit=10_000)
    entry = _create(client, me, plain, "2026-11-25", cadence="weekly")
    assert _schedule(entry)[:4] == ("2026-11-25", None, None, "weekly")
    monthly = _create(client, me, plain, "2026-11-25", anchor_day=25)
    assert _schedule(monthly)[:3] == ("2026-11-25", 25, None)


def test_legacy_due_date_card_create_anchors_on_derived_close(world):
    """Due day 23 with 21 days until due closes on the 2nd."""
    client, me = world["client"], world["me"]
    legacy = _account(client, me, "Legacy card", "credit", 0, due_date=23,
                      days_until_due_date=21, credit_limit=50_000)
    entry = _create(client, me, legacy, "2026-11-25")
    assert _schedule(entry)[:3] == ("2026-12-02", 2, None)


def test_web_shaped_create_off_close_date_snaps(world):
    """The form's create payload for a card installment: no day fields at all."""
    client, me, card = world["client"], world["me"], world["card"]
    r = client.post(f"{API}/budget-entries/", json={
        "name": "Phone plan", "entry_type": "expense", "amount": 1_500, "currency": "PHP",
        "account_id": card, "cadence": "monthly", "next_occurrence": "2026-11-25T00:00:00.000Z",
        "lead_time_days": 0, "is_autopay": False, "is_active": True,
        "end_mode": "after_occurrences", "max_occurrences": 6, "tag_ids": [],
    }, headers=me["headers"])
    assert r.status_code == 201, r.text
    assert _schedule(r.json()) == ("2026-12-02", 2, None, "monthly", 6, 0)


# --- update -----------------------------------------------------------------------------------

def _legacy_row(db, me, card, day=datetime(2026, 11, 28)):
    """A card installment stored before this change: anchored on its own day."""
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    entry = BudgetEntry(user_id=me["id"], name="Legacy plan", entry_type=BudgetEntryType.EXPENSE,
                        amount=1_000, cadence=RecurrenceFrequency.MONTHLY, next_occurrence=day,
                        anchor_day=day.day, account_id=card, end_mode="after_occurrences",
                        max_occurrences=4, occurrences_paid_offset=1)
    db.add(entry)
    db.commit()
    return entry.id


def _get(client, who, entry_id):
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def test_form_shaped_rename_on_legacy_row_is_noop(world):
    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    entry_id = _legacy_row(db, me, card)
    stored = _get(client, me, entry_id)
    assert _schedule(stored) == ("2026-11-28", 28, None, "monthly", 4, 1)
    saved = _put(client, me, entry_id, _form_payload(stored, name="Legacy plan renamed"))
    assert saved["name"] == "Legacy plan renamed"
    assert _schedule(saved) == _schedule(stored)


def test_form_shaped_save_on_normalised_row_is_ok(world):
    client, me, card = world["client"], world["me"], world["card"]
    stored = _create(client, me, card, "2026-11-25")
    saved = _put(client, me, stored["id"], _form_payload(stored, name="Renamed", amount=1_200))
    assert (saved["name"], saved["amount"]) == ("Renamed", 1_200)
    assert _schedule(saved) == _schedule(stored)
    # Moving to a later close keeps it on the close.
    moved = _put(client, me, stored["id"], {"next_occurrence": "2027-01-02T00:00:00"})
    assert _schedule(moved)[:3] == ("2027-01-02", 2, None)


def test_normalised_anchor_or_cadence_change_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    stored = _create(client, me, card, "2026-11-25")
    for body in ({"anchor_day": 3, "next_occurrence": "2026-12-03T00:00:00"},
                 {"anchor_day": None},
                 {"day_rule": "last_weekday", "next_occurrence": "2026-12-31T00:00:00"},
                 {"cadence": "weekly"},
                 {"cadence": "quarterly"}):
        assert _put(client, me, stored["id"], body, expect=422)["detail"] == CLOSE_MESSAGE
    assert _schedule(_get(client, me, stored["id"])) == _schedule(stored)


def test_normalised_next_occurrence_off_close_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    stored = _create(client, me, card, "2026-11-25")
    r = _put(client, me, stored["id"], _form_payload(
        stored, next_occurrence="2026-12-05T00:00:00"), expect=422)
    assert r["detail"] == CLOSE_MESSAGE
    assert _schedule(_get(client, me, stored["id"])) == _schedule(stored)


def test_update_into_installment_eligibility_stays_legacy(world):
    client, me, card = world["client"], world["me"], world["card"]
    checking = _account(client, me, "Checking", balance=10_000)
    other = _card(client, me, close=5, days=20, name="Card B")
    # A bank installment moved onto the card.
    bank = _create(client, me, checking, "2026-11-25")
    moved = _put(client, me, bank["id"], {"account_id": card})
    assert _schedule(moved)[:3] == ("2026-11-25", 25, None)
    # An open-ended card expense given a cap.
    open_ended = _create(client, me, card, "2026-11-25", end_mode="indefinite",
                         max_occurrences=None)
    capped = _put(client, me, open_ended["id"], {"end_mode": "after_occurrences",
                                                  "max_occurrences": 3})
    assert _schedule(capped)[:3] == ("2026-11-25", 25, None)
    # A card bill switched off "bill".
    bill = _create(client, me, card, "2026-11-25", billing_kind="bill")
    unbilled = _put(client, me, bill["id"], {"billing_kind": None})
    assert _schedule(unbilled)[:3] == ("2026-11-25", 25, None)
    # A normalised entry moved to a card with another close day.
    normalised = _create(client, me, card, "2026-11-25")
    other_card = _put(client, me, normalised["id"], {"account_id": other})
    assert _schedule(other_card)[:3] == ("2026-12-02", 2, None)


# --- downstream -------------------------------------------------------------------------------

def test_normalised_month_posts_on_close_and_bills_that_statement(world):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc
    from app.services.statements import iter_cycles_from

    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    entry = _create(client, me, card, "2026-11-25")
    db.expire_all()
    account = db.get(Account, card)
    cycles = {c["close"].date(): c for c in iter_cycles_from(
        account, date(2026, 11, 1), datetime(2027, 3, 1), due_overrides={})}

    def in_cycle(day: date, close: date) -> bool:
        cycle = cycles[close]
        return cycle["window_start"].date() < day <= close

    model = db.get(BudgetEntry, entry["id"])
    (billed, ) = [occ for e, occ, _ in fc._billed_card_occurrences(
        db, [model], {card: account}, datetime(2026, 11, 4), datetime(2026, 12, 3))]
    assert billed.date() == date(2026, 12, 2)
    assert in_cycle(billed.date(), date(2026, 12, 2))

    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize",
                    json={"occurrence_date": "2026-12-02T00:00:00"}, headers=me["headers"])
    assert r.status_code == 201, r.text
    posted = r.json()
    assert posted["transaction_date"][:10] == "2026-12-02"
    assert in_cycle(date(2026, 12, 2), date(2026, 12, 2))
    after = _get(client, me, entry["id"])
    assert after["next_occurrence"][:10] == "2027-01-02"
    assert (after["max_occurrences"], after["occurrences_paid"]) == (2, 1)


def test_close4_installment_payable_rolls_then_due_override_wins(world):
    from app.services import forecast as fc

    client, db, me, savings = world["client"], world["db"], world["me"], world["savings"]
    card = _card(client, me, close=4, days=25, name="Card A", payment_account_id=savings)
    entry = _create(client, me, card, "2026-11-04")
    assert _schedule(entry)[:3] == ("2026-11-04", 4, None)

    def payable():
        db.expire_all()
        (row,) = [p for p in fc.payables_by_currency(db, me["id"], days=60)
                  if p and p.get("source") == "statement" and p["source_id"] == card
                  and p["statement_close"] == "2026-11-04"]
        return row["statement_close"], row["due_date"]

    assert payable() == ("2026-11-04", "2026-12-01")
    r = client.put(f"{API}/cards/{card}/statements/2026-11-04/due-date",
                   json={"due_date": "2026-12-02"}, headers=me["headers"])
    assert r.status_code == 200, r.text
    assert payable() == ("2026-11-04", "2026-12-02")
    assert _get(client, me, entry["id"])["next_occurrence"][:10] == "2026-11-04"


# --- close-day guard --------------------------------------------------------------------------

INSTALLMENT_GUARD = ("This card has installments charged on its statement close with payments "
                     "left; its closing day can't change until they are paid off")


def test_close_day_change_with_active_installment_is_409(world):
    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    _create(client, me, card, "2026-11-25")
    for body in ({"billing_cycle_start": 5}, {"billing_cycle_start": None},
                 {"account_type": "checking"}):
        assert _update_card(client, me, card, body, expect=409)["detail"] == INSTALLMENT_GUARD
    # The close day it already has, a due-days change and other fields still save.
    _update_card(client, me, card, {"billing_cycle_start": 2, "name": "Card C renamed"})
    _update_card(client, me, card, {"days_until_due_date": 20})
    # A legacy (off-close) installment blocks too.
    other = _card(client, me, close=5, days=20, name="Card B")
    _legacy_row(db, me, other)
    _update_card(client, me, other, {"billing_cycle_start": 6}, expect=409)


def test_close_day_change_with_paused_installment_is_409(world):
    client, me, card = world["client"], world["me"], world["card"]
    entry = _create(client, me, card, "2026-11-25")
    _put(client, me, entry["id"], {"is_active": False})
    _update_card(client, me, card, {"billing_cycle_start": 5}, expect=409)


def test_close_day_change_with_only_completed_installments_is_ok(world):
    client, me, card = world["client"], world["me"], world["card"]
    entry = _create(client, me, card, "2026-11-25", payments=1)
    _put(client, me, entry["id"], {"is_active": False, "max_occurrences": 0})
    # An open-ended card subscription does not block either.
    _create(client, me, card, "2026-11-25", end_mode="indefinite", max_occurrences=None)
    _update_card(client, me, card, {"billing_cycle_start": 5})
    # A card without a cycle gaining one is not a change.
    plain = _account(client, me, "Plain card", "credit", 0, credit_limit=10_000)
    _create(client, me, plain, "2026-11-25")
    _update_card(client, me, plain, {"billing_cycle_start": 2})


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def holder(sw_client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _race(engine, holder, fn):
    """Run ``fn`` in a thread while ``holder`` holds the card; commit once it waits."""
    holder_pid = holder.execute(text("SELECT pg_backend_pid()")).scalar()
    outcome = {}

    def run():
        try:
            outcome["result"] = fn()
        except BaseException as exc:  # re-raised in the test thread
            outcome["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    try:
        worker.start()
        deadline, blocked = time.monotonic() + 10, False
        with engine.connect() as probe:
            while not blocked and worker.is_alive() and time.monotonic() < deadline:
                blocked = bool(probe.execute(text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE pg_blocking_pids(pid) @> ARRAY[CAST(:h AS integer)]"),
                    {"h": holder_pid}).scalar())
                probe.rollback()
                time.sleep(0.05)
        assert blocked, ("the worker did not wait on the holder", outcome)
        holder.commit()
    finally:
        holder.rollback()
        worker.join(20)
    assert not worker.is_alive(), "the worker did not finish"
    if "error" in outcome:
        raise outcome["error"]
    return outcome["result"]


def test_create_vs_close_day_change_serialise(world, engine, holder):
    """Both orders: a close-day change committed first is read by the create; a
    create committed first makes the change a 409. Never an entry off its close."""
    from app.core import locking
    from app.models.budget_entry import BudgetEntry, BudgetEntryType
    from app.models.transaction import RecurrenceFrequency

    client, me, card = world["client"], world["me"], world["card"]
    # 1. The change holds the card; the create waits, then reads close day 5.
    locking.lock_accounts(holder, [card])[card].billing_cycle_start = 5
    holder.flush()
    r = _race(engine, holder, lambda: client.post(f"{API}/budget-entries/", json={
        "name": "Raced plan", "entry_type": "expense", "amount": 1_000, "cadence": "monthly",
        "next_occurrence": "2026-11-25T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": 3}, headers=me["headers"]))
    assert r.status_code == 201, r.text
    assert _schedule(r.json())[:3] == ("2026-12-05", 5, None)

    # 2. A create holds the card (as create does); the change waits, then sees it.
    other = _card(client, me, close=2, days=21, name="Card C2")
    locking.lock_accounts(holder, [other])
    holder.add(BudgetEntry(
        user_id=me["id"], name="Held plan", entry_type=BudgetEntryType.EXPENSE, amount=1_000,
        cadence=RecurrenceFrequency.MONTHLY, next_occurrence=datetime(2026, 12, 2),
        anchor_day=2, account_id=other, end_mode="after_occurrences", max_occurrences=3))
    holder.flush()
    r = _race(engine, holder, lambda: client.put(
        f"{API}/accounts/{other}", json={"billing_cycle_start": 5}, headers=me["headers"]))
    assert r.status_code == 409, r.text

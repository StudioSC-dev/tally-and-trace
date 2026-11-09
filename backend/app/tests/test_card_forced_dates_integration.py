"""Forced dates on card entries (services/payment_dates.py, plan section 3.4).

A card charge can post late and fall into the next statement. The nominal date
stays the occurrence's identity; the effective date is the projected line's
``transaction_date``, which is all a statement reads. Skips without a database.

Reference: Sunday 2026-10-18, 02:00 UTC (10:00 in Manila). "Card" closes on the
24th and is due 21 days later, paid from Checking: the statement of Sep 24 is
closed and fell due on Oct 15, Oct 24 is the open cycle (due Nov 14, a Saturday,
so Nov 16), and Nov 24 follows (due Dec 15).
"""
import threading
import time
from datetime import date, datetime

import pytest
from sqlalchemy import text

from app.routers.accounts import LOAN_FIELDS
from app.services.payment_dates import extend
from app.tests.conftest import API, hh_household, sw_db_reachable, sw_post
from app.tests.test_balance_locking_integration import holder  # noqa: F401
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_payment_date_overrides_integration import (
    _checking, _clear, _edit, _entry, _force, _force_loan, _get, _loan, _mark_paid, _overrides,
    _rows, _snapshot,
)
from app.tests.test_statement_minimum_integration import BDO, _debit, _pay

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)
SEP, OCT, NOV, DEC = "2026-09-24", "2026-10-24", "2026-11-24", "2026-12-24"
TOKEN = "test-job-token"


# --- helpers ----------------------------------------------------------------------------------

def _card(client, who, bank, name="Card", close=24, due_in=21, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "credit", "balance": 0, "billing_cycle_start": close,
        "days_until_due_date": due_in, "payment_account_id": bank, **extra})["id"]


def _subscription(client, who, card, first, kind="subscription", amount=500, **extra):
    return _entry(client, who, card, first, name="Video", amount=amount, billing_kind=kind,
                  **extra)


def _installment(client, who, card, first, months=6, amount=3_000):
    entry = sw_post(client, who, "/budget-entries/", {
        "name": "Tablet", "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{first}T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": months})
    assert entry["kind"] == "installment"
    return entry["id"]


def _review(db, entry):
    """Reviewed and auto-post on, written straight to the row."""
    db.execute(text("UPDATE budget_entries SET installment_reviewed_at = now(), "
                    "auto_post_enabled = true WHERE id = :id"), {"id": entry})
    db.commit()


def _statements(client, who, card, days=90):
    """``{close: (due_date, amount)}`` of the card's statement payables."""
    from app.core.database import SessionLocal
    from app.services.forecast import payables_by_currency

    db = SessionLocal()
    try:
        rows = _rows(payables_by_currency(db, who["id"], days=days), "statement", card)
    finally:
        db.close()
    return {r["statement_close"]: (r["due_date"], r["amount"]) for r in rows}


def _closes(client, who, card, days=90):
    return {close: amount for close, (_, amount) in _statements(client, who, card, days).items()}


def _section(client, who, card):
    (section, *_) = [c for c in _snapshot(client, who)["card_charges"]
                     if c["account_id"] == card] or [{"charges": [], "missed": []}]
    return section


def _charges(client, who, card, entry):
    """``(date, occurrence_date)`` of the entry's rows in the card charges panel."""
    return [(c["date"], c["occurrence_date"]) for c in _section(client, who, card)["charges"]
            if c["source"] == "budget_entry" and c["source_id"] == entry]


def _checks(client, who, card, entry):
    """``(date, occurrence_date, status)`` of the entry's available-credit checks."""
    return [(c["date"], c["occurrence_date"]) for c in _section(client, who, card)["credit"]["checks"]
            if c["source"] == "budget_entry" and c["source_id"] == entry]


def _job(client, **params):
    r = client.post(f"{API}/jobs/post-due-installments", params=params,
                    headers={"X-Job-Token": TOKEN})
    assert r.status_code == 200, r.text
    return r.json()


def _linked(db, entry):
    from app.models.transaction import Transaction

    db.rollback()
    return [(t.transaction_date.date().isoformat(), t.occurrence_date.date().isoformat())
            for t in db.query(Transaction).filter(Transaction.budget_entry_id == entry).order_by(
                Transaction.id).all()]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    pin_clock(monkeypatch, REF)
    me = sw_people()
    bank = _checking(sw_client, me)
    return {"client": sw_client, "db": sw_db, "me": me, "bank": bank,
            "card": _card(sw_client, me, bank), "monkeypatch": monkeypatch}


# --- 1 to 4: a forced date moves the charge between statements ---------------------------------

@pytest.mark.parametrize("kind", ["subscription", "bill"])
def test_forced_past_the_close_joins_the_next_statement(world, kind):
    """Criteria 1 and 2: the owner's case, a charge that posts late."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, "2026-10-20", kind=kind)
    december = ("2027-01-14", 500)
    assert _statements(client, me, card) == {
        OCT: ("2026-11-16", 500), NOV: ("2026-12-15", 500), DEC: december}

    r = _force(client, me, entry, "2026-10-20", "2026-10-26")

    assert r.json() == {"occurrence_date": "2026-10-20", "effective_date": "2026-10-26",
                        "statement_close": NOV, "statement_due": "2026-12-15"}
    assert _statements(client, me, card) == {NOV: ("2026-12-15", 1_000), DEC: december}


def test_a_normalised_installment_moves_and_stays_normalised(world):
    """Criterion 3: the close-day rule reads the schedule, not one line."""
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services.recurring_kinds import is_normalised_installment

    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _installment(client, me, card, OCT)
    assert _closes(client, me, card)[OCT] == 3_000

    _force(client, me, entry, OCT, "2026-10-28")

    closes = _closes(client, me, card)
    assert OCT not in closes and closes[NOV] == 6_000
    db.expire_all()
    assert is_normalised_installment(db.get(BudgetEntry, entry), db.get(Account, card))
    _edit(client, me, entry, {"name": "Renamed tablet"})
    assert _overrides(db, budget_entry_id=entry) == [(OCT, "2026-10-28")]


def test_forced_earlier_into_the_previous_open_statement(world):
    """Criterion 4."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, "2026-11-05")
    assert OCT not in _closes(client, me, card)

    r = _force(client, me, entry, "2026-11-05", "2026-10-22")

    assert r.json()["statement_close"] == OCT
    closes = _closes(client, me, card)
    assert closes[OCT] == 500
    # The next month, Dec 5, is on the statement after, so Nov 24 had only this one.
    assert NOV not in closes


# --- 5 and 6: closed statements -----------------------------------------------------------------

def test_an_occurrence_leaves_a_closed_statement_for_the_open_cycle(world):
    """Criterion 5: the statement closed without it. Closes on the 10th, due 30
    days later, so the closed statement of Oct 10 is still unpaid in the window."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank, name="Late", close=10, due_in=30)
    entry = _subscription(client, me, card, "2026-10-05")
    assert _closes(client, me, card)["2026-10-10"] == 500

    r = _force(client, me, entry, "2026-10-05", "2026-10-12")

    assert r.json()["statement_close"] == "2026-11-10"
    closes = _closes(client, me, card)
    assert "2026-10-10" not in closes
    assert closes["2026-11-10"] == 1_000


def test_a_lapsed_subscription_forced_into_the_open_cycle_is_billed_and_not_missed(world):
    """Criterion 5: its statement fell due Oct 15, so it was dropped as lapsed."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, "2026-09-20")
    assert _closes(client, me, card)[OCT] == 500
    assert [m["count"] for m in _section(client, me, card)["missed"]] == [1]

    _force(client, me, entry, "2026-09-20", "2026-10-19")

    assert _closes(client, me, card)[OCT] == 1_000
    assert _section(client, me, card)["missed"] == []


def test_lapsed_reads_the_statement_of_the_effective_date(world):
    """Criterion 5: forced to a day already past, on a statement not yet due."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, "2026-09-20")

    _force(client, me, entry, "2026-09-20", "2026-10-10")

    assert _closes(client, me, card)[OCT] == 1_000
    assert _section(client, me, card)["missed"][0]["count"] == 1


def test_an_installment_forced_into_the_open_cycle_is_not_an_unposted_month(world):
    """Criterion 5: the reviewed month leaves the closed statement of Sep 24."""
    from app.models.account import Account
    from app.services.card_credit import unposted_months

    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _installment(client, me, card, SEP, months=3)
    _review(db, entry)
    owner = _user(db, me)
    assert [m.close for m in unposted_months(db, db.get(Account, card), owner)] == [
        date(2026, 9, 24)]
    assert _closes(client, me, card)[SEP] == 3_000

    _force(client, me, entry, SEP, "2026-10-05")

    db.rollback()
    assert unposted_months(db, db.get(Account, card), owner) == []
    closes = _closes(client, me, card)
    assert SEP not in closes and closes[OCT] == 6_000


def _user(db, who):
    from app.models.user import User

    return db.get(User, who["id"])


def test_a_date_inside_a_closed_statement_is_refused(world):
    """Criterion 6: including a past date within the reach."""
    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _subscription(client, me, card, "2026-10-05")

    r = _force(client, me, entry, "2026-10-05", "2026-09-20", expect=422)

    assert "closed" in r.json()["detail"]
    assert _overrides(db, budget_entry_id=entry) == []


def test_the_day_after_a_close_is_open_and_the_close_itself_is_not(world):
    """Criterion 6: a statement is closed once its close is before today."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = _card(client, me, bank, name="Edge", close=17)
    entry = _subscription(client, me, card, "2026-10-15")

    _force(client, me, entry, "2026-10-15", "2026-10-17", expect=422)
    r = _force(client, me, entry, "2026-10-15", "2026-10-18")

    assert r.json()["statement_close"] == "2026-11-17"


@pytest.mark.parametrize("how", ["delete", "nominal"])
def test_clearing_is_allowed_back_onto_a_closed_statement(world, how):
    """Criterion 6: it restores what the schedule says."""
    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _subscription(client, me, card, "2026-09-20")
    _force(client, me, entry, "2026-09-20", "2026-10-19")

    if how == "delete":
        _clear(client, me, entry, "2026-09-20")
    else:
        _force(client, me, entry, "2026-09-20", "2026-09-20")

    assert _overrides(db, budget_entry_id=entry) == []


# --- 7 and 8: recording ------------------------------------------------------------------------

def test_mark_paid_dates_the_row_on_the_effective_date(world):
    """Criterion 7."""
    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _subscription(client, me, card, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-26")
    before = _statements(client, me, card)

    _mark_paid(client, me, entry)

    assert _linked(db, entry) == [("2026-10-26", "2026-10-20")]
    assert _statements(client, me, card) == before


def test_a_reviewed_installment_forced_later_posts_on_its_effective_date_only(world):
    """Criterion 8: not settled as recorded yet, posted on the day, payable still."""
    from app.models.account import Account
    from app.services.forecast import _card_entry_charges
    from app.models.budget_entry import BudgetEntry

    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    monkeypatch = world["monkeypatch"]
    entry = _installment(client, me, card, SEP, months=3)
    _review(db, entry)
    _force(client, me, entry, SEP, "2026-10-20")

    def lines(start):
        db.rollback()
        account = db.get(Account, card)
        return {line.transaction_date.date().isoformat(): getattr(
            line, "settles_as_recorded", False) for line in _card_entry_charges(
                db, [db.get(BudgetEntry, entry)], {card: account}, start,
                datetime(2026, 12, 1), None)[card]}

    assert lines(datetime(2026, 10, 18))["2026-10-20"] is False
    payable = _statements(client, me, card)
    assert payable[OCT][1] == 6_000

    assert _job(client)["posted"] == 0
    assert _linked(db, entry) == []

    pin_clock(monkeypatch, datetime(2026, 10, 20, 2, 0))
    assert lines(datetime(2026, 10, 20))["2026-10-20"] is True
    assert _statements(client, me, card) == payable
    assert _job(client)["posted"] == 1
    assert _linked(db, entry) == [("2026-10-20", SEP)]
    assert _statements(client, me, card) == payable


def test_a_reviewed_installment_forced_earlier_posts_on_its_effective_date(world):
    """The job's scope reaches a nominal date past ``through``."""
    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _installment(client, me, card, OCT, months=3)
    _review(db, entry)
    _force(client, me, entry, OCT, "2026-10-17")

    assert _job(client)["posted"] == 1

    assert _linked(db, entry) == [("2026-10-17", OCT)]


# --- 9 and 10: a posted charge ------------------------------------------------------------------

def test_editing_a_posted_charge_moves_it_with_no_second_projection(world):
    """Criterion 9."""
    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _subscription(client, me, card, "2026-10-20")
    row = _mark_paid(client, me, entry)
    assert _closes(client, me, card) == {OCT: 500, NOV: 500, DEC: 500}

    r = client.put(f"{API}/transactions/{row['id']}",
                   json={"transaction_date": "2026-10-26T00:00:00"}, headers=me["headers"])

    assert r.status_code == 200, r.text
    assert _linked(db, entry) == [("2026-10-26", "2026-10-20")]
    assert _closes(client, me, card) == {NOV: 1_000, DEC: 500}


def test_editing_a_charge_out_of_a_paid_statement_spills_the_payment_forward(world):
    """Criterion 10: allowed today, and left as it is."""
    from app.core.access import viewable_account_ids
    from app.core.time import manila_midnight
    from app.models.account import Account
    from app.services.statements import statement_history

    client, me, card, db, bank = (world["client"], world["me"], world["card"], world["db"],
                                  world["bank"])
    entry = _subscription(client, me, card, "2026-09-20")
    row = _mark_paid(client, me, entry)
    _pay(client, me, bank, card, "2026-10-01", 500)

    def history():
        db.rollback()
        owner = _user(db, me)
        return {s["close"].date().isoformat(): (s["balance"], s["owed"]) for s in statement_history(
            db, db.get(Account, card), manila_midnight(), viewable_account_ids(db, owner))}

    assert history()[SEP] == (500, 0)

    r = client.put(f"{API}/transactions/{row['id']}",
                   json={"transaction_date": "2026-09-28T00:00:00"}, headers=me["headers"])

    assert r.status_code == 200, r.text
    after = history()
    assert after.get(SEP, (0, 0)) == (0, 0)
    assert after[OCT] == (500, 0)


# --- 11 and 12: the panels ----------------------------------------------------------------------

def test_card_charges_read_the_effective_date(world):
    """Criterion 11."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, "2026-10-10")
    assert _section(client, me, card)["missed"][0]["count"] == 1

    _force(client, me, entry, "2026-10-10", "2026-10-15")
    (missed, ) = _section(client, me, card)["missed"]
    assert (missed["count"], missed["oldest"]) == (1, "2026-10-10")

    _force(client, me, entry, "2026-10-10", "2026-10-18")
    assert _section(client, me, card)["missed"] == []
    assert ("2026-10-18", "2026-10-10") in _charges(client, me, card, entry)

    _force(client, me, entry, "2026-10-10", "2026-10-25")
    assert _section(client, me, card)["missed"] == []
    assert ("2026-10-25", "2026-10-10") in _charges(client, me, card, entry)


def _limit_card(world):
    return _card(world["client"], world["me"], world["bank"], name="Limit", credit_limit=100_000)


def test_a_subscriptions_credit_check_moves_with_its_date(world):
    """Criterion 12: and leaves when forced past the window, which ends Nov 17."""
    client, me = world["client"], world["me"]
    card = _limit_card(world)
    entry = _subscription(client, me, card, "2026-11-10")
    assert _checks(client, me, card, entry) == [("2026-11-10", "2026-11-10")]

    _force(client, me, entry, "2026-11-10", "2026-11-12")
    assert _checks(client, me, card, entry) == [("2026-11-12", "2026-11-10")]

    _force(client, me, entry, "2026-11-10", "2026-11-20")
    assert _checks(client, me, card, entry) == []


def test_a_subscription_forced_into_the_window_gets_a_check(world):
    """Criterion 12."""
    client, me = world["client"], world["me"]
    card = _limit_card(world)
    entry = _subscription(client, me, card, "2026-11-20")
    assert _checks(client, me, card, entry) == []

    _force(client, me, entry, "2026-11-20", "2026-11-05")

    assert _checks(client, me, card, entry) == [("2026-11-05", "2026-11-20")]


def test_a_subscription_forced_later_leaves_the_missed_total(world):
    client, me = world["client"], world["me"]
    card = _limit_card(world)
    entry = _subscription(client, me, card, "2026-10-10")
    assert _section(client, me, card)["credit"]["opening"]["missed_total"] == 500

    _force(client, me, entry, "2026-10-10", "2026-10-20")

    credit = _section(client, me, card)["credit"]
    assert credit["opening"]["missed_total"] == 0
    assert _checks(client, me, card, entry)[0] == ("2026-10-20", "2026-10-10")


def test_a_missed_item_carries_its_oldest_effective_date(world):
    """STU-577: ``oldest_effective`` is the oldest unlinked occurrence on its forced date."""
    client, me = world["client"], world["me"]
    card = _card(client, me, world["bank"], name="Missed card")
    entry = _subscription(client, me, card, "2026-10-09", cadence="weekly")

    (item,) = _section(client, me, card)["missed"]
    assert (item["count"], item["oldest_unlinked"], item["oldest_effective"]) == (
        2, "2026-10-09", "2026-10-09")

    _force(client, me, entry, "2026-10-09", "2026-10-12")
    (item,) = _section(client, me, card)["missed"]
    assert (item["count"], item["oldest"], item["oldest_unlinked"], item["oldest_effective"]) == (
        2, "2026-10-09", "2026-10-09", "2026-10-12")

    _clear(client, me, entry, "2026-10-09")
    (item,) = _section(client, me, card)["missed"]
    assert item["oldest_effective"] == "2026-10-09"


def test_a_linked_row_still_consumes_its_nominal_occurrence(world):
    """Criterion 12: Charged on a forced occurrence leaves one line, the row."""
    client, me, db = world["client"], world["me"], world["db"]
    card = _limit_card(world)
    entry = _subscription(client, me, card, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-26")

    row = _mark_paid(client, me, entry, is_posted=False, advance=False)

    assert _linked(db, entry) == [("2026-10-26", "2026-10-20")]
    checks = _section(client, me, card)["credit"]["checks"]
    assert [(c["source"], c["source_id"], c["date"]) for c in checks if c["date"] < "2026-11-20"
            ] == [("transaction", row["id"], "2026-10-26")]


def test_an_installments_hold_is_unchanged_by_a_forced_date(world):
    """Criterion 12: the hold counts occurrences; its check moves."""
    client, me = world["client"], world["me"]
    card = _limit_card(world)
    entry = _installment(client, me, card, OCT, months=3)
    before = _section(client, me, card)["credit"]["opening"]["installment_hold"]
    assert before == 9_000

    _force(client, me, entry, OCT, "2026-10-28")

    assert _section(client, me, card)["credit"]["opening"]["installment_hold"] == before
    assert _checks(client, me, card, entry)[0] == ("2026-10-28", OCT)


# --- 13 to 15: duplicates, minimums, Household --------------------------------------------------

def test_a_duplicate_near_the_effective_date_holds_the_month_once(world):
    """Criterion 13: Oct 12 is 18 days from the nominal date, 2 from the effective."""
    from app.services.installment_duplicates import held_occurrences
    from app.models.budget_entry import BudgetEntry

    client, me, db = world["client"], world["me"], world["db"]
    card = _limit_card(world)
    entry = _installment(client, me, card, SEP, months=3)
    _review(db, entry)
    _debit(client, me, card, "2026-10-12", 3_000, "Typed by hand")
    assert _closes(client, me, card)[OCT] == 6_000  # the month was on Sep 24: not held

    _force(client, me, entry, SEP, "2026-10-10")

    db.rollback()
    held = held_occurrences(db, [db.get(BudgetEntry, entry)], date(2026, 10, 18))
    assert held == {(entry, date(2026, 9, 24)): 1}
    assert _closes(client, me, card)[OCT] == 6_000  # the charge and October's month
    assert SEP not in _closes(client, me, card)
    assert _section(client, me, card)["credit"]["opening"]["installment_hold"] == 6_000


def test_a_duplicate_only_near_the_nominal_date_does_not_hold(world):
    from app.services.installment_duplicates import held_occurrences
    from app.models.budget_entry import BudgetEntry

    client, me, db = world["client"], world["me"], world["db"]
    card = _limit_card(world)
    entry = _installment(client, me, card, SEP, months=3)
    _review(db, entry)
    _debit(client, me, card, "2026-09-23", 3_000, "Typed by hand")
    db.rollback()
    assert held_occurrences(db, [db.get(BudgetEntry, entry)], date(2026, 10, 18))

    _force(client, me, entry, SEP, "2026-10-10")

    db.rollback()
    assert not held_occurrences(db, [db.get(BudgetEntry, entry)], date(2026, 10, 18))


def test_minimums_read_recorded_lines_only(world):
    """Criterion 14: no effect until recorded, then on the statement of its date."""
    client, me, bank, monkeypatch = (world["client"], world["me"], world["bank"],
                                     world["monkeypatch"])
    card = _card(client, me, bank, name="Rule", credit_limit=500_000, minimum_due_rule=BDO)
    _debit(client, me, card, "2026-09-10", 100_000)
    entry = _subscription(client, me, card, "2026-09-20", amount=200_000)

    def minimums():
        return {s["close_date"]: s["minimum_due"]["amount"]
                for s in _get(client, me, f"/cards/{card}/credit")["statements"]}

    before = minimums()
    assert before[SEP] == 3_000

    _force(client, me, entry, "2026-09-20", "2026-10-19")
    assert minimums() == before

    _mark_paid(client, me, entry)
    assert minimums() == before

    pin_clock(monkeypatch, datetime(2026, 10, 25, 2, 0))
    after = minimums()
    assert after[SEP] == 3_000
    assert after[OCT] >= 6_000


def test_household_shows_the_effective_date_once(hh, sw_client, sw_db, monkeypatch):
    """Criterion 15: a tagged entry on a private card, outside the Household scope."""
    pin_clock(monkeypatch, REF)
    client, a = sw_client, hh["a"]
    tag = hh_household(sw_db, a)
    bank = _checking(client, a, name="Private")
    card = _card(client, a, bank, name="Private card")
    entry = _subscription(client, a, card, "2026-10-20", tag_ids=[tag])
    _force(client, a, entry, "2026-10-20", "2026-10-22")

    rows = [i for i in _get(client, a, f"/household/{a['id']}/upcoming")["items"]
            if i.get("name") == "Video" and i["due_date"] < "2026-11-01"]

    assert [(r["due_date"], r["occurrence_date"]) for r in rows] == [("2026-10-22", "2026-10-20")]


# --- 16, 17, 19, 20 ----------------------------------------------------------------------------

@pytest.mark.parametrize("first, forced", [("2026-10-20", "2026-10-22"),
                                           ("2026-11-20", "2026-10-22")])
def test_a_statement_payable_is_the_same_in_short_and_long_windows(world, first, forced):
    """Criterion 16: the second nominal date is past the 30-day window."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, first)
    _force(client, me, entry, first, forced)

    short = _statements(client, me, card, days=30)
    long = _statements(client, me, card, days=90)

    assert short[OCT] == long[OCT] == ("2026-11-16", 500)


def test_still_bills_when_the_only_occurrence_left_is_forced(world):
    """Criterion 17: an ended entry whose last month lapsed, forced back into play."""
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import card_entries_still_bill

    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _subscription(client, me, card, "2026-09-20", end_mode="on_date",
                          end_date="2026-09-30T00:00:00")

    def bills():
        db.rollback()
        return card_entries_still_bill(db, db.get(Account, card), [db.get(BudgetEntry, entry)],
                                       datetime(2026, 10, 18))

    assert bills() is False

    _force(client, me, entry, "2026-09-20", "2026-10-19")

    assert bills() is True
    assert extend(datetime.max) == datetime.max


def test_a_due_override_on_the_target_statement_applies(world):
    """Criterion 19."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _subscription(client, me, card, "2026-10-20")
    r = client.put(f"{API}/cards/{card}/statements/{NOV}/due-date",
                   json={"due_date": "2026-12-20"}, headers=me["headers"])
    assert r.status_code == 200, r.text

    r = _force(client, me, entry, "2026-10-20", "2026-10-26")

    assert r.json()["statement_due"] == "2026-12-20"
    assert _statements(client, me, card)[NOV] == ("2026-12-20", 1_000)


def test_a_card_with_no_cycle_moves_the_listing_with_no_closed_check(world):
    """Criterion 20."""
    client, me, bank = world["client"], world["me"], world["bank"]
    card = sw_post(client, me, "/accounts/", {
        "name": "Plain", "account_type": "credit", "balance": 0,
        "payment_account_id": bank})["id"]
    entry = _subscription(client, me, card, "2026-10-10")
    assert _section(client, me, card)["statement_cycle"] is False

    r = _force(client, me, entry, "2026-10-10", "2026-10-25")

    assert r.json() == {"occurrence_date": "2026-10-10", "effective_date": "2026-10-25",
                        "statement_close": None, "statement_due": None}
    assert ("2026-10-25", "2026-10-10") in _charges(client, me, card, entry)
    _force(client, me, entry, "2026-10-10", "2026-09-25")


# --- 21: the review ----------------------------------------------------------------------------

def _review_body(client, who, entry):
    return _get(client, who, f"/budget-entries/{entry}/auto-post-review")


def _apply_review(client, who, entry, body):
    return client.post(f"{API}/budget-entries/{entry}/auto-post-review", json={
        "entry_version": body["entry_version"], "review_token": body["review_token"],
        "links": []}, headers=who["headers"])


def test_a_review_token_from_before_an_override_no_longer_applies(world):
    """Criterion 21: the month is missed either way, so only the binding of the
    forced dates tells the two reviews apart."""
    client, me, card, db = world["client"], world["me"], world["card"], world["db"]
    entry = _installment(client, me, card, SEP, months=3)
    stale = _review_body(client, me, entry)

    _force(client, me, entry, SEP, "2026-10-05")

    assert [m["occurrence_date"] for m in _review_body(client, me, entry)["missed"]] == [SEP]
    r = _apply_review(client, me, entry, stale)
    assert r.status_code == 409, r.text
    assert "changed" in r.json()["detail"]
    assert _linked(db, entry) == []
    r = _apply_review(client, me, entry, _review_body(client, me, entry))
    assert r.status_code == 200, r.text
    assert _linked(db, entry) == [("2026-10-05", SEP)]


def test_a_review_reads_the_effective_date(world):
    """A month forced later is not missed yet; ``past_cycles`` reads its date;
    the candidates centre on it."""
    client, me, card = world["client"], world["me"], world["card"]
    entry = _installment(client, me, card, SEP, months=3)
    _debit(client, me, card, "2026-10-04", 3_000, "Typed by hand")
    body = _review_body(client, me, entry)
    assert (body["past_cycles"], body["candidates"]) == (True, [])
    assert body["remaining_after"] == 2

    _force(client, me, entry, SEP, "2026-10-05")
    body = _review_body(client, me, entry)
    assert body["past_cycles"] is False
    assert [c["occurrence_date"] for c in body["candidates"]] == [SEP]

    _force(client, me, entry, SEP, "2026-10-20")
    body = _review_body(client, me, entry)
    assert (body["missed"], body["remaining_after"]) == ([], 3)

    r = _apply_review(client, me, entry, body)
    assert r.status_code == 200, r.text
    assert _txn_count(world["db"], entry) == 0


def _txn_count(db, entry):
    return len(_linked(db, entry))


# --- conversions and the race (PR 3's handoff) --------------------------------------------------

def test_moving_an_entry_onto_a_card_keeps_its_overrides(world):
    """The walk did not change. An override may sit in a closed statement anyway:
    the open cycle closes on any override left unrecorded."""
    client, me, bank, card, db = (world["client"], world["me"], world["bank"], world["card"],
                                  world["db"])
    entry = _entry(client, me, bank, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-26")

    _edit(client, me, entry, {"account_id": card})

    assert _overrides(db, budget_entry_id=entry) == [("2026-10-20", "2026-10-26")]
    assert _closes(client, me, card)[NOV] == 40_000


def test_turning_an_account_into_a_card_keeps_its_entries_overrides(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    second = _checking(client, me, name="Second")
    entry = _entry(client, me, second, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-26")

    r = client.put(f"{API}/accounts/{second}", json={
        "account_type": "credit", "billing_cycle_start": 24, "days_until_due_date": 21,
        "payment_account_id": bank}, headers=me["headers"])

    assert r.status_code == 200, r.text
    assert _overrides(db, budget_entry_id=entry) == [("2026-10-20", "2026-10-26")]
    closes = _closes(client, me, second)
    assert OCT not in closes and closes[NOV] == 40_000


def test_a_loan_override_cannot_outlive_the_loan(world):
    """An account stops being a loan only with its loan terms cleared, and the
    first payment date going takes the overrides with it."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    loan = _loan(client, me, bank)
    _force_loan(client, me, loan, "2026-10-10", "2026-10-25")
    r = client.put(f"{API}/accounts/{loan}", json={
        "account_type": "credit", "billing_cycle_start": 24, "days_until_due_date": 21},
        headers=me["headers"])
    assert r.status_code == 400, r.text
    assert _overrides(db, loan_account_id=loan) == [("2026-10-10", "2026-10-25")]

    r = client.put(f"{API}/accounts/{loan}", json={
        "account_type": "credit", "billing_cycle_start": 24, "days_until_due_date": 21,
        **{field: None for field in LOAN_FIELDS}}, headers=me["headers"])

    assert r.status_code == 200, r.text
    assert _overrides(db, loan_account_id=loan) == []


def test_the_closed_check_waits_for_an_account_change(world, holder):  # noqa: F811
    """A route that read the account without its lock would miss the new cycle."""
    client, me, db = world["client"], world["me"], world["db"]
    second = _checking(client, me, name="Second")
    entry = _entry(client, me, second, "2026-10-05")
    holder.execute(text("UPDATE accounts SET account_type = 'credit', billing_cycle_start = 24, "
                        "days_until_due_date = 21 WHERE id = :id"), {"id": second})
    result = {}

    def put():
        result["response"] = client.put(
            f"{API}/budget-entries/{entry}/occurrences/2026-10-05/date",
            json={"effective_date": "2026-09-20"}, headers=me["headers"])

    thread = threading.Thread(target=put, daemon=True)
    thread.start()
    time.sleep(0.5)
    assert thread.is_alive()
    holder.commit()
    thread.join(timeout=30)

    assert result["response"].status_code == 422, result["response"].text
    assert "closed" in result["response"].json()["detail"]
    assert _overrides(db, budget_entry_id=entry) == []

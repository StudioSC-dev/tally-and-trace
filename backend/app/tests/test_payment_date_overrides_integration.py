"""Forced payment dates (``payment_date_overrides``, services/payment_dates.py).

A schedule's nominal date is the occurrence's identity and never moves; the
effective date decides when it is due, shown, overdue and posted. Skips without
a database.

Reference: Sunday 2026-10-18, 02:00 UTC (10:00 in Manila). The snapshot's
payables run 30 days from today.
"""
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.models.transaction import RecurrenceFrequency
from app.services.forecast import effective_window_occurrences, iter_occurrences
from app.tests.conftest import API, hh_household, sw_db_reachable, sw_post, sw_share
from app.tests.test_balance_locking_integration import engine, holder  # noqa: F401
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_minimum_due_rule_integration import _alembic, scratch_url  # noqa: F401

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)
PREVIOUS = "c4e1a7d92b36"
REVISION = "a2c6e8f0b4d1"


# --- helpers ----------------------------------------------------------------------------------

def _checking(client, who, balance=500_000, name="Checking"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "balance": balance})["id"]


def _entry(client, who, account, first, name="Rent", amount=20_000, cadence="monthly", **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": cadence,
        "next_occurrence": f"{first}T00:00:00", "account_id": account, **extra})["id"]


def _capped(client, who, account, first, months=3):
    return _entry(client, who, account, first, name="Sofa", amount=3_000,
                  end_mode="after_occurrences", max_occurrences=months)


def _loan(client, who, paying, first="2026-10-10", **extra):
    return sw_post(client, who, "/accounts/", {
        "name": "Car loan", "account_type": "loan", "loan_kind": "auto", "balance": -90_000,
        "loan_annual_rate": 6, "loan_term_months": 12, "loan_payment_amount": 8_000,
        "loan_first_payment_date": first, "payment_account_id": paying, **extra})["id"]


def _force(client, who, entry, day, to, expect=200):
    r = client.put(f"{API}/budget-entries/{entry}/occurrences/{day}/date",
                   json={"effective_date": to}, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _clear(client, who, entry, day, expect=204):
    r = client.delete(f"{API}/budget-entries/{entry}/occurrences/{day}/date",
                      headers=who["headers"])
    assert r.status_code == expect, r.text


def _force_loan(client, who, loan, day, to, expect=200):
    r = client.put(f"{API}/accounts/{loan}/loan-due-dates/{day}/date",
                   json={"effective_date": to}, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _clear_loan(client, who, loan, day, expect=204):
    r = client.delete(f"{API}/accounts/{loan}/loan-due-dates/{day}/date", headers=who["headers"])
    assert r.status_code == expect, r.text


def _get(client, who, path):
    r = client.get(f"{API}{path}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _snapshot(client, who):
    return _get(client, who, "/dashboard/snapshot")


def _rows(rows, source, source_id):
    return [p for p in rows if p.get("source") == source and p.get("source_id") == source_id]


def _payables(client, who, source, source_id):
    """``(due_date, overdue, original_date, occurrence_date)`` of the snapshot's payables."""
    return [(p["due_date"], p["overdue"], p.get("original_date"), p.get("occurrence_date"))
            for p in _rows(_snapshot(client, who)["payables"], source, source_id)]


def _missed(client, who, entry):
    return [m for m in _snapshot(client, who)["missed"] if m["entry_id"] == entry]


def _listed(client, who, entry):
    """``(occurrence_date, effective_date)`` of the Transactions page's Upcoming list."""
    body = _get(client, who, "/budget-entries/upcoming-occurrences")
    return [(i["occurrence_date"], i["effective_date"]) for i in body["items"]
            if i["entry_id"] == entry]


def _window(client, who, days, source, source_id):
    """``(due_date, amount)`` of ``GET /forecast/upcoming``."""
    return [(i["due_date"], i["amount"]) for i in _rows(
        _get(client, who, f"/forecast/upcoming?days={days}")["items"], source, source_id)]


def _schedule(client, who, loan):
    return _get(client, who, f"/accounts/{loan}/loan-schedule")


def _mark_paid(client, who, entry, **body):
    r = client.post(f"{API}/budget-entries/{entry}/materialize", json=body, headers=who["headers"])
    assert r.status_code in (200, 201), r.text
    return r.json()


def _edit(client, who, entry, body):
    r = client.put(f"{API}/budget-entries/{entry}", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text


def _overrides(db, **owner):
    from app.models.payment_date_override import PaymentDateOverride as P

    db.rollback()
    return sorted((o.occurrence_date.isoformat(), o.effective_date.isoformat())
                  for o in db.query(P).filter_by(**owner).all())


def _txn(db, txn_id):
    from app.models.transaction import Transaction

    db.rollback()
    return db.get(Transaction, txn_id)


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    return {"client": sw_client, "db": sw_db, "me": me, "bank": _checking(sw_client, me),
            "people": sw_people}


# --- 1 to 4: which list an occurrence is on ----------------------------------------------------

def test_moved_later_a_past_occurrence_is_upcoming_not_missed(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")
    assert _missed(client, me, entry)[0]["oldest"] == "2026-10-10"

    r = _force(client, me, entry, "2026-10-10", "2026-10-25")
    assert r.json() == {"occurrence_date": "2026-10-10", "effective_date": "2026-10-25"}

    assert _missed(client, me, entry) == []
    assert _payables(client, me, "budget_entry", entry)[0] == (
        "2026-10-25", False, None, "2026-10-10")
    assert _listed(client, me, entry)[0] == ("2026-10-10", "2026-10-25")
    listing = _get(client, me, f"/budget-entries/{entry}/occurrences")
    first = listing["occurrences"][0]
    assert (first["occurrence_date"], first["effective_date"], first["due"]) == (
        "2026-10-10", "2026-10-25", False)
    assert listing["due_unposted"] == 0


def test_moved_later_a_past_loan_due_date_is_not_overdue(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank)
    assert _payables(client, me, "loan", loan)[0][:2] == ("2026-10-18", True)

    _force_loan(client, me, loan, "2026-10-10", "2026-10-25")

    assert _payables(client, me, "loan", loan)[0] == ("2026-10-25", False, None, None)
    schedule = _schedule(client, me, loan)
    assert (schedule["next_due_date"], schedule["next_due_effective_date"]) == (
        "2026-10-10", "2026-10-25")
    assert (schedule["upcoming"][0]["due_date"], schedule["upcoming"][0]["effective_date"]) == (
        "2026-10-10", "2026-10-25")
    assert schedule["upcoming"][1]["effective_date"] == "2026-11-10"


def test_moved_earlier_into_the_window_from_past_its_end_is_listed(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-11-05")
    loan = _loan(client, me, bank, first="2026-11-05")
    assert _window(client, me, 14, "budget_entry", entry) == []
    assert _window(client, me, 14, "loan", loan) == []

    _force(client, me, entry, "2026-11-05", "2026-10-28")
    _force_loan(client, me, loan, "2026-11-05", "2026-10-28")

    assert _window(client, me, 14, "budget_entry", entry) == [("2026-10-28", 20_000.0)]
    assert _window(client, me, 14, "loan", loan) == [("2026-10-28", 8_000.0)]


def test_moved_past_the_window_end_is_not_listed(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-28")
    loan = _loan(client, me, bank, first="2026-10-28")
    assert len(_window(client, me, 14, "budget_entry", entry)) == 1
    assert len(_window(client, me, 14, "loan", loan)) == 1

    _force(client, me, entry, "2026-10-28", "2026-11-05")
    _force_loan(client, me, loan, "2026-10-28", "2026-11-05")

    assert _window(client, me, 14, "budget_entry", entry) == []
    assert _window(client, me, 14, "loan", loan) == []


def test_nominal_before_the_window_forced_into_it_is_listed_on_an_open_ended_entry(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")
    assert _window(client, me, 14, "budget_entry", entry) == []  # dropped, as ever

    _force(client, me, entry, "2026-10-10", "2026-10-20")

    assert _window(client, me, 14, "budget_entry", entry) == [("2026-10-20", 20_000.0)]


def test_nominal_in_the_window_forced_before_it_leaves_an_open_ended_entry_for_missed(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")

    _force(client, me, entry, "2026-10-20", "2026-10-15")

    assert _window(client, me, 14, "budget_entry", entry) == []
    (row,) = _missed(client, me, entry)
    assert (row["oldest"], row["oldest_effective"], row["count"]) == (
        "2026-10-20", "2026-10-15", 1)


# --- 5: overdue --------------------------------------------------------------------------------

def test_overdue_reads_the_effective_date_and_keeps_the_nominal_occurrence(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _capped(client, me, bank, "2026-10-05")
    loan = _loan(client, me, bank, first="2026-10-05")

    _force(client, me, entry, "2026-10-05", "2026-10-12")
    _force_loan(client, me, loan, "2026-10-05", "2026-10-12")

    assert _payables(client, me, "budget_entry", entry)[0] == (
        "2026-10-18", True, "2026-10-12", "2026-10-05")
    assert _payables(client, me, "loan", loan)[0] == ("2026-10-18", True, "2026-10-12", None)
    row = _rows(_snapshot(client, me)["upcoming_this_month"], "budget_entry", entry)[0]
    assert (row["original_date"], row["occurrence_date"]) == ("2026-10-12", "2026-10-05")


def test_a_capped_entry_is_not_overdue_on_its_nominal_date(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _capped(client, me, bank, "2026-10-05")

    _force(client, me, entry, "2026-10-05", "2026-10-25")

    assert _payables(client, me, "budget_entry", entry)[0] == (
        "2026-10-25", False, None, "2026-10-05")
    assert _missed(client, me, entry) == []


# --- 6 to 8: recording -------------------------------------------------------------------------

def test_mark_paid_dates_the_row_on_the_effective_date_and_advances_once(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _force(client, me, entry, "2026-10-10", "2026-10-08")
    _force(client, me, entry, "2026-11-10", "2026-11-12")

    paid = _mark_paid(client, me, entry)

    row = _txn(db, paid["id"])
    assert row.transaction_date.date() == date(2026, 10, 8)
    assert row.occurrence_date.date() == date(2026, 10, 10)
    body = _get(client, me, f"/budget-entries/{entry}")
    assert body["next_occurrence"].startswith("2026-11-10")
    # The next month keeps its own nominal date and its own forced date.
    assert _listed(client, me, entry)[0] == ("2026-11-10", "2026-11-12")
    assert _listed(client, me, entry)[1] == ("2026-12-10", "2026-12-10")


def test_a_chosen_transaction_date_still_wins(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _force(client, me, entry, "2026-10-10", "2026-10-08")

    paid = _mark_paid(client, me, entry, transaction_date="2026-10-09T00:00:00")

    assert _txn(db, paid["id"]).transaction_date.date() == date(2026, 10, 9)


def test_mark_paid_refuses_the_effective_date_as_an_occurrence(world):
    """The nominal date is the identity: only it names the occurrence."""
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")
    _force(client, me, entry, "2026-10-10", "2026-10-08")

    r = client.post(f"{API}/budget-entries/{entry}/materialize",
                    json={"occurrence_date": "2026-10-08T00:00:00"}, headers=me["headers"])

    assert r.status_code == 422, r.text


def test_post_n_due_takes_only_effective_due_occurrences(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-04", cadence="weekly", amount=500)
    # Oct 4 and 11 are due; Oct 18 is nominally due today, forced later; Oct 25
    # is not, and neither is the one after it.
    _force(client, me, entry, "2026-10-11", "2026-10-10")
    _force(client, me, entry, "2026-10-18", "2026-10-22")

    r = client.post(f"{API}/budget-entries/{entry}/materialize-due", headers=me["headers"])

    assert r.status_code == 200, r.text
    body = r.json()
    assert [i["occurrence_date"] for i in body["results"]] == ["2026-10-04", "2026-10-11"]
    assert body["next_occurrence"].startswith("2026-10-18")
    rows = [_txn(db, i["transaction"]["id"]) for i in body["results"]]
    assert [t.transaction_date.date() for t in rows] == [date(2026, 10, 4), date(2026, 10, 10)]
    assert [t.occurrence_date.date() for t in rows] == [date(2026, 10, 4), date(2026, 10, 11)]


def test_post_n_due_takes_an_occurrence_forced_earlier(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-15")

    r = client.post(f"{API}/budget-entries/{entry}/materialize-due", headers=me["headers"])

    assert r.status_code == 200, r.text
    (item,) = r.json()["results"]
    assert item["occurrence_date"] == "2026-10-20"
    assert _txn(db, item["transaction"]["id"]).transaction_date.date() == date(2026, 10, 15)


def test_a_recorded_forced_occurrence_is_not_projected_twice(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-25")

    # advance False keeps the occurrence in the walk: only the link suppresses it.
    _mark_paid(client, me, entry, advance=False)

    rows = _payables(client, me, "budget_entry", entry)
    assert all(occurrence != "2026-10-20" for *_, occurrence in rows)
    assert all(day != "2026-10-20" for day, _ in _listed(client, me, entry))
    assert _missed(client, me, entry) == []


# --- 9, 10: covers and windows -----------------------------------------------------------------

@pytest.mark.parametrize("forced", [None, "2026-11-09"])
def test_a_planned_payment_covers_the_nominal_due_date(world, forced):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-11-04")
    if forced:
        _force_loan(client, me, loan, "2026-11-04", forced)
    sw_post(client, me, f"/accounts/{loan}/loan-payment", {
        "from_account_id": bank, "principal": 3_000, "interest": 0, "is_posted": False,
        "transaction_date": "2026-11-04T00:00:00"})

    assert _window(client, me, 30, "loan", loan) == [(forced or "2026-11-04", 5_000.0)]


@pytest.mark.parametrize("forced", [None, "2026-11-09"])
def test_a_recurring_cover_covers_the_nominal_due_date(world, forced):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-11-04")
    if forced:
        _force_loan(client, me, loan, "2026-11-04", forced)
    _entry(client, me, bank, "2026-11-04", name="Top up", amount=3_000,
           transfer_to_account_id=loan)

    assert _window(client, me, 30, "loan", loan) == [(forced or "2026-11-04", 5_000.0)]


def test_a_due_date_forced_in_from_past_the_horizon_still_finds_its_cover(world):
    """Nov 30 forced to Oct 31 in a window ending Nov 1. The cover's Dec 9 occurrence
    belongs to Nov 30 and lies past the window plus ``COVER_HORIZON`` (Dec 2)."""
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-11-30")
    _force_loan(client, me, loan, "2026-11-30", "2026-10-31")
    _entry(client, me, bank, "2026-12-09", name="Top up", amount=3_000,
           transfer_to_account_id=loan)

    assert _window(client, me, 14, "loan", loan) == [("2026-10-31", 5_000.0)]


def test_a_cover_with_its_own_forced_date_stays_on_its_nominal_due_date(world):
    """Forced to Nov 20 the cover is nearer Dec 4; its identity is still Nov 4."""
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-11-04")
    cover = _entry(client, me, bank, "2026-11-04", name="Top up", amount=3_000,
                   transfer_to_account_id=loan)
    _force(client, me, cover, "2026-11-04", "2026-11-20")

    assert _window(client, me, 60, "budget_entry", cover)[0][0] == "2026-11-20"
    assert [amount for _, amount in _window(client, me, 60, "loan", loan)] == [5_000.0, 5_000.0]


def test_an_open_ended_cover_forced_into_the_window_covers_its_nominal_due_date(world):
    """Its nominal date is before the window: the transfer is listed, so it must net."""
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-10-10")
    cover = _entry(client, me, bank, "2026-10-10", name="Top up", amount=3_000,
                   transfer_to_account_id=loan)
    _force(client, me, cover, "2026-10-10", "2026-10-20")

    amounts = [p["amount"] for p in _rows(_snapshot(client, me)["payables"], "loan", loan)]
    assert amounts[0] == 5_000.0


def test_a_due_dates_result_does_not_depend_on_the_window(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-11-04")
    entry = _entry(client, me, bank, "2026-11-04")
    _force_loan(client, me, loan, "2026-11-04", "2026-11-09")
    _force(client, me, entry, "2026-11-04", "2026-11-09")
    _entry(client, me, bank, "2026-11-04", name="Top up", amount=3_000,
           transfer_to_account_id=loan)
    sw_post(client, me, f"/accounts/{loan}/loan-payment", {
        "from_account_id": bank, "principal": 1_000, "interest": 0, "is_posted": False,
        "transaction_date": "2026-11-05T00:00:00"})

    for source, source_id in (("loan", loan), ("budget_entry", entry)):
        short = _window(client, me, 30, source, source_id)
        long = _window(client, me, 90, source, source_id)
        assert len(short) == 1
        assert long[0] == short[0]
    assert _window(client, me, 30, "loan", loan) == [("2026-11-09", 4_000.0)]


# --- 11: clearing ------------------------------------------------------------------------------

def _lists(client, who, entry, loan):
    snapshot = _snapshot(client, who)
    keys = ("due_date", "overdue", "original_date", "occurrence_date", "amount")

    def pick(rows):
        return [{k: r.get(k) for k in keys} for r in rows]

    schedule = _schedule(client, who, loan)
    return {
        "payables": pick(_rows(snapshot["payables"], "budget_entry", entry)
                         + _rows(snapshot["payables"], "loan", loan)),
        "upcoming": pick(_rows(snapshot["upcoming_this_month"], "budget_entry", entry)
                         + _rows(snapshot["upcoming_this_month"], "loan", loan)),
        "missed": [m for m in snapshot["missed"] if m["entry_id"] == entry],
        "listed": _listed(client, who, entry),
        "occurrences": _get(client, who, f"/budget-entries/{entry}/occurrences"),
        "schedule": (schedule["next_due_effective_date"], schedule["upcoming"]),
    }


@pytest.mark.parametrize("how", ["delete", "put"])
def test_clearing_restores_every_list(world, how):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")
    loan = _loan(client, me, bank)
    before = _lists(client, me, entry, loan)

    _force(client, me, entry, "2026-10-10", "2026-10-25")
    _force_loan(client, me, loan, "2026-10-10", "2026-10-25")
    during = _lists(client, me, entry, loan)
    assert all(during[key] != before[key] for key in before)

    if how == "delete":
        _clear(client, me, entry, "2026-10-10")
        _clear_loan(client, me, loan, "2026-10-10")
    else:
        r = _force(client, me, entry, "2026-10-10", "2026-10-10")
        assert r.json()["effective_date"] == "2026-10-10"
        _force_loan(client, me, loan, "2026-10-10", "2026-10-10")

    assert _lists(client, me, entry, loan) == before
    assert _overrides(world["db"], budget_entry_id=entry) == []
    assert _overrides(world["db"], loan_account_id=loan) == []


def test_delete_is_204_with_nothing_set(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-10")
    loan = _loan(client, me, bank)

    _clear(client, me, entry, "2026-10-10")
    _clear(client, me, entry, "2019-01-01")  # not an occurrence: still nothing to clear
    _clear_loan(client, me, loan, "2026-10-10")
    _clear_loan(client, me, loan, "2019-01-01")


def test_setting_again_replaces_the_date(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _force(client, me, entry, "2026-10-10", "2026-10-12")
    _force(client, me, entry, "2026-10-10", "2026-10-14")

    assert _overrides(db, budget_entry_id=entry) == [("2026-10-10", "2026-10-14")]


def test_clearing_is_refused_when_a_neighbour_has_moved_past_the_nominal_date(world):
    """Weekly: Oct 22 forced to Oct 19 and Oct 29 to Oct 20; back on Oct 22 the first
    would fall after the second, so the due occurrences would no longer be a prefix."""
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-22", cadence="weekly", amount=500)
    _force(client, me, entry, "2026-10-22", "2026-10-19")
    _force(client, me, entry, "2026-10-29", "2026-10-20")

    _clear(client, me, entry, "2026-10-22", expect=409)
    _force(client, me, entry, "2026-10-22", "2026-10-22", expect=409)

    _clear(client, me, entry, "2026-10-29")
    _clear(client, me, entry, "2026-10-22")


def test_a_loan_clear_is_refused_the_same_way(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-12-01")
    _force_loan(client, me, loan, "2026-12-01", "2026-11-25")
    _force_loan(client, me, loan, "2027-01-01", "2026-12-01")

    _clear_loan(client, me, loan, "2026-12-01", expect=409)
    _clear_loan(client, me, loan, "2027-01-01")
    _clear_loan(client, me, loan, "2026-12-01")


# --- 12: refusals ------------------------------------------------------------------------------

def test_a_posted_linked_occurrence_is_a_409(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")
    _mark_paid(client, me, entry, advance=False)

    r = _force(client, me, entry, "2026-10-20", "2026-10-25", expect=409)

    assert "change the transaction's date" in r.json()["detail"]


def test_a_pending_linked_occurrence_is_a_409(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")
    sw_post(client, me, "/transactions/", {
        "account_id": bank, "transaction_type": "debit", "amount": 20_000, "description": "Rent",
        "transaction_date": "2026-10-20T00:00:00", "is_posted": False,
        "budget_entry_id": entry})

    _force(client, me, entry, "2026-10-20", "2026-10-25", expect=409)


def test_a_partly_paid_loan_due_date_is_a_409(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank)
    sw_post(client, me, f"/accounts/{loan}/loan-payment", {
        "from_account_id": bank, "principal": 2_000, "interest": 0})

    r = _force_loan(client, me, loan, "2026-10-10", "2026-10-25", expect=409)

    assert "already allocated" in r.json()["detail"]
    _force_loan(client, me, loan, "2026-11-10", "2026-11-15")  # the next one is untouched


def test_a_settled_loan_due_date_is_a_409(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank)
    sw_post(client, me, f"/accounts/{loan}/loan-payment", {
        "from_account_id": bank, "principal": 8_000, "interest": 0})

    _force_loan(client, me, loan, "2026-10-10", "2026-10-25", expect=409)


def test_a_payment_after_the_force_leaves_the_override_inert(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank)
    _force_loan(client, me, loan, "2026-10-10", "2026-10-25")

    sw_post(client, me, f"/accounts/{loan}/loan-payment", {
        "from_account_id": bank, "principal": 8_000, "interest": 0})

    assert _payables(client, me, "loan", loan)[0][0] == "2026-11-10"


def test_a_due_date_before_the_offset_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-08-10", loan_payments_made_offset=2)

    _force_loan(client, me, loan, "2026-08-10", "2026-08-12", expect=422)
    _force_loan(client, me, loan, "2026-10-10", "2026-10-12")


def test_the_reach_is_31_days_either_side(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-11-15", cadence="quarterly")

    _force(client, me, entry, "2026-11-15", "2026-12-16")  # exactly 31 later
    _force(client, me, entry, "2026-11-15", "2026-10-15")  # exactly 31 earlier
    r = _force(client, me, entry, "2026-11-15", "2026-12-17", expect=422)
    assert "31 days" in r.json()["detail"]
    _force(client, me, entry, "2026-11-15", "2026-10-14", expect=422)


def test_a_loan_reach_is_31_days_either_side(world):
    """December has 31 days, so Jan 1 moves first to leave Dec 1 room."""
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank, first="2026-12-01")
    _force_loan(client, me, loan, "2027-01-01", "2027-01-05")

    _force_loan(client, me, loan, "2026-12-01", "2027-01-01")  # exactly 31 later
    r = _force_loan(client, me, loan, "2026-12-01", "2027-01-02", expect=422)
    assert "31 days" in r.json()["detail"]
    _force_loan(client, me, loan, "2026-12-01", "2026-10-31")  # exactly 31 earlier
    _force_loan(client, me, loan, "2026-12-01", "2026-10-30", expect=422)


@pytest.mark.parametrize("day, to", [
    ("2026-10-20", "2026-10-27"),  # on the next occurrence
    ("2026-10-20", "2026-10-28"),  # past it
    ("2026-10-27", "2026-10-20"),  # on the previous one
    ("2026-10-27", "2026-10-19"),  # past it
])
def test_out_of_order_is_a_422(world, day, to):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20", cadence="weekly", amount=500)

    r = _force(client, me, entry, day, to, expect=422)

    assert "between" in r.json()["detail"]


def test_order_reads_the_neighbours_forced_dates(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20", amount=500)
    _force(client, me, entry, "2026-11-20", "2026-11-05")

    _force(client, me, entry, "2026-10-20", "2026-11-05", expect=422)
    _force(client, me, entry, "2026-10-20", "2026-11-04")


def test_a_loan_out_of_order_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank)

    _force_loan(client, me, loan, "2026-10-10", "2026-11-10", expect=422)
    _force_loan(client, me, loan, "2026-11-10", "2026-10-10", expect=422)


def test_the_last_occurrence_stays_before_the_step_past_it(world):
    """Raising the cap later cannot put the last forced date past a new occurrence."""
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _capped(client, me, bank, "2026-10-20", months=1)

    _force(client, me, entry, "2026-10-20", "2026-11-20", expect=422)
    _force(client, me, entry, "2026-10-20", "2026-11-19")


def test_not_an_occurrence_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")
    capped = _capped(client, me, bank, "2026-10-20", months=2)
    loan = _loan(client, me, bank)

    _force(client, me, entry, "2026-10-21", "2026-10-25", expect=422)
    _force(client, me, entry, "2026-09-20", "2026-09-25", expect=422)  # before next_occurrence
    _force(client, me, capped, "2026-12-20", "2026-12-25", expect=422)  # past the cap
    _force(client, me, entry, "2029-10-20", "2029-10-25", expect=422)  # past the two-year walk
    _force_loan(client, me, loan, "2026-10-11", "2026-10-25", expect=422)
    _force_loan(client, me, loan, "2028-10-10", "2028-10-25", expect=422)  # past the term


def test_a_date_outside_the_record_range_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2000-01-05")

    _force(client, me, entry, "2000-01-05", "1999-12-30", expect=422)


def test_a_card_entry_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    card = sw_post(client, me, "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 4,
        "days_until_due_date": 25, "payment_account_id": bank})["id"]
    subscription = _entry(client, me, card, "2026-10-20", name="Video", amount=500)

    r = _force(client, me, subscription, "2026-10-20", "2026-10-25", expect=422)

    assert "card" in r.json()["detail"]


def test_a_body_with_an_unknown_field_is_a_422(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")

    r = client.put(f"{API}/budget-entries/{entry}/occurrences/2026-10-20/date",
                   json={"effective_date": "2026-10-25", "x": 1}, headers=me["headers"])

    assert r.status_code == 422


# --- 13: a schedule edit -----------------------------------------------------------------------

@pytest.mark.parametrize("edit", [
    {"anchor_day": 25, "next_occurrence": "2026-10-25T00:00:00"},  # refused alone
    {"next_occurrence": "2026-10-25T00:00:00"},
    {"cadence": "weekly"},
])
def test_a_schedule_edit_deletes_the_entrys_overrides(world, edit):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-20")
    other = _entry(client, me, bank, "2026-10-20", name="Other")
    _force(client, me, entry, "2026-10-20", "2026-10-22")
    _force(client, me, other, "2026-10-20", "2026-10-22")

    _edit(client, me, entry, edit)

    assert _overrides(db, budget_entry_id=entry) == []
    assert _overrides(db, budget_entry_id=other) == [("2026-10-20", "2026-10-22")]


def test_semi_monthly_days_are_a_schedule_edit(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-11-01", cadence="semi_monthly",
                   semi_monthly_day_1=1, semi_monthly_day_2=15)
    _force(client, me, entry, "2026-11-15", "2026-11-16")

    _edit(client, me, entry, {"semi_monthly_day_2": 20})

    assert _overrides(db, budget_entry_id=entry) == []


def test_an_unrelated_edit_keeps_the_overrides(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-22")

    _edit(client, me, entry, {"name": "Rent, renamed", "amount": 21_000,
                              "next_occurrence": "2026-10-20T00:00:00"})

    assert _overrides(db, budget_entry_id=entry) == [("2026-10-20", "2026-10-22")]


def test_resuming_past_paused_months_deletes_the_overrides(world):
    """The skip moves ``next_occurrence`` though the request never named it."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    _force(client, me, entry, "2026-10-10", "2026-10-12")
    _edit(client, me, entry, {"is_active": False})
    assert _overrides(db, budget_entry_id=entry) == [("2026-10-10", "2026-10-12")]

    _edit(client, me, entry, {"is_active": True})

    assert _overrides(db, budget_entry_id=entry) == []


def test_moving_an_entry_onto_a_card_deletes_its_overrides(world):
    """No half-built card path: a card entry has no forced dates until they are read."""
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    card = sw_post(client, me, "/accounts/", {
        "name": "Card", "account_type": "credit", "balance": 0, "billing_cycle_start": 4,
        "days_until_due_date": 25, "payment_account_id": bank})["id"]
    second = _checking(client, me, name="Second")
    entry = _entry(client, me, bank, "2026-10-20")
    _force(client, me, entry, "2026-10-20", "2026-10-22")

    _edit(client, me, entry, {"account_id": second})
    assert _overrides(db, budget_entry_id=entry) == [("2026-10-20", "2026-10-22")]

    _edit(client, me, entry, {"account_id": card})
    assert _overrides(db, budget_entry_id=entry) == []


def test_turning_an_account_into_a_card_deletes_its_entries_overrides(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    second = _checking(client, me, name="Second")
    moved = _entry(client, me, second, "2026-10-20")
    other = _entry(client, me, bank, "2026-10-20", name="Other")
    _force(client, me, moved, "2026-10-20", "2026-10-22")
    _force(client, me, other, "2026-10-20", "2026-10-22")

    r = client.put(f"{API}/accounts/{second}", json={
        "account_type": "credit", "billing_cycle_start": 4, "days_until_due_date": 25,
        "payment_account_id": bank}, headers=me["headers"])

    assert r.status_code == 200, r.text
    assert _overrides(db, budget_entry_id=moved) == []
    assert _overrides(db, budget_entry_id=other) == [("2026-10-20", "2026-10-22")]


def test_a_loan_first_date_change_deletes_its_overrides(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    loan = _loan(client, me, bank)
    _force_loan(client, me, loan, "2026-10-10", "2026-10-25")

    r = client.put(f"{API}/accounts/{loan}", json={"loan_payment_amount": 8_500},
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _overrides(db, loan_account_id=loan) == [("2026-10-10", "2026-10-25")]

    r = client.put(f"{API}/accounts/{loan}", json={"loan_first_payment_date": "2026-10-12"},
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _overrides(db, loan_account_id=loan) == []


# --- 14: access --------------------------------------------------------------------------------

def test_an_editor_may_set_and_a_viewer_or_stranger_may_not(sw, sw_client, sw_db, monkeypatch):
    pin_clock(monkeypatch, REF)
    client, a, b, v, s = sw_client, sw["a"], sw["b"], sw["v"], sw["s"]
    entry = _entry(client, a, sw["joint"], "2026-10-20")
    loan = _loan(client, a, sw["joint"], first="2026-10-20")
    sw_share(sw_db, loan, b["id"], "editor", a["id"])
    sw_share(sw_db, loan, v["id"], "viewer", a["id"])

    _force(client, b, entry, "2026-10-20", "2026-10-22")
    _force_loan(client, b, loan, "2026-10-20", "2026-10-22")
    assert _overrides(sw_db, budget_entry_id=entry) == [("2026-10-20", "2026-10-22")]

    for who in (v, s):
        _force(client, who, entry, "2026-10-20", "2026-10-23", expect=404)
        _clear(client, who, entry, "2026-10-20", expect=404)
        _force_loan(client, who, loan, "2026-10-20", "2026-10-23", expect=404)
        _clear_loan(client, who, loan, "2026-10-20", expect=404)
    assert _overrides(sw_db, budget_entry_id=entry) == [("2026-10-20", "2026-10-22")]

    _clear(client, b, entry, "2026-10-20")
    _clear_loan(client, b, loan, "2026-10-20")


def test_a_limited_viewer_sees_the_effective_date_and_no_nominal_one(
        sw, sw_client, sw_db, monkeypatch):
    pin_clock(monkeypatch, REF)
    client, a, v = sw_client, sw["a"], sw["v"]
    entry = _entry(client, a, sw["joint"], "2026-10-20")
    loan = _loan(client, a, sw["joint"], first="2026-10-20")
    _force(client, a, entry, "2026-10-20", "2026-10-22")
    _force_loan(client, a, loan, "2026-10-20", "2026-10-24")

    rows = [p for p in _snapshot(client, v)["payables"] if p.get("view") == "limited"]
    assert sorted(p["date"] for p in rows) == ["2026-10-22", "2026-10-24"]
    assert "2026-10-20" not in str(rows)

    sw_share(sw_db, loan, v["id"], "viewer", a["id"])
    schedule = _schedule(client, v, loan)
    assert (schedule["view"], schedule["next_due_date"]) == ("limited", "2026-10-24")
    assert schedule["rows"][0]["due_date"] == "2026-10-24"


# --- 15: a posted row's date -------------------------------------------------------------------

def test_a_posted_cash_rows_date_edit_keeps_its_occurrence(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-10")
    paid = _mark_paid(client, me, entry)

    r = client.put(f"{API}/transactions/{paid['id']}",
                   json={"transaction_date": "2026-10-14T00:00:00"}, headers=me["headers"])

    assert r.status_code == 200, r.text
    row = _txn(db, paid["id"])
    assert row.transaction_date.date() == date(2026, 10, 14)
    assert row.occurrence_date.date() == date(2026, 10, 10)
    assert _missed(client, me, entry) == []
    assert _listed(client, me, entry)[0] == ("2026-11-10", "2026-11-10")


def test_a_date_only_edit_of_a_posted_loan_payment_changes_no_due_date(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    loan = _loan(client, me, bank)
    paid = sw_post(client, me, f"/accounts/{loan}/loan-payment", {
        "from_account_id": bank, "principal": 7_550, "interest": 450,
        "transaction_date": "2026-10-10T00:00:00"})
    before = _schedule(client, me, loan)
    assert (before["payments_made"], before["next_due_date"]) == (1, "2026-11-10")

    r = client.put(f"{API}/transactions/{paid['id']}",
                   json={"transaction_date": "2026-10-14T00:00:00"}, headers=me["headers"])

    assert r.status_code == 200, r.text
    after = _schedule(client, me, loan)
    assert after["payments"][0]["date"].startswith("2026-10-14")
    assert after["owed"] == before["owed"]
    assert (after["payments_made"], after["next_due_date"], after["upcoming"]) == (
        before["payments_made"], before["next_due_date"], before["upcoming"])
    assert _payables(client, me, "loan", loan)[0][0] == "2026-11-10"


# --- 16: Household -----------------------------------------------------------------------------

def test_household_shows_the_effective_date(hh, sw_client, sw_db, monkeypatch):
    pin_clock(monkeypatch, REF)
    client, a = sw_client, hh["a"]
    tag = hh_household(sw_db, a)
    entry = _entry(client, a, hh["joint"], "2026-10-20", name="Household rent", tag_ids=[tag])
    _force(client, a, entry, "2026-10-20", "2026-10-24")

    for path, key in ((f"/household/{a['id']}/upcoming", "items"),
                      (f"/household/{a['id']}/dashboard", "upcoming")):
        (row, *_) = [i for i in _get(client, a, path)[key] if i.get("name") == "Household rent"]
        assert (row["due_date"], row["occurrence_date"]) == ("2026-10-24", "2026-10-20")


def test_household_overdue_reads_the_effective_date(hh, sw_client, sw_db, monkeypatch):
    pin_clock(monkeypatch, REF)
    client, a = sw_client, hh["a"]
    tag = hh_household(sw_db, a)
    entry = _capped(client, a, hh["joint"], "2026-10-05")
    _edit(client, a, entry, {"tag_ids": [tag]})
    _force(client, a, entry, "2026-10-05", "2026-10-12")

    (row, *_) = [i for i in _get(client, a, f"/household/{a['id']}/upcoming")["items"]
                 if i.get("name") == "Sofa"]
    assert (row["due_date"], row["overdue"], row["original_date"], row["occurrence_date"]) == (
        "2026-10-18", True, "2026-10-12", "2026-10-05")


# --- the table ---------------------------------------------------------------------------------

def test_export_lists_the_callers_overrides(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    entry = _entry(client, me, bank, "2026-10-20")
    loan = _loan(client, me, bank)
    _force(client, me, entry, "2026-10-20", "2026-10-22")
    _force_loan(client, me, loan, "2026-10-10", "2026-10-12")

    rows = _get(client, me, "/data/export.json")["payment_date_overrides"]

    assert [(r["budget_entry_id"], r["loan_account_id"], r["occurrence_date"],
             r["effective_date"]) for r in rows] == [
        (entry, None, "2026-10-20", "2026-10-22"), (None, loan, "2026-10-10", "2026-10-12")]
    assert list(rows[0]) == ["id", "budget_entry_id", "loan_account_id", "occurrence_date",
                             "effective_date", "created_at", "updated_at"]
    r = client.get(f"{API}/data/export.csv?table=payment_date_overrides", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert r.text.splitlines()[0].startswith("id,budget_entry_id,loan_account_id")


def test_export_leaves_out_another_users_overrides(world):
    client, me, bank = world["client"], world["me"], world["bank"]
    other = world["people"]()
    _force(client, me, _entry(client, me, bank, "2026-10-20"), "2026-10-20", "2026-10-22")

    assert _get(client, other, "/data/export.json")["payment_date_overrides"] == []


def test_deleting_the_entry_or_loan_cascades(world):
    client, me, bank, db = world["client"], world["me"], world["bank"], world["db"]
    entry = _entry(client, me, bank, "2026-10-20")
    loan = _loan(client, me, bank)
    _force(client, me, entry, "2026-10-20", "2026-10-22")
    _force_loan(client, me, loan, "2026-10-10", "2026-10-12")

    assert client.delete(f"{API}/budget-entries/{entry}", headers=me["headers"]).status_code == 204
    assert _overrides(db, budget_entry_id=entry) == []
    db.execute(text("DELETE FROM accounts WHERE id = :a"), {"a": loan})
    db.commit()
    assert _overrides(db, loan_account_id=loan) == []


def test_upgrade_adds_the_table_and_downgrade_drops_it(scratch_url):  # noqa: F811
    from sqlalchemy import create_engine, inspect
    from sqlalchemy.exc import IntegrityError

    def tables():
        engine = create_engine(scratch_url)
        try:
            with engine.connect() as c:
                return set(inspect(c).get_table_names())
        finally:
            engine.dispose()

    _alembic(scratch_url, "upgrade", REVISION)
    assert "payment_date_overrides" in tables()
    insert = text("INSERT INTO payment_date_overrides (budget_entry_id, loan_account_id, "
                  "occurrence_date, effective_date) VALUES (:e, :l, :o, :f)")
    engine = create_engine(scratch_url)  # noqa: F811
    try:
        with engine.begin() as c:
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('forced@example.com', 'x', 'F', 'D') RETURNING id")).scalar_one()
            loan = c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, balance) "
                "VALUES (:u, 'Loan', 'loan', 0) RETURNING id"), {"u": user}).scalar_one()
        for row in ({"e": None, "l": None, "o": "2026-11-04", "f": "2026-11-05"},  # no owner
                    {"e": None, "l": loan, "o": "2026-11-04", "f": "2026-11-04"}):  # not moved
            with pytest.raises(IntegrityError):
                with engine.begin() as c:
                    c.execute(insert, row)
        with engine.begin() as c:
            c.execute(insert, {"e": None, "l": loan, "o": "2026-11-04", "f": "2026-11-05"})
        with pytest.raises(IntegrityError):  # one per occurrence
            with engine.begin() as c:
                c.execute(insert, {"e": None, "l": loan, "o": "2026-11-04", "f": "2026-11-06"})
    finally:
        engine.dispose()
    _alembic(scratch_url, "downgrade", PREVIOUS)
    assert "payment_date_overrides" not in tables()


# --- the walk's reach --------------------------------------------------------------------------

@pytest.mark.parametrize("cadence, first, cap", [
    (RecurrenceFrequency.WEEKLY, datetime(1985, 1, 7), None),  # past the 2000-step guard
    (RecurrenceFrequency.WEEKLY, datetime(1985, 1, 7), 3000),
    (RecurrenceFrequency.SEMI_MONTHLY, datetime(1970, 1, 1), None),  # past the 600-month one
])
def test_a_long_stale_schedule_still_reaches_the_window(cadence, first, cap):
    """The walk starts at ``next_occurrence`` whatever its window, as a recurring cover's
    does (same walker); its step bound comes from that distance, not the default guard."""
    entry = SimpleNamespace(
        cadence=cadence, next_occurrence=first, end_date=None, anchor_day=None, day_rule=None,
        end_mode="after_occurrences" if cap else "never", max_occurrences=cap,
        semi_monthly_day_1=1, semi_monthly_day_2=15)
    start, end = datetime(2026, 10, 18), datetime(2026, 11, 5)
    nominal = next(iter_occurrences(entry, start, end, max_steps=20_000))
    forced = nominal + timedelta(days=1)

    walked = list(effective_window_occurrences(entry, start, end, {nominal.date(): forced.date()}))

    assert (forced, None, nominal) in walked

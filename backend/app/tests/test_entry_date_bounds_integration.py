"""Recurring-entry dates are bounded (STU-427).

``next_occurrence`` runs from 2000-01-01 to Manila's today plus five years and
``end_date`` from 2000-01-01 to Manila's today plus thirty years, both
inclusive (owner ruling 2026-11-15). Create checks both; an edit checks only
the dates it changes, so an entry stored with an out-of-range date (a legacy
row) still saves an edit that leaves that date as stored: omitted, or sent
equal to the stored value. Skips without a database.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

NEXT_YEARS, END_YEARS = 5, 30
MODES = ["create", "update"]


def _today() -> date:
    from app.core.time import manila_today

    return manila_today()


def _max(years: int) -> date:
    today = _today()
    try:
        return today.replace(year=today.year + years)
    except ValueError:
        return today.replace(year=today.year + years, day=28)


def _message(years: int) -> str:
    return f"Choose a date from 2000-01-01 to {_max(years).isoformat()}"


def _at(day) -> str:
    return f"{day.isoformat() if isinstance(day, date) else day}T00:00:00Z"


def _out_of_range(years: int) -> list:
    return [_at("1999-12-31"), _at(_max(years) + timedelta(days=1)), "0006-05-10T00:00:00.000Z"]


def _checking(client, who) -> int:
    return sw_post(client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]


def _body(account_id, **over):
    """A weekly expense: no day of the month, so any date may be sent."""
    body = {"name": "Gym", "entry_type": "expense", "amount": 100, "cadence": "weekly",
            "next_occurrence": _at(_today()), "account_id": account_id}
    body.update(over)
    return body


def _create(client, who, body):
    return client.post(f"{API}/budget-entries/", json=body, headers=who["headers"])


def _update(client, who, entry_id, body):
    return client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])


def _get(client, who, entry_id):
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _send(client, who, account_id, mode, **fields):
    """Create an entry with ``fields``, or create a plain one and edit ``fields`` onto it."""
    if mode == "create":
        return _create(client, who, _body(account_id, **fields))
    entry_id = sw_post(client, who, "/budget-entries/", _body(account_id))["id"]
    return _update(client, who, entry_id, fields)


def _refusal(r) -> str:
    """The refusal text: a schema error on create, the edit check's detail on update."""
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    return detail if isinstance(detail, str) else detail[0]["msg"]


def _store(db, entry_id, **dates) -> None:
    """Write dates straight to the row: what a legacy row holds, which the API now refuses."""
    db.execute(text("UPDATE budget_entries SET "
                    + ", ".join(f"{k} = :{k}" for k in dates) + " WHERE id = :id"),
               {**dates, "id": entry_id})
    db.commit()


# --- AC1: next_occurrence --------------------------------------------------------------------

@pytest.mark.parametrize("mode", MODES)
def test_next_occurrence_bounds_rejection(mode, sw_client, sw_people):
    me = sw_people()
    acct = _checking(sw_client, me)
    for bad in _out_of_range(NEXT_YEARS):
        r = _send(sw_client, me, acct, mode, next_occurrence=bad)
        assert _refusal(r) == _message(NEXT_YEARS), (mode, bad)


@pytest.mark.parametrize("mode", MODES)
def test_next_occurrence_bounds_endpoints(mode, sw_client, sw_people):
    me = sw_people()
    acct = _checking(sw_client, me)
    for ok in (date(2000, 1, 1), _max(NEXT_YEARS)):
        r = _send(sw_client, me, acct, mode, next_occurrence=_at(ok))
        assert r.status_code in (200, 201), (mode, ok, r.text)
        assert r.json()["next_occurrence"].startswith(ok.isoformat())


# --- AC2: end_date ---------------------------------------------------------------------------

@pytest.mark.parametrize("mode", MODES)
def test_end_date_bounds_rejection(mode, sw_client, sw_people):
    me = sw_people()
    acct = _checking(sw_client, me)
    for bad in _out_of_range(END_YEARS):
        r = _send(sw_client, me, acct, mode, end_mode="on_date", end_date=bad)
        assert _refusal(r) == _message(END_YEARS), (mode, bad)


@pytest.mark.parametrize("mode", MODES)
def test_end_date_bounds_endpoints(mode, sw_client, sw_people):
    me = sw_people()
    acct = _checking(sw_client, me)
    for ok in (date(2000, 1, 1), _max(END_YEARS)):
        r = _send(sw_client, me, acct, mode, end_mode="on_date", end_date=_at(ok))
        assert r.status_code in (200, 201), (mode, ok, r.text)
        assert r.json()["end_date"].startswith(ok.isoformat())
    # Past next_occurrence's reach, inside end_date's: refused there, accepted here.
    between = _at(_max(NEXT_YEARS) + timedelta(days=1))
    r = _send(sw_client, me, acct, mode, end_mode="on_date", end_date=between)
    assert r.status_code in (200, 201), (mode, r.text)


# --- AC3: an untouched stored date -----------------------------------------------------------

def test_update_untouched_old_dates_ok(sw_client, sw_db, sw_people):
    me = sw_people()
    acct = _checking(sw_client, me)
    entry_id = sw_post(sw_client, me, "/budget-entries/",
                       _body(acct, end_mode="on_date", end_date=_at(_today())))["id"]
    old_next, far_end = "1999-12-05 00:00:00", f"{_max(END_YEARS).year + 1}-06-30 00:00:00"
    _store(sw_db, entry_id, next_occurrence=old_next, end_date=far_end)
    stored = _get(sw_client, me, entry_id)
    sent_next, sent_end = stored["next_occurrence"], stored["end_date"]

    # Both omitted.
    r = _update(sw_client, me, entry_id, {"name": "Omitted"})
    assert r.status_code == 200, r.text
    # Both sent as stored (the form's save), and once as the same instant in +08:00.
    r = _update(sw_client, me, entry_id, {"name": "Echoed", "next_occurrence": sent_next,
                                          "end_date": sent_end})
    assert r.status_code == 200, r.text
    r = _update(sw_client, me, entry_id, {"name": "Offset",
                                          "next_occurrence": "1999-12-05T08:00:00+08:00"})
    assert r.status_code == 200, r.text
    after = _get(sw_client, me, entry_id)
    assert after["name"] == "Offset"
    assert after["next_occurrence"].startswith("1999-12-05")
    assert after["end_date"].startswith(far_end[:10])

    # Editing one date checks that one; the other, untouched, keeps its exemption.
    r = _update(sw_client, me, entry_id, {"next_occurrence": _at("1999-12-12"),
                                          "end_date": sent_end})
    assert _refusal(r) == _message(NEXT_YEARS)
    r = _update(sw_client, me, entry_id, {"end_date": _at(_max(END_YEARS) + timedelta(days=1)),
                                          "next_occurrence": sent_next})
    assert _refusal(r) == _message(END_YEARS)
    r = _update(sw_client, me, entry_id, {"end_date": _at(_today()), "next_occurrence": sent_next})
    assert r.status_code == 200, r.text
    assert r.json()["next_occurrence"].startswith("1999-12-05")

    _store(sw_db, entry_id, end_date=far_end)
    r = _update(sw_client, me, entry_id, {"next_occurrence": _at(_today())})
    assert r.status_code == 200, r.text
    assert r.json()["end_date"].startswith(far_end[:10])
    assert r.json()["next_occurrence"].startswith(_today().isoformat())

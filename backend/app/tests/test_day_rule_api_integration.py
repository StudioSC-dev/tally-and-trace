"""``anchor_day`` and ``day_rule`` through the API (STU-315, plan sections 2.4, 3.4, 3.7).

Each branch of the write rule, read back through the database. Rules are
computed on the stored date's UTC components (naive input is UTC
components; aware input is converted), so naive, ``Z`` and ``+08:00`` inputs
are all checked against what is persisted. A legacy row (both fields null)
stays legacy unless the client names ``anchor_day``. Accounts and amounts
are generic fixtures. Skips without a database.
"""
from datetime import datetime, timezone

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")


@pytest.fixture
def world(sw_client, sw_people):
    who = sw_people("Day", "Api")
    bank = sw_post(sw_client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 10_000})["id"]
    return who, bank


def _body(bank, next_occurrence, **kw):
    body = {"name": "Generic bill", "entry_type": "expense", "amount": 100,
            "cadence": "monthly", "next_occurrence": next_occurrence, "account_id": bank}
    body.update(kw)
    return body


def _create(client, who, bank, next_occurrence, expect=201, **kw):
    r = client.post(f"{API}/budget-entries/", headers=who["headers"],
                    json=_body(bank, next_occurrence, **kw))
    assert r.status_code == expect, r.text
    return r.json()


def _update(client, who, entry_id, expect=200, **kw):
    r = client.put(f"{API}/budget-entries/{entry_id}", headers=who["headers"], json=kw)
    assert r.status_code == expect, r.text
    return r.json()


def _stored(db, entry_id):
    """``(anchor_day, day_rule, next_occurrence as UTC components)`` from the database."""
    from app.models.budget_entry import BudgetEntry

    db.expire_all()
    e = db.get(BudgetEntry, entry_id)
    stored = e.next_occurrence.astimezone(timezone.utc).replace(tzinfo=None)
    return e.anchor_day, e.day_rule, stored


# --- Create ------------------------------------------------------------------------------

def test_create_derives_the_anchor_from_the_date(sw_client, sw_db, world):
    who, bank = world
    body = _create(sw_client, who, bank, "2026-10-31T00:00:00")
    assert (body["anchor_day"], body["day_rule"]) == (31, None)
    assert _stored(sw_db, body["id"]) == (31, None, datetime(2026, 10, 31))


def test_create_derives_for_every_month_family_cadence(sw_client, sw_db, world):
    who, bank = world
    for cadence in ("monthly", "quarterly", "semi_annual", "annual"):
        body = _create(sw_client, who, bank, "2026-08-31T00:00:00", cadence=cadence)
        assert _stored(sw_db, body["id"])[:2] == (31, None), cadence


def test_create_outside_the_month_family_stores_neither(sw_client, sw_db, world):
    who, bank = world
    for cadence in ("weekly", "biweekly", "semi_monthly"):
        body = _create(sw_client, who, bank, "2026-10-31T00:00:00", cadence=cadence)
        assert _stored(sw_db, body["id"])[:2] == (None, None), cadence
        _create(sw_client, who, bank, "2026-10-31T00:00:00", expect=422, cadence=cadence,
                anchor_day=31)
        _create(sw_client, who, bank, "2026-10-30T00:00:00", expect=422, cadence=cadence,
                day_rule="last_weekday")


def test_create_explicit_anchor_wins_and_is_validated(sw_client, sw_db, world):
    who, bank = world
    body = _create(sw_client, who, bank, "2027-02-28T00:00:00", anchor_day=31)
    assert _stored(sw_db, body["id"])[:2] == (31, None)  # clamped February
    r = sw_client.post(f"{API}/budget-entries/", headers=who["headers"],
                       json=_body(bank, "2027-03-10T00:00:00", anchor_day=31))
    assert r.status_code == 422
    assert "2027-03-31" in r.json()["detail"]
    _create(sw_client, who, bank, "2026-10-31T00:00:00", expect=422, anchor_day=0)
    _create(sw_client, who, bank, "2026-10-31T00:00:00", expect=422, anchor_day=32)


def test_create_explicit_null_anchor_is_a_legacy_row(sw_client, sw_db, world):
    who, bank = world
    body = _create(sw_client, who, bank, "2026-10-31T00:00:00", anchor_day=None)
    assert _stored(sw_db, body["id"])[:2] == (None, None)


def test_create_last_weekday(sw_client, sw_db, world):
    who, bank = world
    body = _create(sw_client, who, bank, "2026-10-30T00:00:00", day_rule="last_weekday")
    assert (body["anchor_day"], body["day_rule"]) == (None, "last_weekday")
    assert _stored(sw_db, body["id"])[:2] == (None, "last_weekday")


def test_create_rule_on_the_wrong_date_names_the_expected_one(sw_client, world):
    who, bank = world
    r = sw_client.post(f"{API}/budget-entries/", headers=who["headers"],
                       json=_body(bank, "2026-10-31T00:00:00", day_rule="last_weekday"))
    assert r.status_code == 422
    assert "2026-10-30" in r.json()["detail"]
    _create(sw_client, who, bank, "2026-10-30T00:00:00", expect=422, day_rule="first_weekday")


def test_create_rule_and_anchor_together_is_refused(sw_client, world):
    who, bank = world
    _create(sw_client, who, bank, "2026-10-30T00:00:00", expect=422,
            day_rule="last_weekday", anchor_day=30)


# --- Canonical date: naive, Z and +08:00 --------------------------------------------------

def test_aware_and_naive_inputs_derive_on_the_persisted_date(sw_client, sw_db, world):
    who, bank = world
    for sent in ("2026-10-31T00:00:00", "2026-10-31T00:00:00Z", "2026-11-01T07:00:00+08:00"):
        body = _create(sw_client, who, bank, sent)
        anchor, _, stored = _stored(sw_db, body["id"])
        assert (anchor, stored.date()) == (31, datetime(2026, 10, 31).date()), sent
    # Midnight in Manila is 16:00 the day before in UTC: derived from that day.
    body = _create(sw_client, who, bank, "2026-11-01T00:00:00+08:00")
    assert _stored(sw_db, body["id"]) == (31, None, datetime(2026, 10, 31, 16, 0))


def test_aware_inputs_are_validated_on_the_persisted_date(sw_client, sw_db, world):
    who, bank = world
    body = _create(sw_client, who, bank, "2026-10-31T06:00:00+08:00", day_rule="last_weekday")
    assert _stored(sw_db, body["id"]) == (None, "last_weekday", datetime(2026, 10, 30, 22, 0))
    body = _create(sw_client, who, bank, "2026-10-30T20:00:00Z", day_rule="last_weekday")
    assert _stored(sw_db, body["id"])[1:] == ("last_weekday", datetime(2026, 10, 30, 20, 0))
    # 31 Oct in Manila is still 30 Oct in UTC: not on day 31.
    _create(sw_client, who, bank, "2026-10-31T00:00:00+08:00", expect=422, anchor_day=31)
    _create(sw_client, who, bank, "2026-11-01T00:00:00+08:00", anchor_day=31)


# --- Update ------------------------------------------------------------------------------

def _legacy(sw_client, sw_db, who, bank, when="2026-10-31T00:00:00"):
    entry = _create(sw_client, who, bank, when, anchor_day=None)["id"]
    assert _stored(sw_db, entry)[:2] == (None, None)
    return entry


def test_legacy_row_stays_legacy_on_unrelated_edits_and_date_changes(sw_client, sw_db, world):
    who, bank = world
    entry = _legacy(sw_client, sw_db, who, bank)
    _update(sw_client, who, entry, name="Renamed bill")
    assert _stored(sw_db, entry)[:2] == (None, None)
    _update(sw_client, who, entry, next_occurrence="2026-11-15T00:00:00")
    assert _stored(sw_db, entry) == (None, None, datetime(2026, 11, 15))
    _update(sw_client, who, entry, cadence="quarterly")
    assert _stored(sw_db, entry)[:2] == (None, None)


def test_legacy_row_is_anchored_only_when_the_client_names_an_anchor(sw_client, sw_db, world):
    who, bank = world
    entry = _legacy(sw_client, sw_db, who, bank)
    _update(sw_client, who, entry, anchor_day=31)
    assert _stored(sw_db, entry)[:2] == (31, None)


def test_entering_the_month_family_derives(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-31T00:00:00", cadence="weekly")["id"]
    _update(sw_client, who, entry, cadence="monthly")
    assert _stored(sw_db, entry)[:2] == (31, None)
    other = _create(sw_client, who, bank, "2026-10-31T00:00:00", cadence="weekly")["id"]
    _update(sw_client, who, other, cadence="monthly", next_occurrence="2026-11-12T00:00:00")
    assert _stored(sw_db, other)[:2] == (12, None)


def test_leaving_the_month_family_clears_both(sw_client, sw_db, world):
    who, bank = world
    anchored = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    ruled = _create(sw_client, who, bank, "2026-10-30T00:00:00", day_rule="last_weekday")["id"]
    for entry in (anchored, ruled):
        _update(sw_client, who, entry, expect=422, cadence="weekly", anchor_day=5)
        _update(sw_client, who, entry, cadence="weekly")
        assert _stored(sw_db, entry)[:2] == (None, None)


def test_anchored_row_keeps_its_anchor_through_a_clamped_february(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    _update(sw_client, who, entry, next_occurrence="2027-02-28T00:00:00")
    assert _stored(sw_db, entry) == (31, None, datetime(2027, 2, 28))
    _update(sw_client, who, entry, next_occurrence="2027-03-31T00:00:00")
    assert _stored(sw_db, entry) == (31, None, datetime(2027, 3, 31))


def test_anchored_row_moved_to_another_day_is_re_anchored(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    _update(sw_client, who, entry, next_occurrence="2026-11-10T00:00:00")
    assert _stored(sw_db, entry)[:2] == (10, None)


def test_anchored_row_resent_with_the_same_date_keeps_its_anchor(sw_client, sw_db, world):
    """The form resends the date on every save: the value decides, not its presence."""
    who, bank = world
    entry = _create(sw_client, who, bank, "2027-02-28T00:00:00", anchor_day=31)["id"]
    _update(sw_client, who, entry, name="Renamed", next_occurrence="2027-02-28T00:00:00Z")
    assert _stored(sw_db, entry)[:2] == (31, None)


def test_explicit_anchor_on_update_is_validated(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    _update(sw_client, who, entry, expect=422, anchor_day=15)
    _update(sw_client, who, entry, anchor_day=15, next_occurrence="2026-11-15T00:00:00")
    assert _stored(sw_db, entry)[:2] == (15, None)


def test_explicit_null_anchor_on_update_makes_a_legacy_row(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    _update(sw_client, who, entry, anchor_day=None)
    assert _stored(sw_db, entry)[:2] == (None, None)


def test_rule_row_must_stay_on_the_rule(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-30T00:00:00", day_rule="last_weekday")["id"]
    r = sw_client.put(f"{API}/budget-entries/{entry}", headers=who["headers"],
                      json={"next_occurrence": "2026-11-27T00:00:00"})
    assert r.status_code == 422
    assert "2026-11-30" in r.json()["detail"]
    _update(sw_client, who, entry, next_occurrence="2026-11-30T00:00:00")
    assert _stored(sw_db, entry) == (None, "last_weekday", datetime(2026, 11, 30))


def test_a_null_anchor_alone_leaves_a_stored_rule(sw_client, sw_db, world):
    """Only a non-null anchor clears the stored rule (the request decides by value)."""
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-30T00:00:00", day_rule="last_weekday")["id"]
    _update(sw_client, who, entry, anchor_day=None)
    assert _stored(sw_db, entry)[:2] == (None, "last_weekday")


def test_clearing_the_rule_derives_from_the_date(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-30T00:00:00", day_rule="last_weekday")["id"]
    _update(sw_client, who, entry, day_rule=None)
    assert _stored(sw_db, entry)[:2] == (30, None)


def test_the_request_decides_between_rule_and_anchor(sw_client, sw_db, world):
    who, bank = world
    entry = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    _update(sw_client, who, entry, day_rule="last_weekday",
            next_occurrence="2026-11-30T00:00:00")
    assert _stored(sw_db, entry)[:2] == (None, "last_weekday")
    _update(sw_client, who, entry, anchor_day=15, next_occurrence="2026-12-15T00:00:00")
    assert _stored(sw_db, entry)[:2] == (15, None)
    _update(sw_client, who, entry, expect=422, anchor_day=31, day_rule="last_weekday",
            next_occurrence="2026-12-31T00:00:00")
    _update(sw_client, who, entry, anchor_day=None, day_rule="last_weekday",
            next_occurrence="2026-12-31T00:00:00")
    assert _stored(sw_db, entry)[:2] == (None, "last_weekday")


# --- Shared editor and export -------------------------------------------------------------

def test_a_shared_editor_sees_and_edits_the_fields(sw, sw_client, sw_db):
    a, b = sw["a"], sw["b"]
    entry = sw_post(sw_client, a, "/budget-entries/", _body(
        sw["joint"], "2026-10-30T00:00:00", day_rule="last_weekday"))["id"]
    r = sw_client.get(f"{API}/budget-entries/{entry}", headers=b["headers"])
    assert r.status_code == 200, r.text
    shared = r.json()
    assert shared["view"] == "shared_full"
    assert (shared["anchor_day"], shared["day_rule"]) == (None, "last_weekday")
    _update(sw_client, b, entry, day_rule=None, anchor_day=30)
    assert _stored(sw_db, entry)[:2] == (30, None)
    limited = sw_client.get(f"{API}/budget-entries/{entry}", headers=sw["v"]["headers"]).json()
    assert limited["view"] == "limited"
    assert "anchor_day" not in limited and "day_rule" not in limited


def test_export_carries_both_columns(sw_client, world):
    who, bank = world
    anchored = _create(sw_client, who, bank, "2026-10-31T00:00:00")["id"]
    ruled = _create(sw_client, who, bank, "2026-10-30T00:00:00", day_rule="last_weekday")["id"]
    r = sw_client.get(f"{API}/data/export.json", headers=who["headers"])
    assert r.status_code == 200, r.text
    rows = {e["id"]: e for e in r.json()["budget_entries"]}
    assert (rows[anchored]["anchor_day"], rows[anchored]["day_rule"]) == (31, None)
    assert (rows[ruled]["anchor_day"], rows[ruled]["day_rule"]) == (None, "last_weekday")

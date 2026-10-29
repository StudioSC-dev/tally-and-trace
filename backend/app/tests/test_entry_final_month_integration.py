"""PUT /budget-entries/{id}: the final-month rule (STU-343 Plan B, B1).

On a capped entry with payments left, an edit that moves the schedule (next
date, cadence or a day field) and leaves the count as stored keeps the last
payment: the remaining count is recounted to it, and with the cadence
unchanged the months moved over count as paid outside the app. A changed
count is respected as sent. A date after the last payment, more than 360
payments, or more than 360 paid outside the app is a 422 and nothing is
written. A PUT on a paused entry, resuming it or leaving it paused, skips
the rule. Skips without a database.
"""
import sys
from datetime import date, datetime

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
AFTER_FINAL = ("The new date is after the plan's last payment (2028-06-05); "
               "change the number of payments too")
TOO_MANY = "That makes more than 360 payments; change the number of payments too"
TOO_MANY_OUTSIDE = ("That counts more than 360 payments made outside the app; "
                    "change the number of payments too")


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking):
    return _account(client, who, "Card C", "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)


def _entry(client, who, card, name="Tablet", next_day="2026-07-05", remaining=24, **extra):
    """Default: Tablet, PHP 5,000 on the 5th, capped, 24 remaining, next 2026-07-05
    (last payment 2028-06-05)."""
    body = {"name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
            "next_occurrence": f"{next_day}T00:00:00", "account_id": card,
            "end_mode": "after_occurrences", "max_occurrences": remaining, **extra}
    return sw_post(client, who, "/budget-entries/", body)["id"]


def _get(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _put(client, who, entry_id, body):
    return client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])


def _ok(client, who, entry_id, body) -> dict:
    r = _put(client, who, entry_id, body)
    assert r.status_code == 200, r.text
    return r.json()


def _day(d: str) -> str:
    return f"{d}T00:00:00"


def _last_payment(db, entry_id) -> date:
    """The schedule's last payment, walked as posting walks it."""
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import _naive, capped_distinct_days

    db.expire_all()
    e = db.get(BudgetEntry, entry_id)
    walk = capped_distinct_days(e, _naive(e.next_occurrence), datetime.max,
                                max_steps=2 * e.max_occurrences + 2)
    return walk[-1].date()


@pytest.fixture
def world(sw_client, sw_people, monkeypatch):
    client = sw_client
    owner = sw_people("Olive", "Owner")
    checking = _account(client, owner)
    card = _card(client, owner, checking)
    pin_clock(monkeypatch, REF)
    return {"client": client, "o": owner, "card": card}


def test_moving_the_next_date_forward_keeps_the_final_month(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"])
    assert _last_payment(sw_db, tablet) == date(2028, 6, 5)

    body = _ok(client, o, tablet, {"next_occurrence": _day("2026-11-05")})

    assert body["max_occurrences"] == 20
    assert body["occurrences_paid_offset"] == 4
    assert _last_payment(sw_db, tablet) == date(2028, 6, 5)
    # "n of m": paid (linked rows plus the offset) and the total.
    assert body["occurrences_paid"] == 4
    assert body["occurrences_paid"] + body["max_occurrences"] == 24


def test_form_shaped_payload_keeps_the_final_month(world, sw_db):
    client, o, card = world["client"], world["o"], world["card"]
    tablet = _entry(client, o, card)
    loaded = _get(client, o, tablet)

    body = _ok(client, o, tablet, {
        "name": "Tablet", "entry_type": "expense", "amount": 5_000, "currency": "PHP",
        "account_id": card, "overflow_account_id": None, "transfer_to_account_id": None,
        "cadence": "monthly", "next_occurrence": _day("2026-11-05"), "anchor_day": 5,
        "lead_time_days": 0, "is_autopay": False, "is_active": True,
        "end_mode": "after_occurrences", "end_date": None, "max_occurrences": 24,
        "expected_updated_at": loaded["updated_at"]})

    assert body["max_occurrences"] == 20
    assert body["occurrences_paid_offset"] == 4
    assert _last_payment(sw_db, tablet) == date(2028, 6, 5)


def test_changed_count_with_a_new_date_is_respected(world):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"])

    body = _ok(client, o, tablet, {"next_occurrence": _day("2026-11-05"),
                                   "max_occurrences": 30})

    assert body["max_occurrences"] == 30
    assert body["occurrences_paid_offset"] == 0


def test_moving_the_date_back_lengthens_to_the_same_final_month(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"])
    _ok(client, o, tablet, {"next_occurrence": _day("2026-11-05")})

    body = _ok(client, o, tablet, {"next_occurrence": _day("2026-09-05")})

    assert body["max_occurrences"] == 22
    assert body["occurrences_paid_offset"] == 2
    assert _last_payment(sw_db, tablet) == date(2028, 6, 5)


def test_a_day_change_keeps_the_final_month(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"])

    body = _ok(client, o, tablet, {"next_occurrence": _day("2026-07-10"), "anchor_day": 10})

    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, tablet) == date(2028, 6, 10)


def test_a_date_after_the_final_month_is_refused(world):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"])
    before = _get(client, o, tablet)

    r = _put(client, o, tablet, {"next_occurrence": _day("2028-07-05")})

    assert r.status_code == 422, r.text
    assert r.json()["detail"] == AFTER_FINAL
    assert _get(client, o, tablet) == before


def test_open_ended_entries_are_unaffected(world):
    client, o, card = world["client"], world["o"], world["card"]
    netflix = sw_post(client, o, "/budget-entries/", {
        "name": "Netflix", "entry_type": "expense", "amount": 549, "cadence": "monthly",
        "next_occurrence": _day("2026-07-10"), "account_id": card})["id"]

    body = _ok(client, o, netflix, {"next_occurrence": _day("2026-11-10")})

    assert body["next_occurrence"].startswith("2026-11-10")
    assert body["max_occurrences"] is None
    assert body["occurrences_paid_offset"] == 0


def test_a_completed_entry_is_not_recounted(world):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], remaining=0, is_active=False,
                    occurrences_paid_offset=24)

    body = _ok(client, o, tablet, {"next_occurrence": _day("2026-12-05")})

    assert body["max_occurrences"] == 0
    assert body["occurrences_paid_offset"] == 24
    assert body["next_occurrence"].startswith("2026-12-05")


def test_odd_semi_monthly_count_keeps_the_final_slot(world, sw_db):
    client, o, card = world["client"], world["o"], world["card"]
    extra = {"cadence": "semi_monthly", "semi_monthly_day_1": 1, "semi_monthly_day_2": 15}
    kettle = _entry(client, o, card, "Kettle", "2026-11-01", 5, **extra)
    assert _last_payment(sw_db, kettle) == date(2027, 1, 1)

    body = _ok(client, o, kettle, {"next_occurrence": _day("2026-11-15")})

    assert body["max_occurrences"] == 4
    assert body["occurrences_paid_offset"] == 1
    assert _last_payment(sw_db, kettle) == date(2027, 1, 1)

    kettle2 = _entry(client, o, card, "Kettle", "2026-11-01", 5, **extra)
    body = _ok(client, o, kettle2, {"semi_monthly_day_1": 5, "semi_monthly_day_2": 20})

    assert body["max_occurrences"] == 5
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, kettle2) == date(2027, 1, 5)


def test_a_cadence_change_keeps_the_final_date(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], occurrences_paid_offset=3)

    body = _ok(client, o, tablet, {"cadence": "quarterly"})

    # Jul 5 2026, Oct 5, Jan 5 2027, Apr 5, Jul 5, Oct 5, Jan 5 2028, Apr 5.
    assert body["max_occurrences"] == 8
    assert _last_payment(sw_db, tablet) == date(2028, 4, 5)
    assert _last_payment(sw_db, tablet) <= date(2028, 6, 5)
    assert body["occurrences_paid_offset"] == 3


def test_a_derived_count_above_360_is_refused(world):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], remaining=355)
    before = _get(client, o, tablet)

    r = _put(client, o, tablet, {"next_occurrence": _day("2026-01-05")})

    assert r.status_code == 422, r.text
    assert r.json()["detail"] == TOO_MANY
    assert _get(client, o, tablet) == before


def test_a_derived_offset_above_360_is_refused(world):
    client, o, card = world["client"], world["o"], world["card"]
    tablet = _entry(client, o, card, occurrences_paid_offset=355)

    body = _ok(client, o, tablet, {"next_occurrence": _day("2026-12-05")})
    assert body["max_occurrences"] == 19
    assert body["occurrences_paid_offset"] == 360

    fresh = _entry(client, o, card, occurrences_paid_offset=355)
    before = _get(client, o, fresh)
    r = _put(client, o, fresh, {"next_occurrence": _day("2027-01-05")})

    assert r.status_code == 422, r.text
    assert r.json()["detail"] == TOO_MANY_OUTSIDE
    after = _get(client, o, fresh)
    assert after == before
    assert (after["updated_at"], after["max_occurrences"], after["occurrences_paid_offset"]) == (
        before["updated_at"], 24, 355)


STALE = "This entry changed since you opened it; reopen it to edit"


def _tag_links(db, entry_id) -> list:
    from sqlalchemy import text

    return sorted(db.execute(text(
        "SELECT tag_id FROM budget_entry_tags WHERE budget_entry_id = :e"),
        {"e": entry_id}).scalars())


def test_a_stale_copy_is_refused_before_the_final_month_rule(world, sw_db):
    client, o, card = world["client"], world["o"], world["card"]
    tag = sw_post(client, o, "/tags/", {"name": "Gadgets"})["id"]
    tablet = _entry(client, o, card, tag_ids=[tag])
    loaded = _get(client, o, tablet)
    r = client.post(f"{API}/budget-entries/{tablet}/materialize",
                    json={"occurrence_date": _day("2026-07-05")}, headers=o["headers"])
    assert r.status_code == 201, r.text
    before = _get(client, o, tablet)
    assert before["updated_at"] != loaded["updated_at"]
    links = _tag_links(sw_db, tablet)
    assert links == [tag]
    after_final = {"next_occurrence": _day("2028-07-05"), "tag_ids": []}

    r = _put(client, o, tablet, {**after_final, "expected_updated_at": loaded["updated_at"]})

    assert r.status_code == 409, r.text
    assert r.json()["detail"] == STALE
    assert _get(client, o, tablet) == before
    assert _tag_links(sw_db, tablet) == links

    r = _put(client, o, tablet, {**after_final, "expected_updated_at": before["updated_at"]})

    assert r.status_code == 422, r.text
    assert r.json()["detail"] == AFTER_FINAL
    assert _get(client, o, tablet) == before
    assert _tag_links(sw_db, tablet) == links


def test_one_instant_with_any_offset_keeps_the_same_final_month(world, sw_db):
    client, o, card = world["client"], world["o"], world["card"]
    results = []
    for sent in ("2026-10-31T16:00:00Z", "2026-11-01T00:00:00+08:00"):
        tablet = _entry(client, o, card)
        body = _ok(client, o, tablet, {"next_occurrence": sent})
        results.append((body["next_occurrence"], body["max_occurrences"],
                        body["occurrences_paid_offset"], _last_payment(sw_db, tablet)))

    assert results[0] == results[1]
    assert results[0][1:] == (21, 3, date(2028, 6, 30))


def test_a_kept_end_on_the_last_day_a_date_holds(world, sw_db):
    client, o = world["client"], world["o"]
    far = _entry(client, o, world["card"], "Far", "9999-11-05", 2)
    assert _last_payment(sw_db, far) == date(9999, 12, 5)

    body = _ok(client, o, far, {"next_occurrence": _day("9999-11-06"), "anchor_day": 6})

    assert body["max_occurrences"] == 2
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, far) == date(9999, 12, 6)


def test_a_weekly_entry_keeps_the_final_day(world, sw_db):
    client, o = world["client"], world["o"]
    gym = _entry(client, o, world["card"], "Gym", "2026-11-02", 10, cadence="weekly")
    assert _last_payment(sw_db, gym) == date(2027, 1, 4)

    body = _ok(client, o, gym, {"next_occurrence": _day("2026-11-16")})

    assert body["max_occurrences"] == 8
    assert body["occurrences_paid_offset"] == 2
    assert _last_payment(sw_db, gym) == date(2027, 1, 4)


def test_ending_indefinitely_while_moving_the_date_is_not_recounted(world):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"])

    body = _ok(client, o, tablet, {"end_mode": "indefinite",
                                   "next_occurrence": _day("2026-11-05")})

    assert body["end_mode"] == "indefinite"
    assert body["next_occurrence"].startswith("2026-11-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0


# --- Resuming a paused entry skips the rule (owner ruling 2026-10-28) -------------------------
# A PUT that turns a paused entry back on keeps the pause behaviour from before
# the rule (905b562): the paused months are not counted, the count and the
# paid-outside offset stay as stored and the last payment moves later.

def test_resuming_with_a_new_date_keeps_the_count(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], is_active=False)

    body = _ok(client, o, tablet, {"is_active": True, "next_occurrence": _day("2027-01-05")})

    assert body["is_active"] is True
    assert body["next_occurrence"].startswith("2027-01-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, tablet) == date(2028, 12, 5)


def test_resuming_after_the_plan_would_have_ended_is_not_refused(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], is_active=False)

    body = _ok(client, o, tablet, {"is_active": True, "next_occurrence": _day("2029-01-05")})

    assert body["next_occurrence"].startswith("2029-01-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, tablet) == date(2030, 12, 5)


def test_resuming_with_a_cadence_change_is_not_recounted(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], is_active=False)

    body = _ok(client, o, tablet, {"is_active": True, "cadence": "quarterly"})

    assert body["cadence"] == "quarterly"
    # The paused months are skipped: the first quarterly date on or after today.
    assert body["next_occurrence"].startswith("2027-01-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, tablet) == date(2032, 10, 5)


# --- A still-paused edit skips the rule too (owner ruling 2026-10-29) -------------------------
# The rule applies only to an entry stored as active. An edit that leaves a
# paused entry paused keeps the pause behaviour, so moving the date and then
# resuming in two saves ends where one resuming save does.

def test_a_still_paused_date_edit_keeps_the_count(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], is_active=False)

    body = _ok(client, o, tablet, {"next_occurrence": _day("2027-01-05")})

    assert body["is_active"] is False
    assert body["next_occurrence"].startswith("2027-01-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0


def test_a_still_paused_date_after_the_old_final_is_not_refused(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], is_active=False)

    body = _ok(client, o, tablet, {"next_occurrence": _day("2029-01-05")})

    assert body["is_active"] is False
    assert body["next_occurrence"].startswith("2029-01-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0


def test_moving_the_date_while_paused_then_resuming_matches_one_resume(world, sw_db):
    client, o = world["client"], world["o"]
    tablet = _entry(client, o, world["card"], is_active=False)

    _ok(client, o, tablet, {"next_occurrence": _day("2027-01-05")})
    body = _ok(client, o, tablet, {"is_active": True, "next_occurrence": _day("2027-01-05")})

    # As test_resuming_with_a_new_date_keeps_the_count, in one save.
    assert body["is_active"] is True
    assert body["next_occurrence"].startswith("2027-01-05")
    assert body["max_occurrences"] == 24
    assert body["occurrences_paid_offset"] == 0
    assert _last_payment(sw_db, tablet) == date(2028, 12, 5)

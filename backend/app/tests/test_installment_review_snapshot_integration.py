"""Card installments on the dashboard snapshot (STU-343 Plan B, B2 commit 8).
Skips without a database.

``/dashboard/snapshot`` gains ``installment_review`` (installments the caller can
edit that are not reviewed), ``installment_auto_post`` (reviewed installments
with months due, with the caller's ``postable_count``, a ``state`` and the
``can_post``/``can_review`` flags), ``auto_post_scheduled`` and, on ``missed``
rows of card installments, ``auto_post``, ``block_reason`` and ``can_review``.
A viewer's or tag viewer's view of another member's installment is Limited, so
neither sees a row or the flags.

The world is the B2 commit 3 world (``test_installment_autopost_integration``):
Sunday 2026-10-18, 10:00 in Manila; Card C of O's, A admin, E editor, V viewer,
T tag viewer; "Tablet" is O's 5,000 on the 5th from 2026-07-05, so Jul 5 to
Oct 5 are due.
"""
from datetime import date, datetime

import pytest
from sqlalchemy import text

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_share
from app.tests.test_installment_autopost_integration import (
    _backstop, _card, _entry, _flags, _installment, _reviewed, _state, _txn, make_world,
    pin_clock,
)
from app.tests.test_installment_review_integration import NOT_FOUND, _get, _review

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

AUTO_POST_KEYS = ("installment_auto_post", "installment_review", "missed")
FLAG_KEYS = ("installment_reviewed", "auto_post_enabled")


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    return make_world(sw_client, sw_db, sw_people, monkeypatch)


def _snap(w, who) -> dict:
    r = w["client"].get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _by_id(rows) -> dict:
    return {row["entry_id"]: row for row in rows}


def _keys(node):
    """Every dict key in a JSON tree."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from _keys(value)
    elif isinstance(node, list):
        for item in node:
            yield from _keys(item)


def _unreviewed(w, **kw) -> int:
    entry_id = _installment(w, **kw)
    _flags(w["db"], entry_id, reviewed=False, on=False)
    return entry_id


# --- installment_review -----------------------------------------------------------------------

def test_snapshot_lists_installments_awaiting_review_for_editors(world):
    w = world
    tablet = _unreviewed(w)
    fridge = _unreviewed(w, name="Fridge", next_day="2026-12-05", remaining=12)
    _reviewed(w, name="Phone", next_day="2026-09-05", remaining=6)

    expected = [
        {"entry_id": fridge, "name": "Fridge", "account_name": "Card C", "missed_count": 0},
        {"entry_id": tablet, "name": "Tablet", "account_name": "Card C", "missed_count": 4},
    ]
    for who in ("o", "a", "e"):
        assert _snap(w, w[who])["installment_review"] == expected, who
    for who in ("v", "t"):
        assert _snap(w, w[who])["installment_review"] == [], who


def test_review_list_leaves_out_an_installment_that_cannot_auto_post(world):
    w, db = world, world["db"]
    nocycle = _card(w["client"], w["o"], w["checking"], name="Card N")
    odd = _unreviewed(w, name="Odd", card=nocycle)
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL, due_date = NULL "
                    "WHERE id = :id"), {"id": nocycle})
    db.commit()
    tablet = _unreviewed(w)

    assert [r["entry_id"] for r in _snap(w, w["o"])["installment_review"]] == [tablet]
    assert odd not in [r["entry_id"] for r in _snap(w, w["o"])["installment_review"]]


# --- installment_auto_post ----------------------------------------------------------------------

def test_auto_post_rows_include_a_month_due_today(world):
    w = world
    phone = _installment(w, name="Phone", next_day="2026-10-18", remaining=6)  # on from create
    _installment(w, name="Later", next_day="2026-10-19", remaining=6)

    rows = _by_id(_snap(w, w["o"])["installment_auto_post"])
    assert list(rows) == [phone]
    assert rows[phone] == {
        "entry_id": phone, "name": "Phone", "account_name": "Card C", "due_count": 1,
        "postable_count": 1, "due_today_count": 1, "oldest": "2026-10-18", "state": "on",
        "block_reason": None, "can_post": True, "can_review": True}


def test_due_today_count_counts_only_the_months_on_todays_manila_date(world):
    w = world
    today_only = _reviewed(w, name="Today", next_day="2026-10-18", remaining=6)
    with_past = _reviewed(w, name="Mixed", next_day="2026-08-18", remaining=6)
    for day in ("2026-08-18", "2026-09-18"):
        _txn(w, day, budget_entry_id=with_past, is_posted=False)
    past_only = _reviewed(w, name="Past", next_day="2026-08-05", remaining=6)

    rows = _by_id(_snap(w, w["o"])["installment_auto_post"])
    assert {i: (rows[i]["due_count"], rows[i]["due_today_count"])
            for i in (today_only, with_past, past_only)} == {
        today_only: (1, 1), with_past: (3, 1), past_only: (3, 0)}


def test_due_today_count_is_zero_for_a_shared_inactive_card_with_only_past_months(world):
    """The audit's repro: on Oct 18 an editor sees O's reviewed installment on a
    shared card that is now inactive, its Jul 5 to Sep 5 months each standing as
    a pending linked row. ``missed`` leaves another creator's entry out unless it
    touches an active account, so nothing there says the months are past."""
    w, db = world, world["db"]
    tablet = _reviewed(w, remaining=3)
    for day in ("2026-07-05", "2026-08-05", "2026-09-05"):
        _txn(w, day, budget_entry_id=tablet, is_posted=False)
    db.execute(text("UPDATE accounts SET is_active = false WHERE id = :id"), {"id": w["card"]})
    db.commit()

    snap = _snap(w, w["e"])
    row = _by_id(snap["installment_auto_post"])[tablet]
    assert (row["due_count"], row["due_today_count"]) == (3, 0)
    assert snap["missed"] == []


def test_auto_post_rows_carry_state_and_guidance(world):
    w, db = world, world["db"]
    tablet = _reviewed(w)
    _txn(w, "2026-08-07")
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    blocked = _reviewed(w, name="Blocked", card=card_n)
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL, due_date = NULL "
                    "WHERE id = :id"), {"id": card_n})
    db.commit()
    unreviewed = _unreviewed(w, name="Raw")

    rows = _by_id(_snap(w, w["o"])["installment_auto_post"])
    assert unreviewed not in rows
    assert {k: rows[tablet][k] for k in ("state", "due_count", "postable_count", "block_reason",
                                         "oldest")} == {
        "state": "held", "due_count": 4, "postable_count": 1, "block_reason": None,
        "oldest": "2026-07-05"}
    assert {k: rows[blocked][k] for k in ("state", "block_reason", "postable_count",
                                          "can_post", "can_review")} == {
        "state": "blocked", "block_reason": "no_statement_cycle", "postable_count": 0,
        "can_post": True, "can_review": True}

    _flags(db, tablet, reviewed=True, on=False)
    off = _by_id(_snap(w, w["o"])["installment_auto_post"])[tablet]
    assert (off["state"], off["postable_count"], off["due_count"]) == ("off", 0, 4)

    # A held month is held for every caller, and an editor who can post sees the same.
    _flags(db, tablet, reviewed=True, on=True)
    for who in ("a", "e"):
        row = _by_id(_snap(w, w[who])["installment_auto_post"])[tablet]
        assert (row["state"], row["postable_count"], row["can_post"], row["can_review"]) == (
            "held", 1, True, True), who


def test_auto_post_row_for_a_demoted_creator_is_blocked(world, monkeypatch):
    w, db = world, world["db"]
    edtab = _installment(w, name="EdTab", next_day="2026-10-05", remaining=6, who=w["e"],
                         amount=2_000)
    assert _entry(db, edtab).installment_reviewed_at is None
    body = _review(w, w["e"], edtab)
    assert body["next_occurrence"].startswith("2026-11-05") and body["max_occurrences"] == 5

    pin_clock(monkeypatch, datetime(2026, 11, 6, 2, 0))  # Nov 6, 10:00 in Manila
    before = _by_id(_snap(w, w["o"])["installment_auto_post"])[edtab]
    assert (before["state"], before["due_count"], before["postable_count"]) == ("on", 1, 1)

    db.execute(text("UPDATE account_shares SET role = 'viewer' WHERE account_id = :a "
                    "AND user_id = :u"), {"a": w["card"], "u": w["e"]["id"]})
    db.commit()

    for who, label in (("o", "owner"), ("e", "creator")):
        row = _by_id(_snap(w, w[who])["installment_auto_post"])[edtab]
        assert (row["state"], row["block_reason"], row["due_count"], row["postable_count"],
                row["can_post"], row["can_review"]) == (
            "blocked", "creator_no_access", 1, 0, False, False), label
    assert _backstop(w["client"], w["o"])["posted"] == 0
    assert _state(db, edtab) == (date(2026, 11, 5), 5)


def test_post_now_count_equals_what_the_backstop_posts(world):
    w, db = world, world["db"]
    held = _reviewed(w, name="Held")
    off = _installment(w, name="Off")
    _flags(db, off, reviewed=True, on=False)
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    sw_share(db, card_n, w["e"]["id"], "editor", w["o"]["id"])
    blocked = _reviewed(w, name="Blocked", card=card_n)
    plain = _reviewed(w, name="Plain")
    linked = _reviewed(w, name="Linked")
    _txn(w, "2026-08-05", budget_entry_id=linked)
    _txn(w, "2026-08-07")
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL, due_date = NULL "
                    "WHERE id = :id"), {"id": card_n})
    db.commit()

    rows = _by_id(_snap(w, w["o"])["installment_auto_post"])
    assert (rows[linked]["due_count"], rows[linked]["postable_count"]) == (3, 3)
    assert {i: rows[i]["postable_count"] for i in (held, off, blocked, plain, linked)} == {
        held: 1, off: 0, blocked: 0, plain: 4, linked: 3}
    total = sum(r["postable_count"] for r in rows.values())

    for who in ("v", "t"):
        snap = _snap(w, w[who])
        assert snap["installment_auto_post"] == [] and snap["installment_review"] == []
        assert _backstop(w["client"], w[who])["entries"] == []
    body = _backstop(w["client"], w["o"])
    assert body["posted"] == total == 8
    assert _state(db, linked) == (date(2026, 11, 5), 20)


# --- missed rows ------------------------------------------------------------------------------

def test_missed_installment_rows_carry_auto_post_state(world):
    w = world
    tablet = _unreviewed(w, name=f"Tablet {PRIVATE}")

    for who in ("o", "a", "e"):
        row = _by_id(_snap(w, w[who])["missed"])[tablet]
        assert (row["auto_post"], row["block_reason"], row["can_review"]) == (
            "unreviewed", None, True), who
        assert row["count"] == 4
    for who in ("v", "t"):
        assert tablet not in _by_id(_snap(w, w[who])["missed"]), who

    _flags(w["db"], tablet, reviewed=True, on=True)
    row = _by_id(_snap(w, w["o"])["missed"])[tablet]
    assert (row["auto_post"], row["can_review"]) == ("on", True)


def test_missed_row_offers_review_only_when_the_review_would_be_accepted(world):
    w, db = world, world["db"]
    plain = _unreviewed(w, name="Plain")
    foreign = _unreviewed(w, name="Lens", currency="USD")
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    nocycle = _unreviewed(w, name="Odd", card=card_n)
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL, due_date = NULL "
                    "WHERE id = :id"), {"id": card_n})
    db.commit()

    # Card N is O's alone, so only O sees the no-cycle row.
    for who, blocked_ids in (("o", (foreign, nocycle)), ("a", (foreign,)), ("e", (foreign,))):
        rows = _by_id(_snap(w, w[who])["missed"])
        assert rows[plain]["can_review"] is True, who
        for blocked in blocked_ids:
            assert rows[blocked]["auto_post"] == "unreviewed", who
            assert rows[blocked]["can_review"] is False, who
    review_ids = [r["entry_id"] for r in _snap(w, w["o"])["installment_review"]]
    assert plain in review_ids and foreign not in review_ids and nocycle not in review_ids


def test_unreviewed_entry_of_a_demoted_creator_is_not_offered_for_review(world):
    w, db = world, world["db"]
    edtab = _installment(w, name="EdTab", next_day="2026-10-05", remaining=6, who=w["e"],
                         amount=2_000)
    assert _entry(db, edtab).installment_reviewed_at is None
    assert edtab in [r["entry_id"] for r in _snap(w, w["e"])["installment_review"]]

    db.execute(text("UPDATE account_shares SET role = 'viewer' WHERE account_id = :a "
                    "AND user_id = :u"), {"a": w["card"], "u": w["e"]["id"]})
    db.commit()

    for who in ("o", "e"):
        assert _get(w, w[who], edtab, expect=404)["detail"] == NOT_FOUND, who
        assert edtab not in [r["entry_id"] for r in _snap(w, w[who])["installment_review"]], who


def test_other_missed_rows_carry_no_auto_post_keys(world):
    w = world
    rent = w["client"].post(f"{API}/budget-entries/", json={
        "name": "Rent", "entry_type": "expense", "amount": 100, "cadence": "monthly",
        "next_occurrence": "2026-09-05T00:00:00", "account_id": w["checking"]},
        headers=w["o"]["headers"])
    assert rent.status_code in (200, 201), rent.text

    row = _by_id(_snap(w, w["o"])["missed"])[rent.json()["id"]]
    assert not {"auto_post", "block_reason", "can_review"} & set(row)


# --- viewers ----------------------------------------------------------------------------------

def test_viewer_sees_no_auto_post_rows_or_flags(world):
    w = world
    _installment(w, name=f"Tablet {PRIVATE}")
    _reviewed(w, name=f"Phone {PRIVATE}", next_day="2026-09-05", remaining=6)
    _unreviewed(w, name=f"Fridge {PRIVATE}", next_day="2026-09-05", remaining=6)

    for who in ("v", "t"):
        snap = _snap(w, w[who])
        assert snap["installment_auto_post"] == [] and snap["installment_review"] == []
        assert snap["missed"] == [], who
        assert not set(FLAG_KEYS) & set(_keys(snap)), who
        assert sw_leaks({k: snap[k] for k in AUTO_POST_KEYS}) == [], who
        r = w["client"].get(f"{API}/budget-entries/", headers=w[who]["headers"])
        assert r.status_code == 200, r.text
        assert not set(FLAG_KEYS) & set(_keys(r.json())), who


def test_snapshot_state_is_canonical_across_callers(world):
    """The fixture of ``test_held_assignment_is_canonical_across_callers``: O's and
    A's snapshots give the same state per entry."""
    w = world
    tablet = _reviewed(w)                                      # the lower id
    phone = _reviewed(w, name="Phone")
    _txn(w, "2026-08-07")                                      # one candidate, two Aug 5s

    states = {who: {r["entry_id"]: r["state"] for r in _snap(w, w[who])["installment_auto_post"]}
              for who in ("o", "a")}
    assert states["o"] == states["a"] == {tablet: "held", phone: "on"}


def test_auto_post_scheduled_reflects_the_token(world, monkeypatch):
    from app.core.config import settings

    w = world
    monkeypatch.setattr(settings, "JOB_TOKEN", None)
    assert _snap(w, w["o"])["auto_post_scheduled"] is False
    monkeypatch.setattr(settings, "JOB_TOKEN", "test-job-token")
    assert _snap(w, w["o"])["auto_post_scheduled"] is True

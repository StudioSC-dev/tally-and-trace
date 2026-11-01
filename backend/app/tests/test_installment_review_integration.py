"""Reviewing a card installment: its missed months and duplicates (STU-343 Plan
B, B2 commit 5). Skips without a database.

``GET /budget-entries/{id}/auto-post-review`` lists what turning auto-post on
would record; ``POST`` links the chosen duplicates, turns auto-post on and
records every month due through Manila's today, bound to the GET by
``entry_version`` and a caller-bound ``review_token``. ``POST
/budget-entries/{id}/auto-post {enabled: false}`` turns it off and keeps the
review. Anyone who can edit the entry may do either (owner ruling Q3).

The world is the B2 commit 3 world (``test_installment_autopost_integration``):
Sunday 2026-10-18, 10:00 in Manila; Card C of O's (closes on the 24th, due 21
days later, tagged with O's Household tag), A admin, E editor, V viewer, T tag
viewer; "Tablet" is O's 5,000 on the 5th, 24 remaining, from 2026-07-05, so
Jul 5 to Oct 5 are due. A backdated installment starts unreviewed and off.
"""
import re
from datetime import date, datetime

import pytest
from sqlalchemy import text

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post
from app.tests.test_installment_autopost_integration import (
    MONTHS, TOKEN, _card, _entry, _flags, _installment, _job_ok, _rows, _state, _txn,
    make_world, pin_clock,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

CHANGED = "This installment changed since you opened the review; reopen it"
NOT_FOUND = "Budget entry not found"


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    return make_world(sw_client, sw_db, sw_people, monkeypatch)


@pytest.fixture
def token(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    return TOKEN


def _get(w, who, entry_id, expect=200):
    r = w["client"].get(f"{API}/budget-entries/{entry_id}/auto-post-review",
                        headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _post(w, who, entry_id, review, links=(), **override):
    body = {"entry_version": review["entry_version"], "review_token": review["review_token"],
            "links": [{"transaction_id": t, "occurrence_date": d.isoformat()}
                      for t, d in links], **override}
    return w["client"].post(f"{API}/budget-entries/{entry_id}/auto-post-review", json=body,
                            headers=who["headers"])


def _review(w, who, entry_id, links=()):
    r = _post(w, who, entry_id, _get(w, who, entry_id), links)
    assert r.status_code == 200, r.text
    return r.json()


def _turn_off(w, who, entry_id, enabled=False):
    return w["client"].post(f"{API}/budget-entries/{entry_id}/auto-post",
                            json={"enabled": enabled}, headers=who["headers"])


def _outcomes(body):
    return [(date.fromisoformat(o["occurrence_date"]), o["outcome"]) for o in body["outcomes"]]


def _balance(w, account=None):
    db = w["db"]
    db.rollback()
    return float(db.execute(text("SELECT balance FROM accounts WHERE id = :a"),
                            {"a": account or w["card"]}).scalar())


def _card_rows(w):
    """Every row on Card C: ``(id, amount, entry, occurrence day, posted, date, version)``."""
    db = w["db"]
    db.rollback()
    return sorted((r.id, float(r.amount), r.budget_entry_id,
                   r.occurrence_date.date() if r.occurrence_date else None, r.is_posted,
                   r.transaction_date.date(), r.updated_at)
                  for r in db.execute(text(
                      "SELECT id, amount, budget_entry_id, occurrence_date, is_posted, "
                      "transaction_date, updated_at FROM transactions WHERE account_id = :a"),
                      {"a": w["card"]}))


def _row(w, txn_id):
    db = w["db"]
    db.rollback()
    return db.execute(text(
        "SELECT id, amount, budget_entry_id, occurrence_date, is_posted, transaction_date, "
        "is_recurring, recurrence_frequency, updated_at, user_id, created_by_actor "
        "FROM transactions WHERE id = :t"), {"t": txn_id}).one()


def _unreviewed_off(w, entry_id):
    row = _entry(w["db"], entry_id)
    return row.installment_reviewed_at is None and row.auto_post_enabled is False


# --- the GET ----------------------------------------------------------------------------------

def test_review_lists_missed_months_and_duplicate_candidates(world, sw_people):
    w, db = world, world["db"]
    tablet = _installment(w)
    phone = _installment(w, name="Phone", next_day="2027-01-06", remaining=6)
    aug7 = _txn(w, "2026-08-07")
    sep4 = _txn(w, "2026-09-04", is_posted=False)
    _txn(w, "2026-08-06", amount=4_999)                       # another amount
    _txn(w, "2026-07-01")                                     # 4 days from Jul 5
    _txn(w, "2026-09-06", who=w["e"])                         # E's row on the joint card
    _txn(w, "2026-10-06", budget_entry_id=phone)              # linked to another entry
    r = w["client"].put(f"{API}/budget-entries/{tablet}", json={"name": "Tablet"},
                        headers=w["o"]["headers"])                # a stored version
    assert r.status_code == 200, r.text

    body = _get(w, w["o"], tablet)
    assert [m["occurrence_date"] for m in body["missed"]] == [d.isoformat() for d in MONTHS]
    assert all(m["linked"] is None for m in body["missed"])
    assert body["candidates"] == [
        {"occurrence_date": "2026-08-05", "transactions": [
            {"id": aug7, "date": "2026-08-07", "amount": 5_000.0, "is_posted": True,
             "description": "Card charge"}]},
        {"occurrence_date": "2026-09-05", "transactions": [
            {"id": sep4, "date": "2026-09-04", "amount": 5_000.0, "is_posted": False,
             "description": "Card charge"}]},
    ]
    assert body["remaining_after"] == 20
    assert (body["reviewed"], body["auto_post_enabled"], body["block"]) == (False, False, None)
    assert (body["name"], body["account_name"], body["currency"], body["amount"]) == (
        "Tablet", "Card C", "PHP", 5_000.0)
    assert body["past_cycles"] is True
    stored = _entry(db, tablet).updated_at
    assert stored is not None
    sent = datetime.fromisoformat(body["entry_version"].replace("Z", "+00:00"))
    assert sent == stored and sent.microsecond == stored.microsecond
    assert re.fullmatch(r"[0-9a-f]{64}", body["review_token"])
    assert _get(w, w["o"], tablet)["review_token"] == body["review_token"]
    # No row's entry, category or allocation is returned.
    for month in body["candidates"]:
        for row in month["transactions"]:
            assert set(row) == {"id", "date", "amount", "is_posted", "description"}


def test_review_lists_a_pending_linked_month(world):
    w = world
    tablet = _installment(w)
    _txn(w, "2026-07-05", is_posted=False, budget_entry_id=tablet)  # linked by its date
    body = _get(w, w["o"], tablet)
    assert body["missed"][0] == {"occurrence_date": "2026-07-05", "linked": "pending"}
    assert body["candidates"] == []


# --- the POST ---------------------------------------------------------------------------------

def test_review_links_then_enables_and_posts_the_rest(world):
    w, db = world, world["db"]
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    sep4 = _txn(w, "2026-09-04", is_posted=False)
    assert _balance(w) == -5_000

    body = _review(w, w["o"], tablet, [(aug7, date(2026, 8, 5)), (sep4, date(2026, 9, 5))])
    assert body["replayed"] is False
    assert _outcomes(body) == [
        (MONTHS[0], "created"), (MONTHS[1], "already_posted"),
        (MONTHS[2], "posted_pending"), (MONTHS[3], "created")]
    assert (body["reviewed"], body["auto_post_enabled"], body["max_occurrences"]) == (
        True, True, 20)
    assert body["next_occurrence"].startswith("2026-11-05")
    assert _state(db, tablet) == (date(2026, 11, 5), 20)
    row = _entry(db, tablet)
    assert row.installment_reviewed_at is not None and row.auto_post_enabled
    rows = _rows(db, tablet)
    assert [(r[1], r[0], r[2]) for r in rows] == [
        (MONTHS[0], MONTHS[0], True), (MONTHS[1], date(2026, 8, 7), True),
        (MONTHS[2], date(2026, 9, 4), True), (MONTHS[3], MONTHS[3], True)]
    assert [r[5] for r in rows if r[1] in (MONTHS[1], MONTHS[2])] == [aug7, sep4]
    assert _balance(w) == -20_000


# --- the response's representation (STU-474 commit 1) -----------------------------------------

def _advancing_review(w):
    """The review of ``test_review_links_then_enables_and_posts_the_rest``: Tablet,
    Aug 7 and Sep 4 linked, four outcomes. Returns the payload and the response."""
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    sep4 = _txn(w, "2026-09-04", is_posted=False)
    review = _get(w, w["o"], tablet)
    links = [(aug7, date(2026, 8, 5)), (sep4, date(2026, 9, 5))]
    r = _post(w, w["o"], tablet, review, links)
    assert r.status_code == 200, r.text
    return tablet, review, links, r.json()


def test_review_response_reads_the_committed_entry(world):
    """The response is built from the entry read back after the commit: the
    walk's advance assigns a naive ``next_occurrence``, and only the refresh
    gives back the column's aware value (``Z`` on the wire)."""
    w = world
    _, _, _, body = _advancing_review(w)
    assert body["next_occurrence"] == "2026-11-05T00:00:00Z"
    assert body["max_occurrences"] == 20
    assert _outcomes(body) == [
        (MONTHS[0], "created"), (MONTHS[1], "already_posted"),
        (MONTHS[2], "posted_pending"), (MONTHS[3], "created")]


def test_review_replay_response_is_unchanged(world):
    w = world
    tablet, review, links, first = _advancing_review(w)
    again = _post(w, w["o"], tablet, review, links)
    assert again.status_code == 200, again.text
    assert again.json() == {
        "replayed": True, "reviewed": True, "auto_post_enabled": True,
        "next_occurrence": first["next_occurrence"], "max_occurrences": 20, "outcomes": []}
    assert first["next_occurrence"] == "2026-11-05T00:00:00Z"


# --- r3 row 1 (flush) and r3.1 row 1 (walk) -----------------------------------------------------

def test_review_linking_the_oldest_due_month_adds_no_second_row(world):
    w, db = world, world["db"]
    tablet = _installment(w)
    jul6 = _txn(w, "2026-07-06")
    before = _balance(w)

    body = _review(w, w["o"], tablet, [(jul6, MONTHS[0])])
    assert [o for _, o in _outcomes(body)] == [
        "already_posted", "created", "created", "created"]
    rows = _rows(db, tablet)
    assert len(rows) == 4
    assert [r[5] for r in rows if r[1] == MONTHS[0]] == [jul6]
    assert _balance(w) - before == -15_000
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_review_linking_the_oldest_due_month_posts_the_pending_charge(world):
    w, db = world, world["db"]
    tablet = _installment(w)
    jul4 = _txn(w, "2026-07-04", is_posted=False)

    body = _review(w, w["o"], tablet, [(jul4, MONTHS[0])])
    assert _outcomes(body)[0] == (MONTHS[0], "posted_pending")
    rows = _rows(db, tablet)
    assert [(r[5], r[0], r[2]) for r in rows if r[1] == MONTHS[0]] == [
        (jul4, date(2026, 7, 4), True)]
    assert len(rows) == 4
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_review_linking_the_only_due_month_adds_no_second_row(world):
    w, db = world, world["db"]
    phone = _installment(w, name="Phone", next_day="2026-10-05", remaining=12)
    oct6 = _txn(w, "2026-10-06")

    body = _review(w, w["o"], phone, [(oct6, date(2026, 10, 5))])
    assert _outcomes(body) == [(date(2026, 10, 5), "already_posted")]
    assert [r[5] for r in _rows(db, phone)] == [oct6]
    assert _state(db, phone) == (date(2026, 11, 5), 11)


def test_review_link_sets_the_recurring_fields_and_version(world):
    w = world
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    before = _row(w, aug7)
    assert (before.is_recurring, before.recurrence_frequency) == (False, None)

    _review(w, w["o"], tablet, [(aug7, MONTHS[1])])
    after = _row(w, aug7)
    assert after.budget_entry_id == tablet
    assert after.occurrence_date.date() == MONTHS[1]
    assert after.is_recurring is True
    assert after.recurrence_frequency == "monthly"
    assert after.updated_at is not None
    assert before.updated_at is None or after.updated_at > before.updated_at


def test_review_link_is_the_only_non_creator_link_write(world):
    w = world
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    other = _txn(w, "2026-06-01", amount=1_200)

    _review(w, w["e"], tablet, [(aug7, MONTHS[1])])
    assert _row(w, aug7).budget_entry_id == tablet

    before = _row(w, other)
    for value in (tablet, None):
        r = w["client"].put(f"{API}/transactions/{other}", json={"budget_entry_id": value},
                            headers=w["e"]["headers"])
        assert r.status_code == 400, r.text
        assert r.json()["detail"].startswith("Only the transaction's creator can change")
    assert _row(w, other) == before


# --- the binding ------------------------------------------------------------------------------

def _binding_world(w):
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    return tablet, aug7, _get(w, w["o"], tablet)


def _refused(w, tablet, review, aug7):
    rows, entry = _card_rows(w), _entry(w["db"], tablet)
    r = _post(w, w["o"], tablet, review, [(aug7, MONTHS[1])])
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == CHANGED
    assert _card_rows(w) == rows
    assert _entry(w["db"], tablet) == entry
    assert _unreviewed_off(w, tablet)


def test_review_refuses_after_an_entry_edit(world):
    w = world
    tablet, aug7, review = _binding_world(w)
    r = w["client"].put(f"{API}/budget-entries/{tablet}", json={"name": "Tablet 2"},
                        headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    _refused(w, tablet, review, aug7)


def test_review_refuses_after_a_new_candidate(world):
    w = world
    tablet, aug7, review = _binding_world(w)
    _txn(w, "2026-09-06")
    _refused(w, tablet, review, aug7)


def test_review_refuses_after_a_candidate_edit(world):
    w = world
    tablet, aug7, review = _binding_world(w)
    for amount in (5_001, 5_000):
        r = w["client"].put(f"{API}/transactions/{aug7}", json={"amount": amount},
                            headers=w["o"]["headers"])
        assert r.status_code == 200, r.text
    _refused(w, tablet, review, aug7)


def test_review_refuses_after_a_mark_paid(world):
    w = world
    tablet, aug7, review = _binding_world(w)
    r = w["client"].post(f"{API}/budget-entries/{tablet}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    _refused(w, tablet, review, aug7)


def test_review_refuses_after_midnight(world, monkeypatch):
    w = world
    tablet, aug7, review = _binding_world(w)
    pin_clock(monkeypatch, datetime(2026, 10, 18, 16, 1))  # 00:01 on Oct 19 in Manila
    _refused(w, tablet, review, aug7)


def test_review_requires_the_binding(world):
    w = world
    tablet, aug7, review = _binding_world(w)
    url = f"{API}/budget-entries/{tablet}/auto-post-review"
    for body in ({"entry_version": review["entry_version"], "links": []},
                 {"review_token": review["review_token"], "links": []}):
        r = w["client"].post(url, json=body, headers=w["o"]["headers"])
        assert r.status_code == 422, r.text
    assert _unreviewed_off(w, tablet)


def test_review_token_is_bound_to_the_caller(world):
    w, db = world, world["db"]
    tablet = _installment(w)
    owners = _get(w, w["o"], tablet)
    admins = _get(w, w["a"], tablet)
    assert owners["review_token"] != admins["review_token"]

    rows = _card_rows(w)
    r = _post(w, w["a"], tablet, owners)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == CHANGED
    assert _card_rows(w) == rows and _unreviewed_off(w, tablet)

    r = _post(w, w["a"], tablet, _get(w, w["a"], tablet))
    assert r.status_code == 200, r.text
    assert [(r[3], r[4]) for r in _rows(db, tablet)] == [(w["o"]["id"], w["a"]["id"])] * 4


def test_review_recomputes_under_the_locks(world, monkeypatch):
    from app.core import locking
    from app.services import posting

    w = world
    tablet, aug7, review = _binding_world(w)
    events = []

    def spy(name, real):
        def wrapped(*args, **kwargs):
            events.append(name)
            return real(*args, **kwargs)
        return wrapped

    for name in ("lock_owner_budgets", "lock_entry", "lock_transaction"):
        monkeypatch.setattr(locking, name, spy(name, getattr(locking, name)))
    monkeypatch.setattr(posting, "review_state", spy("review_state", posting.review_state))

    r = _post(w, w["o"], tablet, review, [(aug7, MONTHS[1])])
    assert r.status_code == 200, r.text
    assert events[:3] == ["lock_owner_budgets", "lock_entry", "review_state"]
    assert events.index("review_state") < events.index("lock_transaction")
    assert events.count("review_state") == 1


def test_review_retry_after_success_is_a_no_op(world):
    w, db = world, world["db"]
    tablet, aug7, review = _binding_world(w)
    first = _post(w, w["o"], tablet, review, [(aug7, MONTHS[1])])
    assert first.status_code == 200, first.text
    rows, entry = _card_rows(w), _entry(db, tablet)

    again = _post(w, w["o"], tablet, review, [(aug7, MONTHS[1])])
    assert again.status_code == 200, again.text
    body = again.json()
    assert body["replayed"] is True and body["outcomes"] == []
    assert (body["reviewed"], body["auto_post_enabled"], body["max_occurrences"]) == (
        True, True, 20)
    assert _card_rows(w) == rows and _entry(db, tablet) == entry


def test_review_replay_check_reads_the_walk(world):
    """The replay check reads the schedule walk, not the unrecorded months: a
    reviewed, on entry whose only walk month already has a posted linked row
    still has that month to advance, so it is no replay."""
    w, db = world, world["db"]
    phone = _installment(w, name="Phone", next_day="2026-10-05", remaining=12)
    _flags(db, phone)
    oct5 = _txn(w, "2026-10-05", budget_entry_id=phone, occurrence_date="2026-10-05T00:00:00")
    assert _state(db, phone) == (date(2026, 10, 5), 12)

    r = _post(w, w["o"], phone, _get(w, w["o"], phone))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["replayed"] is False
    assert _outcomes(body) == [(date(2026, 10, 5), "already_posted")]
    assert body["max_occurrences"] == 11
    assert _state(db, phone) == (date(2026, 11, 5), 11)
    assert [row[5] for row in _rows(db, phone)] == [oct5]


def test_review_retry_after_the_review_ended_the_entry(world):
    w, db = world, world["db"]
    tablet = _installment(w, next_day="2026-09-05", remaining=2)
    review = _get(w, w["o"], tablet)
    first = _post(w, w["o"], tablet, review)
    assert first.status_code == 200, first.text
    row = _entry(db, tablet)
    assert (row.max_occurrences, row.is_active) == (0, False)
    rows = _card_rows(w)

    again = _post(w, w["o"], tablet, review)
    assert again.status_code == 200, again.text
    assert again.json()["replayed"] is True
    assert _card_rows(w) == rows


def test_review_rejects_invalid_links(world):
    w = world
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    aug4 = _txn(w, "2026-08-04")
    wrong_amount = _txn(w, "2026-08-06", amount=4_999)
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    other_card = _txn(w, "2026-08-06", account=card_n)
    other_owner = _txn(w, "2026-08-06", who=w["e"])
    too_far = _txn(w, "2026-08-01")
    review = _get(w, w["o"], tablet)
    aug5, sep5, nov5 = MONTHS[1], MONTHS[2], date(2026, 11, 5)

    cases = [
        [(wrong_amount, aug5)], [(other_card, aug5)], [(other_owner, aug5)], [(too_far, aug5)],
        [(aug7, nov5)], [(aug7, sep5)], [(aug7, aug5), (aug7, aug5)],
        [(aug7, aug5), (aug4, aug5)], [(999_999_999, aug5)],
    ]
    rows = _card_rows(w)
    for links in cases:
        r = _post(w, w["o"], tablet, review, links)
        assert r.status_code == 422, (links, r.text)
        assert _card_rows(w) == rows and _unreviewed_off(w, tablet), links


def test_review_rejects_a_link_to_a_month_with_a_linked_row(world):
    w = world
    tablet = _installment(w)
    _txn(w, "2026-07-05", is_posted=False, budget_entry_id=tablet)  # linked by its date
    jul6 = _txn(w, "2026-07-06")
    review = _get(w, w["o"], tablet)
    r = _post(w, w["o"], tablet, review, [(jul6, MONTHS[0])])
    assert r.status_code == 422, r.text
    assert _unreviewed_off(w, tablet)


def test_review_locks_rows_in_ascending_id_before_creating(world, monkeypatch):
    import app.routers.transactions as transactions_router
    from app.core import locking

    w = world
    tablet = _installment(w)
    oct5 = _txn(w, "2026-10-05", is_posted=False, budget_entry_id=tablet)
    sep4 = _txn(w, "2026-09-04", is_posted=False)
    aug7 = _txn(w, "2026-08-07")
    review = _get(w, w["o"], tablet)
    events = []
    real_lock, real_add = locking.lock_transaction, transactions_router.add_transaction

    def lock(db, txn_id, **kwargs):
        events.append(("lock", txn_id))
        return real_lock(db, txn_id, **kwargs)

    def add(*args, **kwargs):
        events.append(("add", None))
        return real_add(*args, **kwargs)

    monkeypatch.setattr(locking, "lock_transaction", lock)
    monkeypatch.setattr(transactions_router, "add_transaction", add)
    r = _post(w, w["o"], tablet, review, [(aug7, MONTHS[1]), (sep4, MONTHS[2])])
    assert r.status_code == 200, r.text
    first_add = events.index(("add", None))
    locked = [txn_id for kind, txn_id in events[:first_add] if kind == "lock"]
    assert locked[:3] == sorted([oct5, sep4, aug7]) == [oct5, sep4, aug7]
    assert set(locked) == {oct5, sep4, aug7}


def test_review_link_copies_entry_tags_once(world):
    w, db = world, world["db"]
    tag_a = sw_post(w["client"], w["o"], "/tags/", {"name": "Gadgets"})["id"]
    tag_b = sw_post(w["client"], w["o"], "/tags/", {"name": "Kids"})["id"]
    tablet = _installment(w, tag_ids=[tag_a, tag_b])
    aug7 = _txn(w, "2026-08-07", tag_ids=[tag_a])

    _review(w, w["o"], tablet, [(aug7, MONTHS[1])])

    def tags(txn_id):
        db.rollback()
        return sorted(t for (t,) in db.execute(text(
            "SELECT tag_id FROM transaction_tags WHERE transaction_id = :t"), {"t": txn_id}))

    assert tags(aug7) == sorted([tag_a, tag_b])
    created = [r[5] for r in _rows(db, tablet) if r[1] == MONTHS[0]]
    assert tags(created[0]) == sorted([tag_a, tag_b])


def test_review_refuses_paused_ended_and_ineligible(world):
    w, db = world, world["db"]
    paused = _installment(w, name="Paused")
    ended = _installment(w, name="Ended")
    db.execute(text("UPDATE budget_entries SET is_active = false WHERE id = :e"), {"e": paused})
    db.execute(text("UPDATE budget_entries SET is_active = false, max_occurrences = 0 "
                    "WHERE id = :e"), {"e": ended})
    db.commit()
    foreign = _installment(w, name="Lens", currency="USD")
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    nocycle = _installment(w, name="Watch", card=card_n)
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL, due_date = NULL "
                    "WHERE id = :id"), {"id": card_n})
    db.commit()
    stale = {"entry_version": None, "review_token": "0" * 64}

    for entry_id, status, detail in (
            (paused, 409, "This entry is paused"), (ended, 409, "This entry has ended"),
            (foreign, 400, "another currency"), (nocycle, 400, "no statement cycle")):
        rows = _card_rows(w)
        r = _post(w, w["o"], entry_id, stale)
        assert r.status_code == status, (entry_id, r.text)
        assert detail in r.json()["detail"]
        assert _card_rows(w) == rows and _unreviewed_off(w, entry_id)
    assert _get(w, w["o"], foreign)["block"] == "foreign_currency"
    assert _get(w, w["o"], nocycle)["block"] == "no_statement_cycle"


# --- roles (Q3) -------------------------------------------------------------------------------

def test_review_roles(world):
    w, db = world, world["db"]
    for who in ("o", "a", "e"):
        tablet = _installment(w, name=f"Tablet {who}")
        review = _get(w, w[who], tablet)
        assert [m["occurrence_date"] for m in review["missed"]] == [d.isoformat() for d in MONTHS]
        r = _post(w, w[who], tablet, review)
        assert r.status_code == 200, (who, r.text)
        assert [o for _, o in _outcomes(r.json())] == ["created"] * 4
        assert [(r[3], r[4]) for r in _rows(db, tablet)] == [(w["o"]["id"], w[who]["id"])] * 4

    tablet = _installment(w, name="Tablet v")
    owners = _get(w, w["o"], tablet)
    rows = _card_rows(w)
    for who in ("v", "t"):
        assert _get(w, w[who], tablet, expect=404)["detail"] == NOT_FOUND
        r = _post(w, w[who], tablet, owners)
        assert r.status_code == 404, (who, r.text)
        assert _card_rows(w) == rows and _unreviewed_off(w, tablet)


def test_review_envelope_is_creator_only(world):
    w = world
    allocation = sw_post(w["client"], w["o"], "/allocations/", {
        "account_id": w["checking"], "name": f"{PRIVATE} SW-ENVELOPE",
        "allocation_type": "savings", "target_amount": 10_000})["id"]
    tablet = _installment(w, allocation_id=allocation)
    _txn(w, "2026-08-07")

    assert _get(w, w["o"], tablet)["envelope"] == {"allocation_name": f"{PRIVATE} SW-ENVELOPE"}
    for who in ("a", "e"):
        body = _get(w, w[who], tablet)
        assert body["envelope"] is None
        assert "SW-ENVELOPE" not in str(body)
        # A row's own id comes from another sequence and may equal the
        # allocation's by chance: ``entry_id`` and a candidate's ``id`` are let
        # through; nothing else may carry it.
        own = {"$.entry_id": tablet}
        for i, month in enumerate(body["candidates"]):
            for j, row in enumerate(month["transactions"]):
                own[f"$.candidates[{i}].transactions[{j}].id"] = row["id"]
        leaks = [(where, value) for where, value in sw_leaks(body, private_ids=[allocation])
                 if own.get(where) != value]
        assert leaks == []


def test_review_lists_only_rows_the_caller_reads(world, monkeypatch):
    from app.core.access import RecordAccess

    w = world
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")
    sep4 = _txn(w, "2026-09-04", is_posted=False)
    real = RecordAccess.readable
    checked = []

    def readable(self, record):
        allowed = real(self, record)
        checked.append((self.uid, getattr(record, "id", None), allowed))
        return allowed

    monkeypatch.setattr(RecordAccess, "readable", readable)
    body = _get(w, w["e"], tablet)
    listed = [row["id"] for month in body["candidates"] for row in month["transactions"]]
    assert listed == [aug7, sep4]
    for txn_id in listed:
        assert (w["e"]["id"], txn_id, True) in checked

    # A row the caller does not read is dropped.
    monkeypatch.setattr(RecordAccess, "readable",
                        lambda self, record: getattr(record, "id", None) != aug7
                        and real(self, record))
    body = _get(w, w["e"], tablet)
    assert [row["id"] for month in body["candidates"] for row in month["transactions"]] == [sep4]


# --- the locked recheck (r3.1 row 2) ----------------------------------------------------------

@pytest.mark.parametrize("action", ["review", "turn_off", "mark_paid"])
def test_entry_writes_recheck_the_caller_after_the_locks(world, monkeypatch, action):
    """A demotion committed while the caller waited for the owner lock is seen."""
    from app.core import locking
    from app.core.database import SessionLocal
    from app.models.account import Account

    w, db = world, world["db"]
    tablet = _installment(w)
    if action == "turn_off":
        _flags(db, tablet)
    review = _get(w, w["e"], tablet) if action == "review" else None
    before, rows = _entry(db, tablet), _card_rows(w)
    real = locking.lock_owner_budgets
    calls, cached = [], []

    def demote_first(session, owner_id):
        if not calls:
            # The request's session holds Card C and its shares as read before
            # the lock (a strong reference keeps them in its identity map).
            account = session.get(Account, w["card"])
            assert [s.role for s in account.shares if s.user_id == w["e"]["id"]] == ["editor"]
            cached.append(account)
            other = SessionLocal()
            try:
                other.execute(text("UPDATE account_shares SET role = 'viewer' "
                                   "WHERE account_id = :a AND user_id = :u"),
                              {"a": w["card"], "u": w["e"]["id"]})
                other.commit()
            finally:
                other.close()
        calls.append(owner_id)
        return real(session, owner_id)

    monkeypatch.setattr(locking, "lock_owner_budgets", demote_first)
    if action == "review":
        r = _post(w, w["e"], tablet, review)
    elif action == "turn_off":
        r = _turn_off(w, w["e"], tablet)
    else:
        r = w["client"].post(f"{API}/budget-entries/{tablet}/materialize", json={},
                             headers=w["e"]["headers"])
    assert r.status_code == 404, r.text
    assert calls == [w["o"]["id"]]  # the creator's lock, taken once: nothing was recorded
    assert _card_rows(w) == rows
    assert _entry(db, tablet) == before


# --- turn off ---------------------------------------------------------------------------------

def test_turning_auto_post_off_keeps_the_review(world, token, monkeypatch):
    from app.services.forecast import payables_by_currency

    w, db = world, world["db"]
    tablet = _installment(w)
    _review(w, w["o"], tablet)
    assert _state(db, tablet) == (date(2026, 11, 5), 20)

    r = _turn_off(w, w["o"], tablet, enabled=True)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Review the installment to turn auto-post on"
    assert _entry(db, tablet).auto_post_enabled is True

    r = _turn_off(w, w["o"], tablet)
    assert r.status_code == 200, r.text
    assert (r.json()["installment_reviewed"], r.json()["auto_post_enabled"]) == (True, False)
    row = _entry(db, tablet)
    assert row.installment_reviewed_at is not None and row.auto_post_enabled is False

    # Dec 20: Nov 5 (statement Nov 24, due Dec 15) has lapsed unrecorded.
    pin_clock(monkeypatch, datetime(2026, 12, 20, 2, 0))
    assert _job_ok(w["client"])["posted"] == 0
    assert _state(db, tablet) == (date(2026, 11, 5), 20)
    db.expire_all()
    statements = [(str(p["statement_close"])[:10], float(p["amount"]))
                  for p in payables_by_currency(db, w["o"]["id"], days=60,
                                                reference=datetime(2026, 12, 20, 10, 0))
                  if p["source"] == "statement"]
    assert ("2026-11-24", 5_000.0) in statements


def test_turn_off_roles(world):
    w, db = world, world["db"]
    for who in ("o", "a", "e"):
        tablet = _installment(w, name=f"Tablet {who}")
        _flags(db, tablet)
        r = _turn_off(w, w[who], tablet)
        assert r.status_code == 200, (who, r.text)
        row = _entry(db, tablet)
        assert row.installment_reviewed_at is not None and row.auto_post_enabled is False
    tablet = _installment(w, name="Tablet v")
    _flags(db, tablet)
    before = _entry(db, tablet)
    for who in ("v", "t"):
        r = _turn_off(w, w[who], tablet)
        assert r.status_code == 404, (who, r.text)
        assert _entry(db, tablet) == before


# --- Plan C: the hold and the minimum ---------------------------------------------------------

def test_linking_a_duplicate_releases_its_installment_hold(world):
    """STU-404 base: nothing is pending, so ``pending_total`` and
    ``planned_charges_total`` stay 0; the hold is every remaining month of the
    active installment (24, then 20, at 5,000)."""
    w = world
    r = w["client"].put(f"{API}/accounts/{w['card']}", json={"credit_limit": 128_000},
                        headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")

    def credit():
        r = w["client"].get(f"{API}/cards/{w['card']}/credit", headers=w["o"]["headers"])
        assert r.status_code == 200, r.text
        body = r.json()["credit"]
        return (body["available_now"], body["opening"]["balance_owed"],
                body["opening"]["pending_total"], body["opening"]["installment_hold"],
                body["planned_charges_total"])

    assert credit() == (3_000.0, 5_000.0, 0.0, 120_000.0, 0.0)
    _review(w, w["o"], tablet, [(aug7, MONTHS[1])])
    assert _balance(w) == -20_000
    assert credit() == (8_000.0, 20_000.0, 0.0, 100_000.0, 0.0)


def test_linked_duplicate_counts_as_an_installment_in_the_minimum(world):
    from app.tests.test_statement_minimum_integration import BDO

    w = world
    r = w["client"].put(f"{API}/accounts/{w['card']}",
                        json={"minimum_due_rule": BDO, "credit_limit": 200_000},
                        headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    tablet = _installment(w)
    aug7 = _txn(w, "2026-08-07")

    def installments():
        r = w["client"].get(f"{API}/cards/{w['card']}/credit", headers=w["o"]["headers"])
        assert r.status_code == 200, r.text
        statement = {s["close_date"]: s for s in r.json()["statements"]}["2026-08-24"]
        return statement["minimum_due"]["inputs"]["installments"]

    assert installments() == 0.0
    _review(w, w["o"], tablet, [(aug7, MONTHS[1])])
    assert installments() == 5_000.0

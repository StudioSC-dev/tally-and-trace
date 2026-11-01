"""Reviewing several clean card installments at once (STU-474). Skips without a
database.

``/dashboard/snapshot``'s ``installment_review`` rows carry ``clean_review``: for
an entry whose review asks nothing (no missed month, so no candidate), the
binding the review's POST checks (``entry_version`` as ``posting._iso`` and the
caller-bound ``review_token``), else null.

The world is the B2 commit 3 world (``test_installment_autopost_integration``):
Sunday 2026-10-18, 10:00 in Manila; Card C of O's, A admin, E editor, V viewer,
T tag viewer. A clean entry is created from a future month (so it starts
reviewed and on) and then set unreviewed and off, as the migration left the
owner's entries. A posted-linked clean entry is due on Oct 5 with a posted row
linked to that month, so nothing is missed but its walk through today is not
empty. A missed entry is due on Oct 5 with no row.
"""
from datetime import datetime

import pytest
from sqlalchemy import text

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks
from app.tests.test_installment_autopost_integration import (
    _card, _entry, _flags, _installment, _txn, make_world,
)
from app.tests.test_installment_review_integration import _get

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

SEEDED_VERSION = "2026-10-17 03:04:05.123456+00"


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    return make_world(sw_client, sw_db, sw_people, monkeypatch)


def _clean(w, name="Tablet", next_day="2026-11-05", **kw) -> int:
    """A clean, unreviewed installment: created from a future month, then set
    unreviewed and off."""
    entry_id = _installment(w, name=name, next_day=next_day, remaining=12, **kw)
    _flags(w["db"], entry_id, reviewed=False, on=False)
    return entry_id


def _posted_linked(w, name="Phone") -> int:
    """Due on Oct 5 (so it starts unreviewed and off) with a posted row linked to
    Oct 5: nothing is missed, and the walk through today holds Oct 5."""
    entry_id = _installment(w, name=name, next_day="2026-10-05", remaining=12)
    _txn(w, "2026-10-05", budget_entry_id=entry_id, occurrence_date="2026-10-05T00:00:00")
    return entry_id


def _missed(w, name="Fridge") -> int:
    """Due on Oct 5 with no row: one missed month."""
    return _installment(w, name=name, next_day="2026-10-05", remaining=12)


def _seed_version(w, entry_id, value=SEEDED_VERSION):
    w["db"].execute(text("UPDATE budget_entries SET updated_at = :v WHERE id = :e"),
                    {"v": value, "e": entry_id})
    w["db"].commit()


def _snap_response(w, who):
    r = w["client"].get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r


def _review_rows(w, who) -> dict:
    return {row["entry_id"]: row for row in _snap_response(w, who).json()["installment_review"]}


def _contains_string(node, s) -> bool:
    """Whether ``s`` occurs in any dict key, dict value, list item or string of a JSON tree."""
    if isinstance(node, dict):
        return any(_contains_string(k, s) or _contains_string(v, s) for k, v in node.items())
    if isinstance(node, list):
        return any(_contains_string(item, s) for item in node)
    if isinstance(node, str):
        return s in node
    return False


def _aware(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# --- clean_review on the snapshot -------------------------------------------------------------

def test_snapshot_binds_only_a_review_that_asks_nothing(world):
    w = world
    clean = _clean(w)
    linked = _posted_linked(w)
    missed = _missed(w)
    pending = _installment(w, name="Lens", next_day="2026-10-05", remaining=12)
    _txn(w, "2026-10-05", is_posted=False, budget_entry_id=pending)  # linked by its date

    rows = _review_rows(w, w["o"])
    assert set(rows) == {clean, linked, missed, pending}
    for entry_id in (clean, linked):
        binding = rows[entry_id]["clean_review"]
        assert rows[entry_id]["missed_count"] == 0
        assert set(binding) == {"entry_version", "review_token"}
        assert binding["review_token"] == _get(w, w["o"], entry_id)["review_token"]
    assert rows[missed]["missed_count"] == 1 and rows[missed]["clean_review"] is None
    assert rows[pending]["missed_count"] == 1 and rows[pending]["clean_review"] is None


def test_snapshot_binding_is_the_reviews(world):
    """The snapshot's binding and the GET's are the same: the token literally,
    the version as an aware UTC instant (microseconds included). The snapshot
    sends ``posting._iso`` (``+00:00``), the GET Pydantic's ``Z``."""
    from app.services import posting

    w = world
    clean = _clean(w)
    _seed_version(w, clean)
    stored = _entry(w["db"], clean).updated_at
    assert stored.microsecond == 123456

    snap = _review_rows(w, w["o"])[clean]["clean_review"]
    review = _get(w, w["o"], clean)
    assert snap["review_token"] == review["review_token"]
    assert _aware(snap["entry_version"]) == _aware(review["entry_version"]) == stored
    assert _aware(snap["entry_version"]).microsecond == 123456
    assert snap["entry_version"] == posting._iso(stored) == "2026-10-17T03:04:05.123456+00:00"


def test_snapshot_binding_is_bound_to_the_caller(world):
    w = world
    clean = _clean(w)
    tokens = {}
    for who in ("o", "a", "e"):
        binding = _review_rows(w, w[who])[clean]["clean_review"]
        assert binding is not None, who
        assert binding["review_token"] == _get(w, w[who], clean)["review_token"], who
        tokens[who] = binding["review_token"]
    assert len(set(tokens.values())) == 3


def test_snapshot_binding_is_not_sent_to_viewers(world):
    w = world
    clean = _clean(w, name=f"Tablet {PRIVATE}")
    _seed_version(w, clean)
    binding = _review_rows(w, w["o"])[clean]["clean_review"]
    version, token = binding["entry_version"], binding["review_token"]
    assert version == "2026-10-17T03:04:05.123456+00:00" and token

    for who in ("v", "t"):
        r = _snap_response(w, w[who])
        snap = r.json()
        assert snap["installment_review"] == [], who
        for s in (version, token):
            assert not _contains_string(snap, s), (who, s)
            assert s not in r.text, (who, s)
        assert sw_leaks({k: snap[k] for k in (
            "installment_auto_post", "installment_review", "missed")}) == [], who


def test_snapshot_lists_no_blocked_entry(world):
    w, db = world, world["db"]
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    foreign = _clean(w, name="Lens", card=card_n)
    clean = _clean(w)
    db.execute(text("UPDATE accounts SET currency = 'USD' WHERE id = :a"), {"a": card_n})
    db.commit()
    assert set(_review_rows(w, w["o"])) == {clean}
    assert foreign not in _review_rows(w, w["o"])


# --- the batch review -------------------------------------------------------------------------

CHANGED = "This installment changed since you opened the review; reopen it"
NOT_CLEAN = "This installment now has a month to record; review it on its own"
NOT_FOUND = "Budget entry not found"
STALE = {"entry_version": None, "review_token": "0" * 64}


def _item(entry_id, binding) -> dict:
    return {"entry_id": entry_id, "entry_version": binding["entry_version"],
            "review_token": binding["review_token"]}


def _items(w, who, *ids) -> list:
    """Each id's snapshot binding as ``who`` sees it, in the order given."""
    rows = _review_rows(w, who)
    return [_item(entry_id, rows[entry_id]["clean_review"]) for entry_id in ids]


def _send(w, who, items):
    return w["client"].post(f"{API}/budget-entries/review-installments",
                            json={"items": items}, headers=who["headers"])


def _batch(w, who, items) -> dict:
    r = _send(w, who, items)
    assert r.status_code == 200, r.text
    return r.json()


def _results(body) -> list:
    return [(row["entry_id"], row["outcome"], row["detail"]) for row in body["results"]]


def _card_count(w) -> int:
    w["db"].rollback()
    return w["db"].execute(text("SELECT count(*) FROM transactions WHERE account_id = :a"),
                           {"a": w["card"]}).scalar()


def _fresh(*ids) -> dict:
    """Each entry's row read in a new session, not the test's."""
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        return {entry_id: session.execute(text(
            "SELECT next_occurrence, max_occurrences, is_active, updated_at, "
            "auto_post_enabled, installment_reviewed_at FROM budget_entries WHERE id = :e"),
            {"e": entry_id}).one() for entry_id in ids}
    finally:
        session.close()


def _on(row) -> bool:
    return row.installment_reviewed_at is not None and row.auto_post_enabled is True


def _off(row) -> bool:
    return row.installment_reviewed_at is None and row.auto_post_enabled is False


def _spy_entries(monkeypatch, module, name, calls, fail_on=None):
    """Wrap ``module.name`` to record each call's entry id; with ``fail_on`` the
    n-th call raises ``RuntimeError`` instead."""
    real = getattr(module, name)

    def wrapped(db, entry, *args, **kwargs):
        calls.append(entry.id)
        if fail_on is not None and len(calls) == fail_on:
            raise RuntimeError("boom")
        return real(db, entry, *args, **kwargs)

    monkeypatch.setattr(module, name, wrapped)
    return real


def test_batch_reviews_clean_entries(world):
    w = world
    ids = [_clean(w, name=n) for n in ("Tablet", "Fridge", "Lens")]
    count = _card_count(w)
    body = _batch(w, w["o"], _items(w, w["o"], *ids))
    assert _results(body) == [(i, "reviewed", None) for i in ids]
    assert body["reviewed"] == 3
    assert all(_on(row) for row in _fresh(*ids).values())
    assert _card_count(w) == count
    assert _review_rows(w, w["o"]) == {}


def test_batch_advances_a_posted_linked_entry_as_the_single_review(world, monkeypatch):
    from app.services import posting
    from app.tests.test_installment_review_integration import _review

    w = world
    batched = _posted_linked(w, name="Phone")
    twin = _posted_linked(w, name="Phone twin")
    _review(w, w["o"], twin)
    count = _card_count(w)
    calls = []
    _spy_entries(monkeypatch, posting, "record_occurrence", calls)

    body = _batch(w, w["o"], _items(w, w["o"], batched))
    assert _results(body) == [(batched, "reviewed", None)]
    assert calls.count(batched) >= 1
    assert _card_count(w) == count
    rows = _fresh(batched, twin)
    assert _on(rows[batched])
    assert ((rows[batched].next_occurrence, rows[batched].max_occurrences)
            == (rows[twin].next_occurrence, rows[twin].max_occurrences))
    assert rows[batched].max_occurrences == 11


def test_batch_refuses_a_not_clean_entry_before_posting(world, monkeypatch):
    from app.services import posting

    w = world
    missed = _missed(w)
    linked = _posted_linked(w)
    review = _get(w, w["o"], missed)                     # a valid binding, not clean
    items = [_item(missed, review), *_items(w, w["o"], linked)]
    before, count = _fresh(missed)[missed], _card_count(w)
    calls = []
    _spy_entries(monkeypatch, posting, "_post_entry_due", calls)

    body = _batch(w, w["o"], items)
    assert _results(body) == [(missed, "needs_choices", NOT_CLEAN), (linked, "reviewed", None)]
    assert calls.count(missed) == 0
    assert calls.count(linked) == 1                      # the spy is wired
    assert _fresh(missed)[missed] == before and _off(before)
    assert _card_count(w) == count


def test_batch_post_check_rolls_back_a_walk_that_records(world, monkeypatch):
    from app.services import posting

    w = world
    linked = _posted_linked(w)
    items = _items(w, w["o"], linked)
    before, count = _fresh(linked)[linked], _card_count(w)
    real = posting.record_occurrence
    calls = []

    def created(db, entry, *args, **kwargs):
        calls.append(entry.id)
        recorded = real(db, entry, *args, **kwargs)
        return posting.Recorded(transaction=recorded.transaction,
                                outcome=posting.Outcome.CREATED,
                                occurrence=recorded.occurrence)

    monkeypatch.setattr(posting, "record_occurrence", created)
    body = _batch(w, w["o"], items)
    assert len(calls) >= 1
    assert _results(body) == [(linked, "needs_choices", NOT_CLEAN)]
    after = _fresh(linked)[linked]
    assert after == before and _off(after)
    assert (after.next_occurrence, after.max_occurrences) == (
        before.next_occurrence, before.max_occurrences)
    assert _card_count(w) == count


@pytest.mark.parametrize("change", ["rename", "midnight", "other_caller"])
def test_batch_reports_a_stale_binding_as_changed(world, monkeypatch, change):
    from app.tests.test_installment_autopost_integration import pin_clock

    w = world
    clean = _clean(w)
    items = _items(w, w["o"], clean)
    sender = w["o"]
    if change == "rename":
        r = w["client"].put(f"{API}/budget-entries/{clean}", json={"name": "Tablet 2"},
                            headers=w["o"]["headers"])
        assert r.status_code == 200, r.text
    elif change == "midnight":
        pin_clock(monkeypatch, datetime(2026, 10, 18, 16, 1))  # 00:01 on Oct 19 in Manila
    else:
        sender = w["e"]
    before, count = _fresh(clean)[clean], _card_count(w)

    body = _batch(w, sender, items)
    assert _results(body) == [(clean, "changed", CHANGED)]
    assert body["reviewed"] == 0
    assert _fresh(clean)[clean] == before and _off(before)
    assert _card_count(w) == count


def test_batch_reports_paused_ended_and_blocked_entries(world):
    w, db = world, world["db"]
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    paused = _clean(w, name="Paused")
    ended = _clean(w, name="Ended")
    foreign = _clean(w, name="Lens", card=card_n)
    items = _items(w, w["o"], paused, ended, foreign)
    db.execute(text("UPDATE budget_entries SET is_active = false WHERE id = :e"), {"e": paused})
    db.execute(text("UPDATE budget_entries SET is_active = false, max_occurrences = 0 "
                    "WHERE id = :e"), {"e": ended})
    db.execute(text("UPDATE accounts SET currency = 'USD' WHERE id = :a"), {"a": card_n})
    db.commit()
    before, count = _fresh(paused, ended, foreign), _card_count(w)

    body = _batch(w, w["o"], items)
    assert _results(body) == [
        (paused, "blocked", "This entry is paused"),
        (ended, "blocked", "This entry has ended"),
        (foreign, "blocked",
         "This installment is in another currency than its card, so it can't auto-post"),
    ]
    assert body["reviewed"] == 0
    assert _fresh(paused, ended, foreign) == before
    assert _card_count(w) == count


def test_batch_reports_an_entry_with_no_account_as_blocked(world):
    w, db = world, world["db"]
    clean = _clean(w)
    items = _items(w, w["o"], clean)
    db.execute(text("UPDATE budget_entries SET account_id = NULL WHERE id = :e"), {"e": clean})
    db.commit()
    before, count = _fresh(clean)[clean], _card_count(w)

    body = _batch(w, w["o"], items)
    assert _results(body) == [(clean, "blocked", "This entry has no account to post to")]
    assert body["reviewed"] == 0
    assert _fresh(clean)[clean] == before and _off(before)
    assert _card_count(w) == count


def test_batch_reports_another_recorder_409_as_failed(world):
    w, db = world, world["db"]
    linked = _posted_linked(w)
    second = _txn(w, "2026-10-06")
    db.execute(text("UPDATE transactions SET budget_entry_id = :e, "
                    "occurrence_date = '2026-10-05 00:00:00' WHERE id = :t"),
               {"e": linked, "t": second})
    db.commit()
    items = _items(w, w["o"], linked)                    # still clean: nothing is missed
    before, count = _fresh(linked)[linked], _card_count(w)

    body = _batch(w, w["o"], items)
    [(entry_id, outcome, detail)] = _results(body)
    assert (entry_id, outcome) == (linked, "failed")
    assert detail.startswith("This occurrence has more than one linked transaction")
    assert _fresh(linked)[linked] == before
    assert _card_count(w) == count


def test_batch_isolates_each_entry(world):
    w = world
    c1 = _clean(w, name="One")
    s = _clean(w, name="Stale")
    c2 = _clean(w, name="Two")
    assert c1 < s < c2
    bindings = {item["entry_id"]: item for item in _items(w, w["o"], c1, s, c2)}
    r = w["client"].put(f"{API}/budget-entries/{s}", json={"name": "Stale 2"},
                        headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    renamed = _fresh(s)[s]

    body = _batch(w, w["o"], [bindings[c2], bindings[s], bindings[c1]])
    assert _results(body) == [(c1, "reviewed", None), (s, "changed", CHANGED),
                              (c2, "reviewed", None)]
    assert body["reviewed"] == 2
    rows = _fresh(c1, s, c2)
    assert _on(rows[c1]) and _on(rows[c2])
    assert _off(rows[s]) and rows[s] == renamed


def test_batch_partial_500_keeps_earlier_entries_and_a_retry_replays_them(world, monkeypatch):
    from app.services import posting

    w = world
    c1, c2, c3 = (_clean(w, name=n) for n in ("One", "Two", "Three"))
    items = _items(w, w["o"], c1, c2, c3)
    count = _card_count(w)
    calls = []
    real = _spy_entries(monkeypatch, posting, "_post_entry_due", calls, fail_on=2)

    with pytest.raises(RuntimeError):
        _send(w, w["o"], items)
    assert calls == [c1, c2]
    rows = _fresh(c1, c2, c3)
    assert _on(rows[c1])
    assert _off(rows[c2]) and _off(rows[c3])
    assert _card_count(w) == count

    monkeypatch.setattr(posting, "_post_entry_due", real)
    body = _batch(w, w["o"], items)
    assert _results(body) == [(c1, "replayed", None), (c2, "reviewed", None),
                              (c3, "reviewed", None)]
    assert body["reviewed"] == 3
    assert all(_on(row) for row in _fresh(c1, c2, c3).values())
    assert _card_count(w) == count


def test_batch_roles(world, sw_client):
    w = world
    owners = _clean(w, name="Tablet")
    admins = _clean(w, name="Fridge")
    editors = _clean(w, name="Lens")
    before, count = _fresh(owners), _card_count(w)

    for who in ("v", "t"):
        body = _batch(w, w[who], [_item(owners, STALE), _item(999_999_999, STALE)])
        assert _results(body) == [(owners, "not_found", NOT_FOUND),
                                  (999_999_999, "not_found", NOT_FOUND)], who
    assert _fresh(owners) == before and _card_count(w) == count

    assert _results(_batch(w, w["a"], _items(w, w["a"], admins))) == [
        (admins, "reviewed", None)]
    assert _results(_batch(w, w["e"], _items(w, w["e"], editors))) == [
        (editors, "reviewed", None)]
    assert all(_on(row) for row in _fresh(admins, editors).values())

    r = sw_client.post(f"{API}/budget-entries/review-installments",
                       json={"items": [_item(owners, STALE)]})
    assert r.status_code == 401, r.text


def test_batch_replay_writes_nothing(world):
    w = world
    clean = _clean(w)
    items = _items(w, w["o"], clean)
    assert _results(_batch(w, w["o"], items)) == [(clean, "reviewed", None)]
    after, count = _fresh(clean)[clean], _card_count(w)

    body = _batch(w, w["o"], items)
    assert _results(body) == [(clean, "replayed", None)]
    assert body["reviewed"] == 1
    assert _fresh(clean)[clean] == after and _card_count(w) == count


def test_batch_validates_its_items_and_cap(world):
    w = world
    clean = _clean(w)
    item = _items(w, w["o"], clean)[0]
    for items in ([], [item, dict(item)],
                  [_item(900_000_000 + i, STALE) for i in range(51)]):
        r = _send(w, w["o"], items)
        assert r.status_code == 422, (len(items), r.text)
    assert _off(_fresh(clean)[clean])

    body = _batch(w, w["o"], [_item(900_000_000 + i, STALE) for i in range(50)])
    assert _results(body) == [(900_000_000 + i, "not_found", NOT_FOUND) for i in range(50)]
    assert body["reviewed"] == 0


def test_batch_locks_entries_in_ascending_id(world, monkeypatch):
    from app.core import locking

    w = world
    first, middle, last = (_clean(w, name=n) for n in ("One", "Two", "Three"))
    items = _items(w, w["o"], last, first, middle)
    locked = []
    real = locking.lock_entry

    def lock(db, entry_id, *args, **kwargs):
        locked.append(entry_id)
        return real(db, entry_id, *args, **kwargs)

    monkeypatch.setattr(locking, "lock_entry", lock)
    body = _batch(w, w["o"], items)
    assert [row["entry_id"] for row in body["results"]] == [first, middle, last]
    assert [i for i in locked if i in (first, middle, last)] == [first, middle, last]


def test_batch_route_leaves_the_entry_routes(world):
    w = world
    clean = _clean(w)
    assert _results(_batch(w, w["o"], _items(w, w["o"], clean))) == [(clean, "reviewed", None)]
    r = w["client"].get(f"{API}/budget-entries/{clean}", headers=w["o"]["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["id"] == clean

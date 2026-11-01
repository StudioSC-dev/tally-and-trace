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

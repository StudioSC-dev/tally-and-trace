"""Ranking savings goals (STU-786). Skips without a database.

``allocations.rank`` orders a user's active ``savings`` and ``goal`` allocations, 1 at the
top; every other row has a null rank. One helper (``services.allocation_rank``) owns every
change: a create or reactivation lands at the bottom, a type change in does too, leaving
the set (deactivation, soft delete, a type change out) closes the gap. ``GET`` and ``PUT
/allocations/ranked`` read and rewrite the whole order; ``GET /allocations`` takes
``ranked``.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
BEFORE_RANK = "a7c3e5f9b1d2"


# --- migration --------------------------------------------------------------------------------

@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_rank_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _db_user(c, email):
    return c.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
        "is_verified) VALUES (:e, 'x', 'Rank', 'Probe', true, true) RETURNING id"),
        {"e": email}).scalar_one()


def _db_allocation(c, user, name, kind, created_at, active=True):
    return c.execute(text(
        "INSERT INTO allocations (user_id, name, allocation_type, current_amount, is_active, "
        "created_at) VALUES (:u, :n, :k, 0, :a, :c) RETURNING id"),
        {"u": user, "n": name, "k": kind, "a": active, "c": created_at}).scalar_one()


def _db_ranks(c, user):
    return {n: r for n, r in c.execute(text(
        "SELECT name, rank FROM allocations WHERE user_id = :u"), {"u": user})}


def test_backfill_numbers_each_user_by_created_at_then_id(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", BEFORE_RANK)
        with engine.begin() as c:
            first, second = _db_user(c, "rank-a@example.com"), _db_user(c, "rank-b@example.com")
            # Inserted out of order: the oldest goal is rank 1, a tie on created_at goes by id.
            _db_allocation(c, first, "newest", "goal", "2026-03-01")
            _db_allocation(c, first, "oldest", "savings", "2026-01-01")
            _db_allocation(c, first, "tie-low-id", "goal", "2026-02-01")
            _db_allocation(c, first, "tie-high-id", "savings", "2026-02-01")
            _db_allocation(c, first, "budget", "budget", "2026-01-01")
            _db_allocation(c, first, "inactive", "goal", "2026-01-01", active=False)
            # A second user is numbered from 1 on their own.
            _db_allocation(c, second, "other-newer", "goal", "2026-05-01")
            _db_allocation(c, second, "other-older", "goal", "2026-04-01")
            _db_allocation(c, second, "other-budget", "budget", "2026-04-01")

        _alembic(scratch_url, "upgrade", "head")
        with engine.begin() as c:
            assert _db_ranks(c, first) == {
                "oldest": 1, "tie-low-id": 2, "tie-high-id": 3, "newest": 4,
                "budget": None, "inactive": None}
            assert _db_ranks(c, second) == {
                "other-older": 1, "other-newer": 2, "other-budget": None}

        _alembic(scratch_url, "downgrade", BEFORE_RANK)
        with engine.begin() as c:
            assert c.execute(text(
                "SELECT count(*) FROM information_schema.columns "
                "WHERE table_name = 'allocations' AND column_name = 'rank'")).scalar_one() == 0
        _alembic(scratch_url, "upgrade", "head")
        with engine.begin() as c:
            assert _db_ranks(c, second)["other-older"] == 1
    finally:
        engine.dispose()


# --- API --------------------------------------------------------------------------------------

def _bank(client, who):
    return sw_post(client, who, "/accounts/", {
        "name": "Bank", "account_type": "savings", "balance": 1_000})["id"]


def _goal(client, who, bank, name, kind="goal", **fields):
    return sw_post(client, who, "/allocations/", {
        "account_id": bank, "name": name, "allocation_type": kind,
        "target_amount": 1_000, **fields})


def _ranked(client, who):
    r = client.get(f"{API}/allocations/ranked", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["items"]


def _order(client, who):
    """(name, rank) of the caller's ranked goals, top first."""
    return [(a["name"], a["rank"]) for a in _ranked(client, who)]


def _put(client, who, path, body, expect=200):
    r = client.put(f"{API}{path}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _reorder(client, who, ids, expect=200):
    return _put(client, who, "/allocations/ranked", {"ids": ids}, expect)


def _delete(client, who, allocation_id):
    r = client.delete(f"{API}/allocations/{allocation_id}", headers=who["headers"])
    assert r.status_code == 200, r.text


def test_create_lands_at_the_bottom_and_only_ranked_types_are_ranked(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)

    a = _goal(sw_client, me, bank, "A")
    b = _goal(sw_client, me, bank, "B", kind="savings")
    budget = _goal(sw_client, me, bank, "Budget", kind="budget",
                   configuration={"category_ids": []})
    inactive = _goal(sw_client, me, bank, "Inactive", is_active=False)
    c = _goal(sw_client, me, bank, "C")

    assert (a["rank"], b["rank"], c["rank"]) == (1, 2, 3)
    assert budget["rank"] is None and inactive["rank"] is None
    assert _order(sw_client, me) == [("A", 1), ("B", 2), ("C", 3)]
    got = sw_client.get(f"{API}/allocations/{budget['id']}", headers=me["headers"]).json()
    assert got["rank"] is None


def test_a_sent_rank_is_ignored(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    _goal(sw_client, me, bank, "A")
    b = _goal(sw_client, me, bank, "B", rank=1)
    assert b["rank"] == 2
    updated = _put(sw_client, me, f"/allocations/{b['id']}", {"rank": 1})
    assert updated["rank"] == 2


def test_reactivation_lands_at_the_bottom(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    a, b, c = (_goal(sw_client, me, bank, n) for n in "ABC")

    off = _put(sw_client, me, f"/allocations/{a['id']}", {"is_active": False})
    assert off["rank"] is None
    assert _order(sw_client, me) == [("B", 1), ("C", 2)]

    on = _put(sw_client, me, f"/allocations/{a['id']}", {"is_active": True})
    assert on["rank"] == 3
    assert _order(sw_client, me) == [("B", 1), ("C", 2), ("A", 3)]


def test_an_edit_that_changes_neither_flag_keeps_the_rank(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    _goal(sw_client, me, bank, "A")
    b = _goal(sw_client, me, bank, "B")
    _goal(sw_client, me, bank, "C")

    _put(sw_client, me, f"/allocations/{b['id']}", {"name": "B2", "is_active": True,
                                                    "allocation_type": "goal"})
    assert _order(sw_client, me) == [("A", 1), ("B2", 2), ("C", 3)]
    # goal to savings stays inside the set: its place is kept.
    _put(sw_client, me, f"/allocations/{b['id']}", {"allocation_type": "savings"})
    assert _order(sw_client, me) == [("A", 1), ("B2", 2), ("C", 3)]


def test_a_null_is_active_is_no_change(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    a = _goal(sw_client, me, bank, "A")
    _goal(sw_client, me, bank, "B")
    before = _order(sw_client, me)

    updated = _put(sw_client, me, f"/allocations/{a['id']}", {"is_active": None})
    assert updated["is_active"] is True and updated["rank"] == 1
    assert _order(sw_client, me) == before == [("A", 1), ("B", 2)]
    r = sw_client.get(f"{API}/allocations/", params={"ranked": "false"}, headers=me["headers"])
    assert r.status_code == 200, r.text


def test_soft_delete_clears_the_rank_and_closes_the_gap(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    _, b, _ = (_goal(sw_client, me, bank, n) for n in "ABC")

    _delete(sw_client, me, b["id"])

    assert _order(sw_client, me) == [("A", 1), ("C", 2)]
    gone = sw_client.get(f"{API}/allocations/{b['id']}", headers=me["headers"]).json()
    assert gone["is_active"] is False and gone["rank"] is None
    # A second delete of the same row changes nothing.
    _delete(sw_client, me, b["id"])
    assert _order(sw_client, me) == [("A", 1), ("C", 2)]
    # A new goal still lands at the bottom, with no hole left.
    assert _goal(sw_client, me, bank, "D")["rank"] == 3


def test_type_change_out_of_the_set_closes_the_gap_and_in_lands_at_the_bottom(
        sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    a, b, c = (_goal(sw_client, me, bank, n) for n in "ABC")

    out = _put(sw_client, me, f"/allocations/{a['id']}", {
        "allocation_type": "budget", "configuration": {"category_ids": []}})
    assert out["rank"] is None
    assert _order(sw_client, me) == [("B", 1), ("C", 2)]

    back = _put(sw_client, me, f"/allocations/{a['id']}", {"allocation_type": "goal"})
    assert back["rank"] == 3
    assert _order(sw_client, me) == [("B", 1), ("C", 2), ("A", 3)]


def test_a_budget_made_active_or_inactive_stays_unranked(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    budget = _goal(sw_client, me, bank, "Budget", kind="budget",
                   configuration={"category_ids": []})
    _put(sw_client, me, f"/allocations/{budget['id']}", {"is_active": False})
    on = _put(sw_client, me, f"/allocations/{budget['id']}", {"is_active": True})
    assert on["rank"] is None
    assert _ranked(sw_client, me) == []


def test_reorder_rewrites_the_whole_order(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    a, b, c = (_goal(sw_client, me, bank, n) for n in "ABC")

    body = _reorder(sw_client, me, [c["id"], a["id"], b["id"]])

    assert [(x["name"], x["rank"]) for x in body["items"]] == [("C", 1), ("A", 2), ("B", 3)]
    assert _order(sw_client, me) == [("C", 1), ("A", 2), ("B", 3)]
    assert _goal(sw_client, me, bank, "D")["rank"] == 4


def test_reorder_refuses_partial_duplicate_and_unranked_lists(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    a, b, c = (_goal(sw_client, me, bank, n) for n in "ABC")
    budget = _goal(sw_client, me, bank, "Budget", kind="budget",
                   configuration={"category_ids": []})
    inactive = _goal(sw_client, me, bank, "Inactive", is_active=False)
    before = _order(sw_client, me)

    # Missing an id, empty, a duplicate (even at full length), an unranked id.
    assert _reorder(sw_client, me, [a["id"], b["id"]], expect=422)
    assert _reorder(sw_client, me, [], expect=422)
    assert _reorder(sw_client, me, [a["id"], a["id"], b["id"]], expect=422)
    assert _reorder(sw_client, me, [a["id"], b["id"], c["id"], c["id"]], expect=422)
    assert _reorder(sw_client, me, [a["id"], b["id"], c["id"], budget["id"]], expect=422)
    assert _reorder(sw_client, me, [a["id"], b["id"], inactive["id"]], expect=422)
    # An id that exists nowhere.
    assert _reorder(sw_client, me, [a["id"], b["id"], c["id"], 2_000_000_000], expect=404)

    assert _order(sw_client, me) == before


def test_reorder_with_a_foreign_id_is_not_found_and_leaves_both_orders_alone(
        sw_client, sw_people):
    me, other = sw_people(), sw_people()
    my_bank, other_bank = _bank(sw_client, me), _bank(sw_client, other)
    a, b = (_goal(sw_client, me, my_bank, n) for n in "AB")
    x, y = (_goal(sw_client, other, other_bank, n) for n in "XY")

    # A foreign id swapped in, and one added.
    _reorder(sw_client, me, [a["id"], x["id"]], expect=404)
    _reorder(sw_client, me, [b["id"], a["id"], x["id"]], expect=404)
    # A complete reorder of my own list moves nothing of the other user's.
    _reorder(sw_client, me, [b["id"], a["id"]])

    assert _order(sw_client, me) == [("B", 1), ("A", 2)]
    assert _order(sw_client, other) == [("X", 1), ("Y", 2)]


def test_ranked_list_is_complete_with_more_than_ten_allocations(sw_client, sw_people):
    me, other = sw_people(), sw_people()
    bank = _bank(sw_client, me)
    for n in range(13):
        _goal(sw_client, me, bank, f"G{n:02d}", kind="goal" if n % 2 else "savings")
    _goal(sw_client, me, bank, "Budget", kind="budget", configuration={"category_ids": []})
    _goal(sw_client, other, _bank(sw_client, other), "Theirs")

    items = _ranked(sw_client, me)

    assert [a["name"] for a in items] == [f"G{n:02d}" for n in range(13)]
    assert [a["rank"] for a in items] == list(range(1, 14))
    # The paged list still pages on its own.
    paged = sw_client.get(f"{API}/allocations/", headers=me["headers"]).json()
    assert len(paged["items"]) == 10 and paged["total"] == 14


def test_ranked_false_excludes_ranked_rows_from_pages_and_totals(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    for n in range(3):
        _goal(sw_client, me, bank, f"G{n}")
    for n in range(4):
        _goal(sw_client, me, bank, f"B{n}", kind="budget", configuration={"category_ids": []})
    _goal(sw_client, me, bank, "Off", is_active=False)

    def listed(**params):
        r = sw_client.get(f"{API}/allocations/", params=params, headers=me["headers"])
        assert r.status_code == 200, r.text
        return r.json()

    everything = listed(limit=100)
    assert everything["total"] == 8

    unranked = listed(ranked="false", limit=2, offset=0)
    assert unranked["total"] == 5 and unranked["has_more"] is True
    assert all(a["rank"] is None for a in unranked["items"])
    last = listed(ranked="false", limit=2, offset=4)
    assert len(last["items"]) == 1 and last["has_more"] is False
    assert {a["name"] for a in listed(ranked="false", limit=100)["items"]} == {
        "B0", "B1", "B2", "B3", "Off"}

    only = listed(ranked="true", limit=2)
    assert only["total"] == 3 and len(only["items"]) == 2 and only["has_more"] is True
    assert all(a["rank"] is not None for a in only["items"])


def test_ranked_is_not_read_as_an_id(sw_client, sw_people):
    me = sw_people()
    r = sw_client.get(f"{API}/allocations/ranked", headers=me["headers"])
    assert r.status_code == 200 and r.json() == {"items": []}
    # An empty complete list is accepted when nothing is ranked.
    assert _reorder(sw_client, me, []) == {"items": []}
    assert sw_client.get(f"{API}/allocations/9999999", headers=me["headers"]).status_code == 404


def test_ranked_routes_need_a_login(sw_client):
    assert sw_client.get(f"{API}/allocations/ranked").status_code in (401, 403)
    assert sw_client.put(f"{API}/allocations/ranked", json={"ids": []}).status_code in (401, 403)


def test_the_seeded_demo_goals_are_ranked_from_one(sw_client, sw_db):
    from app.core.seed import DEMO_EMAIL, _seed
    from app.models.allocation import Allocation
    from app.models.demo_state import DemoState
    from app.models.user import User

    def demo_rows():
        demo = sw_db.query(User).filter(User.email == DEMO_EMAIL).one()
        return sw_db.query(Allocation).filter(Allocation.user_id == demo.id).all()

    before = {a.id for a in demo_rows()}
    # No state row: the seed is not current, so it really replaces the demo data.
    sw_db.query(DemoState).delete()
    sw_db.commit()
    _seed(sw_db)
    sw_db.expire_all()

    rows = demo_rows()
    assert rows and not before & {a.id for a in rows}
    expected = [a for a in rows if a.is_active and a.allocation_type.value in ("savings", "goal")]
    assert sorted(a.rank for a in expected) == list(range(1, len(expected) + 1))
    assert all(a.rank is None for a in rows if a not in expected)

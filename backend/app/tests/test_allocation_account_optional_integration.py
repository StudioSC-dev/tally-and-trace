"""An allocation's account is optional where its mode needs none (STU-777).

``allocations.account_id`` is nullable. A ``transaction_total`` savings
allocation can be saved with no account, and so can a budget (STU-795); goals and
``target_balance`` savings (a missing ``goal_mode`` included) still need one; ``multi_account``
savings store their first aggregated account. The migration's downgrade
backfills nulls with the owner's main account, else their first owned one,
before restoring NOT NULL. Skips without a database.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "f5905076b019"
OPTIONAL = "b7d4e1a9c3f6"
BEFORE_DATA_VERSION = "c3d5e7a9b1f4"  # a7c2e4f6b8d1 (data version) drops its tables going here


# --- migration --------------------------------------------------------------------------------

def test_optional_account_is_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert OPTIONAL in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(OPTIONAL).down_revision == PREVIOUS


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_allocacct_{os.urandom(3).hex()}"
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


def _alembic(url, *args, ok=True):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert (result.returncode == 0) == ok, result.stderr
    return result


def _nullable(c):
    return {col["name"]: col for col in inspect(c).get_columns("allocations")}[
        "account_id"]["nullable"]


def _user(c, email):
    return c.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name, is_active, "
        "is_verified) VALUES (:e, 'x', 'Alloc', 'Probe', true, true) RETURNING id"),
        {"e": email}).scalar_one()


def _account(c, user, name):
    return c.execute(text(
        "INSERT INTO accounts (user_id, name, account_type, balance, currency, is_active, "
        "is_spending_wallet) VALUES (:u, :n, 'savings', 100, 'PHP', true, false) "
        "RETURNING id"), {"u": user, "n": name}).scalar_one()


def _allocation(c, user, account):
    return c.execute(text(
        "INSERT INTO allocations (user_id, account_id, name, allocation_type, current_amount, "
        "configuration, is_active) VALUES (:u, :a, 'Fund', 'savings', 0, "
        "'{\"goal_mode\": \"transaction_total\"}', true) RETURNING id"),
        {"u": user, "a": account}).scalar_one()


def _account_of(c, allocation):
    return c.execute(text("SELECT account_id FROM allocations WHERE id = :a"),
                     {"a": allocation}).scalar_one()


def test_upgrade_makes_account_nullable_and_downgrade_backfills(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert not _nullable(c)

        _alembic(scratch_url, "upgrade", OPTIONAL)
        with engine.begin() as c:
            assert _nullable(c)
            # Pinned main account (owned) wins over the first owned one.
            pinned = _user(c, "alloc-pinned@example.com")
            first = _account(c, pinned, "First")
            main = _account(c, pinned, "Main")
            c.execute(text("UPDATE users SET main_account_id = :a WHERE id = :u"),
                      {"a": main, "u": pinned})
            pinned_alloc = _allocation(c, pinned, None)
            # No main account: the first owned account (lowest id).
            plain = _user(c, "alloc-plain@example.com")
            plain_first = _account(c, plain, "First")
            _account(c, plain, "Second")
            plain_alloc = _allocation(c, plain, None)
            # A main account the user does not own is never used.
            foreign = _user(c, "alloc-foreign@example.com")
            foreign_own = _account(c, foreign, "Own")
            c.execute(text("UPDATE users SET main_account_id = :a WHERE id = :u"),
                      {"a": first, "u": foreign})
            foreign_alloc = _allocation(c, foreign, None)
            # A row that already has an account keeps it.
            kept_alloc = _allocation(c, plain, plain_first + 1)
            assert _account_of(c, pinned_alloc) is None

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert not _nullable(c)
            assert _account_of(c, pinned_alloc) == main
            assert _account_of(c, plain_alloc) == plain_first
            assert _account_of(c, foreign_alloc) == foreign_own
            assert _account_of(c, kept_alloc) == plain_first + 1
            assert first  # the pinned user's first account was passed over

        _alembic(scratch_url, "upgrade", OPTIONAL)
    finally:
        engine.dispose()


def test_downgrade_stops_when_an_owner_has_no_account(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", OPTIONAL)
        with engine.begin() as c:
            lonely = _user(c, "alloc-lonely@example.com")
            orphan = _allocation(c, lonely, None)
        result = _alembic(scratch_url, "downgrade", PREVIOUS, ok=False)
        assert "no account" in result.stderr
        with engine.begin() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == OPTIONAL
            assert _nullable(c)
            assert _account_of(c, orphan) is None
    finally:
        engine.dispose()


# --- API --------------------------------------------------------------------------------------

def _bank(client, who, name="Bank", balance=1_000):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "savings", "balance": balance})["id"]


def _create(client, who, body, expect=200):
    r = client.post(f"{API}/allocations/", json={"name": "Fund", **body},
                    headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _update(client, who, allocation_id, body, expect=200):
    r = client.put(f"{API}/allocations/{allocation_id}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def test_transaction_total_savings_needs_no_account(sw_client, sw_people):
    me = sw_people()
    body = _create(sw_client, me, {"allocation_type": "savings",
                                   "configuration": {"goal_mode": "transaction_total"}})
    assert body["account_id"] is None
    r = sw_client.get(f"{API}/allocations/{body['id']}", headers=me["headers"])
    assert r.status_code == 200 and r.json()["account_id"] is None
    listed = sw_client.get(f"{API}/allocations/", headers=me["headers"]).json()["items"]
    assert [a["account_id"] for a in listed] == [None]

    # One sent is kept (and must be the caller's).
    bank = _bank(sw_client, me)
    kept = _create(sw_client, me, {"allocation_type": "savings", "account_id": bank,
                                   "configuration": {"goal_mode": "transaction_total"}})
    assert kept["account_id"] == bank


@pytest.mark.parametrize("body", [
    {"allocation_type": "goal"},
    {"allocation_type": "savings", "configuration": {"goal_mode": "target_balance"}},
    {"allocation_type": "savings", "configuration": {}},
    {"allocation_type": "savings"},
])
def test_goals_and_target_balance_savings_need_an_account(sw_client, sw_people, body):
    me = sw_people()
    _create(sw_client, me, body, expect=422)


def test_unknown_goal_mode_is_refused(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    _create(sw_client, me, {"allocation_type": "savings", "account_id": bank,
                            "configuration": {"goal_mode": "lottery"}}, expect=422)


def test_multi_account_stores_the_first_aggregated_account(sw_client, sw_people):
    me = sw_people()
    first, second = _bank(sw_client, me, "First"), _bank(sw_client, me, "Second")
    body = _create(sw_client, me, {"allocation_type": "savings", "account_id": second,
                                   "configuration": {"goal_mode": "multi_account",
                                                     "account_ids": [first, second]}})
    assert body["account_id"] == first
    # No account sent at all: the first aggregated one is stored.
    body = _create(sw_client, me, {"allocation_type": "savings",
                                   "configuration": {"goal_mode": "multi_account",
                                                     "account_ids": [second, first]}})
    assert body["account_id"] == second
    # Re-pointing the account directly is overruled by the configuration.
    assert _update(sw_client, me, body["id"], {"account_id": first})["account_id"] == second
    # And a new list moves it.
    assert _update(sw_client, me, body["id"], {"configuration": {
        "goal_mode": "multi_account", "account_ids": [first]}})["account_id"] == first

    _create(sw_client, me, {"allocation_type": "savings", "configuration": {
        "goal_mode": "multi_account", "account_ids": []}}, expect=422)


def test_multi_account_never_takes_another_users_account(sw_client, sw_people):
    me, other = sw_people(), sw_people()
    theirs = _bank(sw_client, other, "Theirs")
    _create(sw_client, me, {"allocation_type": "savings", "configuration": {
        "goal_mode": "multi_account", "account_ids": [theirs]}}, expect=404)
    _create(sw_client, me, {"allocation_type": "savings", "account_id": theirs,
                            "configuration": {"goal_mode": "transaction_total"}}, expect=404)


def test_update_applies_the_rule_to_the_edited_allocation(sw_client, sw_people):
    me = sw_people()
    bank = _bank(sw_client, me)
    budget = _create(sw_client, me, {"allocation_type": "budget", "account_id": bank,
                                     "configuration": {"category_ids": []},
                                     "period_frequency": "monthly",
                                     "period_start": "2026-11-01T00:00:00"})
    # A budget needs no account (STU-795): clearing it succeeds.
    cleared = _update(sw_client, me, budget["id"], {"account_id": None})
    assert cleared["account_id"] is None

    savings = _create(sw_client, me, {"allocation_type": "savings", "account_id": bank,
                                      "configuration": {"goal_mode": "target_balance"}})
    _update(sw_client, me, savings["id"], {"account_id": None}, expect=422)
    moved = _update(sw_client, me, savings["id"], {
        "account_id": None, "configuration": {"goal_mode": "transaction_total"}})
    assert moved["account_id"] is None
    # Back to target_balance with no account is refused.
    _update(sw_client, me, savings["id"], {"configuration": {"goal_mode": "target_balance"}},
            expect=422)
    # An edit that touches neither the type, the configuration nor the account passes.
    assert _update(sw_client, me, savings["id"], {"name": "Renamed"})["name"] == "Renamed"


def test_a_backfilling_downgrade_runs_on_past_the_data_version_tables(scratch_url):
    """The backfill's write queues the data version's deferred bump; a downgrade that
    goes on to drop ``data_version_pending`` in the same run must not trip over it."""
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", OPTIONAL)
        with engine.begin() as c:
            user = _user(c, "alloc-deep@example.com")
            account = _account(c, user, "Only")
            allocation = _allocation(c, user, None)
        _alembic(scratch_url, "downgrade", BEFORE_DATA_VERSION)
        with engine.begin() as c:
            assert _account_of(c, allocation) == account
    finally:
        engine.dispose()

"""Conditional GETs (STU-602, PERF-7): ETag and 304 on the opted-in GETs.

One test per invalidation bug in the plan: version read after the data, cross-user
staleness (a shared card, a household account, a revoked share), day rollover, a user
switch on one browser, query parameters, a deploy, and self-invalidation by a GET's
own writes (every opted-in page-open request, all four callers). Plus: errors carry
no ETag, and a stale exchange rate is never answered with a 304. The trigger side is
``test_data_version_integration.py``. Skips without a database.
"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import event, text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

OPTED_IN = {
    ("GET", "/api/v1/dashboard/snapshot"),
    ("GET", "/api/v1/budget-entries/installment-plans"),
    ("GET", "/api/v1/budget-entries/upcoming-occurrences"),
    ("GET", "/api/v1/budget-entries/"),
    ("GET", "/api/v1/transactions/"),
    ("GET", "/api/v1/accounts/"),
    ("GET", "/api/v1/categories/"),
}


def get(client, who, path, etag=None):
    headers = dict(who["headers"]) if isinstance(who, dict) else dict(who.headers)
    if etag:
        headers["If-None-Match"] = etag
    return client.get(f"{API}{path}", headers=headers)


def version(db) -> int:
    db.rollback()
    return db.execute(text("SELECT version FROM data_version WHERE id = 1")).scalar_one()


def pin(monkeypatch, when: datetime):
    from app.core import time as clock

    monkeypatch.setattr(clock, "naive_utc_now", lambda: when)


def test_the_opted_in_routes():
    """Read from each router module (the installed FastAPI keeps included routers
    opaque on the app), at the prefix ``app/routers/__init__.py`` mounts it on."""
    import app.main  # noqa: F401
    from app import routers
    from app.core.conditional import conditional_get

    prefixes = {"auth": "/auth", "accounts": "/accounts", "transactions": "/transactions",
                "categories": "/categories", "allocations": "/allocations",
                "budget_entries": "/budget-entries", "wishlist": "/wishlist",
                "dashboard": "/dashboard", "forecast": "/forecast",
                "data_portability": "/data", "tags": "/tags", "household": "/household",
                "cards": "/cards", "jobs": "/jobs"}
    found = set()
    for module, prefix in prefixes.items():
        for r in getattr(routers, module).router.routes:
            if any(d.call is conditional_get for d in r.dependant.dependencies):
                found |= {(m, f"{API}{prefix}{r.path}") for m in r.methods}
    for name in ("account_router", "received_router", "users_router", "tag_router"):
        for r in getattr(routers.shares, name).routes:
            assert not any(d.call is conditional_get for d in r.dependant.dependencies)
    assert found == OPTED_IN


def test_a_repeat_is_a_304_with_no_body(sw_client, sw):
    a = sw["a"]
    first = get(sw_client, a, "/accounts/?is_active=true&limit=100")
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert etag.startswith('W/"')
    assert first.headers["cache-control"] == "private, no-cache"
    assert "Authorization" in first.headers["vary"]
    again = get(sw_client, a, "/accounts/?is_active=true&limit=100", etag)
    assert again.status_code == 304
    assert again.content == b""
    assert again.headers["etag"] == etag
    # A proxy may weaken or strip the W/ prefix, or send a list.
    for sent in (etag[2:], f'"other", {etag}'):
        assert get(sw_client, a, "/accounts/?is_active=true&limit=100", sent).status_code == 304
    assert get(sw_client, a, "/accounts/?is_active=true&limit=100", '"other"').status_code == 200
    assert get(sw_client, a, "/accounts/?is_active=true&limit=100", "*").status_code == 200


def test_errors_carry_no_etag(sw_client, sw):
    bad_type = get(sw_client, sw["a"], "/accounts/?account_type=bogus")
    assert bad_type.status_code == 400
    assert "etag" not in bad_type.headers
    bad_limit = get(sw_client, sw["a"], "/accounts/?limit=0")
    assert bad_limit.status_code == 422
    assert "etag" not in bad_limit.headers


# --- version read after the data ----------------------------------------------------------

def test_the_version_is_read_before_any_data(sw_client, sw):
    """Only the caller's own user row is read before the version."""
    from app.core.database import engine

    seen = []

    def log(conn, cursor, statement, *args):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", log)
    try:
        assert get(sw_client, sw["a"], "/transactions/?limit=25").status_code == 200
    finally:
        event.remove(engine, "before_cursor_execute", log)
    at = next(i for i, s in enumerate(seen) if "data_version" in s)
    before = [s for s in seen[:at] if not s.lstrip().upper().startswith(("SET", "SELECT 1"))]
    assert all("FROM users" in s for s in before), before


def test_a_write_committed_after_the_version_read_is_never_revalidated(
        sw_client, sw, sw_db, monkeypatch):
    from app.core import data_version
    from app.core.database import SessionLocal

    a, joint = sw["a"], sw["joint"]
    real = data_version.current_version

    def read_then_write(db):
        got = real(db)
        other = SessionLocal()
        try:
            other.execute(text("UPDATE accounts SET name = 'Renamed meanwhile' WHERE id = :i"),
                          {"i": joint})
            other.commit()
        finally:
            other.close()
        return got

    monkeypatch.setattr(data_version, "current_version", read_then_write)
    first = get(sw_client, a, "/accounts/?limit=100")
    monkeypatch.setattr(data_version, "current_version", real)
    assert first.status_code == 200
    names = {r["id"]: r["name"] for r in first.json()["items"]}
    assert names[joint] == "Renamed meanwhile"  # the data is newer than its tag
    again = get(sw_client, a, "/accounts/?limit=100", first.headers["etag"])
    assert again.status_code == 200
    assert again.headers["etag"] != first.headers["etag"]


# --- cross-user staleness -----------------------------------------------------------------

def test_an_edit_on_a_shared_card_reaches_the_other_user(sw_client, sw, sw_db):
    a, b = sw["a"], sw["b"]
    card = sw_post(sw_client, a, "/accounts/", {
        "name": "Shared card", "account_type": "credit", "balance": 0,
        "billing_cycle_start": 15, "days_until_due_date": 21})["id"]
    sw_share(sw_db, card, b["id"], "editor", a["id"])
    txn = sw_post(sw_client, a, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": 100,
        "description": "Card lunch", "transaction_date": "2026-11-02T00:00:00",
        "is_posted": True})["id"]
    path = f"/transactions/?account_ids={card}&limit=50"
    first = get(sw_client, b, path)
    assert first.status_code == 200
    assert get(sw_client, b, path, first.headers["etag"]).status_code == 304
    r = sw_client.put(f"{API}/transactions/{txn}", json={"amount": 250},
                      headers=a["headers"])
    assert r.status_code == 200, r.text
    after = get(sw_client, b, path, first.headers["etag"])
    assert after.status_code == 200
    assert [float(t["amount"]) for t in after.json()["items"] if t["id"] == txn] == [250.0]


def test_an_edit_on_a_household_account_reaches_the_household(sw_client, hh):
    a, c, joint = hh["a"], hh["c"], hh["joint"]
    first = get(sw_client, c, "/accounts/?limit=100")
    assert joint in {r["id"] for r in first.json()["items"]}
    assert get(sw_client, c, "/accounts/?limit=100", first.headers["etag"]).status_code == 304
    r = sw_client.put(f"{API}/accounts/{joint}", json={"name": "Joint renamed"},
                      headers=a["headers"])
    assert r.status_code == 200, r.text
    after = get(sw_client, c, "/accounts/?limit=100", first.headers["etag"])
    assert after.status_code == 200
    assert {r["id"]: r["name"] for r in after.json()["items"]}[joint] == "Joint renamed"


def test_a_revoked_share_drops_the_account(sw_client, sw):
    a, b, joint = sw["a"], sw["b"], sw["joint"]
    first = get(sw_client, b, "/accounts/?limit=100")
    assert joint in {r["id"] for r in first.json()["items"]}
    r = sw_client.delete(f"{API}/accounts/{joint}/shares/{sw['shares']['b']}",
                         headers=a["headers"])
    assert r.status_code == 204, r.text
    after = get(sw_client, b, "/accounts/?limit=100", first.headers["etag"])
    assert after.status_code == 200
    assert joint not in {r["id"] for r in after.json()["items"]}


# --- day rollover, user switch, params, deploy ------------------------------------------

def test_manila_midnight_changes_the_tag(sw_client, sw, sw_db, monkeypatch):
    a = sw["a"]
    pin(monkeypatch, datetime(2026, 11, 13, 15, 59))  # 23:59 Manila, Nov 13
    v = version(sw_db)
    late = get(sw_client, a, "/categories/")
    pin(monkeypatch, datetime(2026, 11, 13, 16, 1))  # 00:01 Manila, Nov 14
    early = get(sw_client, a, "/categories/", late.headers["etag"])
    assert version(sw_db) == v
    assert early.status_code == 200
    assert early.headers["etag"] != late.headers["etag"]


def test_utc_midnight_changes_the_tag(sw_client, sw, sw_db, monkeypatch):
    """The snapshot's ``affordable_by`` reads the UTC date (08:00 Manila)."""
    a = sw["a"]
    pin(monkeypatch, datetime(2026, 11, 13, 23, 59))  # 07:59 Manila, Nov 14
    v = version(sw_db)
    before = get(sw_client, a, "/categories/")
    pin(monkeypatch, datetime(2026, 11, 14, 0, 1))  # 08:01 Manila, Nov 14
    after = get(sw_client, a, "/categories/", before.headers["etag"])
    assert version(sw_db) == v
    assert after.status_code == 200


def test_another_user_with_the_first_users_tag_gets_their_own_data(sw_client, sw):
    a, s = sw["a"], sw["s"]
    mine = get(sw_client, a, "/accounts/?limit=100")
    theirs = get(sw_client, s, "/accounts/?limit=100", mine.headers["etag"])
    assert theirs.status_code == 200
    assert {r["id"] for r in theirs.json()["items"]} == {sw["s_bank"]}


def test_query_strings(sw_client, sw):
    a = sw["a"]
    one = get(sw_client, a, "/accounts/?is_active=true&limit=100")
    other = get(sw_client, a, "/accounts/?is_active=true&limit=99", one.headers["etag"])
    assert other.status_code == 200
    assert other.headers["etag"] != one.headers["etag"]
    assert get(sw_client, a, "/accounts/?is_active=false&limit=100").headers["etag"] \
        != one.headers["etag"]
    reordered = get(sw_client, a, "/accounts/?limit=100&is_active=true", one.headers["etag"])
    assert reordered.status_code == 304


def test_a_deploy_changes_the_tag(sw_client, sw, monkeypatch):
    a = sw["a"]
    monkeypatch.setenv("RENDER_GIT_COMMIT", "aaaaaaa")
    old = get(sw_client, a, "/categories/")
    monkeypatch.setenv("RENDER_GIT_COMMIT", "bbbbbbb")
    new = get(sw_client, a, "/categories/", old.headers["etag"])
    assert new.status_code == 200
    assert new.headers["etag"] != old.headers["etag"]


def test_a_stale_exchange_rate_is_never_revalidated(sw_client, sw):
    """A rate turning stale changes ``stale`` with no write, and its refresh is
    scheduled by the handler: no 304 while any stored rate is stale."""
    from app.main import app
    from app.services import fx
    from app.tests.conftest import FX_REF, FX_STORE, FxNoNetwork

    a = sw["a"]
    first = get(sw_client, a, "/dashboard/snapshot")
    assert get(sw_client, a, "/dashboard/snapshot", first.headers["etag"]).status_code == 304
    later = FX_REF + timedelta(hours=30)
    app.dependency_overrides[fx.get_fx] = lambda: fx.FxRates(
        FX_STORE, provider=FxNoNetwork(), clock=lambda: later, on_stale=lambda: None)
    try:
        again = get(sw_client, a, "/dashboard/snapshot", first.headers["etag"])
    finally:
        from app.tests.conftest import fx_rates
        app.dependency_overrides[fx.get_fx] = fx_rates
    assert again.status_code == 200


# --- self-invalidation by a GET's own writes ----------------------------------------------

def test_a_throttled_page_open_run_does_not_bump(sw_client, sw, sw_db):
    """The Transactions page posts ``page_open`` on every open; inside the 15-minute
    slot it writes nothing, so the next open still revalidates with 304s."""
    a = sw["a"]

    def page_open():
        r = sw_client.post(f"{API}/budget-entries/post-due-installments",
                           json={"trigger": "page_open"}, headers=a["headers"])
        assert r.status_code == 200, r.text
        return r.json()["throttled"]

    assert page_open() is False  # takes the slot: a real write
    v = version(sw_db)
    assert page_open() is True
    assert version(sw_db) == v


def test_two_concurrent_page_open_claims_bump_once(sw, sw_db):
    """Two claims at the same moment: the second waits on the first's row lock, then sees
    the slot taken and writes nothing, so the version moves once. Without the lock both
    pass the slot check and the loser's zero-row UPDATE bumps a second time."""
    import os
    import threading
    import time

    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app.core.time import utc_now
    from app.models.user import User
    from app.services import posting

    uid = sw["a"]["id"]
    sw_db.execute(text("UPDATE users SET installments_page_posted_at = NULL WHERE id = :u"),
                  {"u": uid})
    sw_db.commit()
    now = utc_now()
    engine = create_engine(os.environ["DATABASE_URL"])
    loser = {}
    try:
        with Session(engine) as one, Session(engine) as two:
            before = version(sw_db)
            assert posting._claim_page_open_sql(one, one.get(User, uid), now) is True
            user_two = two.get(User, uid)
            loser["statements"] = []
            event.listen(two.connection(), "before_cursor_execute",
                         lambda *a: loser["statements"].append(a[2].split()[0].upper()))
            pid_two = two.execute(text("SELECT pg_backend_pid()")).scalar_one()

            def claim():
                loser["statements"].clear()  # only the claim's own statements
                try:
                    loser["claimed"] = posting._claim_page_open_sql(two, user_two, now)
                except BaseException as exc:  # recorded for the test thread
                    loser["error"] = exc

            worker = threading.Thread(target=claim, daemon=True)
            worker.start()
            deadline, waiting = time.monotonic() + 10, False
            with engine.connect() as probe:
                while not waiting and time.monotonic() < deadline:
                    waiting = probe.execute(text(
                        "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = :p"),
                        {"p": pid_two}).scalar() or False
                    time.sleep(0.02)
            one.commit()
            worker.join(30)
            assert not worker.is_alive()
            two.commit()
            assert waiting, "the second claim did not wait on the first"
    finally:
        engine.dispose()
    sw_db.expire_all()
    # The loser sends no UPDATE, and the version moves once (the winner's commit).
    assert (loser, version(sw_db) - before) == ({"claimed": False, "statements": ["SELECT"]}, 1)


def _page_open_cases():
    from app.tests.fixtures.realistic import CALLERS

    return [(caller, name) for caller in CALLERS for name in (
        "snapshot", "transactions (month, 25)", "accounts", "categories", "budget-entries",
        "due window (unposted)", "upcoming transactions", "upcoming occurrences (none)",
        "upcoming occurrences (subscription)", "installment-plans")]


@pytest.mark.parametrize("caller,name", _page_open_cases())
def test_a_second_identical_get_is_a_304(sw_client, sw_db, realistic, caller, name):
    """Whatever a GET writes on its way (catch-ups, backfills) must not bump."""
    from app.tests.fixtures import perf

    path = perf.page_open_paths(realistic)[name]
    who = realistic.callers[caller]
    headers = who.headers  # logs in first: a login writes (last_login, a refresh token)
    assert headers
    v = version(sw_db)
    first = get(sw_client, who, path)
    assert first.status_code == 200, first.text[:300]
    second = get(sw_client, who, path, first.headers["etag"])
    assert version(sw_db) == v
    assert second.status_code == 304

"""The Transactions page posts due card installments when it opens (STU-343 Plan
B, B2 commit 4, owner ruling Q1). Skips without a database.

``POST /budget-entries/post-due-installments {trigger: "page_open"}`` runs the
same posting as Post now and the daily job, after claiming the caller's
15-minute slot on ``users.installments_page_posted_at`` in one atomic
``UPDATE … RETURNING`` committed on its own. Without the slot the response is
``throttled`` and nothing is posted. Post now (``button``) is never throttled.

The world is the B2 commit 3 world (``test_installment_autopost_integration``):
Card C of O's, A admin, E editor, V viewer, T tag viewer, and "Tablet", 5,000
on the 5th, 24 remaining, from 2026-07-05, so Jul 5 to Oct 5 are due on Sunday
2026-10-18.
"""
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.tests.conftest import API, sw_db_reachable
from app.tests.test_installment_autopost_integration import (
    MONTHS, TOKEN, _installment, _job_ok, _reviewed, _rows, _state, make_world,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
AUTO_POST_REVISION = "b3d7f1a9c5e2"
PAGE_OPEN_REVISION = "d9a1c3e5f7b2"
NOW = datetime(2026, 10, 18, 2, 0, tzinfo=timezone.utc)
PROBE_DEADLINE = 10
JOIN_TIMEOUT = 30


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    return make_world(sw_client, sw_db, sw_people, monkeypatch)


@pytest.fixture
def db_engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def token(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    return TOKEN


def pin_now(monkeypatch, when: datetime) -> None:
    """The aware clock the page-open claim reads (``posting.utc_now``)."""
    from app.services import posting

    monkeypatch.setattr(posting, "utc_now", lambda: when)


def _post(client, who, trigger):
    return client.post(f"{API}/budget-entries/post-due-installments", json={"trigger": trigger},
                       headers=who["headers"])


def _open(client, who, trigger="page_open") -> dict:
    r = _post(client, who, trigger)
    assert r.status_code == 200, r.text
    return r.json()


def _claimed_at(db, who):
    db.rollback()
    return db.execute(text("SELECT installments_page_posted_at FROM users WHERE id = :u"),
                      {"u": who["id"]}).scalar()


def test_page_open_posts_due_months_once(world, monkeypatch):
    w, db = world, world["db"]
    tablet = _reviewed(w)
    pin_now(monkeypatch, NOW)

    first = _open(w["client"], w["o"])
    assert first["trigger"] == "page_open"
    assert (first["throttled"], first["posted"]) == (False, 4)
    assert _claimed_at(db, w["o"]) == NOW

    pin_now(monkeypatch, NOW + timedelta(minutes=14, seconds=59))
    assert _open(w["client"], w["o"]) == {"trigger": "page_open", "throttled": True,
                                           "posted": 0, "skipped": {}, "entries": []}
    assert _claimed_at(db, w["o"]) == NOW
    assert len(_rows(db, tablet)) == 4

    pin_now(monkeypatch, NOW + timedelta(minutes=16))
    later = _open(w["client"], w["o"])
    assert (later["throttled"], later["posted"]) == (False, 0)
    assert _claimed_at(db, w["o"]) == NOW + timedelta(minutes=16)
    assert len(_rows(db, tablet)) == 4
    # Operational state: never in a user response.
    me = w["client"].get(f"{API}/auth/me", headers=w["o"]["headers"]).json()
    assert "installments_page_posted_at" not in me


def test_page_open_throttle_boundary_is_exactly_fifteen_minutes(world, monkeypatch):
    w, db = world, world["db"]
    _reviewed(w)
    pin_now(monkeypatch, NOW)
    assert _open(w["client"], w["o"])["throttled"] is False
    assert _claimed_at(db, w["o"]) == NOW

    pin_now(monkeypatch, NOW + timedelta(minutes=14, seconds=59))
    assert _open(w["client"], w["o"])["throttled"] is True
    assert _claimed_at(db, w["o"]) == NOW

    pin_now(monkeypatch, NOW + timedelta(minutes=15))
    at_boundary = _open(w["client"], w["o"])
    assert (at_boundary["throttled"], at_boundary["posted"]) == (False, 0)
    assert _claimed_at(db, w["o"]) == NOW + timedelta(minutes=15)


def test_page_open_is_idempotent_with_the_job_and_post_now(world, token, monkeypatch):
    w, db = world, world["db"]
    pin_now(monkeypatch, NOW)
    tablet = _reviewed(w)
    assert _job_ok(w["client"])["posted"] == 4
    body = _open(w["client"], w["o"])
    assert (body["throttled"], body["posted"]) == (False, 0)
    assert _open(w["client"], w["o"], "button")["posted"] == 0
    assert [r[1] for r in _rows(db, tablet)] == MONTHS

    # The other order, on a new entry and a new slot.
    pin_now(monkeypatch, NOW + timedelta(minutes=16))
    phone = _reviewed(w, name="Phone")
    body = _open(w["client"], w["o"])
    assert (body["throttled"], body["posted"]) == (False, 4)
    assert _job_ok(w["client"])["posted"] == 0
    assert _open(w["client"], w["o"], "button")["posted"] == 0
    assert [r[1] for r in _rows(db, phone)] == MONTHS
    assert _state(db, phone) == _state(db, tablet)


def test_page_open_button_is_never_throttled(world, monkeypatch):
    w = world
    pin_now(monkeypatch, NOW)
    _reviewed(w)
    assert _open(w["client"], w["o"])["posted"] == 4
    phone = _installment(w, name="Phone", next_day="2026-10-18", remaining=6)  # on by create

    body = _open(w["client"], w["o"], "button")
    assert body["trigger"] == "button"
    assert (body["throttled"], body["posted"]) == (False, 1)
    assert body["entries"] == [{"entry_id": phone, "posted": 1, "skipped_reason": None}]
    assert _open(w["client"], w["o"])["throttled"] is True


def test_page_open_throttle_is_per_user(world, monkeypatch):
    w, db = world, world["db"]
    pin_now(monkeypatch, NOW)
    tablet = _reviewed(w)
    assert _open(w["client"], w["o"])["posted"] == 4

    body = _open(w["client"], w["a"])
    assert (body["throttled"], body["posted"]) == (False, 0)
    assert body["entries"] == []  # O's run already posted Tablet; A's had nothing due
    assert _claimed_at(db, w["a"]) == NOW
    assert len(_rows(db, tablet)) == 4


def _pid(session) -> int:
    return session.execute(text("SELECT pg_backend_pid()")).scalar()


def _wait_blocked(engine, holder_pid: int, worker) -> bool:
    """Whether some backend waits on ``holder_pid`` before the deadline (or the worker ends)."""
    deadline = time.monotonic() + PROBE_DEADLINE
    with engine.connect() as probe:
        while True:
            waiting = probe.execute(text(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE pg_blocking_pids(pid) @> ARRAY[CAST(:holder AS integer)]"),
                {"holder": holder_pid}).scalar()
            probe.rollback()
            if waiting or not worker.thread.is_alive() or time.monotonic() > deadline:
                return bool(waiting)
            time.sleep(0.05)


class _Worker:
    def __init__(self, fn):
        self.fn = fn
        self.result = None
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        try:
            self.result = self.fn()
        except BaseException as exc:  # recorded for the test thread
            self.error = exc


def test_concurrent_page_opens_claim_once(world, db_engine, monkeypatch):
    """r3.1 row 10: only the claim's SQL is wrapped; the real UPDATE holds the row lock."""
    from app.services import posting

    w, db = world, world["db"]
    tablet = _reviewed(w)
    real = posting._claim_page_open_sql
    claimed, release = threading.Event(), threading.Event()
    first_pid = []

    def hold_first(session, user, now):
        result = real(session, user, now)
        if not first_pid:
            first_pid.append(_pid(session))
            claimed.set()
            assert release.wait(JOIN_TIMEOUT), "the test never released the first claim"
        return result

    monkeypatch.setattr(posting, "_claim_page_open_sql", hold_first)
    first = _Worker(lambda: _post(w["client"], w["o"], "page_open"))
    second = _Worker(lambda: _post(w["client"], w["o"], "page_open"))
    try:
        first.thread.start()
        assert claimed.wait(PROBE_DEADLINE), (first.result, first.error)
        second.thread.start()
        assert _wait_blocked(db_engine, first_pid[0], second), (
            "the second claim did not wait on the first", second.result, second.error)
    finally:
        release.set()
        first.thread.join(JOIN_TIMEOUT)
        second.thread.join(JOIN_TIMEOUT)
    assert not first.thread.is_alive() and not second.thread.is_alive()
    assert (first.error, second.error) == (None, None)
    a, b = first.result.json(), second.result.json()
    assert (a["throttled"], a["posted"]) == (False, 4)
    assert b == {"trigger": "page_open", "throttled": True, "posted": 0, "skipped": {},
                 "entries": []}
    assert [r[1] for r in _rows(db, tablet)] == MONTHS


def test_page_open_roles(world):
    """Q3: owner, admin and editor post (rows owned by the creator); viewers post nothing."""
    w, db = world, world["db"]
    for who in ("o", "a", "e"):
        tablet = _reviewed(w, name=f"Tablet {who}")
        body = _open(w["client"], w[who])
        assert body == {"trigger": "page_open", "throttled": False, "posted": 4, "skipped": {},
                        "entries": [{"entry_id": tablet, "posted": 4, "skipped_reason": None}]}
        assert [(r[1], r[3], r[4]) for r in _rows(db, tablet)] == [
            (m, w["o"]["id"], w[who]["id"]) for m in MONTHS]
    for who in ("v", "t"):
        tablet = _reviewed(w, name=f"Tablet {who}")
        assert _open(w["client"], w[who]) == {"trigger": "page_open", "throttled": False,
                                              "posted": 0, "skipped": {}, "entries": []}
        assert _rows(db, tablet) == []
        assert _state(db, tablet) == (MONTHS[0], 24)


def test_page_open_rejects_an_unknown_trigger(world):
    w, db = world, world["db"]
    tablet = _reviewed(w)

    for trigger in ("cron", "", None, 1):
        r = _post(w["client"], w["o"], trigger)
        assert r.status_code == 422, (trigger, r.text)
    assert _rows(db, tablet) == []
    assert _claimed_at(db, w["o"]) is None


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_pageopen_{os.urandom(3).hex()}"
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


def test_page_open_migration_is_the_single_head(scratch_url):
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    assert script.get_heads() == [PAGE_OPEN_REVISION]
    assert script.get_revision(PAGE_OPEN_REVISION).down_revision == AUTO_POST_REVISION

    def columns():
        engine = create_engine(scratch_url)
        try:
            with engine.connect() as c:
                return {col["name"]: col for col in inspect(c).get_columns("users")}
        finally:
            engine.dispose()

    _alembic(scratch_url, "upgrade", PAGE_OPEN_REVISION)
    column = columns()["installments_page_posted_at"]
    assert column["nullable"] is True
    assert getattr(column["type"], "timezone", False) is True
    _alembic(scratch_url, "downgrade", AUTO_POST_REVISION)
    assert "installments_page_posted_at" not in columns()
    _alembic(scratch_url, "upgrade", "head")
    assert "installments_page_posted_at" in columns()

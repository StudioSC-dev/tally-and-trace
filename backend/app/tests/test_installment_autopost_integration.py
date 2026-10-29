"""Card installments post themselves: the job, the backstop and ``post_plan``
(STU-343 Plan B, B2 commit 3). Skips without a database.

Reference Sunday 2026-10-18, 10:00 in Manila. O owns Checking (50,000) and Card
C (closes on the 24th, due 21 days later, paid from Checking, tagged with O's
Household tag). A is an admin, E an editor and V a viewer on Card C; T holds
O's Household tag share, so T is a tag viewer of Card C. "Tablet" is O's
5,000 on the 5th, capped at 24, next 2026-07-05: Jul 5 to Oct 5 are due.

Reviewed and auto-post flags are written straight to the row: the review
lands in a later commit, and create starts a backdated installment off.
"""
import os
import sys
import threading
import time
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import (
    API, PRIVATE, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)  # Sunday, 10:00 in Manila
TODAY = date(2026, 10, 18)
TOKEN = "test-job-token"
PROBE_DEADLINE = 10
JOIN_TIMEOUT = 30
MONTHS = [date(2026, 7, 5), date(2026, 8, 5), date(2026, 9, 5), date(2026, 10, 5)]


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def token(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    return TOKEN


def _account(client, who, name, account_type, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking, name="Card C", **extra):
    return _account(client, who, name, "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking, **extra)


def make_world(client, db, sw_people, monkeypatch) -> dict:
    """The shared world (module docstring); also used by the page-open tests."""
    o = sw_people("Olive", "Owner")
    a = sw_people("Ada", "Admin")
    e = sw_people("Eli", "Editor")
    v = sw_people("Vic", "Viewer")
    t = sw_people("Tess", "Tagviewer")
    checking = _account(client, o, "Checking", "checking", 50_000)
    card = _card(client, o, checking, tag_ids=[hh_household(db, o)])
    sw_share(db, card, a["id"], "admin", o["id"])
    sw_share(db, card, e["id"], "editor", o["id"])
    sw_share(db, card, v["id"], "viewer", o["id"])
    hh_tag_share(db, o, t)
    pin_clock(monkeypatch, REF)
    return {"client": client, "db": db, "o": o, "a": a, "e": e, "v": v, "t": t,
            "checking": checking, "card": card}


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    return make_world(sw_client, sw_db, sw_people, monkeypatch)


def _installment(w, name="Tablet", next_day="2026-07-05", remaining=24, who=None, card=None,
                 **extra):
    body = {"name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
            "next_occurrence": f"{next_day}T00:00:00", "account_id": card or w["card"],
            "end_mode": "after_occurrences", "max_occurrences": remaining, **extra}
    return sw_post(w["client"], who or w["o"], "/budget-entries/", body)["id"]


def _flags(db, entry_id, reviewed=True, on=True):
    db.execute(text("UPDATE budget_entries SET installment_reviewed_at = "
                    "CASE WHEN :r THEN now() ELSE NULL END, auto_post_enabled = :on "
                    "WHERE id = :id"), {"r": reviewed, "on": on, "id": entry_id})
    db.commit()


def _reviewed(w, **kw) -> int:
    entry_id = _installment(w, **kw)
    _flags(w["db"], entry_id)
    return entry_id


def _txn(w, when, amount=5_000, who=None, account=None, **extra):
    return sw_post(w["client"], who or w["o"], "/transactions/", {
        "account_id": account or w["card"], "amount": amount, "transaction_type": "debit",
        "description": "Card charge", "transaction_date": f"{when}T00:00:00", **extra})["id"]


def _rows(db, entry_id):
    """``[(transaction date, occurrence day or None, is_posted, owner, actor, id)]``."""
    db.rollback()
    return [(r.transaction_date.date(), r.occurrence_date.date() if r.occurrence_date else None,
             r.is_posted, r.user_id, r.created_by_actor, r.id)
            for r in db.execute(text(
                "SELECT id, transaction_date, occurrence_date, is_posted, user_id, "
                "created_by_actor FROM transactions WHERE budget_entry_id = :e "
                "ORDER BY transaction_date, id"), {"e": entry_id})]


def _entry(db, entry_id):
    db.rollback()
    return db.execute(text(
        "SELECT next_occurrence, max_occurrences, is_active, updated_at, auto_post_enabled, "
        "installment_reviewed_at FROM budget_entries WHERE id = :e"), {"e": entry_id}).one()


def _state(db, entry_id):
    row = _entry(db, entry_id)
    return (row.next_occurrence.date(), row.max_occurrences)


def _job(client, token=TOKEN, **params):
    headers = {} if token is None else {"X-Job-Token": token}
    return client.post(f"{API}/jobs/post-due-installments", params=params, headers=headers)


def _job_ok(client, **params) -> dict:
    r = _job(client, **params)
    assert r.status_code == 200, r.text
    return r.json()


def _backstop(client, who, **params) -> dict:
    r = client.post(f"{API}/budget-entries/post-due-installments", json={"trigger": "button"},
                    params=params, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _orm(db, model, record_id):
    db.rollback()
    db.expire_all()
    return db.get(model, record_id)


def _plan(db, entry_id, who, through=TODAY):
    from app.core.access import RecordAccess
    from app.models.budget_entry import BudgetEntry
    from app.models.user import User
    from app.services.installment_duplicates import held_occurrences
    from app.services.posting import post_plan

    entry = _orm(db, BudgetEntry, entry_id)
    actor = db.get(User, who["id"])
    return post_plan(db, entry, actor, through, held_occurrences(db, [entry], through),
                     RecordAccess(db, actor))


def _days(occurrences):
    return [occ.date() for occ in occurrences]


def _entries(db, *ids):
    from app.models.budget_entry import BudgetEntry

    db.rollback()
    db.expire_all()
    return [db.get(BudgetEntry, i) for i in ids]


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


def _lock_waiters(engine) -> int:
    with engine.connect() as probe:
        n = probe.execute(text(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND wait_event_type = 'Lock'")).scalar()
        probe.rollback()
    return n


def _wait_waiters(engine, target, workers) -> bool:
    deadline = time.monotonic() + PROBE_DEADLINE
    while True:
        if _lock_waiters(engine) >= target:
            return True
        if any(not w.thread.is_alive() for w in workers) or time.monotonic() > deadline:
            return False
        time.sleep(0.05)


def _statement_events(db, user_id):
    from app.services.forecast import project_running_balance

    db.rollback()
    r = project_running_balance(db, user_id, days=90)
    return [(e["date"].isoformat(), e["name"], e["amount"]) for e in r["events"]
            if e["name"].endswith("statement")]


# --- the job --------------------------------------------------------------------------------

def test_job_posts_the_four_missed_months_and_payables_stay_identical(world, token):
    w, db = world, world["db"]
    tablet = _reviewed(w)
    before = _statement_events(db, w["o"]["id"])

    assert _job_ok(w["client"]) == {"dry_run": False, "posted": 4, "skipped": {}}

    rows = _rows(db, tablet)
    assert [(r[0], r[1], r[2], r[3], r[4]) for r in rows] == [
        (m, m, True, w["o"]["id"], w["o"]["id"]) for m in MONTHS]
    assert _state(db, tablet) == (date(2026, 11, 5), 20)
    assert _statement_events(db, w["o"]["id"]) == before


def test_job_posts_todays_occurrence_on_the_manila_day(world, token, monkeypatch):
    w, db = world, world["db"]
    phone = _installment(w, name="Phone", next_day="2026-10-18", remaining=6)
    assert _entry(db, phone).auto_post_enabled  # from today: on by create

    pin_clock(monkeypatch, datetime(2026, 10, 17, 15, 59))  # 23:59 on Oct 17 in Manila
    assert _job_ok(w["client"])["posted"] == 0
    assert _rows(db, phone) == []

    pin_clock(monkeypatch, datetime(2026, 10, 17, 16, 1))  # 00:01 on Oct 18 in Manila
    assert _job_ok(w["client"])["posted"] == 1
    assert [(r[0], r[2]) for r in _rows(db, phone)] == [(date(2026, 10, 18), True)]
    assert _state(db, phone) == (date(2026, 11, 18), 5)


def test_unreviewed_entry_with_history_is_never_backfilled(world, token):
    w, db = world, world["db"]
    tablet = _installment(w)
    r = w["client"].post(f"{API}/budget-entries/{tablet}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text
    _flags(db, tablet, reviewed=False, on=True)  # no writer does this; still unreviewed
    before = _entry(db, tablet)

    assert _job_ok(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert len(_rows(db, tablet)) == 1
    assert _entry(db, tablet) == before


def test_reviewed_entry_with_auto_post_off_is_not_posted(world, token):
    w, db = world, world["db"]
    tablet = _installment(w)
    _flags(db, tablet, reviewed=True, on=False)

    assert _job_ok(w["client"])["posted"] == 0
    assert _rows(db, tablet) == []
    assert _state(db, tablet) == (date(2026, 7, 5), 24)


def test_job_is_idempotent(world, token):
    w, db = world, world["db"]
    tablet = _reviewed(w)

    assert _job_ok(w["client"])["posted"] == 4
    updated = _entry(db, tablet).updated_at
    assert _job_ok(w["client"]) == {"dry_run": False, "posted": 0, "skipped": {}}
    assert len(_rows(db, tablet)) == 4
    assert _entry(db, tablet).updated_at == updated


def test_two_concurrent_job_runs_post_each_month_once(world, token, engine):
    from app.core import locking

    w, db = world, world["db"]
    tablet = _reviewed(w)
    workers = [_Worker(lambda: _job(w["client"])) for _ in range(2)]
    holder = engine.connect()
    try:
        holder.execute(text("SELECT pg_advisory_xact_lock(:ns, :owner)"),
                       {"ns": locking.OWNER_BUDGET_LOCK_NS, "owner": w["o"]["id"]})
        for worker in workers:
            worker.thread.start()
        assert _wait_waiters(engine, 2, workers), "both runs did not queue on the owner lock"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        for worker in workers:
            worker.thread.join(JOIN_TIMEOUT)
    assert not any(worker.thread.is_alive() for worker in workers)
    assert [worker.error for worker in workers] == [None, None]
    assert sorted(worker.result.json()["posted"] for worker in workers) == [0, 4]
    assert [r[1] for r in _rows(db, tablet)] == MONTHS
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_job_waits_for_a_mark_paid_holding_the_owner_lock(world, token, engine, sw_client):
    from app.core import locking
    from app.core.database import SessionLocal
    from app.models.user import User
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services.posting import record_occurrence

    w, db = world, world["db"]
    tablet = _reviewed(w)
    holder = SessionLocal()
    worker = _Worker(lambda: _job(w["client"]))
    try:
        locking.lock_owner_budgets(holder, w["o"]["id"])
        entry = locking.lock_entry(holder, tablet)
        record_occurrence(holder, entry, holder.get(User, w["o"]["id"]),
                          BudgetEntryMaterialize(), datetime(2026, 7, 5))
        worker.thread.start()
        assert _wait_waiters(engine, 1, [worker]), "the job did not wait for the Mark paid"
        holder.commit()
    finally:
        holder.rollback()
        holder.close()
        worker.thread.join(JOIN_TIMEOUT)
    assert not worker.thread.is_alive()
    assert worker.error is None
    assert worker.result.json()["posted"] == 3
    assert [r[1] for r in _rows(db, tablet)] == MONTHS
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_job_dry_run_posts_nothing(world, token):
    w, db = world, world["db"]
    tablet = _reviewed(w)
    before = _entry(db, tablet)

    assert _job_ok(w["client"], dry_run="true") == {"dry_run": True, "posted": 4, "skipped": {}}
    assert _rows(db, tablet) == []
    assert _entry(db, tablet) == before
    assert _job_ok(w["client"])["posted"] == 4


def test_job_endpoint_requires_the_token(world, monkeypatch):
    from app.core.config import settings

    w, db = world, world["db"]
    tablet = _reviewed(w)
    monkeypatch.setattr(settings, "JOB_TOKEN", None)
    assert _job(w["client"], token=None).status_code == 404
    assert _job(w["client"], token="anything").status_code == 404

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    assert _job(w["client"], token=None).status_code == 401
    assert _job(w["client"], token="wrong").status_code == 401
    assert _job(w["client"], token=TOKEN + "x").status_code == 401
    # Bearer auth is no substitute for the token.
    r = w["client"].post(f"{API}/jobs/post-due-installments", headers=w["o"]["headers"])
    assert r.status_code == 401
    assert _rows(db, tablet) == []

    assert _job(w["client"]).status_code == 200
    assert len(_rows(db, tablet)) == 4
    # Kept out of the published API schema.
    paths = w["client"].get(f"{API}/openapi.json").json()["paths"]
    assert not [p for p in paths if p.startswith(f"{API}/jobs")]


def test_empty_job_token_is_unset(world, monkeypatch):
    from app.core import config

    for blank in ("", "   ", "\t\n"):
        assert config.Settings(JOB_TOKEN=blank).JOB_TOKEN is None
        monkeypatch.setenv("JOB_TOKEN", blank)
        assert config.Settings().JOB_TOKEN is None
        monkeypatch.setattr(config.settings, "JOB_TOKEN", config.Settings().JOB_TOKEN)
        assert _job(world["client"], token="anything").status_code == 404
        assert _job(world["client"], token=None).status_code == 404
    monkeypatch.setenv("JOB_TOKEN", "set")
    assert config.Settings().JOB_TOKEN == "set"


def test_job_token_header_is_scrubbed_from_sentry_events():
    from app.core.observability import _scrub_event

    secret = "real-job-token-value-0123"
    event = {"request": {"headers": {"X-Job-Token": secret, "Accept": "application/json"}}}
    out = _scrub_event(event, {})
    assert out["request"]["headers"]["X-Job-Token"] == "[Filtered]"
    assert out["request"]["headers"]["Accept"] == "application/json"
    assert secret not in repr(out)


BACKEND_DIR = Path(__file__).resolve().parents[2]

SENTRY_CHILD = """
import json
import os
import sys

import sentry_sdk
from fastapi.testclient import TestClient
from sentry_sdk.transport import Transport

from app.core import observability
from app.core.config import settings
from app.main import app
from app.services import posting

api, synthetic = sys.argv[1], os.environ["SYNTHETIC_JOB_TOKEN"]
sent = []


class Capture(Transport):
    def capture_envelope(self, envelope):
        for item in envelope.items:
            sent.append(item.payload.json)


def boom(*args, **kwargs):
    raise RuntimeError("posting failed")


real_init = sentry_sdk.init
sentry_sdk.init = lambda **options: real_init(transport=Capture(), **options)
settings.JOB_TOKEN = synthetic
settings.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0"
posting.post_due_installments = boom
assert observability.init_sentry() is True
with TestClient(app, raise_server_exceptions=False) as client:
    r = client.post(api + "/jobs/post-due-installments", headers={"X-Job-Token": synthetic})
sentry_sdk.flush()
events = [i for i in sent if i and "exception" in i]
print(json.dumps({"status": r.status_code, "events": len(events),
                  "leaked": synthetic in json.dumps(sent, default=str)}))
"""


def test_job_token_stays_out_of_sentry_frame_locals():
    """An unhandled error inside the job endpoint reaches Sentry with its stack
    frames; the endpoint's ``x_job_token`` argument must not ride along in them.
    Real Sentry runs in a child process: its integration patches, registry and
    scope state would otherwise outlive the test."""
    import json
    import subprocess

    import sentry_sdk

    synthetic = "synthetic-job-token-frame-vars-7f3a"
    done = subprocess.run(
        [sys.executable, "-c", SENTRY_CHILD, API],  # the token rides env: Sentry captures argv
        env={**os.environ, "SYNTHETIC_JOB_TOKEN": synthetic}, capture_output=True, text=True, timeout=120,
        cwd=BACKEND_DIR,
    )
    assert done.returncode == 0, done.stderr[-2000:].replace(synthetic, "[token]")
    result = json.loads(done.stdout.strip().splitlines()[-1])
    assert result["status"] == 500
    assert result["events"] >= 1, "the endpoint error never reached the Sentry transport"
    assert result["leaked"] is False
    assert not sentry_sdk.get_client().is_active(), "Sentry is active in the test process"


def test_job_rejects_through_after_manila_today(world, token, monkeypatch):
    w, db = world, world["db"]
    tablet = _reviewed(w)

    r = _job(w["client"], through="2026-10-19")
    assert r.status_code == 422, r.text
    assert _rows(db, tablet) == []

    assert _job_ok(w["client"], through="2026-08-10")["posted"] == 2
    assert [r[1] for r in _rows(db, tablet)] == MONTHS[:2]
    # 07:30 on Oct 18 in Manila is still Oct 17 in UTC: Manila's day decides.
    pin_clock(monkeypatch, datetime(2026, 10, 17, 23, 30))
    assert _job_ok(w["client"], through="2026-10-18")["posted"] == 2
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_job_response_carries_counts_only(world, token):
    w, db = world, world["db"]
    tablet = _reviewed(w, name=f"{PRIVATE} Tablet")
    foreign = _installment(w, name=f"{PRIVATE} Lens", currency="USD")
    _flags(db, foreign)

    r = _job(w["client"])
    body = r.json()
    assert set(body) == {"dry_run", "posted", "skipped"}
    assert body == {"dry_run": False, "posted": 4, "skipped": {"foreign_currency": 1}}
    assert PRIVATE not in r.text and "5000" not in r.text
    assert str(tablet) not in r.text and str(foreign) not in r.text


def test_job_skips_ineligible_entries_with_reasons(world, token):
    w, db = world, world["db"]
    foreign = _installment(w, name="Lens", currency="USD")
    card_n = _card(w["client"], w["o"], w["checking"], name="Card N")
    nocycle = _installment(w, name="Watch", card=card_n)
    plain = _installment(w, name="Plain")
    for entry_id in (foreign, nocycle, plain):
        _flags(db, entry_id)
    db.execute(text("UPDATE accounts SET billing_cycle_start = NULL, due_date = NULL "
                    "WHERE id = :id"), {"id": card_n})
    db.commit()

    body = _job_ok(w["client"])
    assert body["posted"] == 4
    assert body["skipped"] == {"foreign_currency": 1, "no_statement_cycle": 1}
    assert _rows(db, foreign) == [] and _rows(db, nocycle) == []
    assert _state(db, foreign) == _state(db, nocycle) == (date(2026, 7, 5), 24)


def test_job_ignores_subscriptions_bills_cash_installments_and_paused_entries(world, token):
    w, db = world, world["db"]
    client, o = w["client"], w["o"]
    open_ended = {"name": "Stream", "entry_type": "expense", "amount": 5_000,
                  "cadence": "monthly", "next_occurrence": "2026-07-05T00:00:00",
                  "account_id": w["card"]}
    subscription = sw_post(client, o, "/budget-entries/", open_ended)["id"]
    bill = sw_post(client, o, "/budget-entries/", {
        **open_ended, "name": "Power", "billing_kind": "bill"})["id"]
    cash = _installment(w, name="Cash plan", card=w["checking"])
    paused = _reviewed(w, name="Paused")
    r = client.put(f"{API}/budget-entries/{paused}", json={"is_active": False},
                   headers=o["headers"])
    assert r.status_code == 200, r.text
    for entry_id in (subscription, bill, cash):
        _flags(db, entry_id)  # no writer turns these on; the job still leaves them
    assert _entry(db, paused).auto_post_enabled  # pausing keeps the flags

    assert _job_ok(client) == {"dry_run": False, "posted": 0, "skipped": {}}
    for entry_id in (subscription, bill, cash, paused):
        assert _rows(db, entry_id) == []
        assert _state(db, entry_id)[0] == date(2026, 7, 5)


def test_job_posts_a_linked_pending_row_instead_of_adding_one(world, token):
    w, db = world, world["db"]
    tablet = _reviewed(w)
    pending = _txn(w, "2026-08-05", is_posted=False, budget_entry_id=tablet)

    assert _job_ok(w["client"])["posted"] == 4
    rows = _rows(db, tablet)
    assert len(rows) == 4
    aug = [r for r in rows if r[0] == date(2026, 8, 5)]
    assert [(r[5], r[2]) for r in aug] == [(pending, True)]
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_job_keeps_a_pending_charge_on_its_own_statement(world, token):
    """Q5: a linked pending row is posted on its own date, so on its own statement."""
    w, db = world, world["db"]
    tablet = _reviewed(w)
    pending = _txn(w, "2026-07-26", is_posted=False, budget_entry_id=tablet)
    db.execute(text("UPDATE transactions SET occurrence_date = '2026-07-05' WHERE id = :id"),
               {"id": pending})
    db.commit()

    assert _job_ok(w["client"])["posted"] == 4
    row = [r for r in _rows(db, tablet) if r[5] == pending]
    assert [(r[0], r[1], r[2]) for r in row] == [(date(2026, 7, 26), date(2026, 7, 5), True)]
    assert len(_rows(db, tablet)) == 4


def test_job_holds_a_month_with_a_possible_duplicate(world, token):
    """Q4: the month is held, the months before it post, the candidate stays unlinked."""
    w, db = world, world["db"]
    tablet = _reviewed(w)
    typed = _txn(w, "2026-08-07")

    assert _job_ok(w["client"]) == {"dry_run": False, "posted": 1,
                                    "skipped": {"possible_duplicate": 1}}
    assert [r[1] for r in _rows(db, tablet)] == [date(2026, 7, 5)]
    assert _state(db, tablet) == (date(2026, 8, 5), 23)
    db.rollback()
    assert db.execute(text("SELECT budget_entry_id FROM transactions WHERE id = :id"),
                      {"id": typed}).scalar() is None


def test_held_occurrences_use_each_candidate_once(world):
    from app.services.installment_duplicates import held_occurrences

    w, db = world, world["db"]
    tablet = _reviewed(w)
    phone = _reviewed(w, name="Phone")
    _txn(w, "2026-08-06")

    held = held_occurrences(db, _entries(db, tablet, phone), TODAY)
    assert held == Counter({(tablet, date(2026, 8, 5)): 1})

    _txn(w, "2026-08-04")
    held = held_occurrences(db, _entries(db, tablet, phone), TODAY)
    assert held == Counter({(tablet, date(2026, 8, 5)): 1, (phone, date(2026, 8, 5)): 1})


def test_job_rolls_back_an_ambiguous_entry_and_continues(world, token):
    w, db = world, world["db"]
    lens = _reviewed(w, name="Lens")
    for _ in range(2):
        _txn(w, "2026-08-05", budget_entry_id=lens)
    tablet = _reviewed(w)

    body = _job_ok(w["client"])
    assert body == {"dry_run": False, "posted": 4, "skipped": {"ambiguous": 1}}
    assert len(_rows(db, lens)) == 2
    assert _state(db, lens) == (date(2026, 7, 5), 24)
    assert len(_rows(db, tablet)) == 4


def test_manual_mark_paid_before_the_job_counts_once(world, token):
    w, db = world, world["db"]
    tablet = _reviewed(w)
    r = w["client"].post(f"{API}/budget-entries/{tablet}/materialize", json={},
                         headers=w["o"]["headers"])
    assert r.status_code == 201, r.text

    assert _job_ok(w["client"])["posted"] == 3
    assert [r[1] for r in _rows(db, tablet)] == MONTHS
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


def test_job_advances_past_a_posted_linked_row_without_a_new_row(world, token):
    """r3.1 row 1: the walk includes the posted-linked Aug 5, which advances only."""
    from app.models.budget_entry import BudgetEntry
    from app.models.user import User
    from app.services.posting import Outcome, _post_entry_due

    w, db = world, world["db"]
    tablet = _reviewed(w)
    typed = _txn(w, "2026-08-05", budget_entry_id=tablet)

    # The outcomes, in a run that is rolled back.
    entry = _orm(db, BudgetEntry, tablet)
    run = _post_entry_due(db, entry, db.get(User, w["o"]["id"]), TODAY, hold_duplicates=True)
    assert [item.outcome for item in run.recorded] == [
        Outcome.CREATED, Outcome.ALREADY_POSTED, Outcome.CREATED, Outcome.CREATED]
    assert run.posted == 3
    db.rollback()

    assert _job_ok(w["client"])["posted"] == 3
    rows = _rows(db, tablet)
    assert [r[0] for r in rows] == MONTHS
    assert [r[5] for r in rows if r[0] == date(2026, 8, 5)] == [typed]
    assert _state(db, tablet) == (date(2026, 11, 5), 20)


# --- post_plan and held months ---------------------------------------------------------------

def test_post_plan_blocks_an_unreviewed_entry(world):
    w, db = world, world["db"]
    tablet = _installment(w)

    plan = _plan(db, tablet, w["o"])
    assert (plan.blocker, plan.walk, plan.postable) == ("unreviewed", [], [])
    assert _days(plan.due) == MONTHS

    _flags(db, tablet, reviewed=False, on=True)  # no writer does this
    plan = _plan(db, tablet, w["o"])
    assert (plan.blocker, plan.walk, plan.postable) == ("unreviewed", [], [])


def test_post_plan_blocks_a_month_with_two_linked_rows(world):
    """r3.2: ``record_occurrence`` refuses a day with two linked rows, so nothing is postable."""
    w, db = world, world["db"]
    tablet = _reviewed(w)
    linked = [_txn(w, "2026-08-05", budget_entry_id=tablet) for _ in range(2)]
    before = _entry(db, tablet)

    plan = _plan(db, tablet, w["o"])
    assert (plan.blocker, plan.walk, plan.postable) == ("blocked:ambiguous", [], [])

    body = _backstop(w["client"], w["o"])
    assert (body["posted"], body["skipped"]) == (0, {"ambiguous": 1})
    assert body["entries"] == [{"entry_id": tablet, "posted": 0, "skipped_reason": "ambiguous"}]
    assert sorted(r[5] for r in _rows(db, tablet)) == sorted(linked)
    assert _entry(db, tablet) == before
    assert _state(db, tablet) == (date(2026, 7, 5), 24)


def test_held_assignment_breaks_ties_on_overlapping_windows(world, sw_people):
    """r3.1 row 7: occurrences by (day, entry id); candidates by gap, then date, then id."""
    from app.services.installment_duplicates import held_assignment, held_occurrences

    w, db = world, world["db"]
    # Order: Phone has the lower id, but Tablet's Aug 5 comes first.
    phone = _reviewed(w, name="Phone", next_day="2026-08-07")
    tablet = _reviewed(w, next_day="2026-08-05")
    aug9 = _txn(w, "2026-08-09")
    aug6 = _txn(w, "2026-08-06")
    expected = {(tablet, date(2026, 8, 5)): aug6, (phone, date(2026, 8, 7)): aug9}
    for subset in ([phone], [tablet], [phone, tablet]):
        assert held_assignment(db, _entries(db, *subset), TODAY) == expected, subset
        assert held_occurrences(db, _entries(db, *subset), TODAY) == Counter(expected.keys())

    # Gap, then date, then id: a second owner's single Tablet.
    p = sw_people("Pia", "Second")
    checking = _account(w["client"], p, "Checking", "checking", 50_000)
    card = _card(w["client"], p, checking)
    single = _reviewed(w, who=p, card=card, next_day="2026-08-05", remaining=1)
    aug7 = _txn(w, "2026-08-07", who=p, account=card)
    aug3 = _txn(w, "2026-08-03", who=p, account=card)
    p_aug6 = _txn(w, "2026-08-06", who=p, account=card)
    assert aug7 < aug3 < p_aug6
    key = (single, date(2026, 8, 5))
    assert held_assignment(db, _entries(db, single), TODAY) == {key: p_aug6}
    r = w["client"].delete(f"{API}/transactions/{p_aug6}", headers=p["headers"])
    assert r.status_code in (200, 204), r.text
    assert held_assignment(db, _entries(db, single), TODAY) == {key: aug3}
    later_aug3 = _txn(w, "2026-08-03", who=p, account=card)
    assert later_aug3 > aug3
    assert held_assignment(db, _entries(db, single), TODAY) == {key: aug3}


def test_held_assignment_is_canonical_across_callers(world, token):
    """r3 row 3: one assignment per (creator, card), whichever entries are passed."""
    from app.core.database import SessionLocal
    from app.services.installment_duplicates import held_occurrences
    from app.services.posting import post_due_installments

    w, db = world, world["db"]
    tablet = _reviewed(w)
    phone = _reviewed(w, name="Phone")
    _txn(w, "2026-08-07")
    expected = Counter({(tablet, date(2026, 8, 5)): 1})
    for subset in ([phone], [tablet, phone], [tablet]):
        assert held_occurrences(db, _entries(db, *subset), TODAY) == expected, subset

    session = SessionLocal()
    try:
        result = post_due_installments(session, through=TODAY, entry_ids=[phone])
    finally:
        session.close()
    assert (result.posted, dict(result.skipped)) == (4, {})
    assert [r[1] for r in _rows(db, phone)] == MONTHS

    body = _backstop(w["client"], w["a"])
    assert body["entries"] == [
        {"entry_id": tablet, "posted": 1, "skipped_reason": "possible_duplicate"}]
    assert [r[1] for r in _rows(db, tablet)] == [date(2026, 7, 5)]
    assert _state(db, tablet) == (date(2026, 8, 5), 23)


@pytest.mark.parametrize("caller", ["o", "e"])
def test_post_plan_matches_what_the_backstop_posts(world, caller):
    """r3 row 4, r3.1 row 1: ``len(postable)`` per entry is what the backstop posts."""
    w, db = world, world["db"]
    who = w[caller]
    held = _reviewed(w, name="Held")  # created first: the lowest id takes the candidate
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

    ids = {"Held": held, "Off": off, "Blocked": blocked, "Plain": plain, "Linked": linked}
    plans = {name: _plan(db, entry_id, who) for name, entry_id in ids.items()}
    assert {name: (p.blocker, _days(p.postable)) for name, p in plans.items()} == {
        "Held": ("held", MONTHS[:1]),
        "Off": ("auto_post_off", []),
        "Blocked": ("blocked:no_statement_cycle", []),
        "Plain": (None, MONTHS),
        "Linked": (None, [MONTHS[0], MONTHS[2], MONTHS[3]]),
    }
    assert _days(plans["Linked"].walk) == MONTHS
    assert len(plans["Linked"].due) == 3

    body = _backstop(w["client"], who)
    posted = {item["entry_id"]: item["posted"] for item in body["entries"]}
    for name, entry_id in ids.items():
        assert posted.get(entry_id, 0) == len(plans[name].postable), name
    assert body["posted"] == sum(len(p.postable) for p in plans.values()) == 8
    assert _state(db, linked) == (date(2026, 11, 5), 20)
    assert _state(db, plain) == (date(2026, 11, 5), 20)
    assert _state(db, held) == (date(2026, 8, 5), 23)
    assert _state(db, off) == _state(db, blocked) == (date(2026, 7, 5), 24)


def test_post_plan_for_a_caller_who_cannot_edit(world):
    w, db = world, world["db"]
    tablet = _reviewed(w)

    for who in ("v", "t"):
        plan = _plan(db, tablet, w[who])
        assert (plan.blocker, plan.walk, plan.postable) == ("caller_no_access", [], []), who


# --- the backstop ----------------------------------------------------------------------------

def test_backstop_roles(world):
    """Q3: owner, admin and editor post (rows owned by the creator); viewers post nothing."""
    w, db = world, world["db"]
    for who in ("o", "a", "e"):
        tablet = _reviewed(w, name=f"Tablet {who}")
        body = _backstop(w["client"], w[who], through="2026-08-01")  # ignored
        assert body == {"posted": 4, "skipped": {},
                        "entries": [{"entry_id": tablet, "posted": 4, "skipped_reason": None}]}
        assert [(r[1], r[3], r[4]) for r in _rows(db, tablet)] == [
            (m, w["o"]["id"], w[who]["id"]) for m in MONTHS]
    for who in ("v", "t"):
        tablet = _reviewed(w, name=f"Tablet {who}")
        before = _entry(db, tablet)
        assert _backstop(w["client"], w[who]) == {"posted": 0, "skipped": {}, "entries": []}
        assert _rows(db, tablet) == []
        assert _entry(db, tablet) == before


def test_backstop_rechecks_the_caller_on_the_locked_entry(world, monkeypatch):
    """r3 row 5: a demotion committed before the locks is seen on the locked entry."""
    from app.core import locking
    from app.core.database import SessionLocal
    from app.models.account import Account
    from app.services import posting

    w, db = world, world["db"]
    tablet = _reviewed(w)
    before = _entry(db, tablet)
    real = locking.lock_owner_budgets
    calls, cached = [], []

    def demote_first(session, owner_id):
        if not calls:
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

    def scope_and_cache(session, *args):
        # The request's session holds Card C and its shares from before the
        # demotion (a strong reference keeps them in its identity map).
        scope = real_scope(session, *args)
        cached.append(session.get(Account, w["card"]))
        assert [s.role for s in cached[0].shares if s.user_id == w["e"]["id"]] == ["editor"]
        return scope

    real_scope = posting._auto_post_scope
    monkeypatch.setattr(posting, "_auto_post_scope", scope_and_cache)
    monkeypatch.setattr(locking, "lock_owner_budgets", demote_first)
    body = _backstop(w["client"], w["e"])
    assert calls, "the backstop took no owner lock"
    assert (body["posted"], body["skipped"]) == (0, {"no_access": 1})
    assert body["entries"] == [{"entry_id": tablet, "posted": 0, "skipped_reason": "no_access"}]
    assert _rows(db, tablet) == []
    assert _entry(db, tablet) == before

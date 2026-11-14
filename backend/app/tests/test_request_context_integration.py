"""One request context per read (STU-598, PERF-3).

**AC4, the N+1 regressions (Sentry STU-512, STU-513, STU-531, STU-532).** Each
read below issues the same number of SQL statements with one card and one set of
recurring entries as with six of each: the per-entry reads (linked rows, forced
dates, held months, the creator's access) and the per-card reads (printed dues,
the credit groups) are made once for every record the request may walk. Before
the request context each of these grew with every entry or card.

**The shared events.** ``forecast.shared_events`` serves every list of a request
from one ``collect_events`` run over the widest window the request reads; each
list keeps the events dated before its own end. That is only right while a
longer window adds events after a shorter one's end and changes none before it,
which the last test checks against ``collect_events`` run on each window alone.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). Skips without a
database.
"""
from datetime import datetime

import pytest
from sqlalchemy import event

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2027, 3, 18, 2, 0)


def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _entry(client, who, name, account, day, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": 1_000, "cadence": "monthly",
        "next_occurrence": f"{day}T00:00:00", "account_id": account, **extra})["id"]


def _build(client, db, who, checking, numbers):
    """Per number: a card with a limit and a posted charge on a closed statement, a
    reviewed card installment with auto-post on and months due, a card subscription,
    and a cash bill with a missed month."""
    from app.models.budget_entry import BudgetEntry

    for n in numbers:
        card = _account(client, who, f"Card {n}", "credit", billing_cycle_start=3,
                        days_until_due_date=21, credit_limit=200_000,
                        payment_account_id=checking)
        sw_post(client, who, "/transactions/", {
            "account_id": card, "transaction_type": "debit", "amount": 1_000 + n,
            "description": f"Charge {n}", "transaction_date": "2027-02-20T00:00:00",
            "is_posted": True})
        plan = _entry(client, who, f"Plan {n}", card, "2027-02-10", end_mode="after_occurrences",
                      max_occurrences=12)
        _entry(client, who, f"Stream {n}", card, "2027-03-25")
        _entry(client, who, f"Bill {n}", checking, "2027-03-05")
        db.query(BudgetEntry).filter(BudgetEntry.id == plan).update(
            {"installment_reviewed_at": REF, "auto_post_enabled": True})
    db.commit()


def _statements(client, who, path):
    from app.core.database import engine

    seen = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        r = client.get(f"{API}{path}", headers=who["headers"])
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert r.status_code == 200, r.text
    return r.json(), len(seen)


def _one_then_six(client, db, who, path):
    checking = _account(client, who, "Checking", balance=500_000)
    _build(client, db, who, checking, [0])
    client.get(f"{API}{path}", headers=who["headers"])  # warm
    body_one, one = _statements(client, who, path)
    _build(client, db, who, checking, [1, 2, 3, 4, 5])
    client.get(f"{API}{path}", headers=who["headers"])
    body_six, six = _statements(client, who, path)
    return body_one, one, body_six, six


@pytest.mark.parametrize("path,shows", [
    # The snapshot: missed, installments to post, statements due, credit, card charges.
    ("/dashboard/snapshot",
     lambda body: {r["name"] for r in body["installment_auto_post"]}),
    # The Installments tab: each plan's next charge, held months and auto-post state.
    ("/budget-entries/installment-plans",
     lambda body: {r["name"] for r in body["items"]}),
    # The cards' credit: every group's rows, entries and linked rows.
    ("/cards/credit",
     lambda body: {r["account_id"] for r in body["items"]}),
    # The Transactions page's scheduled occurrences.
    ("/budget-entries/upcoming-occurrences?limit=500",
     lambda body: {r["entry_id"] for r in body["items"]}),
])
def test_reads_do_not_query_per_entry_or_card(sw_client, sw_db, sw_people, monkeypatch,
                                              path, shows):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    body_one, one, body_six, six = _one_then_six(sw_client, sw_db, me, path)
    # The read really walks every entry or card it was given.
    assert len(shows(body_one)) >= 1
    assert len(shows(body_six)) == 6 * len(shows(body_one)), (shows(body_one), shows(body_six))
    assert six == one, f"{path}: {one} statements with one of each, {six} with six"


def _same(events):
    """The events without ``event_uid``, a process-wide counter each run draws from."""
    return [{k: v for k, v in e.items() if k != "event_uid"} for e in events]


def test_shared_events_match_their_own_window(sw_client, sw_db, sw_people, monkeypatch):
    """Every list the snapshot reads from the shared run gets what ``collect_events``
    gives on its own window, origin and detail included (``event_uid`` aside: it
    only pairs an event with its rows inside one response)."""
    from app.core.context import RequestContext
    from app.models.user import User
    from app.services import forecast as fc

    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=500_000)
    _build(sw_client, sw_db, me, checking, [0, 1, 2])
    user = sw_db.get(User, me["id"])
    start, short = fc._upcoming_window(30, None)
    windows = [short, fc.cashflow_window_end(3), fc.cashflow_window_end(6)]

    ctx = RequestContext(sw_db, user)
    ctx.widen_events(windows[-1])
    for end in windows:
        shared = fc.shared_events(ctx, start, end, keep_origin=True, detail=True)
        alone = fc.collect_events(sw_db, start, end, user_id=user.id, accounts=ctx.accounts,
                                  detail=True, keep_origin=True)
        assert _same(shared) == _same(alone), end
        assert any(e.get("source") == "statement" for e in alone)  # the windows hold payables

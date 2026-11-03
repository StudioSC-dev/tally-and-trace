"""``GET /budget-entries/installment-plans`` (STU-511): one row per active card
installment the caller sees in full or shared_full, with its next unrecorded
charge, for the Transactions card's Installments tab. Skips without a database.

Reference Sunday 2026-10-18, 10:00 in Manila (T), in ``make_world``'s
household: O owns Card C; A is an admin, E an editor and V a viewer on it; T
is a tag viewer. ``next_charge`` is the first scheduled month no row stands
for, posted or pending, over the whole remaining schedule; "N of M left" is
``payments_left`` of ``payments_total``.
"""
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_installment_autopost_integration import (
    _flags, _installment, make_world, pin_clock,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

T = date(2026, 10, 18)
KEYS = {"view", "entry_id", "name", "account_name", "amount", "currency", "next_charge",
        "missed", "payments_left", "payments_total", "can_mark_paid", "auto_post",
        "block_reason", "can_review", "recordable"}


def _day(offset: int) -> str:
    return (T + timedelta(days=offset)).isoformat()


def _plans(client, who) -> dict:
    r = client.get(f"{API}/budget-entries/installment-plans", headers=who["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"items", "auto_post_scheduled", "today"}
    for item in body["items"]:
        assert set(item) == KEYS
    return body


def _plan(client, who, entry_id) -> dict:
    rows = [i for i in _plans(client, who)["items"] if i["entry_id"] == entry_id]
    assert len(rows) == 1, rows
    return rows[0]


def _set(db, entry_id, **values) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in values)
    db.execute(text(f"UPDATE budget_entries SET {sets} WHERE id = :id"),
               {**values, "id": entry_id})
    db.commit()


def _linked(db, who, account_id, entry_id, day, *, occurrence=None, posted=False) -> int:
    """A row linked to the entry, written directly: pending unless ``posted``;
    materialised (``occurrence_date`` set) when ``occurrence`` is given, else
    linked by hand."""
    from app.models.transaction import Transaction, TransactionType

    txn = Transaction(user_id=who["id"], account_id=account_id, budget_entry_id=entry_id,
                      amount=5_000, transaction_type=TransactionType.DEBIT,
                      description="Linked row", is_posted=posted,
                      transaction_date=datetime.fromisoformat(f"{day}T00:00:00"),
                      occurrence_date=(datetime.fromisoformat(f"{occurrence}T00:00:00")
                                       if occurrence else None))
    db.add(txn)
    db.commit()
    return txn.id


@pytest.fixture
def w(sw_client, sw_db, sw_people, monkeypatch):
    world = make_world(sw_client, sw_db, sw_people, monkeypatch)
    world["monkeypatch"] = monkeypatch
    return world


def _ordinary(w, name="Sofa", **kw) -> int:
    """12 in total: 2 paid before import, 10 left, next T+3; reviewed, auto-post off."""
    entry_id = _installment(w, name=name, next_day=_day(3), remaining=10,
                            occurrences_paid_offset=2, **kw)
    _flags(w["db"], entry_id, reviewed=True, on=False)
    return entry_id


def test_a_plan_reads_its_next_charge_and_n_of_m(w):
    client, o = w["client"], w["o"]
    sofa = _ordinary(w)
    body = _plans(client, o)
    assert body["today"] == T.isoformat()
    assert body["items"] == [{
        "view": "full", "entry_id": sofa, "name": "Sofa", "account_name": "Card C",
        "amount": 5000.0, "currency": "PHP", "next_charge": _day(3), "missed": 0,
        "payments_left": 10, "payments_total": 12, "can_mark_paid": True, "auto_post": "off",
        "block_reason": None, "can_review": True, "recordable": True}]


def test_an_overdue_plan_counts_its_missed_months_and_sorts_first(w):
    client, o = w["client"], w["o"]
    sofa = _ordinary(w)
    late = _installment(w, name="Late", next_day=_day(-40), remaining=6)  # Sep 8
    gone = _installment(w, name="All linked", next_day=_day(1), remaining=1)
    _flags(w["db"], gone, reviewed=True, on=False)
    _linked(w["db"], o, w["card"], gone, _day(1), occurrence=_day(1))
    zed = _ordinary(w, name="Zed")
    items = _plans(client, o)["items"]
    assert [(i["entry_id"], i["next_charge"], i["missed"]) for i in items] == [
        (late, "2026-09-08", 2),  # Sep 8 and Oct 8 are before T
        (sofa, _day(3), 0), (zed, _day(3), 0),
        (gone, None, 0)]  # every remaining month has a row: last
    assert items[0]["auto_post"] == "unreviewed" and items[0]["recordable"] is True
    assert items[-1]["recordable"] is False


def test_a_charged_month_moves_the_next_charge_on(w):
    client, o = w["client"], w["o"]
    sofa = _ordinary(w)
    r = client.post(f"{API}/budget-entries/{sofa}/materialize", json={"is_posted": False},
                    headers=o["headers"])
    assert r.status_code == 201, r.text
    plan = _plan(client, o, sofa)
    assert (plan["next_charge"], plan["payments_left"], plan["payments_total"],
            plan["recordable"]) == ("2026-11-21", 9, 12, True)


def test_a_hand_linked_row_on_the_next_occurrence_stands_for_it(w):
    client, o, db = w["client"], w["o"], w["db"]
    sofa = _ordinary(w)
    _linked(db, o, w["card"], sofa, _day(3))  # linked by hand, pending
    plan = _plan(client, o, sofa)
    # The next scheduled day; Mark paid can record only the schedule's first.
    assert (plan["next_charge"], plan["recordable"], plan["can_mark_paid"]) == (
        "2026-11-21", False, True)
    # The hand-linked row is paid in "n of m", as Allocations counts it.
    assert (plan["payments_left"], plan["payments_total"]) == (10, 13)


def test_a_far_next_charge_is_found(w):
    """A quarterly plan whose next charge is T+420: the walk covers the whole
    remaining schedule, not a fixed lookahead."""
    client, o = w["client"], w["o"]
    far = _installment(w, name="Far", next_day=_day(3), remaining=4, cadence="quarterly")
    _flags(w["db"], far, reviewed=True, on=False)
    _set(w["db"], far, next_occurrence=datetime.fromisoformat(f"{_day(420)}T00:00:00"))
    plan = _plan(client, o, far)
    assert (plan["next_charge"], plan["missed"], plan["recordable"]) == (_day(420), 0, True)


def test_linked_rows_covering_the_early_months(w):
    """4 left from T+5 (Oct 23): Oct 23, Nov 23, Dec 23 and Jan 23 by calendar
    month. With the first three linked (pending, materialised on their day) the
    next charge is Jan 23; with all four, none."""
    client, o, db = w["client"], w["o"], w["db"]
    plan_id = _installment(w, name="Phone", next_day=_day(5), remaining=4)
    _flags(db, plan_id, reviewed=True, on=False)
    months = ["2026-10-23", "2026-11-23", "2026-12-23", "2027-01-23"]
    for month in months[:3]:
        _linked(db, o, w["card"], plan_id, month, occurrence=month)
    plan = _plan(client, o, plan_id)
    assert (plan["next_charge"], plan["recordable"]) == (months[3], False)
    _linked(db, o, w["card"], plan_id, months[3], occurrence=months[3])
    plan = _plan(client, o, plan_id)
    assert (plan["next_charge"], plan["missed"], plan["recordable"]) == (None, 0, False)


def test_auto_post_on_is_not_recordable(w):
    client, o = w["client"], w["o"]
    sofa = _ordinary(w)
    _flags(w["db"], sofa, reviewed=True, on=True)
    plan = _plan(client, o, sofa)
    assert (plan["next_charge"], plan["auto_post"], plan["recordable"]) == (
        _day(3), "on", False)


def test_roles(w):
    client, db = w["client"], w["db"]
    sofa = _ordinary(w)
    eli = _plan(client, w["e"], sofa)
    assert (eli["view"], eli["can_mark_paid"], eli["recordable"], eli["can_review"]) == (
        "shared_full", True, True, True)
    ada = _plan(client, w["a"], sofa)
    assert (ada["view"], ada["can_mark_paid"]) == ("shared_full", True)
    for who in ("v", "t"):  # Limited: not listed
        assert _plans(client, w[who])["items"] == []
    db.execute(text("UPDATE account_shares SET role = 'viewer' WHERE account_id = :card "
                    "AND user_id = :e"), {"card": w["card"], "e": w["e"]["id"]})
    db.commit()
    assert _plans(client, w["e"])["items"] == []


def test_paused_finished_and_other_kinds_are_absent(w):
    client, o = w["client"], w["o"]
    sofa = _ordinary(w)
    paused = _ordinary(w, name="Paused")
    r = client.put(f"{API}/budget-entries/{paused}", json={"is_active": False},
                   headers=o["headers"])
    assert r.status_code == 200, r.text
    done = _installment(w, name="Done", next_day=_day(0), remaining=1)
    r = client.post(f"{API}/budget-entries/{done}/materialize", json={}, headers=o["headers"])
    assert r.status_code == 201, r.text
    _installment(w, name="Globe", next_day=_day(3), remaining=6, billing_kind="bill")
    sw_post(client, o, "/budget-entries/", {
        "name": "Netflix", "entry_type": "expense", "amount": 500, "cadence": "monthly",
        "next_occurrence": f"{_day(3)}T00:00:00", "account_id": w["card"]})
    sw_post(client, o, "/budget-entries/", {
        "name": "Loan", "entry_type": "expense", "amount": 500, "cadence": "monthly",
        "next_occurrence": f"{_day(3)}T00:00:00", "account_id": w["checking"],
        "end_mode": "after_occurrences", "max_occurrences": 6})
    assert [i["entry_id"] for i in _plans(client, o)["items"]] == [sofa]


def test_today_is_the_manila_day(w):
    client, o = w["client"], w["o"]
    pin_clock(w["monkeypatch"], datetime(2026, 10, 18, 15, 59))  # 23:59 in Manila
    assert _plans(client, o)["today"] == "2026-10-18"
    pin_clock(w["monkeypatch"], datetime(2026, 10, 18, 16, 1))  # 00:01 on Oct 19
    assert _plans(client, o)["today"] == "2026-10-19"


def test_occurrences_paid_on_the_entry_is_unchanged(w):
    """The paid count moved to a service (``forecast.occurrences_paid``); the
    entry routes read the same figure: linked rows plus the offset, null for an
    open-ended entry."""
    client, o, db = w["client"], w["o"], w["db"]
    sofa = _ordinary(w)
    netflix = sw_post(client, o, "/budget-entries/", {
        "name": "Netflix", "entry_type": "expense", "amount": 500, "cadence": "monthly",
        "next_occurrence": f"{_day(3)}T00:00:00", "account_id": w["card"]})["id"]

    def paid(entry_id):
        r = client.get(f"{API}/budget-entries/{entry_id}", headers=o["headers"])
        assert r.status_code == 200, r.text
        return r.json()["occurrences_paid"]

    assert (paid(sofa), paid(netflix)) == (2, None)
    _linked(db, o, w["card"], sofa, _day(-1), posted=True)
    assert paid(sofa) == 3
    r = client.get(f"{API}/budget-entries/", headers=o["headers"])
    assert r.status_code == 200, r.text
    listed = {i["id"]: i["occurrences_paid"] for i in r.json()["items"]}
    assert (listed[sofa], listed[netflix]) == (3, None)
    assert _plan(client, o, sofa)["payments_total"] == 3 + 10


def test_the_route_is_declared_before_the_entry_route(w):
    client, o = w["client"], w["o"]
    r = client.get(f"{API}/budget-entries/installment-plans")
    assert r.status_code == 401
    assert _plans(client, o)["items"] == []


def _counted(w, fn):
    """``(result, queries outside installment_infos, queries inside it)`` while ``fn`` runs."""
    from sqlalchemy import event

    from app.core.database import engine
    from app.services import missed

    counts = {"all": 0, "infos": 0}
    inside = []
    real = missed.installment_infos

    def infos(*args, **kwargs):
        inside.append(True)
        try:
            return real(*args, **kwargs)
        finally:
            inside.pop()

    def count(*_):
        counts["infos" if inside else "all"] += 1

    w["monkeypatch"].setattr(missed, "installment_infos", infos)
    event.listen(engine, "before_cursor_execute", count)
    try:
        result = fn()
    finally:
        event.remove(engine, "before_cursor_execute", count)
    return result, counts["all"], counts["infos"]


def test_plan_rows_load_in_one_pass(w):
    """The plans route's own queries do not grow with the number of plans
    (``installment_infos``, the snapshot's shared per-plan ``post_plan``, is
    counted apart), and the one batched walk lists each plan's days exactly as
    a walk of that plan alone does."""
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc

    client, o, db = w["client"], w["o"], w["db"]

    def seed(n):
        ids = []
        for i in range(n):
            cadence = ("weekly", "monthly", "quarterly", "semi_monthly")[i % 4]
            entry_id = _installment(w, name=f"Plan {len(ids)}", next_day=_day(-10 + 5 * i),
                                    remaining=2 + i, cadence=cadence)
            _linked(db, o, w["card"], entry_id, _day(-10 + 5 * i), occurrence=_day(-10 + 5 * i))
            ids.append(entry_id)
        return ids

    seed(2)
    two, two_own, _ = _counted(w, lambda: _plans(client, o))
    seed(4)
    six, six_own, six_infos = _counted(w, lambda: _plans(client, o))
    assert (len(two["items"]), len(six["items"])) == (2, 6)
    assert six_own == two_own, (two_own, six_own, six_infos)

    db.rollback()
    entries = db.query(BudgetEntry).filter(
        BudgetEntry.id.in_([i["entry_id"] for i in six["items"]])).all()
    batch = fc.unrecorded_occurrences(
        db, entries, through=max(fc.capped_schedule_end(e) for e in entries),
        pending_records=True)
    for entry in entries:
        alone = fc.unrecorded_occurrences(db, [entry], through=fc.capped_schedule_end(entry),
                                          pending_records=True)
        assert batch[entry.id] == alone[entry.id], entry.name
    assert {i["entry_id"]: i["next_charge"] for i in six["items"]} == {
        e.id: (batch[e.id][0].date().isoformat() if batch[e.id] else None) for e in entries}


def test_a_plan_ending_on_the_last_representable_day(w):
    """Monthly on the 31st from 9999-11-30 with 2 left ends on 9999-12-31
    (``date.max``): the walk through it has no next day to stop before."""
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc

    client, o, db = w["client"], w["o"], w["db"]
    edge = _installment(w, name="Edge", next_day=_day(3), remaining=2)
    _flags(db, edge, reviewed=True, on=False)
    _set(db, edge, next_occurrence=datetime(9999, 11, 30), anchor_day=31)
    db.rollback()
    entry = db.get(BudgetEntry, edge)
    assert fc.capped_schedule_end(entry) == date.max
    days = fc.unrecorded_occurrences(db, [entry], through=date.max)[edge]
    assert [d.date() for d in days] == [date(9999, 11, 30), date.max]
    plan = _plan(client, o, edge)
    assert (plan["next_charge"], plan["missed"], plan["payments_left"]) == ("9999-11-30", 0, 2)


def test_a_capped_walk_stops_at_its_last_payment(w):
    """The batched walk runs every plan through the latest schedule end; each
    plan's walk still stops at its own last payment (``capped_distinct_days``),
    so a 10-payment weekly plan beside a 360-year annual one walks 10 days, not
    every week to the year 2386."""
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc

    client, o, db = w["client"], w["o"], w["db"]
    weekly = _installment(w, name="Weekly", next_day=_day(3), remaining=10, cadence="weekly")
    annual = _installment(w, name="Annual", next_day=_day(3), remaining=360, cadence="annual")
    for entry_id in (weekly, annual):
        _flags(db, entry_id, reviewed=True, on=False)
    db.rollback()
    entries = db.query(BudgetEntry).filter(BudgetEntry.id.in_([weekly, annual])).all()

    yielded: dict = {}
    real = fc.iter_occurrences

    def counting(entry, *args, **kwargs):
        for occ in real(entry, *args, **kwargs):
            yielded[entry.id] = yielded.get(entry.id, 0) + 1
            yield occ

    w["monkeypatch"].setattr(fc, "iter_occurrences", counting)
    through = max(fc.capped_schedule_end(e) for e in entries)
    yielded.clear()
    days = fc.unrecorded_occurrences(db, entries, through=through, pending_records=True)
    assert (len(days[weekly]), len(days[annual])) == (10, 360)
    assert yielded == {weekly: 10, annual: 360}

    yielded.clear()
    plans = {i["entry_id"]: i["next_charge"] for i in _plans(client, o)["items"]}
    assert plans == {weekly: _day(3), annual: _day(3)}
    # Its schedule end, its walk, its first occurrence and the auto-post plan:
    # a few times its 10 payments, never every week to the annual plan's end.
    assert yielded.get(weekly, 0) <= 30

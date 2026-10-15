"""Historical transactions must not disturb the active budget period. Skips without a database.

A budget allocation tracks a single active period (``period_start`` .. ``period_end``)
and ``current_amount`` is what has been spent inside it. Loading or editing rows dated
before ``period_start`` (e.g. September rows imported while October is active) must
leave the period dates and the spent total alone; only deltas dated inside the active
period count.
"""
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_reachable(), reason="no database available")

API = "/api/v1"

OCT_START = datetime(2026, 10, 1)
NOV_START = datetime(2026, 11, 1)
SEPT_DAY = datetime(2026, 9, 15, 12, 0)
OCT_DAY = datetime(2026, 10, 5, 12, 0)
OCT_SPENT = Decimal("500.00")


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _auth(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def now_is(monkeypatch):
    """Pin the clock the period helpers compare against (naive UTC)."""
    import app.routers.transactions as transactions_module

    def _set(value):
        monkeypatch.setattr(transactions_module, "naive_utc_now", lambda: value)

    _set(datetime(2026, 10, 7, 9, 0))
    return _set


@pytest.fixture
def october(client, db, now_is):
    """Two October budgets with spending: one linked explicitly, one by category auto-match.

    Both start at 0 and count one posted October debit of ``OCT_SPENT``, seeded through the
    API, so their totals are backed by a ledger row. The clock is pinned to 2026-10-07 09:00
    UTC; tests that need another time call ``now_is``.
    """
    from app.models.allocation import Allocation, AllocationType, BudgetPeriodFrequency
    from app.models.category import Category
    from app.models.user import User

    headers = _auth(client)
    user = db.query(User).filter(User.email == "demo@example.com").one()
    accounts = client.get(f"{API}/accounts/", headers=headers, params={"limit": 1000}).json()["items"]
    funding = next(a for a in accounts if a["account_type"] != "credit")

    category = Category(user_id=user.id, name="Historical guard groceries")
    db.add(category)
    db.flush()

    def _budget(name, config):
        allocation = Allocation(
            user_id=user.id,
            account_id=funding["id"],
            name=name,
            allocation_type=AllocationType.BUDGET,
            current_amount=Decimal("0"),
            target_amount=Decimal("5000.00"),
            period_frequency=BudgetPeriodFrequency.MONTHLY,
            period_start=OCT_START,
            period_end=NOV_START,
            configuration=config,
        )
        db.add(allocation)
        return allocation

    explicit = _budget("Historical guard explicit", None)
    matched = _budget("Historical guard matched", {"category_ids": [category.id]})
    db.commit()

    ctx = {
        "headers": headers,
        "account_id": funding["id"],
        "category_id": category.id,
        "explicit_id": explicit.id,
        "matched_id": matched.id,
        "txn_ids": [],
        "allocation_ids": [],  # extra budgets a test makes, removed with the fixture's
        "category_ids": [],
    }
    _charge(client, ctx, datetime(2026, 10, 2, 12, 0), amount=float(OCT_SPENT))
    yield ctx

    for txn_id in ctx["txn_ids"]:
        client.delete(f"{API}/transactions/{txn_id}", headers=headers)
    db.rollback()
    db.query(Allocation).filter(
        Allocation.id.in_([explicit.id, matched.id, *ctx["allocation_ids"]])
    ).delete(synchronize_session=False)
    db.query(Category).filter(
        Category.id.in_([category.id, *ctx["category_ids"]])
    ).delete(synchronize_session=False)
    db.commit()


def _charge(client, ctx, when, amount=120.0):
    resp = client.post(
        f"{API}/transactions/",
        json={
            "account_id": ctx["account_id"],
            "category_id": ctx["category_id"],
            "allocation_id": ctx["explicit_id"],
            "amount": amount,
            "transaction_type": "debit",
            "description": "historical guard charge",
            "transaction_date": when.isoformat(),
        },
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    txn_id = resp.json()["id"]
    ctx["txn_ids"].append(txn_id)
    return txn_id


def _state(db, ctx):
    from app.models.allocation import Allocation

    db.expire_all()
    rows = db.query(Allocation).filter(Allocation.id.in_([ctx["explicit_id"], ctx["matched_id"]])).all()
    return {r.id: (r.period_start, r.period_end, Decimal(r.current_amount)) for r in rows}


def _assert_october(db, ctx, spent):
    expected = (OCT_START, NOV_START, spent)
    state = _state(db, ctx)
    assert state[ctx["explicit_id"]] == expected
    assert state[ctx["matched_id"]] == expected


def test_creating_a_september_charge_leaves_october_alone(client, db, october):
    _charge(client, october, SEPT_DAY)
    _assert_october(db, october, OCT_SPENT)


def test_editing_a_september_charge_leaves_october_alone(client, db, october):
    txn_id = _charge(client, october, SEPT_DAY)
    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"amount": 340.0, "transaction_date": datetime(2026, 9, 20, 12, 0).isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT)


def test_deleting_a_september_charge_leaves_october_alone(client, db, october):
    txn_id = _charge(client, october, SEPT_DAY)
    resp = client.delete(f"{API}/transactions/{txn_id}", headers=october["headers"])
    assert resp.status_code == 200, resp.text
    october["txn_ids"].remove(txn_id)
    _assert_october(db, october, OCT_SPENT)


def test_moving_a_september_charge_into_october_adds_it(client, db, october):
    """Into the active period: nothing to reverse (it never counted), the new delta counts."""
    txn_id = _charge(client, october, SEPT_DAY)
    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"transaction_date": OCT_DAY.isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT + Decimal("120.00"))


def test_moving_an_october_charge_into_september_removes_it(client, db, october):
    """Out of the active period: the October delta is reversed, the September one is excluded."""
    txn_id = _charge(client, october, OCT_DAY)
    _assert_october(db, october, OCT_SPENT + Decimal("120.00"))
    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"transaction_date": SEPT_DAY.isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT)


def test_october_charges_still_count(client, db, october):
    """Control: in-period create/delete keep working."""
    txn_id = _charge(client, october, OCT_DAY, amount=80.0)
    _assert_october(db, october, OCT_SPENT + Decimal("80.00"))
    resp = client.delete(f"{API}/transactions/{txn_id}", headers=october["headers"])
    assert resp.status_code == 200, resp.text
    october["txn_ids"].remove(txn_id)
    _assert_october(db, october, OCT_SPENT)


NOV_DAY = datetime(2026, 11, 10, 12, 0)
DEC_START = datetime(2026, 12, 1)


def test_a_november_charge_while_october_is_current_leaves_october_alone(client, db, october):
    """Future-dated rows are out of period: no roll-forward, no reset, no delta."""
    txn_id = _charge(client, october, NOV_DAY)
    _assert_october(db, october, OCT_SPENT)

    resp = client.put(
        f"{API}/transactions/{txn_id}",
        json={"amount": 340.0, "transaction_date": datetime(2026, 11, 12, 12, 0).isoformat()},
        headers=october["headers"],
    )
    assert resp.status_code == 200, resp.text
    _assert_october(db, october, OCT_SPENT)

    resp = client.delete(f"{API}/transactions/{txn_id}", headers=october["headers"])
    assert resp.status_code == 200, resp.text
    october["txn_ids"].remove(txn_id)
    _assert_october(db, october, OCT_SPENT)


def test_october_charges_still_count_after_a_november_row(client, db, october):
    _charge(client, october, NOV_DAY)
    _charge(client, october, OCT_DAY, amount=80.0)
    _assert_october(db, october, OCT_SPENT + Decimal("80.00"))


def test_a_november_charge_rolls_the_period_once_november_is_current(client, db, october, now_is):
    now_is(datetime(2026, 11, 3, 9, 0))
    _charge(client, october, NOV_DAY)
    state = _state(db, october)
    expected = (NOV_START, DEC_START, Decimal("120.00"))
    assert state[october["explicit_id"]] == expected
    assert state[october["matched_id"]] == expected


def _clear_period_end(db, ctx):
    from app.models.allocation import Allocation

    db.query(Allocation).filter(Allocation.id.in_([ctx["explicit_id"], ctx["matched_id"]])).update(
        {Allocation.period_end: None}, synchronize_session=False
    )
    db.commit()


def test_a_missing_period_end_is_derived_not_re_anchored(client, db, october):
    """period_start alone still pins the period: a September row stays historical."""
    _clear_period_end(db, october)
    _charge(client, october, SEPT_DAY)
    state = _state(db, october)
    expected = (OCT_START, None, OCT_SPENT)
    assert state[october["explicit_id"]] == expected
    assert state[october["matched_id"]] == expected

    _charge(client, october, OCT_DAY, amount=80.0)
    _assert_october(db, october, OCT_SPENT + Decimal("80.00"))


def _delete(client, ctx, txn_id):
    resp = client.delete(f"{API}/transactions/{txn_id}", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    ctx["txn_ids"].remove(txn_id)


def test_an_offset_date_before_the_period_in_utc_is_excluded(client, db, october):
    """2026-10-01T00:30+08:00 is 2026-09-30 16:30 UTC: historical on create and on delete."""
    when = datetime(2026, 10, 1, 0, 30, tzinfo=timezone(timedelta(hours=8)))
    txn_id = _charge(client, october, when)
    _assert_october(db, october, OCT_SPENT)
    _delete(client, october, txn_id)
    _assert_october(db, october, OCT_SPENT)


def test_an_offset_date_inside_the_period_in_utc_counts(client, db, october):
    """2026-09-30T23:30-04:00 is 2026-10-01 03:30 UTC: counted on create, reversed on delete."""
    when = datetime(2026, 9, 30, 23, 30, tzinfo=timezone(timedelta(hours=-4)))
    txn_id = _charge(client, october, when)
    _assert_october(db, october, OCT_SPENT + Decimal("120.00"))
    _delete(client, october, txn_id)
    _assert_october(db, october, OCT_SPENT)


AUG_START = datetime(2026, 8, 1)
SEPT_START = datetime(2026, 9, 1)


def _set_periods(db, ctx, periods):
    from app.models.allocation import Allocation

    for allocation_id, (start, end) in periods.items():
        db.query(Allocation).filter(Allocation.id == allocation_id).update(
            {Allocation.period_start: start, Allocation.period_end: end}, synchronize_session=False
        )
    db.commit()


def test_a_september_charge_does_not_pin_unset_or_stale_budgets_to_september(client, db, october):
    """Unset and stale (August) budgets advance to October; the September row is not counted; October's rows are."""
    _set_periods(
        db,
        october,
        {october["explicit_id"]: (None, None), october["matched_id"]: (AUG_START, SEPT_START)},
    )
    _charge(client, october, SEPT_DAY)
    _assert_october(db, october, OCT_SPENT)

    _charge(client, october, OCT_DAY, amount=80.0)
    _assert_october(db, october, OCT_SPENT + Decimal("80.00"))


def test_a_utc_plus_8_local_today_row_on_the_1st_rolls_the_period_and_counts(client, db, october, now_is):
    """04:00 on 1 Nov in UTC+8 is 20:00 on 31 Oct UTC; the frontend sends the date as 2026-11-01T00:00Z."""
    now_is(datetime(2026, 10, 31, 20, 0))
    txn_id = _charge(client, october, datetime(2026, 11, 1, tzinfo=timezone.utc))
    state = _state(db, october)
    expected = (NOV_START, DEC_START, Decimal("120.00"))
    assert state[october["explicit_id"]] == expected
    assert state[october["matched_id"]] == expected

    _delete(client, october, txn_id)
    state = _state(db, october)
    expected = (NOV_START, DEC_START, Decimal("0.00"))
    assert state[october["explicit_id"]] == expected
    assert state[october["matched_id"]] == expected


# --- STU-222: totals are recomputed from the active period's rows ---------------------------
#
# A budget's total is the sum of its owner's posted rows in the active period, recomputed
# on every write that touches it, so it never subtracts a row it never counted.

DEC_START = datetime(2026, 12, 1)
JAN_START = datetime(2027, 1, 1)


def _post(client, ctx, when, amount, *, category_id=None, allocation_id=None):
    """A posted debit with only the references given (``_charge`` carries both)."""
    resp = client.post(
        f"{API}/transactions/",
        json={
            "account_id": ctx["account_id"],
            "category_id": category_id,
            "allocation_id": allocation_id,
            "amount": amount,
            "transaction_type": "debit",
            "description": "budget recompute charge",
            "transaction_date": when.isoformat(),
        },
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    txn_id = resp.json()["id"]
    ctx["txn_ids"].append(txn_id)
    return txn_id


def _total(db, allocation_id) -> Decimal:
    from app.models.allocation import Allocation

    db.expire_all()
    return Decimal(db.get(Allocation, allocation_id).current_amount)


def _category(db, ctx, name) -> int:
    from app.models.category import Category
    from app.models.user import User

    user = db.query(User).filter(User.email == "demo@example.com").one()
    category = Category(user_id=user.id, name=name)
    db.add(category)
    db.commit()
    ctx["category_ids"].append(category.id)
    return category.id


def _make_budget(client, ctx, name, category_ids, start, end) -> int:
    resp = client.post(
        f"{API}/allocations/",
        json={
            "account_id": ctx["account_id"],
            "name": name,
            "allocation_type": "budget",
            "target_amount": 5000,
            "period_frequency": "monthly",
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "configuration": {"category_ids": category_ids},
        },
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    allocation_id = resp.json()["id"]
    ctx["allocation_ids"].append(allocation_id)
    return allocation_id


def _put_allocation(client, ctx, allocation_id, body):
    resp = client.put(f"{API}/allocations/{allocation_id}", json=body, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_a_future_row_counts_once_its_period_is_current_and_never_goes_negative(
        client, db, october, now_is):
    """Main: 50 after the roll, then -70 on the delete (and the list fails validation)."""
    nov20 = _charge(client, october, datetime(2026, 11, 20, 12, 0), amount=120.0)
    _assert_october(db, october, OCT_SPENT)

    now_is(datetime(2026, 11, 5, 9, 0))
    _charge(client, october, datetime(2026, 11, 3, 12, 0), amount=50.0)
    state = _state(db, october)
    assert state[october["explicit_id"]] == (NOV_START, DEC_START, Decimal("170.00"))
    assert state[october["matched_id"]] == (NOV_START, DEC_START, Decimal("170.00"))

    _delete(client, october, nov20)
    state = _state(db, october)
    assert state[october["explicit_id"]] == (NOV_START, DEC_START, Decimal("50.00"))
    assert state[october["matched_id"]] == (NOV_START, DEC_START, Decimal("50.00"))
    resp = client.get(f"{API}/allocations/", headers=october["headers"], params={"limit": 1000})
    assert resp.status_code == 200, resp.text


def test_adding_a_category_to_a_budget_counts_its_rows(client, db, october):
    """Main: 500 after the PUT, then 300 on the delete."""
    dining = _category(db, october, "Recompute dining")
    row = _post(client, october, OCT_DAY, 200.0, category_id=dining)
    assert _total(db, october["matched_id"]) == OCT_SPENT

    _put_allocation(client, october, october["matched_id"],
                    {"configuration": {"category_ids": [october["category_id"], dining]}})
    assert _total(db, october["matched_id"]) == OCT_SPENT + Decimal("200.00")

    _delete(client, october, row)
    assert _total(db, october["matched_id"]) == OCT_SPENT


def test_moving_a_period_start_back_counts_the_rows_it_now_covers(client, db, october):
    """The period becomes [Sep 1, Nov 1): period_end is kept. Main: 500, then 200."""
    row = _charge(client, october, datetime(2026, 9, 25, 12, 0), amount=300.0)
    _assert_october(db, october, OCT_SPENT)

    _put_allocation(client, october, october["explicit_id"], {"period_start": SEPT_START.isoformat()})
    state = _state(db, october)
    assert state[october["explicit_id"]] == (SEPT_START, NOV_START, OCT_SPENT + Decimal("300.00"))

    _delete(client, october, row)
    state = _state(db, october)
    assert state[october["explicit_id"]] == (SEPT_START, NOV_START, OCT_SPENT)


def test_a_row_matching_a_budget_twice_counts_once(client, db, october):
    """Guard: by allocation_id and by a configured category, the row counts once."""
    second = _category(db, october, "Recompute second groceries")
    _put_allocation(client, october, october["explicit_id"],
                    {"configuration": {"category_ids": [october["category_id"], second]}})
    assert _total(db, october["explicit_id"]) == OCT_SPENT

    _post(client, october, OCT_DAY, 100.0, category_id=second,
          allocation_id=october["explicit_id"])
    assert _total(db, october["explicit_id"]) == OCT_SPENT + Decimal("100.00")


def test_a_period_that_has_not_started_totals_zero_until_it_starts(client, db, october, now_is):
    """Main: 0 after the rename (nothing recomputes it)."""
    first = _make_budget(client, october, "Recompute future one", [october["category_id"]],
                         DEC_START, JAN_START)
    _post(client, october, datetime(2026, 12, 5, 12, 0), 120.0, category_id=october["category_id"])
    assert _total(db, first) == Decimal("0")

    second = _make_budget(client, october, "Recompute future two", [october["category_id"]],
                          DEC_START, JAN_START)
    assert _total(db, second) == Decimal("0")

    now_is(datetime(2026, 11, 30, 12, 0))  # Dec 1 00:00 is within the 14 h horizon
    _put_allocation(client, october, first, {"name": "Recompute future one renamed"})
    assert _total(db, first) == Decimal("120.00")

    _post(client, october, datetime(2026, 12, 6, 12, 0), 30.0, category_id=october["category_id"])
    assert _total(db, first) == Decimal("150.00")


def test_an_out_of_period_row_still_recomputes_a_drifted_total(client, db, october):
    """Main leaves the drifted 999: the September row is excluded, so nothing changes."""
    from app.models.allocation import Allocation

    db.query(Allocation).filter(Allocation.id == october["explicit_id"]).update(
        {Allocation.current_amount: Decimal("999.00")}, synchronize_session=False)
    db.commit()

    _charge(client, october, SEPT_DAY)
    assert _total(db, october["explicit_id"]) == OCT_SPENT


def test_moving_a_row_between_categories_keeps_both_budgets_right(client, db, october):
    """Guard (passes on main). No allocation is read after the first total is written."""
    from sqlalchemy import event

    from app.core.database import engine as app_engine

    travel = _category(db, october, "Recompute travel")
    travel_budget = _make_budget(client, october, "Recompute travel budget", [travel],
                                 OCT_START, NOV_START)
    row = _post(client, october, OCT_DAY, 200.0, category_id=travel)
    assert _total(db, travel_budget) == Decimal("200.00")

    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(" ".join(statement.split()))

    event.listen(app_engine, "before_cursor_execute", record)
    try:
        resp = client.put(f"{API}/transactions/{row}", json={"category_id": october["category_id"]},
                          headers=october["headers"])
    finally:
        event.remove(app_engine, "before_cursor_execute", record)
    assert resp.status_code == 200, resp.text

    assert _total(db, october["matched_id"]) == OCT_SPENT + Decimal("200.00")
    assert _total(db, travel_budget) == Decimal("0")
    first_write = next((i for i, s in enumerate(statements)
                        if s.startswith("UPDATE allocations")), len(statements))
    late_reads = [s for s in statements[first_write:]
                  if s.startswith("SELECT") and "FROM allocations" in s]
    assert late_reads == [], late_reads


# --- STU-222: budget membership changes are serialised per owner ----------------------------
#
# A configuration change and a transaction write for the same owner take the owner's
# advisory lock first, so neither can discover budgets from a state the other is about
# to change. The negative control patches the lock out (every caller reaches it through
# ``app.core.locking``) and shows the race then loses the row.

RACE_PROBE_DEADLINE = 10
RACE_JOIN_TIMEOUT = 20


def _race_worker(fn):
    import threading

    outcome = {}

    def run():
        try:
            outcome["result"] = fn()
        except BaseException as exc:  # recorded, re-raised in the test thread
            outcome["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    return thread, outcome


def _blocked_on(holder_pid, thread) -> bool:
    """Whether a backend waits on ``holder_pid`` before the deadline (one transaction per poll)."""
    import time

    engine = create_engine(os.environ["DATABASE_URL"])
    deadline = time.monotonic() + RACE_PROBE_DEADLINE
    try:
        with engine.connect() as probe:
            while True:
                waiting = probe.execute(text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE pg_blocking_pids(pid) @> ARRAY[CAST(:holder AS integer)]"),
                    {"holder": holder_pid}).scalar()
                probe.rollback()
                if waiting or not thread.is_alive() or time.monotonic() > deadline:
                    return bool(waiting)
                time.sleep(0.05)
    finally:
        engine.dispose()


def _race_against(session, serialised, fn):
    """Run ``fn`` in a worker while ``session`` holds its uncommitted write, then commit it.

    Serialised, the worker must wait on the session before it commits. Without the
    owner lock nothing makes it wait, so it must finish on its own while the session
    is still open (no probe: it could only run into its deadline).
    """
    thread, outcome = _race_worker(fn)
    holder_pid = session.execute(text("SELECT pg_backend_pid()")).scalar()
    try:
        thread.start()
        if serialised:
            assert _blocked_on(holder_pid, thread), ("the worker did not wait on the holder", outcome)
        else:
            thread.join(RACE_PROBE_DEADLINE)
            assert not thread.is_alive(), "the worker waited although nothing serialises it"
            assert "error" not in outcome, outcome
        session.commit()
    finally:
        session.rollback()  # a no-op once committed
        thread.join(RACE_JOIN_TIMEOUT)
    assert not thread.is_alive(), "the worker did not finish"
    if "error" in outcome:
        raise outcome["error"]
    return outcome["result"]


@pytest.fixture
def unserialised(monkeypatch):
    """Patch the owner lock out for every caller (they reach it through the module)."""
    from app.core import locking

    def patch(serialised):
        if not serialised:
            monkeypatch.setattr(locking, "lock_owner_budgets", lambda db, owner_id: None)

    return patch


@pytest.mark.parametrize("serialised", [True, False])
def test_a_charge_racing_a_budget_config_change_is_counted(client, db, october, unserialised,
                                                          serialised):
    """Config first. Without the lock the charge discovers the old config and is lost (500)."""
    from app.core.database import SessionLocal
    from app.models.allocation import Allocation
    from app.models.user import User
    from app.routers.allocations import apply_allocation_update

    unserialised(serialised)
    dining = _category(db, october, "Race dining")
    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "demo@example.com").one()
        apply_allocation_update(
            session, user, session.get(Allocation, october["matched_id"]),
            {"configuration": {"category_ids": [october["category_id"], dining]}})
        assert Decimal(session.get(Allocation, october["matched_id"]).current_amount) == OCT_SPENT

        _race_against(session, serialised,
                      lambda: _post(client, october, OCT_DAY, 200.0, category_id=dining))
    finally:
        session.rollback()
        session.close()

    expected = OCT_SPENT + Decimal("200.00") if serialised else OCT_SPENT
    assert _total(db, october["matched_id"]) == expected


@pytest.mark.parametrize("serialised", [True, False])
def test_a_budget_config_change_racing_a_charge_counts_it(client, db, october, unserialised,
                                                         serialised):
    """Transaction first. Without the lock the recompute skips the uncommitted row (500)."""
    from app.core.database import SessionLocal
    from app.models.user import User
    from app.routers.transactions import add_transaction
    from app.schemas.transaction import TransactionCreate

    unserialised(serialised)
    dining = _category(db, october, "Race dining")
    session = SessionLocal()
    try:
        user = session.query(User).filter(User.email == "demo@example.com").one()
        txn = add_transaction(session, user, TransactionCreate(
            account_id=october["account_id"], category_id=dining, amount=200.0,
            transaction_type="debit", description="race charge", transaction_date=OCT_DAY))
        session.flush()
        txn_id = txn.id

        r = _race_against(session, serialised, lambda: client.put(
            f"{API}/allocations/{october['matched_id']}",
            json={"configuration": {"category_ids": [october["category_id"], dining]}},
            headers=october["headers"]))
        october["txn_ids"].append(txn_id)
    finally:
        session.rollback()
        session.close()

    assert r.status_code == 200, r.text
    expected = OCT_SPENT + Decimal("200.00") if serialised else OCT_SPENT
    assert _total(db, october["matched_id"]) == expected

"""Budget envelopes: accounts, carry-over, stored periods, history and counted rows (STU-795).

A budget needs no account; ``configuration.account_ids`` (the owner's own accounts)
narrows what it counts, empty or absent meaning every account. Each window a budget
rolls past is stored in ``budget_periods`` with the limit, currency and carry chain
it ran with; ``GET /allocations/{id}/periods`` shows the current window and the last
11 before it (estimated ones generated back to fill 12), and
``GET /allocations/{id}/transactions`` the rows one window counts. Carry-over
(``carry_over`` on create and update, ``carry_over_from`` on the allocation) runs
within one chain of windows.

The clock is pinned per test (``pin_clock``), and moved forward to roll. Rates: the
test store has PHP and USD (58.00 PHP per USD) and no EUR. Skips without a database.
"""
import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import IntegrityError

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.fixtures.realistic import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

UTC = timezone.utc
PERIOD_FIELDS = {"start", "end", "limit", "carry_in", "available", "spent", "remaining",
                 "complete", "missing", "provisional", "inherited_missing", "estimated",
                 "before_created", "is_current"}
PAGE_FIELDS = {"items", "total", "has_more", "currency_subtotals", "converted_total"}
CURRENT_FIELDS = {"carry_over_from", "carry_in", "available", "complete", "missing",
                  "provisional", "inherited_missing"}


def at(y, m, d, h=0, minute=0):
    """Naive UTC, as the pinned clock and the stored windows are."""
    return datetime(y, m, d, h, minute)


def utc(y, m, d, h=0):
    return datetime(y, m, d, h, tzinfo=UTC)


def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert parsed.utcoffset() == timedelta(0), value  # an explicit UTC offset
    return parsed


# --- the world ----------------------------------------------------------------------------------

def _account(client, who, name, currency="PHP", kind="checking"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": kind, "balance": 100_000, "currency": currency})["id"]


def _category(client, who, name, kind="expense"):
    return sw_post(client, who, "/categories/", {"name": name, "kind": kind})["id"]


@pytest.fixture
def env(sw_client, sw_db, sw_people, monkeypatch):
    def clock(when):
        pin_clock(monkeypatch, when)

    clock(at(2026, 1, 10, 3))
    me = sw_people()
    return SimpleNamespace(
        client=sw_client, db=sw_db, me=me, people=sw_people, clock=clock,
        bank=_account(sw_client, me, "Bank"),
        wallet=_account(sw_client, me, "Wallet", kind="savings"),
        usd=_account(sw_client, me, "Dollars", "USD"),
        eur=_account(sw_client, me, "Euros", "EUR"),
        food=_category(sw_client, me, "Food"),
        fuel=_category(sw_client, me, "Fuel"))


def _call(w, method, path, expect=200, who=None, **kwargs):
    r = w.client.request(method, f"{API}{path}", headers=(who or w.me)["headers"], **kwargs)
    assert r.status_code == expect, (path, r.status_code, r.text)
    return r.json()


def _create(w, expect=200, who=None, **body):
    data = {"name": "Groceries", "allocation_type": "budget", "period_frequency": "monthly",
            "configuration": {"category_ids": [w.food]}, "target_amount": 1000, **body}
    return _call(w, "POST", "/allocations/", expect, who, json=data)


def _put(w, allocation_id, body, expect=200):
    return _call(w, "PUT", f"/allocations/{allocation_id}", expect, json=body)


def _get(w, allocation_id, expect=200, who=None):
    return _call(w, "GET", f"/allocations/{allocation_id}", expect, who)


def _periods(w, allocation_id, expect=200, who=None):
    return _call(w, "GET", f"/allocations/{allocation_id}/periods", expect, who)


def _page(w, allocation_id, expect=200, who=None, **params):
    return _call(w, "GET", f"/allocations/{allocation_id}/transactions", expect, who,
                 params=params)


def _row(w, account, day, amount, kind="debit", category="food", allocation=None,
         posted=True, who=None):
    body = {"account_id": account, "transaction_type": kind, "amount": amount,
            "description": f"{kind} {amount}", "transaction_date": day.isoformat(),
            "is_posted": posted,
            "category_id": getattr(w, category) if isinstance(category, str) else category}
    if allocation is not None:
        body["allocation_id"] = allocation
    return sw_post(w.client, who or w.me, "/transactions/", body)["id"]


def _stored(w, allocation_id):
    """The stored windows: (start, end, limit, currency, carry_from), oldest first."""
    rows = w.db.execute(text(
        'SELECT start, "end", "limit", currency::text, carry_from FROM budget_periods '
        "WHERE allocation_id = :a ORDER BY start"), {"a": allocation_id}).all()
    w.db.rollback()
    return [tuple(r) for r in rows]


def _stored_total(w, allocation_id):
    """The total the last write stored on the allocation."""
    value = w.db.execute(text("SELECT current_amount FROM allocations WHERE id = :a"),
                         {"a": allocation_id}).scalar_one()
    w.db.rollback()
    return Decimal(value)


def _windows(periods):
    return [(_instant(p["start"]), _instant(p["end"])) for p in periods]


def _assert_contiguous(periods):
    """Newest first, each window ending where the newer one starts: no overlap, no gap."""
    spans = _windows(periods)
    for newer, older in zip(spans, spans[1:]):
        assert older[0] < older[1] == newer[0] < newer[1], (older, newer)


# --- accounts -----------------------------------------------------------------------------------

def test_budget_account_is_optional_and_legacy_account_is_stored(env):
    w = env
    bare = _create(w)
    assert bare["account_id"] is None
    legacy = _create(w, account_id=w.bank)
    assert legacy["account_id"] == w.bank
    # The stored account filters nothing: a row on another account counts.
    _row(w, w.wallet, at(2026, 1, 5), 120)
    _row(w, w.bank, at(2026, 1, 6), 30)
    for budget in (bare, legacy):
        assert _get(w, budget["id"])["current_amount"] == 150.0
        assert _stored_total(w, budget["id"]) == Decimal("150.00")
    assert _get(w, legacy["id"])["account_id"] == w.bank


def test_budget_account_selection_requires_owned_accounts(env):
    w = env
    other = w.people()
    theirs = _account(w.client, other, "Theirs")
    shared = _account(w.client, other, "Shared with me")
    sw_share(w.db, shared, w.me["id"], "editor", other["id"])

    def config(ids):
        return {"category_ids": [w.food], "account_ids": ids}

    # The same refusal savings gives an account that isn't the caller's own.
    for account in (theirs, shared):
        savings = w.client.post(f"{API}/allocations/", headers=w.me["headers"], json={
            "name": "Fund", "allocation_type": "savings", "target_amount": 100,
            "configuration": {"goal_mode": "multi_account", "account_ids": [account]}})
        assert savings.status_code in (403, 404), savings.text
        _create(w, expect=savings.status_code, configuration=config([account]))
    _create(w, expect=400, configuration=config(["not-an-id"]))
    _create(w, expect=422, configuration=config(str(w.bank)))

    selected = _create(w, configuration=config([w.bank]))
    assert selected["configuration"]["account_ids"] == [w.bank]
    every = _create(w, configuration=config([]))
    absent = _create(w)
    _row(w, w.bank, at(2026, 1, 3), 100)
    _row(w, w.wallet, at(2026, 1, 4), 40)
    assert _get(w, selected["id"])["current_amount"] == 100.0
    assert _get(w, every["id"])["current_amount"] == 140.0
    assert _get(w, absent["id"])["current_amount"] == 140.0
    # An edit naming another user's account is refused the same way.
    status = w.client.put(f"{API}/allocations/{selected['id']}", headers=w.me["headers"],
                          json={"configuration": config([theirs])}).status_code
    assert status in (403, 404)
    assert _get(w, selected["id"])["configuration"]["account_ids"] == [w.bank]


def test_budget_membership_matches_on_reads_and_writes(env):
    from app.core.database import SessionLocal
    from app.models.transaction import Transaction, TransactionType
    from app.services.installment_redate import redate_row

    w = env
    budget = _create(w, configuration={"category_ids": [w.food], "account_ids": [w.bank]})
    bid = budget["id"]
    match = _row(w, w.bank, at(2026, 1, 3), 100)                       # counts
    _row(w, w.wallet, at(2026, 1, 4), 50)                              # an excluded account
    _row(w, w.wallet, at(2026, 1, 5), 30, category="fuel", allocation=bid)  # linked: counts
    _row(w, w.bank, at(2026, 1, 6), 20, kind="credit")                 # a refund: subtracts
    _row(w, w.bank, at(2026, 1, 7), 70, category="fuel")               # another category
    _row(w, w.bank, at(2026, 1, 8), 90, posted=False)                  # not posted
    # Another user's posted row on the selected account, in the category: not the owner's.
    partner = w.people()
    w.db.add(Transaction(user_id=partner["id"], account_id=w.bank, category_id=w.food,
                         transaction_type=TransactionType.DEBIT, amount=500,
                         description="Theirs", transaction_date=at(2026, 1, 2),
                         is_posted=True))
    w.db.commit()

    def agree(expected):
        assert _stored_total(w, bid) == Decimal(expected)
        assert _get(w, bid)["current_amount"] == float(expected)
        assert _periods(w, bid)[0]["spent"] == float(expected)
        assert _page(w, bid)["converted_total"] == float(expected)

    agree("110.00")
    # A category match moved to an excluded account and back: each write recomputes.
    _call(w, "PUT", f"/transactions/{match}", json={"account_id": w.wallet})
    agree("10.00")
    _call(w, "PUT", f"/transactions/{match}", json={"account_id": w.bank})
    agree("110.00")

    # Two posted instalments from the last window, one on each kind of account, redated
    # into this one: only the selected account's counts, at the new date and the old.
    ids = []
    for account in (w.bank, w.wallet):
        row = Transaction(user_id=w.me["id"], account_id=account, category_id=w.food,
                          transaction_type=TransactionType.DEBIT, amount=40,
                          description="Instalment", transaction_date=at(2025, 12, 28),
                          is_posted=True)
        w.db.add(row)
        w.db.commit()
        ids.append(row.id)
    for day in (at(2026, 1, 2), at(2025, 12, 29)):
        for txn_id in ids:
            session = SessionLocal()
            try:
                redate_row(session, session.get(Transaction, txn_id), day)
                session.commit()
            finally:
                session.close()
        agree("150.00" if day.year == 2026 else "110.00")


def test_budget_account_selection_is_preserved_or_cleared(env):
    w = env
    budget = _create(w, configuration={"category_ids": [w.food], "account_ids": [w.bank]})
    bid = budget["id"]
    _row(w, w.bank, at(2026, 1, 3), 100)
    _row(w, w.wallet, at(2026, 1, 4), 40)

    # Omitted: kept.
    assert _put(w, bid, {"name": "Renamed"})["configuration"]["account_ids"] == [w.bank]
    # No account_ids key: kept.
    body = _put(w, bid, {"configuration": {"category_ids": [w.food]}})
    assert body["configuration"] == {"category_ids": [w.food], "account_ids": [w.bank]}
    assert body["current_amount"] == 100.0
    # Null: the selection is kept (null configuration otherwise clears it, as before).
    assert _put(w, bid, {"configuration": None})["configuration"] == {"account_ids": [w.bank]}
    _put(w, bid, {"configuration": {"category_ids": [w.food]}})
    # An old client sending account_id: stored, and the selection and filter unchanged.
    body = _put(w, bid, {"account_id": w.wallet})
    assert body["account_id"] == w.wallet
    assert body["configuration"]["account_ids"] == [w.bank]
    assert body["current_amount"] == 100.0
    # A null account_ids is a 422, changing nothing.
    _put(w, bid, {"configuration": {"category_ids": [w.food], "account_ids": None}},
         expect=422)
    assert _get(w, bid)["configuration"]["account_ids"] == [w.bank]
    # An empty list clears it: every account counts.
    body = _put(w, bid, {"configuration": {"category_ids": [w.food], "account_ids": []}})
    assert body["configuration"]["account_ids"] == []
    assert body["current_amount"] == 140.0
    assert _stored_total(w, bid) == Decimal("140.00")


def test_allocation_list_filters_on_stored_legacy_account(env):
    w = env
    legacy = _create(w, account_id=w.bank,
                     configuration={"category_ids": [w.food], "account_ids": [w.wallet]})
    _create(w, configuration={"category_ids": [w.food], "account_ids": [w.bank]})
    listed = _call(w, "GET", "/allocations/", params={"account_id": w.bank})["items"]
    assert [a["id"] for a in listed] == [legacy["id"]]


# --- carry-over ---------------------------------------------------------------------------------

def test_budget_carry_toggle_and_reset(env):
    w = env
    budget = _create(w)
    bid = budget["id"]
    assert budget["carry_over_from"] is None  # off by default
    _row(w, w.bank, at(2026, 1, 5), 200)

    # Switched on late, in February: from February's start, after January is closed.
    w.clock(at(2026, 2, 10, 3))
    assert _put(w, bid, {"carry_over": True})["carry_over_from"] == "2026-02-01T00:00:00"
    assert _stored(w, bid) == [(at(2026, 1, 1), at(2026, 2, 1), Decimal("1000.00"), "PHP",
                                None)]
    assert _get(w, bid)["carry_in"] == 0.0  # never reaches back before it was switched on
    _row(w, w.bank, at(2026, 2, 3), 300)

    w.clock(at(2026, 3, 10, 3))
    body = _get(w, bid)
    assert (body["carry_in"], body["available"]) == (700.0, 1700.0)
    # True again while on keeps the chain.
    body = _put(w, bid, {"carry_over": True})
    assert body["carry_over_from"] == "2026-02-01T00:00:00" and body["carry_in"] == 700.0
    # False clears it.
    body = _put(w, bid, {"carry_over": False})
    assert body["carry_over_from"] is None
    assert (body["carry_in"], body["available"]) == (0.0, 1000.0)
    # On again in the same window: a new chain, its carry-in reset to 0.
    body = _put(w, bid, {"carry_over": True})
    assert body["carry_over_from"] == "2026-03-01T00:00:00" and body["carry_in"] == 0.0
    # Omitted on update: unchanged.
    assert _put(w, bid, {"name": "Food"})["carry_over_from"] == "2026-03-01T00:00:00"
    # The closed periods are kept, with the chain each ran in.
    assert [(s, cf) for s, _, _, _, cf in _stored(w, bid)] == [
        (at(2026, 1, 1), None), (at(2026, 2, 1), at(2026, 2, 1))]

    w.clock(at(2026, 4, 10, 3))
    periods = _periods(w, bid)
    assert periods[0]["carry_in"] == 1000.0  # March's whole limit, not February's
    assert [p["carry_in"] for p in periods[1:4]] == [0.0, 0.0, 0.0]

    # Ignored for other types.
    savings = _call(w, "POST", "/allocations/", json={
        "name": "Fund", "allocation_type": "savings", "target_amount": 100, "carry_over": True,
        "configuration": {"goal_mode": "transaction_total"}})
    assert savings["carry_over_from"] is None
    assert _put(w, savings["id"], {"carry_over": True})["carry_over_from"] is None


def test_budget_carry_requires_a_limit(env):
    w = env
    # Create: carry needs a limit; a zero limit is one; so is monthly_target alone.
    _create(w, expect=422, target_amount=None, carry_over=True)
    zero = _create(w, target_amount=0, carry_over=True, period_start="2026-01-01T00:00:00")
    assert zero["carry_over_from"] == "2026-01-01T00:00:00"
    monthly = _create(w, target_amount=None, monthly_target=300, carry_over=True)
    assert monthly["carry_over_from"] == "2026-01-01T00:00:00"

    on = _create(w, target_amount=500, carry_over=True)
    bid = on["id"]
    # Clearing the last limit with carry true: 422, nothing changed, carry still on.
    _put(w, bid, {"target_amount": None, "carry_over": True}, expect=422)
    body = _get(w, bid)
    assert (body["target_amount"], body["carry_over_from"]) == (500.0, "2026-01-01T00:00:00")
    # Moving the limit to monthly_target keeps carry.
    body = _put(w, bid, {"target_amount": None, "monthly_target": 200, "carry_over": True})
    assert body["carry_over_from"] == "2026-01-01T00:00:00" and body["available"] == 200.0
    # Clearing the last limit with carry omitted clears it.
    body = _put(w, bid, {"monthly_target": None})
    assert body["carry_over_from"] is None and body["available"] is None
    # Carry true on a budget with no limit is a 422.
    _put(w, bid, {"carry_over": True}, expect=422)
    assert _get(w, bid)["carry_over_from"] is None

    other = _create(w, target_amount=500, carry_over=True)
    # ... and with carry false.
    body = _put(w, other["id"], {"target_amount": None, "carry_over": False})
    assert body["carry_over_from"] is None


def test_budget_currency_change_with_history_is_rejected(env):
    w = env
    # Started in November: creating it closes November and December.
    budget = _create(w, period_start="2025-11-01T00:00:00")
    assert len(_stored(w, budget["id"])) == 2
    _put(w, budget["id"], {"currency": "USD"}, expect=422)
    assert _get(w, budget["id"])["currency"] == "PHP"
    assert _put(w, budget["id"], {"currency": "PHP"})["currency"] == "PHP"  # no change
    fresh = _create(w)
    assert _put(w, fresh["id"], {"currency": "USD"})["currency"] == "USD"


def test_budget_type_changes_preserve_history_and_currency(env):
    w = env
    budget = _create(w, period_start="2025-12-01T00:00:00", carry_over=True)
    bid = budget["id"]
    assert budget["carry_over_from"] == "2026-01-01T00:00:00"
    w.clock(at(2026, 2, 10, 3))
    _get(w, bid)  # closes January, in the chain
    history = _stored(w, bid)
    assert [(s, cf) for s, _, _, _, cf in history] == [
        (at(2025, 12, 1), None), (at(2026, 1, 1), at(2026, 1, 1))]

    savings = {"allocation_type": "savings", "configuration": {"goal_mode": "transaction_total"}}
    # A type change and a currency change together are refused.
    _put(w, bid, {**savings, "currency": "USD"}, expect=422)
    body = _put(w, bid, savings)
    assert body["allocation_type"] == "savings" and body["carry_over_from"] is None
    assert _stored(w, bid) == history
    # Still a 422 after the type change.
    _put(w, bid, {"currency": "USD"}, expect=422)
    back = {"allocation_type": "budget", "configuration": {"category_ids": [w.food]}}
    # Back to budget: the currency guard and the date guard both hold.
    _put(w, bid, {**back, "currency": "USD"}, expect=422)
    _put(w, bid, {**back, "period_start": "2026-01-15T00:00:00"}, expect=422)
    assert _get(w, bid)["allocation_type"] == "savings"
    # Back to budget: carry starts off.
    body = _put(w, bid, back)
    assert body["allocation_type"] == "budget" and body["carry_over_from"] is None
    assert _stored(w, bid) == history
    assert _put(w, bid, savings)["carry_over_from"] is None
    # ... unless the request turns it on.
    body = _put(w, bid, {**back, "carry_over": True})
    assert body["carry_over_from"] == "2026-02-01T00:00:00"
    assert _stored(w, bid) == history


# --- stored periods -----------------------------------------------------------------------------

def test_budget_period_constraints_and_cascade(env):
    w = env
    budget = _create(w, period_start="2025-11-01T00:00:00")
    bid = budget["id"]
    columns = {name: (kind, nullable) for name, kind, nullable in w.db.execute(text(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'budget_periods'")).all()}
    assert columns == {
        "id": ("integer", "NO"), "allocation_id": ("integer", "NO"),
        "start": ("timestamp without time zone", "NO"),
        "end": ("timestamp without time zone", "NO"), "limit": ("numeric", "YES"),
        "currency": ("USER-DEFINED", "NO"),
        "carry_from": ("timestamp without time zone", "YES"),
        "created_at": ("timestamp with time zone", "NO")}
    carry = w.db.execute(text(
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'allocations' AND column_name = 'carry_over_from'")).one()
    assert tuple(carry) == ("timestamp without time zone", "YES")
    assert w.db.execute(text(
        "SELECT confdeltype FROM pg_constraint WHERE conname = "
        "'fk_budget_periods_allocation_id_allocations'")).scalar_one() == "c"
    w.db.rollback()

    with pytest.raises(IntegrityError):
        w.db.execute(text(
            'INSERT INTO budget_periods (allocation_id, start, "end", currency) '
            "VALUES (:a, '2025-11-01', '2025-12-01', 'PHP')"), {"a": bid})
    w.db.rollback()
    assert len(_stored(w, bid)) == 2

    # The API's delete is soft: the periods stay. Removing the row removes them.
    _call(w, "DELETE", f"/allocations/{bid}")
    assert len(_stored(w, bid)) == 2
    w.db.execute(text("DELETE FROM allocations WHERE id = :a"), {"a": bid})
    w.db.commit()
    assert _stored(w, bid) == []


def test_budget_roll_stores_each_elapsed_window_once(env):
    from app.core.database import SessionLocal
    from app.models.allocation import Allocation
    from app.services import budget_periods

    w = env
    # A quarterly budget; the clock skips a whole quarter, and two reads roll at once.
    w.clock(at(2025, 2, 1, 3))
    quarterly = _create(w, period_frequency="quarterly")["id"]
    w.clock(at(2025, 10, 5, 3))
    barrier, errors = threading.Barrier(2), []

    def read():
        session = SessionLocal()
        try:
            allocation = session.get(Allocation, quarterly)
            barrier.wait(5)
            budget_periods.roll_for_read(session, [allocation])
        except BaseException as exc:  # pragma: no cover - reported below
            errors.append(exc)
        finally:
            session.close()

    threads = [threading.Thread(target=read) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert errors == []
    assert [(s, e) for s, e, *_ in _stored(w, quarterly)] == [
        (at(2025, 1, 1), at(2025, 4, 1)), (at(2025, 4, 1), at(2025, 7, 1)),
        (at(2025, 7, 1), at(2025, 10, 1))]
    assert _periods(w, quarterly)[0]["start"] == "2025-10-01T00:00:00Z"
    assert len(_stored(w, quarterly)) == 3

    # Every window is kept, beyond the 12 shown and with carry off.
    w.clock(at(2026, 1, 1, 3))
    daily = _create(w, period_frequency="daily")["id"]
    w.clock(at(2026, 1, 21, 3))
    assert len(_periods(w, daily)) == 12
    stored = _stored(w, daily)
    assert [s for s, *_ in stored] == [at(2026, 1, d) for d in range(1, 21)]
    assert {cf for *_, cf in stored} == {None}

    # The early roll: a row dated in February, within now + 14 h, advances the window and
    # stores January although it hasn't ended in UTC; a later read keeps February.
    w.clock(at(2026, 1, 31, 12))
    early = _create(w)["id"]
    _row(w, w.bank, at(2026, 2, 1), 80)
    assert _stored(w, early) == [(at(2026, 1, 1), at(2026, 2, 1), Decimal("1000.00"), "PHP",
                                  None)]
    periods = _periods(w, early)
    assert (periods[0]["start"], periods[0]["spent"]) == ("2026-02-01T00:00:00Z", 80.0)
    assert periods[1]["start"] == "2026-01-01T00:00:00Z" and not periods[1]["estimated"]
    assert _get(w, early)["period_start"] == "2026-02-01T00:00:00"


def test_read_roll_racing_an_edit_keeps_the_edit(env):
    from app.core.database import SessionLocal
    from app.models.allocation import Allocation
    from app.models.user import User
    from app.routers.allocations import apply_allocation_update
    from app.services import budget_periods

    w = env
    bid = _create(w, target_amount=500)["id"]
    w.clock(at(2026, 2, 10, 3))
    reader = SessionLocal()
    editor = SessionLocal()
    try:
        stale = reader.get(Allocation, bid)  # read before the edit: still January
        holding, errors = threading.Event(), []

        def edit():
            try:
                apply_allocation_update(editor, editor.get(User, w.me["id"]),
                                        editor.get(Allocation, bid),
                                        {"name": "Edited", "target_amount": 900})
                holding.set()
                time.sleep(0.5)
                editor.commit()
            except BaseException as exc:  # pragma: no cover - reported below
                errors.append(exc)
                holding.set()

        thread = threading.Thread(target=edit)
        thread.start()
        assert holding.wait(10)
        started = time.monotonic()
        budget_periods.roll_for_read(reader, [stale])
        waited = time.monotonic() - started
        thread.join(10)
        assert errors == []
        assert waited >= 0.3  # the read's roll waited for the edit's lock
    finally:
        reader.close()
        editor.close()
    body = _get(w, bid)
    assert (body["name"], body["target_amount"]) == ("Edited", 900.0)
    # January was closed once, by the edit, with the limit it ran with.
    assert _stored(w, bid) == [(at(2026, 1, 1), at(2026, 2, 1), Decimal("500.00"), "PHP",
                                None)]


def test_budget_roll_before_edit_keeps_the_old_limit(env):
    w = env
    w.clock(at(2026, 1, 31, 23))
    bid = _create(w, target_amount=500)["id"]
    # After midnight, nothing has read it: the edit closes January under the old limit.
    w.clock(at(2026, 2, 1, 0, 30))
    _put(w, bid, {"target_amount": 800})
    assert _stored(w, bid) == [(at(2026, 1, 1), at(2026, 2, 1), Decimal("500.00"), "PHP",
                                None)]
    periods = _periods(w, bid)
    assert [(p["limit"], p["estimated"]) for p in periods[:2]] == [(800.0, False),
                                                                    (500.0, False)]


def test_budget_date_edit_cannot_overlap_history(env):
    w = env
    bid = _create(w)["id"]
    w.clock(at(2026, 2, 10, 3))
    _get(w, bid)  # closes January
    _put(w, bid, {"period_start": "2026-01-15T00:00:00"}, expect=422)
    _put(w, bid, {"period_start": "2026-01-31T23:00:00-01:00"}, expect=200)  # = Feb 1 UTC
    body = _put(w, bid, {"period_start": "2026-02-05T00:00:00",
                         "period_end": "2026-03-05T00:00:00", "carry_over": True})
    # Carry starts at the period start the request applied.
    assert body["carry_over_from"] == "2026-02-05T00:00:00"
    _put(w, bid, {"period_start": "2025-12-01T00:00:00"}, expect=422)
    assert _get(w, bid)["period_start"] == "2026-02-05T00:00:00"


# --- the periods service ------------------------------------------------------------------------

def test_budget_history_preserves_custom_and_month_end_boundaries(env):
    w = env
    # Anchored on January 31, 2025 (not a leap year): Feb 28, then Mar 31, Apr 30, May 31.
    w.clock(at(2025, 2, 10, 3))
    month_end = _create(w, period_start="2025-01-31T00:00:00")["id"]
    w.clock(at(2025, 5, 10, 3))
    periods = _periods(w, month_end)
    assert _windows(periods)[:4] == [
        (utc(2025, 4, 30), utc(2025, 5, 31)), (utc(2025, 3, 31), utc(2025, 4, 30)),
        (utc(2025, 2, 28), utc(2025, 3, 31)), (utc(2025, 1, 31), utc(2025, 2, 28))]
    assert [(s, e) for s, e, *_ in _stored(w, month_end)] == [
        (at(2025, 1, 31), at(2025, 2, 28)), (at(2025, 2, 28), at(2025, 3, 31)),
        (at(2025, 3, 31), at(2025, 4, 30))]
    _assert_contiguous(periods)

    # A custom September-to-November window is one window.
    w.clock(at(2025, 9, 10, 3))
    custom = _create(w, period_start="2025-09-01T00:00:00",
                     period_end="2025-12-01T00:00:00")["id"]
    w.clock(at(2026, 1, 10, 3))
    periods = _periods(w, custom)
    assert _windows(periods)[:4] == [
        (utc(2026, 1, 1), utc(2026, 2, 1)), (utc(2025, 12, 1), utc(2026, 1, 1)),
        (utc(2025, 9, 1), utc(2025, 12, 1)), (utc(2025, 8, 1), utc(2025, 9, 1))]
    assert [p["estimated"] for p in periods[:4]] == [False, False, False, True]
    assert [(s, e) for s, e, *_ in _stored(w, custom)] == [
        (at(2025, 9, 1), at(2025, 12, 1)), (at(2025, 12, 1), at(2026, 1, 1))]
    _assert_contiguous(periods)


def test_budget_history_fills_with_estimated_windows(env):
    w = env
    w.clock(at(2026, 3, 10, 3))
    bid = _create(w, period_start="2026-03-01T00:00:00", carry_over=True)["id"]
    w.db.execute(text("UPDATE allocations SET created_at = :c WHERE id = :a"),
                 {"c": utc(2026, 3, 1, 5), "a": bid})
    w.db.commit()
    _row(w, w.bank, at(2026, 2, 10), 250)  # in an estimated window
    _row(w, w.bank, at(2026, 3, 5), 100)
    w.clock(at(2026, 4, 10, 3))
    periods = _periods(w, bid)
    assert len(periods) == 12
    _assert_contiguous(periods)
    assert [p["estimated"] for p in periods] == [False, False] + [True] * 10
    assert [p["is_current"] for p in periods] == [True] + [False] * 11
    assert _windows(periods)[2] == (utc(2026, 2, 1), utc(2026, 3, 1))
    assert _windows(periods)[-1] == (utc(2025, 5, 1), utc(2025, 6, 1))
    # Created on Mar 1 05:00 UTC: every window ending by then is before it.
    assert [p["before_created"] for p in periods] == [False, False] + [True] * 10
    # Estimated windows use the current limit and never carry.
    feb = periods[2]
    assert (feb["limit"], feb["carry_in"], feb["spent"], feb["available"],
            feb["remaining"]) == (1000.0, 0.0, 250.0, 1000.0, 750.0)
    assert {p["carry_in"] for p in periods[2:]} == {0.0}
    assert periods[0]["carry_in"] == 900.0  # March, in the chain, carries into April


def test_budget_history_uses_current_membership_and_stored_limits(env):
    w = env
    bid = _create(w, target_amount=500)["id"]
    _row(w, w.bank, at(2026, 1, 4), 100)
    _row(w, w.bank, at(2026, 1, 5), 70, category="fuel")
    w.clock(at(2026, 2, 10, 3))
    _put(w, bid, {"target_amount": 800, "configuration": {"category_ids": [w.food, w.fuel]}})
    _row(w, w.bank, at(2026, 2, 3), 30, category="fuel")
    current, january = _periods(w, bid)[:2]
    assert (january["limit"], january["spent"]) == (500.0, 170.0)  # today's categories
    assert (current["limit"], current["spent"]) == (800.0, 30.0)


def test_budget_spent_uses_signed_currency_subtotals(env):
    w = env
    php = _create(w)["id"]
    _row(w, w.bank, at(2026, 1, 2), 1000)
    _row(w, w.bank, at(2026, 1, 3), 200, kind="credit")
    _row(w, w.usd, at(2026, 1, 4), 10)        # 580 PHP
    _row(w, w.eur, at(2026, 1, 5), 5)         # no rate
    current = _periods(w, php)[0]
    assert (current["spent"], current["complete"], current["missing"]) == (1380.0, False,
                                                                          ["EUR"])
    page = _page(w, php)
    assert page["currency_subtotals"] == {"EUR": 5.0, "PHP": 800.0, "USD": 10.0}
    assert page["converted_total"] == 1380.0
    body = _get(w, php)
    assert (body["current_amount"], body["complete"], body["missing"]) == (1380.0, False,
                                                                           ["EUR"])

    # Each currency's subtotal is converted once: 3 PHP is 0.05 USD (not 3 x 0.02).
    usd = _create(w, currency="USD", configuration={"category_ids": [w.fuel]})["id"]
    for day in (6, 7, 8):
        _row(w, w.bank, at(2026, 1, day), 1, category="fuel")
    assert _periods(w, usd)[0]["spent"] == 0.05

    # Refunds larger than debits: spent is floored at 0; the subtotal stays signed.
    refunds = _create(w, configuration={"category_ids": [], "account_ids": []})["id"]
    _row(w, w.bank, at(2026, 1, 6), 100, category=None, allocation=refunds)
    _row(w, w.bank, at(2026, 1, 7), 300, kind="credit", category=None, allocation=refunds)
    current = _periods(w, refunds)[0]
    assert (current["spent"], current["remaining"]) == (0.0, 1000.0)
    assert _page(w, refunds)["currency_subtotals"] == {"PHP": -200.0}


def test_future_budget_window_counts_nothing(env):
    w = env
    bid = _create(w, period_start="2026-06-01T00:00:00")["id"]
    _row(w, w.bank, at(2026, 6, 5), 300)
    _row(w, w.bank, at(2026, 1, 5), 40)
    assert _stored_total(w, bid) == 0
    periods = _periods(w, bid)
    assert periods[0]["start"] == "2026-06-01T00:00:00Z" and periods[0]["spent"] == 0.0
    assert _get(w, bid)["current_amount"] == 0.0
    page = _page(w, bid)
    assert (page["items"], page["total"], page["converted_total"]) == ([], 0, 0.0)
    # January, generated behind it, has started and counts its row.
    january = next(p for p in periods if p["start"] == "2026-01-01T00:00:00Z")
    assert january["estimated"] and january["spent"] == 40.0


def _chain(limit, spends):
    """The carry model: [(carry_in, available, remaining)] for each window's spend."""
    carry, out = Decimal("0"), []
    for spent in spends:
        available = Decimal(limit) + carry
        remaining = available - Decimal(spent)
        out.append((float(carry), float(available), float(remaining)))
        carry = remaining
    return out


def test_budget_carry_uses_entire_chain(env):
    w = env
    w.clock(at(2026, 1, 1, 3))
    bid = _create(w, period_frequency="daily", target_amount=10, carry_over=True)["id"]
    spends = [3, 0, 12, 5, 0, 20, 1, 0, 0, 7, 2, 15, 4, 0, 9]
    for day, amount in enumerate(spends, start=1):
        if amount:
            _row(w, w.bank, at(2026, 1, day), amount)
        w.clock(at(2026, 1, day + 1, 3))
        _get(w, bid)  # each day's read rolls the window
    periods = _periods(w, bid)
    model = _chain(10, spends + [0])  # Jan 1..15, then the current Jan 16
    shown = list(reversed(model))[:12]  # newest first: Jan 16 .. Jan 5
    assert [(p["carry_in"], p["available"], p["remaining"]) for p in periods] == shown
    # The oldest shown window's carry-in comes from windows older than the 12 shown.
    assert periods[-1]["start"] == "2026-01-05T00:00:00Z"
    assert periods[-1]["carry_in"] == model[4][0] == 20.0
    assert len(_stored(w, bid)) == 15


def test_budget_carry_can_exceed_the_next_limit(env):
    w = env
    bid = _create(w, target_amount=300, carry_over=True)["id"]
    w.clock(at(2026, 2, 10, 3))
    _put(w, bid, {"target_amount": 100})  # January closes at 300 unspent
    body = _get(w, bid)
    assert (body["carry_in"], body["available"]) == (300.0, 400.0)  # more than the limit
    _row(w, w.bank, at(2026, 2, 3), 400)
    _row(w, w.bank, at(2026, 2, 4), 250)
    w.clock(at(2026, 3, 10, 3))
    # Overspent by more than the next limit: March starts below zero.
    _row(w, w.bank, at(2026, 3, 2), 50)
    _row(w, w.bank, at(2026, 3, 3), 120, kind="credit")  # refunds larger than debits
    march, february, january = _periods(w, bid)[:3]
    assert (january["limit"], january["carry_in"], january["remaining"]) == (300.0, 0.0, 300.0)
    assert (february["carry_in"], february["available"], february["spent"],
            february["remaining"]) == (300.0, 400.0, 650.0, -250.0)
    assert (march["carry_in"], march["available"], march["spent"],
            march["remaining"]) == (-250.0, -150.0, 0.0, -150.0)


def test_missing_budget_rates_propagate_within_the_chain(env):
    w = env
    bid = _create(w, carry_over=True)["id"]
    _row(w, w.bank, at(2026, 1, 3), 100)
    _row(w, w.eur, at(2026, 1, 4), 5)
    w.clock(at(2026, 2, 10, 3))
    february, january = _periods(w, bid)[:2]
    assert (january["complete"], january["missing"], january["provisional"],
            january["spent"]) == (False, ["EUR"], False, 100.0)
    assert (february["complete"], february["provisional"], february["inherited_missing"],
            february["carry_in"]) == (True, True, ["EUR"], 900.0)
    _row(w, w.eur, at(2026, 2, 4), 5)
    w.clock(at(2026, 3, 10, 3))
    march, february = _periods(w, bid)[:2]
    assert (february["missing"], february["inherited_missing"]) == (["EUR"], ["EUR"])
    assert (march["provisional"], march["inherited_missing"], march["carry_in"]) == (
        True, ["EUR"], 1900.0)
    body = _get(w, bid)
    assert (body["complete"], body["provisional"], body["inherited_missing"]) == (
        True, True, ["EUR"])
    # A new chain clears the inherited flags.
    _put(w, bid, {"carry_over": False})
    body = _put(w, bid, {"carry_over": True})
    assert (body["provisional"], body["inherited_missing"], body["carry_in"]) == (False, [], 0.0)


def test_budget_writes_recompute_only_the_current_period(env):
    from app.core.database import engine

    w = env
    bid = _create(w, carry_over=True)["id"]
    _row(w, w.bank, at(2026, 1, 3), 100)
    w.clock(at(2026, 3, 10, 3))
    _get(w, bid)  # closes January and February
    history = _stored(w, bid)
    statements = []

    def capture(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        _row(w, w.bank, at(2026, 3, 2), 60)
        _row(w, w.bank, at(2026, 1, 20), 40)  # into a closed window
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    # No carry chain and no stored window is read or written by the writes.
    assert not [s for s in statements if "budget_periods" in s]
    assert _stored(w, bid) == history
    assert _stored_total(w, bid) == Decimal("60.00")
    # Reads compute the chain: January's late row lowers what carries into March.
    march, february, january = _periods(w, bid)[:3]
    assert january["spent"] == 140.0
    assert march["carry_in"] == 1000 - 140 + 1000


# --- reads and endpoints ------------------------------------------------------------------------

def test_budget_reads_agree_after_a_read_only_roll(env):
    w = env
    bid = _create(w, carry_over=True)["id"]
    _row(w, w.bank, at(2026, 1, 3), 100)
    _row(w, w.usd, at(2026, 1, 4), 2)  # 116 PHP
    _row(w, w.bank, at(2026, 3, 1, 1), 30)  # dated ahead: counts once March is current
    # No writes from here: the first read rolls into March.
    w.clock(at(2026, 3, 10, 3))
    listed = {a["id"]: a for a in _call(w, "GET", "/allocations/")["items"]}[bid]
    detail = _get(w, bid)
    progress = _call(w, "GET", f"/allocations/{bid}/progress")
    periods = _periods(w, bid)
    page = _page(w, bid)
    assert listed["current_amount"] == detail["current_amount"] == progress["current_amount"] \
        == periods[0]["spent"] == page["converted_total"] == 30.0
    for field in ("carry_in", "available", "complete", "provisional"):
        assert listed[field] == detail[field]
    assert listed["carry_in"] == periods[0]["carry_in"] == 1000 - 216 + 1000
    for window in periods[:3]:
        drill = _page(w, bid, period_start=window["start"], limit=100)
        assert drill["converted_total"] == window["spent"]
        assert drill["total"] == len(drill["items"])
    assert _stored_total(w, bid) == Decimal("30.00")


def test_budget_create_and_update_ignore_sent_current_amount(env):
    w = env
    _row(w, w.bank, at(2026, 1, 3), 100)
    body = _create(w, current_amount=9999)
    assert body["current_amount"] == 100.0
    assert _stored_total(w, body["id"]) == Decimal("100.00")
    body = _put(w, body["id"], {"current_amount": 5555, "name": "Food"})
    assert body["current_amount"] == 100.0
    assert _stored_total(w, body["id"]) == Decimal("100.00")


def test_budget_periods_response_contract(env):
    w = env
    bid = _create(w, period_start="2025-11-01T00:00:00")["id"]
    _row(w, w.bank, at(2025, 12, 3), 100)
    _row(w, w.bank, at(2026, 1, 3), 45)
    periods = _periods(w, bid)
    assert isinstance(periods, list) and len(periods) == 12
    for p in periods:
        assert set(p) == PERIOD_FIELDS
        _instant(p["start"]), _instant(p["end"])
    assert [p["is_current"] for p in periods] == [True] + [False] * 11
    assert [p["estimated"] for p in periods[:4]] == [False, False, False, True]
    assert (periods[0]["spent"], periods[1]["spent"]) == (45.0, 100.0)
    # The round trip: each returned start is accepted verbatim by the drill-down.
    for p in periods:
        page = _page(w, bid, period_start=p["start"])
        assert set(page) == PAGE_FIELDS
        assert page["converted_total"] == p["spent"]

    # Without a limit: limit, available and remaining are null and carry-in is 0.
    bare = _create(w, target_amount=None)["id"]
    current = _periods(w, bare)[0]
    assert (current["limit"], current["available"], current["remaining"],
            current["carry_in"]) == (None, None, None, 0.0)


def test_budget_transaction_page_contract(env):
    w = env
    bid = _create(w)["id"]
    same_day = [_row(w, w.bank, at(2026, 1, 4), 10), _row(w, w.bank, at(2026, 1, 4), 20)]
    newest = _row(w, w.bank, at(2026, 1, 8), 30)
    oldest = _row(w, w.bank, at(2026, 1, 1), 40)
    euro = _row(w, w.eur, at(2026, 1, 6), 5)
    _row(w, w.bank, at(2025, 12, 30), 99)  # last window: not this one's
    page = _page(w, bid, limit=2)
    assert (page["total"], page["has_more"]) == (5, True)
    assert [i["id"] for i in page["items"]] == [newest, euro]
    page = _page(w, bid, limit=2, offset=2)
    # Date descending, then id descending.
    assert [i["id"] for i in page["items"]] == [same_day[1], same_day[0]]
    page = _page(w, bid, limit=2, offset=4)
    assert ([i["id"] for i in page["items"]], page["has_more"]) == ([oldest], False)
    empty = _page(w, bid, offset=50)
    assert (empty["items"], empty["total"], empty["has_more"]) == ([], 5, False)
    assert empty["converted_total"] == _periods(w, bid)[0]["spent"] == 100.0
    assert empty["currency_subtotals"] == {"EUR": 5.0, "PHP": 100.0}
    # The defaults: the current window, 10 rows.
    assert len(_page(w, bid)["items"]) == 5

    # Full rows: the transaction's own shape, its own amount and currency, and missing_rate.
    items = {i["id"]: i for i in _page(w, bid)["items"]}
    alone = _call(w, "GET", f"/transactions/{euro}")
    assert set(items[euro]) == set(alone) | {"missing_rate"}
    assert items[euro]["view"] == "full" and items[euro]["missing_rate"] is True
    assert items[euro]["amount"] == alone["amount"] == 5.0
    assert items[euro].get("currency") == alone.get("currency")
    assert items[newest]["missing_rate"] is False

    # A timestamp matches by instant, whatever its offset.
    page = _page(w, bid, period_start="2026-01-01T08:00:00+08:00")
    assert page["total"] == 5
    assert _page(w, bid, period_start="2025-12-01T00:00:00Z")["total"] == 1
    # Malformed, unexposed or out-of-range paging: 422.
    _page(w, bid, expect=422, period_start="not-a-date")
    _page(w, bid, expect=422, period_start="2020-01-01T00:00:00Z")
    _page(w, bid, expect=422, period_start="2026-01-02T00:00:00Z")
    _page(w, bid, expect=422, limit=0)
    _page(w, bid, expect=422, limit=1001)
    _page(w, bid, expect=422, offset=-1)


def test_budget_transactions_apply_redaction_after_revocation(env):
    from app.models.account_share import AccountShare
    from app.schemas.transaction import LimitedTransaction

    w = env
    bea = w.people("Bea", "Partner")
    joint = _account(w.client, bea, "Bea's account")
    share = sw_share(w.db, joint, w.me["id"], "editor", bea["id"])
    bid = _create(w)["id"]
    txn = _row(w, joint, at(2026, 1, 3), 75)
    (item,) = _page(w, bid)["items"]
    assert (item["id"], item["view"], item["missing_rate"]) == (txn, "full", False)

    w.db.query(AccountShare).filter(AccountShare.id == share).delete()
    w.db.commit()
    page = _page(w, bid)
    (item,) = page["items"]
    # Still the owner's row, so still counted; shown as GET /transactions shows it.
    assert page["converted_total"] == 75.0
    assert item["view"] == "limited" and "missing_rate" not in item
    assert set(item) <= set(LimitedTransaction.model_fields)
    listed = _call(w, "GET", "/transactions/", params={"ids": [txn]})["items"]
    assert listed == [item]


def test_budget_list_and_detail_expose_current_window_fields(env):
    w = env
    budget = _create(w, carry_over=True,
                     configuration={"category_ids": [w.food], "account_ids": [w.bank]})
    _row(w, w.bank, at(2026, 1, 3), 250)
    goal = _call(w, "POST", "/allocations/", json={
        "name": "Trip", "allocation_type": "goal", "account_id": w.bank,
        "target_amount": 100})
    listed = {a["id"]: a for a in _call(w, "GET", "/allocations/")["items"]}
    for body in (listed[budget["id"]], _get(w, budget["id"])):
        assert CURRENT_FIELDS <= set(body)
        assert body["configuration"]["account_ids"] == [w.bank]
        assert (body["carry_over_from"], body["carry_in"], body["available"],
                body["complete"], body["missing"], body["provisional"],
                body["inherited_missing"], body["current_amount"]) == (
            "2026-01-01T00:00:00", 0.0, 1000.0, True, [], False, [], 250.0)
    assert listed[goal["id"]]["carry_over_from"] is None


def test_budget_read_routes_require_envelope_ownership(env):
    w = env
    other = w.people()
    mine = _create(w)["id"]
    theirs = _create(w, who=other, configuration={"category_ids": []})["id"]
    savings = _call(w, "POST", "/allocations/", json={
        "name": "Fund", "allocation_type": "savings", "target_amount": 100,
        "configuration": {"goal_mode": "transaction_total"}})["id"]
    missing = max(mine, theirs, savings) + 10_000
    for allocation_id in (theirs, savings, missing):
        _periods(w, allocation_id, expect=404)
        _page(w, allocation_id, expect=404)
    _get(w, theirs, expect=404)
    _call(w, "PUT", f"/allocations/{theirs}", expect=404, json={"carry_over": True})
    # The owner reads their own; the other user can't read mine.
    _periods(w, theirs, who=other)
    _periods(w, mine, expect=404, who=other)
    _page(w, mine, expect=404, who=other)

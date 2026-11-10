"""``GET /transactions/scheduled``: the Scheduled view's list. Future
transactions (``GET /transactions``' query and filters) and unrecorded
recurring occurrences (``GET /budget-entries/upcoming-occurrences``' service)
merged by day, transactions first on a day, paged by an opaque cursor.
Skips without a database.
"""
import base64
import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import event, text

from app.tests.conftest import API, PRIVATE, hh_household, sw_db_reachable, sw_leaks, sw_post
from app.tests.test_recurring_missed_integration import _account, _entry, _put, pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
TODAY = date(2026, 10, 18)
BODY_KEYS = {"items", "total", "transactions_total", "occurrences_total",
             "occurrences_through", "auto_post_scheduled", "next_cursor"}


def _t(n: int) -> date:
    return TODAY + timedelta(days=n)


def _start(day) -> str:
    return f"{day}T00:00:00Z"


def _end(day) -> str:
    return f"{day}T23:59:59.999999Z"


def _scheduled(client, who, expect=200, **params):
    r = client.get(f"{API}/transactions/scheduled", headers=who["headers"], params=params)
    assert r.status_code == expect, r.text
    body = r.json()
    if expect == 200:
        assert set(body) == BODY_KEYS
        assert body["total"] == body["transactions_total"] + body["occurrences_total"]
        for item in body["items"]:
            assert set(item) == {"kind", "day", item["kind"]}
    return body


def _walk(client, who, limit, **params):
    """Every page from the first, following ``next_cursor``: (rows, pages)."""
    rows, pages, cursor = [], [], None
    while True:
        body = _scheduled(client, who, limit=limit, **params,
                          **({"cursor": cursor} if cursor else {}))
        pages.append(body)
        rows.extend(body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            return rows, pages
        assert len(body["items"]) == limit
        assert len(pages) < 10_000


def _key(item) -> tuple:
    """A row's identity: ``(day, "t", id)`` or ``(day, "o", entry id, scheduled day)``."""
    if item["kind"] == "transaction":
        return (item["day"], "t", item["transaction"]["id"])
    occ = item["occurrence"]
    return (item["day"], "o", occ["entry_id"], occ["occurrence_date"])


def _keys(items) -> list:
    return [_key(i) for i in items]


def _txn(db, who, account_id, day, description="One-off", *, kind="debit", posted=False,
         amount=100, **extra) -> int:
    """A transaction written directly (fast; the API's own create is not under test)."""
    from app.models.transaction import Transaction, TransactionType

    txn = Transaction(user_id=who["id"], account_id=account_id, amount=amount,
                      transaction_type=TransactionType(kind), description=description,
                      is_posted=posted, transaction_date=datetime.fromisoformat(f"{day}T00:00:00"),
                      **extra)
    db.add(txn)
    db.commit()
    return txn.id


def _api_txn(client, who, account_id, day, description, kind="debit", **extra) -> int:
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": kind, "amount": 100,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": False, **extra})["id"]


def _monthly(start: date, through: date) -> list:
    days, i = [], 0
    while True:
        y, m = divmod(start.month - 1 + i, 12)
        day = date(start.year + y, m + 1, start.day)
        if day > through:
            return days
        days.append(day)
        i += 1


def _stepped(start: date, step: int, through: date) -> list:
    days = []
    while start <= through:
        days.append(start)
        start += timedelta(days=step)
    return days


@pytest.fixture
def me(sw_client, sw_people, sw_db, monkeypatch):
    who = sw_people()
    checking = _account(sw_client, who)
    pin_clock(monkeypatch, REF)
    return SimpleNamespace(client=sw_client, db=sw_db, who=who, checking=checking,
                           monkeypatch=monkeypatch)


# --- AC 1: the default horizon ------------------------------------------------------------------

def test_scheduled_default_horizon(me):
    client, db, who = me.client, me.db, me.who
    near = _txn(db, who, me.checking, _t(10))
    mid = _txn(db, who, me.checking, _t(200))
    far = _txn(db, who, me.checking, _t(400))
    rent = _entry(client, who, me.checking, "2026-11-01", "Rent")
    insurance = _entry(client, who, me.checking, _t(300).isoformat(), "Insurance",
                       cadence="annual")
    gym = _entry(client, who, me.checking, "2026-10-20", "Gym", cadence="weekly")

    through = _t(365)
    expected = sorted(
        [(_t(10).isoformat(), "t", near), (_t(200).isoformat(), "t", mid)]
        + [(d.isoformat(), "o", rent, d.isoformat()) for d in _monthly(date(2026, 11, 1), through)]
        + [(_t(300).isoformat(), "o", insurance, _t(300).isoformat())]
        + [(d.isoformat(), "o", gym, d.isoformat())
           for d in _stepped(date(2026, 10, 20), 7, through)],
        key=lambda k: (k[0], k[1] == "o", {rent: "Rent", insurance: "Insurance",
                                           gym: "Gym"}.get(k[2], "") if k[1] == "o" else k[2]))
    body = _scheduled(client, who, limit=100)
    assert _keys(body["items"]) == expected
    assert body["next_cursor"] is None
    assert (body["transactions_total"], body["occurrences_total"]) == (2, len(expected) - 2)
    assert body["occurrences_through"] == through.isoformat()
    assert [i for i in body["items"] if i["kind"] == "occurrence"
            and i["occurrence"]["entry_id"] == insurance][0]["day"] == _t(300).isoformat()
    assert far not in [k[2] for k in expected]

    # The T+400 one-off is listed once the end passes it.
    later = _scheduled(client, who, limit=100, start_date=_start(_t(390)),
                       end_date=_end(_t(410)))
    assert (_t(400).isoformat(), "t", far) in _keys(later["items"])


# --- AC 2: same-day order and forced dates ------------------------------------------------------

def test_scheduled_merge_order(me):
    client, db, who = me.client, me.db, me.who
    day = "2026-11-05"
    before = _txn(db, who, me.checking, "2026-11-04", "Before")
    t1 = _txn(db, who, me.checking, day, "Zulu row")
    t2 = _txn(db, who, me.checking, day, "Alpha row")
    zed = _entry(client, who, me.checking, day, "Zed")
    alpha1 = _entry(client, who, me.checking, day, "Alpha")
    alpha2 = _entry(client, who, me.checking, day, "Alpha")
    moved = _entry(client, who, me.checking, "2026-11-02", "Moved")
    r = client.put(f"{API}/budget-entries/{moved}/occurrences/2026-11-02/date",
                   json={"effective_date": day}, headers=who["headers"])
    assert r.status_code == 200, r.text
    params = {"start_date": _start("2026-11-01"), "end_date": _end("2026-11-07")}

    expected = [("2026-11-04", "t", before), (day, "t", t1), (day, "t", t2),
                (day, "o", alpha1, day), (day, "o", alpha2, day),
                (day, "o", moved, "2026-11-02"), (day, "o", zed, day)]
    assert alpha1 < alpha2
    body = _scheduled(client, who, limit=100, **params)
    assert _keys(body["items"]) == expected
    # Every page boundary falls inside the same-day run, and the order holds.
    for limit in (1, 2, 3):
        rows, _ = _walk(client, who, limit, **params)
        assert _keys(rows) == expected


# --- AC 3: exact pages ----------------------------------------------------------------------------

def test_scheduled_pagination_exact(me):
    client, db, who = me.client, me.db, me.who
    txns = [(date(2026, 11, 1) + timedelta(days=5 * i),
             _txn(db, who, me.checking, date(2026, 11, 1) + timedelta(days=5 * i)))
            for i in range(70)]
    names = ["Echo", "Delta", "Charlie", "Bravo", "Alpha"]
    entries = {_entry(client, who, me.checking, "2026-11-01", n): n for n in names}
    expected = sorted(
        [(d.isoformat(), "t", i) for d, i in txns]
        + [(d.isoformat(), "o", e, d.isoformat()) for e in entries
           for d in _monthly(date(2026, 11, 1), _t(365))],
        key=lambda k: (k[0], k[1] == "o", entries[k[2]] if k[1] == "o" else "", k[2]))
    assert len(expected) == 130

    rows, pages = _walk(client, who, 25)
    assert [len(p["items"]) for p in pages] == [25, 25, 25, 25, 25, 5]
    assert all((p["total"], p["transactions_total"], p["occurrences_total"]) == (130, 70, 60)
               for p in pages)
    assert _keys(rows) == expected
    assert len(set(_keys(rows))) == 130  # no repeat
    whole = _scheduled(client, who, limit=100)
    assert _keys(whole["items"]) == expected[:100]


def test_scheduled_pages_past_5100_rows(me):
    """W2: keyset paging reaches every row, however deep. Fifty weekly entries
    over the two-year horizon make 5,250 occurrences from a small fixture; the
    walk at the largest page size crosses row 5,100."""
    client, db, who = me.client, me.db, me.who
    entries = [_entry(client, who, me.checking, "2026-10-20", f"W{i:02d}", cadence="weekly")
               for i in range(50)]
    late = _txn(db, who, me.checking, _t(800), "Late")
    params = {"end_date": _end(_t(900))}
    days = _stepped(date(2026, 10, 20), 7, _t(730))

    rows, pages = _walk(client, who, 100, **params)
    assert len(rows) == 50 * len(days) + 1 == pages[0]["total"]
    assert len(rows) > 5_100
    assert len(set(_keys(rows))) == len(rows)
    assert _keys(rows) == sorted(_keys(rows), key=lambda k: (k[0], k[1] == "o", k[2]))
    assert _keys(rows)[5_100] == (days[102].isoformat(), "o", entries[0], days[102].isoformat())
    assert _keys(rows)[-1] == (_t(800).isoformat(), "t", late)


# --- AC 4: filters on both sources -------------------------------------------------------------

def test_scheduled_filters(sw, sw_client, sw_db, monkeypatch):
    client = sw_client
    a, b = sw["a"], sw["b"]
    joint = sw["joint"]
    savings = _account(client, a, "Savings", "savings", 0)
    food = sw_post(client, a, "/categories/", {"name": "Food"})["id"]
    tag = sw_post(client, a, "/tags/", {"name": "Home"}, expect=(201,))["id"]
    pin_clock(monkeypatch, REF)
    entry_ids, txn_ids = {}, {}
    for name, who, account, extra, txn_extra in (
        ("Groceries", a, joint, {"category_id": food}, {"category_id": food}),
        ("Salary", a, joint, {"entry_type": "income"}, {"kind": "credit"}),
        ("Save", a, joint, {"transfer_to_account_id": savings},
         {"kind": "transfer", "transfer_from_account_id": joint,
          "transfer_to_account_id": savings}),
        ("Gym", a, savings, {}, {"tag_ids": [tag]}),
        ("Bea bill", b, joint, {}, {}),
    ):
        entry_ids[name] = _entry(client, who, account, "2026-11-03", name, **extra)
        txn_ids[name] = _api_txn(client, who, account, "2026-11-03", name, **txn_extra)
    _put(client, a, entry_ids["Gym"], {"tag_ids": [tag]})

    def names(**params):
        body = _scheduled(client, a, limit=100, start_date=_start("2026-11-01"),
                          end_date=_end("2026-11-10"), **params)
        out = {"transaction": [], "occurrence": []}
        for item in body["items"]:
            if item["kind"] == "transaction":
                out["transaction"].append(
                    {v: k for k, v in txn_ids.items()}[item["transaction"]["id"]])
            else:
                out["occurrence"].append(
                    {v: k for k, v in entry_ids.items()}[item["occurrence"]["entry_id"]])
        assert len(body["items"]) == body["total"]
        return {k: sorted(v) for k, v in out.items()}

    def both(*expected):
        return {"transaction": sorted(expected), "occurrence": sorted(expected)}

    everything = ("Groceries", "Salary", "Save", "Gym", "Bea bill")
    assert names() == both(*everything)
    cases = {
        "search": ({"search": "ALA"}, ("Salary",)),
        "account": ({"account_ids": [savings]}, ("Save", "Gym")),
        "account not viewable": ({"account_ids": [sw["s_bank"]]}, ()),
        "category name": ({"category_names": ["Food"]}, ("Groceries",)),
        "uncategorized": ({"uncategorized": True}, ("Salary", "Gym", "Bea bill")),
        "entered by": ({"entered_by": "me"}, ("Groceries", "Salary", "Save", "Gym")),
        "type": ({"transaction_types": ["credit"]}, ("Salary",)),
        "transfer type": ({"transaction_types": ["transfer"]}, ("Save",)),
        "tag": ({"tag": tag}, ("Gym",)),
        "unknown tag": ({"tag": 999_999_999}, ()),
    }
    for case, (params, expected) in cases.items():
        assert names(**params) == both(*expected), case
    r = client.get(f"{API}/transactions/scheduled", headers=a["headers"],
                   params={"transaction_types": ["bogus"]})
    assert r.status_code == 400, r.text


# --- AC 5: bounds ---------------------------------------------------------------------------------

def test_scheduled_bounds(me):
    client, db, who = me.client, me.db, me.who
    yesterday = _txn(db, who, me.checking, _t(-1))
    today = _txn(db, who, me.checking, TODAY)
    tomorrow = _txn(db, who, me.checking, _t(1))
    beyond = _txn(db, who, me.checking, _t(800))
    rent = _entry(client, who, me.checking, TODAY.isoformat(), "Rent")

    body = _scheduled(client, who, limit=100)
    listed = _keys(body["items"])
    assert listed[0] == (_t(1).isoformat(), "t", tomorrow)
    assert all(k[0] > TODAY.isoformat() for k in listed)
    assert yesterday not in [k[2] for k in listed if k[1] == "t"]
    assert today not in [k[2] for k in listed if k[1] == "t"]
    assert TODAY.isoformat() not in [k[3] for k in listed if k[1] == "o"]

    clamped = _scheduled(client, who, limit=100, start_date=_start("2026-10-01"))
    assert _keys(clamped["items"]) == listed
    later = _scheduled(client, who, limit=100, start_date=_start("2026-12-01"))
    assert _keys(later["items"])[0] == ("2026-12-18", "o", rent, "2026-12-18")

    wide = _scheduled(client, who, limit=100, end_date=_end(_t(900)))
    occurrences = [k for k in _keys(wide["items"]) if k[1] == "o"]
    assert all(k[0] <= _t(730).isoformat() for k in occurrences)
    assert [k[0] for k in occurrences] == [
        d.isoformat() for d in _monthly(date(2026, 11, 18), _t(730))]
    assert wide["occurrences_through"] == _t(730).isoformat()
    assert _keys(wide["items"])[-1] == (_t(800).isoformat(), "t", beyond)

    # Bad cursors and page sizes are 422s.
    def encoded(data):
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode()

    tampered = encoded({"k": "t", "d": "x"})
    huge_id = encoded({"k": "t", "d": "2026-11-01", "at": "2026-11-01T00:00:00", "id": 2**40})
    for params in ({"cursor": "not-a-cursor"}, {"cursor": tampered}, {"cursor": huge_id},
                   {"cursor": encoded([1, 2])}, {"limit": 101}, {"limit": 0}):
        _scheduled(client, who, expect=422, **params)


# --- AC 6: access -------------------------------------------------------------------------------

def _parity(client, who, body, params):
    """The rows are exactly ``GET /transactions``' and ``upcoming-occurrences``' over the range."""
    r = client.get(f"{API}/transactions/", headers=who["headers"],
                   params={**params, "order": "asc", "limit": 1000})
    assert r.status_code == 200, r.text
    assert [i["transaction"] for i in body["items"] if i["kind"] == "transaction"] == \
        r.json()["items"]
    r = client.get(f"{API}/budget-entries/upcoming-occurrences", headers=who["headers"],
                   params={**params, "limit": 500})
    assert r.status_code == 200, r.text
    assert [i["occurrence"] for i in body["items"] if i["kind"] == "occurrence"] == \
        r.json()["items"]


def test_scheduled_access(sw, sw_client, sw_db, monkeypatch):
    client, db = sw_client, sw_db
    a, b, v, d, s = sw["a"], sw["b"], sw["v"], sw["d"], sw["s"]
    joint_rent = _entry(client, a, sw["joint"], "2026-11-05", "Joint rent")
    private = _entry(client, a, sw["a_private"], "2026-11-05", f"{PRIVATE} bill")
    joint_row = _api_txn(client, a, sw["joint"], "2026-11-06", "Joint groceries")
    private_row = _api_txn(client, a, sw["a_private"], "2026-11-06", f"{PRIVATE} row")
    pin_clock(monkeypatch, REF)
    params = {"start_date": _start("2026-11-01"), "end_date": _end("2026-11-30")}

    bodies = {k: _scheduled(client, w, limit=100, **params)
              for k, w in (("a", a), ("b", b), ("d", d), ("v", v), ("s", s))}
    for k, w in (("a", a), ("b", b), ("d", d), ("v", v), ("s", s)):
        _parity(client, w, bodies[k], params)

    def summary(body):
        return [(i["kind"], i["transaction"]["id"], i["transaction"]["view"])
                if i["kind"] == "transaction" else
                (i["kind"], i["occurrence"]["entry_id"], i["occurrence"]["view"],
                 i["occurrence"]["recordable"]) for i in body["items"]]

    assert summary(bodies["a"]) == [
        ("occurrence", joint_rent, "full", True), ("occurrence", private, "full", True),
        ("transaction", joint_row, "full"), ("transaction", private_row, "full")]
    for k in ("b", "d"):  # shared editor and admin
        assert summary(bodies[k]) == [("occurrence", joint_rent, "shared_full", True),
                                      ("transaction", joint_row, "shared_full")]
    # A viewer: the row as the transaction list shows it, and no occurrence
    # (their view of the entry is Limited, which the occurrences list drops).
    assert summary(bodies["v"]) == [("transaction", joint_row, "limited")]
    assert summary(bodies["s"]) == []
    for k in ("b", "d", "v", "s"):
        assert PRIVATE not in json.dumps(bodies[k])
        assert sw_leaks(bodies[k], private_ids=[private, private_row]) == []

    # An account id the caller can't view matches nothing.
    assert _scheduled(client, s, account_ids=[sw["joint"]], **params)["items"] == []
    assert _scheduled(client, b, account_ids=[sw["a_private"]], **params)["items"] == []

    # A creator who is now only a viewer sees their own entry with nothing to record.
    bea = _entry(client, b, sw["joint"], "2026-11-07", "Bea bill")
    db.execute(text("UPDATE account_shares SET role = 'viewer' WHERE id = :s"),
               {"s": sw["shares"]["b"]})
    db.commit()
    body = _scheduled(client, b, limit=100, **params)
    _parity(client, b, body, params)
    assert [(i["occurrence"]["entry_id"], i["occurrence"]["view"], i["occurrence"]["recordable"])
            for i in body["items"] if i["kind"] == "occurrence"] == [(bea, "full", False)]


def test_scheduled_access_household_tag_viewer(hh, sw_client, sw_db, monkeypatch):
    client, a, c = sw_client, hh["a"], hh["c"]
    rent = _entry(client, a, hh["joint"], "2026-11-05", "Joint rent")
    row = _api_txn(client, a, hh["joint"], "2026-11-06", "Joint groceries",
                   tag_ids=[hh_household(sw_db, a)])
    pin_clock(monkeypatch, REF)
    params = {"start_date": _start("2026-11-01"), "end_date": _end("2026-11-30")}

    owner = _scheduled(client, a, limit=100, **params)
    assert [_key(i)[1:3] for i in owner["items"]] == [("o", rent), ("t", row)]
    body = _scheduled(client, c, limit=100, **params)
    _parity(client, c, body, params)
    assert [(i["kind"], i["transaction"]["id"], i["transaction"]["view"])
            for i in body["items"]] == [("transaction", row, "limited")]
    assert body["occurrences_total"] == 0


# --- AC 7: query count ---------------------------------------------------------------------------

def test_scheduled_query_count(me):
    from app.core.database import engine

    client, db, who = me.client, me.db, me.who
    _txn(db, who, me.checking, _t(5))
    _txn(db, who, me.checking, _t(200))
    _entry(client, who, me.checking, "2026-10-25", "Rent")
    _entry(client, who, me.checking, "2026-10-20", "Gym", cadence="weekly")
    _entry(client, who, me.checking, _t(100).isoformat(), "Insurance", cadence="annual")

    def statements(days):
        seen = []

        def count(conn, cursor, statement, parameters, context, executemany):
            seen.append(statement)

        event.listen(engine, "before_cursor_execute", count)
        try:
            body = _scheduled(client, who, limit=100, end_date=_end(_t(days)))
        finally:
            event.remove(engine, "before_cursor_execute", count)
        return len(seen), len(body["items"])

    statements(365)  # warm
    short, short_rows = statements(30)
    long, long_rows = statements(365)
    assert long_rows > short_rows
    assert short == long


# --- the route ---------------------------------------------------------------------------------

def test_the_route_is_declared_before_the_transaction_route(me):
    client, db, who = me.client, me.db, me.who
    row = _txn(db, who, me.checking, _t(3))
    assert _scheduled(client, who)["transactions_total"] == 1
    r = client.get(f"{API}/transactions/{row}", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["id"] == row
    assert client.get(f"{API}/transactions/scheduled").status_code == 401

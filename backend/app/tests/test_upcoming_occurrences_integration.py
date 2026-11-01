"""``GET /budget-entries/upcoming-occurrences`` (STU-465): the recurring
occurrences after Manila's today that no row stands for yet, for the
Transactions page's Upcoming list. Skips without a database.

An occurrence is listed when no linked row stands for it, posted or pending
(a linked planned or pending row is listed itself). The entries are the
missed list's (full or shared_full, active, with an account; Limited dropped),
with card subscriptions and bills and wallet spending kept. ``recordable`` is
the only auto-post gate: a capped entry's first month only, and never an
installment whose auto-post is on.
"""
import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from app.tests.conftest import (
    API, PRIVATE, sw_db_reachable, sw_leaks, sw_post,
)
from app.tests.test_installment_autopost_integration import (
    _flags, _installment, make_world,
)
from app.tests.test_recurring_missed_integration import (
    _account, _card, _entry, _put, pin_clock,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
TODAY = date(2026, 10, 18)
KEYS = {"view", "entry_id", "name", "occurrence_date", "entry_type", "is_transfer", "kind",
        "amount", "currency", "account_name", "transfer_to_account_name", "capped",
        "can_mark_paid", "recordable", "auto_post", "block_reason", "can_review"}


def _upcoming(client, who, **params) -> dict:
    r = client.get(f"{API}/budget-entries/upcoming-occurrences", headers=who["headers"],
                   params=params)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"items", "total", "auto_post_scheduled"}
    for item in body["items"]:
        assert set(item) == KEYS
    return body


def _days(body, entry_id=None) -> list:
    return [i["occurrence_date"] for i in body["items"]
            if entry_id is None or i["entry_id"] == entry_id]


def _pairs(body) -> list:
    return [(i["occurrence_date"], i["entry_id"]) for i in body["items"]]


def _start(day) -> str:
    return f"{day}T00:00:00Z"


def _end(day) -> str:
    return f"{day}T23:59:59.999999Z"


def _row(db, who, account_id, day, *, entry_id, posted=False, kind="debit",
         occurrence=None, amount=1_000, **extra) -> int:
    """A transaction written directly: a future posted row, or a materialised
    one (``occurrence_date`` set) on any account, which the API would refuse."""
    from app.models.transaction import Transaction, TransactionType

    txn = Transaction(user_id=who["id"], account_id=account_id, budget_entry_id=entry_id,
                      amount=amount, transaction_type=TransactionType(kind),
                      description="Linked row", is_posted=posted,
                      transaction_date=datetime.fromisoformat(f"{day}T00:00:00"),
                      occurrence_date=(datetime.fromisoformat(f"{occurrence}T00:00:00")
                                       if occurrence else None), **extra)
    db.add(txn)
    db.commit()
    return txn.id


def _set(db, entry_id, **values) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in values)
    db.execute(text(f"UPDATE budget_entries SET {sets} WHERE id = :id"), {**values, "id": entry_id})
    db.commit()


@pytest.fixture
def me(sw_client, sw_people, sw_db, monkeypatch):
    who = sw_people()
    checking = _account(sw_client, who)
    pin_clock(monkeypatch, REF)
    return SimpleNamespace(client=sw_client, db=sw_db, who=who, checking=checking,
                           monkeypatch=monkeypatch)


# --- the ticket's case ------------------------------------------------------------------------

def test_three_salaries_list_each_unrecorded_month_once(me):
    client, who = me.client, me.who
    pin_clock(me.monkeypatch, datetime(2026, 10, 29, 2, 0))  # 10:00 Oct 29 in Manila
    linked = _entry(client, who, me.checking, "2026-10-30", "Salary A", entry_type="income")
    due = _entry(client, who, me.checking, "2026-10-30", "Salary B", entry_type="income")
    later = _entry(client, who, me.checking, "2026-11-05", "Salary C", entry_type="income")
    planned = sw_post(client, who, "/transactions/", {
        "account_id": me.checking, "transaction_type": "credit", "amount": 1_000,
        "description": "Salary A Oct", "transaction_date": "2026-10-30T00:00:00",
        "is_posted": False, "budget_entry_id": linked})["id"]

    body = _upcoming(client, who, start_date=_start("2026-10-30"), end_date=_end("2026-11-30"))
    assert _pairs(body) == [
        ("2026-10-30", due), ("2026-11-05", later), ("2026-11-30", linked),
        ("2026-11-30", due)]
    assert body["total"] == 4
    item = body["items"][0]
    assert item == {
        "view": "full", "entry_id": due, "name": "Salary B", "occurrence_date": "2026-10-30",
        "entry_type": "income", "is_transfer": False, "kind": None, "amount": 1000.0,
        "currency": "PHP", "account_name": "Checking", "transfer_to_account_name": None,
        "capped": False, "can_mark_paid": True, "recordable": True, "auto_post": None,
        "block_reason": None, "can_review": False}

    # The linked planned row is the only Oct 30 item for its entry: it is in the
    # transaction list over the same range, and its occurrence is not listed.
    r = client.get(f"{API}/transactions/", headers=who["headers"], params={
        "start_date": _start("2026-10-30"), "end_date": _end("2026-10-30"), "limit": 100})
    assert r.status_code == 200, r.text
    assert [t["id"] for t in r.json()["items"]] == [planned]
    assert "2026-10-30" not in _days(body, linked)


# --- range --------------------------------------------------------------------------------------

def test_start_is_clamped_to_manila_tomorrow(me):
    client, who = me.client, me.who
    today = _entry(client, who, me.checking, "2026-10-18", "Today")
    tomorrow = _entry(client, who, me.checking, "2026-10-19", "Tomorrow")
    after = _entry(client, who, me.checking, "2026-10-20", "After")

    def first_days(**params):
        body = _upcoming(client, who, start_date=_start("2026-10-01"),
                         end_date=_end("2026-10-31"), **params)
        return _pairs(body)

    assert first_days() == [("2026-10-19", tomorrow), ("2026-10-20", after)]
    assert today not in [e for _, e in first_days()]

    # 23:30 on Oct 18 in Manila (15:30 UTC): today is still Oct 18.
    pin_clock(me.monkeypatch, datetime(2026, 10, 18, 15, 30))
    assert first_days() == [("2026-10-19", tomorrow), ("2026-10-20", after)]
    # 00:30 on Oct 19 in Manila (16:30 UTC, still Oct 18 in UTC): Oct 19 is today.
    pin_clock(me.monkeypatch, datetime(2026, 10, 18, 16, 30))
    assert first_days() == [("2026-10-20", after)]


def test_end_is_clamped_two_years_ahead_and_an_open_end_is_that_horizon(me):
    client, who = me.client, me.who
    rent = _entry(client, who, me.checking, "2026-11-01", "Rent")
    horizon = TODAY + timedelta(days=730)
    months = [date(2026 + (10 + i) // 12, (10 + i) % 12 + 1, 1) for i in range(24)]
    assert months[-1] <= horizon < date(months[-1].year, months[-1].month + 1, 1)
    expected = [m.isoformat() for m in months]

    assert _days(_upcoming(client, who, end_date=_end("2031-01-01"), limit=500)) == expected
    open_end = _upcoming(client, who, limit=500)
    assert _days(open_end) == expected and open_end["total"] == 24
    assert all(i["entry_id"] == rent for i in open_end["items"])


def test_start_after_end_lists_nothing(me):
    client, who = me.client, me.who
    _entry(client, who, me.checking, "2026-11-01", "Rent")
    assert _upcoming(client, who, start_date=_start("2026-12-02"),
                     end_date=_end("2026-12-01"))["items"] == []
    # An end before Manila's tomorrow is empty too: the start is clamped past it.
    body = _upcoming(client, who, start_date=_start("2026-10-01"), end_date=_end("2026-10-18"))
    assert (body["items"], body["total"]) == ([], 0)


def test_limit_total_and_order(me):
    client, who = me.client, me.who
    zed = _entry(client, who, me.checking, "2026-11-01", "Zed")
    first_gym = _entry(client, who, me.checking, "2026-11-01", "Gym")
    second_gym = _entry(client, who, me.checking, "2026-11-01", "Gym")
    alpha = _entry(client, who, me.checking, "2026-11-02", "Alpha")
    params = {"start_date": _start("2026-11-01"), "end_date": _end("2026-11-30")}

    body = _upcoming(client, who, **params)
    assert first_gym < second_gym
    assert _pairs(body) == [("2026-11-01", first_gym), ("2026-11-01", second_gym),
                            ("2026-11-01", zed), ("2026-11-02", alpha)]
    limited = _upcoming(client, who, limit=2, **params)
    assert (_pairs(limited), limited["total"]) == (_pairs(body)[:2], 4)
    r = client.get(f"{API}/budget-entries/upcoming-occurrences", headers=who["headers"],
                   params={"limit": 501})
    assert r.status_code == 422


def test_manila_midnight_moves_tomorrow_into_due(me):
    """At 23:59 in Manila on Oct 18 (15:59 UTC) Oct 19 is upcoming; at 00:01 on
    Oct 19 (16:01 UTC, the same UTC day) it is today: gone from this list and
    in the snapshot's payables as due today. A planned row on Oct 19 is in the
    Upcoming bounds for Oct 18 and in the main-list bounds for Oct 19."""
    client, who = me.client, me.who
    rent = _entry(client, who, me.checking, "2026-10-19", "Rent")
    planned = sw_post(client, who, "/transactions/", {
        "account_id": me.checking, "transaction_type": "debit", "amount": 50,
        "description": "Planned", "transaction_date": "2026-10-19T00:00:00",
        "is_posted": False})["id"]

    def listed(**bounds):
        r = client.get(f"{API}/transactions/", headers=who["headers"],
                       params={**bounds, "limit": 100})
        assert r.status_code == 200, r.text
        return planned in [t["id"] for t in r.json()["items"]]

    pin_clock(me.monkeypatch, datetime(2026, 10, 18, 15, 59))
    assert _days(_upcoming(client, who), rent)[0] == "2026-10-19"
    assert listed(start_date=_start("2026-10-19"))  # Upcoming for Oct 18
    assert not listed(end_date=_end("2026-10-18"))  # the main list for Oct 18

    pin_clock(me.monkeypatch, datetime(2026, 10, 18, 16, 1))
    assert _days(_upcoming(client, who), rent)[0] == "2026-11-19"
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert [p["occurrence_date"] for p in r.json()["payables"]
            if p.get("source") == "budget_entry" and p.get("source_id") == rent
            ][:1] == ["2026-10-19"]
    assert listed(end_date=_end("2026-10-19"))  # the main list for Oct 19
    assert not listed(start_date=_start("2026-10-20"))  # Upcoming for Oct 19


# --- links --------------------------------------------------------------------------------------

def test_linked_rows_stand_for_their_months(me):
    client, db, who = me.client, me.db, me.who
    savings = _account(client, who, "Savings", "savings", 0)
    params = {"start_date": _start("2026-11-01"), "end_date": _end("2027-01-31")}
    posted = _entry(client, who, me.checking, "2026-11-05", "Posted")
    _row(db, who, me.checking, "2026-11-05", entry_id=posted, posted=True)
    pending = _entry(client, who, me.checking, "2026-11-05", "Pending")
    _row(db, who, me.checking, "2026-11-05", entry_id=pending)
    moved = _entry(client, who, me.checking, "2026-11-05", "Moved")
    _row(db, who, savings, "2026-11-05", entry_id=moved, occurrence="2026-11-05")
    kept = _entry(client, who, me.checking, "2026-11-05", "Kept")
    _row(db, who, me.checking, "2026-11-05", entry_id=kept, occurrence="2026-11-05")
    by_hand = _entry(client, who, me.checking, "2026-11-05", "By hand")
    _row(db, who, me.checking, "2026-11-07", entry_id=by_hand)  # off the schedule
    _row(db, who, me.checking, "2026-12-05", entry_id=by_hand)

    body = _upcoming(client, who, **params)
    assert {e: _days(body, e) for e in (posted, pending, moved, kept, by_hand)} == {
        posted: ["2026-12-05", "2027-01-05"],
        pending: ["2026-12-05", "2027-01-05"],
        moved: ["2026-11-05", "2026-12-05", "2027-01-05"],
        kept: ["2026-12-05", "2027-01-05"],
        by_hand: ["2026-11-05", "2027-01-05"],
    }


def test_two_rows_on_a_clamped_day_stand_for_it_once(me):
    """Days 30 and 31 both fall on Feb 28: one occurrence, which two rows on that
    day stand for once; the second row stands for nothing else."""
    client, db, who = me.client, me.db, me.who
    gym = _entry(client, who, me.checking, "2027-01-30", "Gym", cadence="semi_monthly",
                 semi_monthly_day_1=30, semi_monthly_day_2=31)
    for _ in range(2):
        _row(db, who, me.checking, "2027-02-28", entry_id=gym)

    body = _upcoming(client, who, start_date=_start("2027-01-01"), end_date=_end("2027-03-31"))
    assert _days(body, gym) == ["2027-01-30", "2027-01-31", "2027-03-30", "2027-03-31"]


# --- not shown ----------------------------------------------------------------------------------

def test_paused_ended_and_accountless_entries_are_not_listed(me):
    client, db, who = me.client, me.db, me.who
    rent = _entry(client, who, me.checking, "2026-11-01", "Rent")
    gym = _entry(client, who, me.checking, "2026-11-01", "Gym")
    _put(client, who, gym, {"is_active": False})
    course = _entry(client, who, me.checking, "2026-11-01", "Course",
                    end_mode="after_occurrences", max_occurrences=1)
    r = client.post(f"{API}/budget-entries/{course}/materialize", json={},
                    headers=who["headers"])
    assert r.status_code == 201, r.text
    lapsed = _entry(client, who, me.checking, "2026-09-01", "Lapsed")
    _set(db, lapsed, end_mode="on_date", end_date=datetime(2026, 10, 10), is_active=False)
    ending = _entry(client, who, me.checking, "2026-09-01", "Ending")
    _set(db, ending, end_mode="on_date", end_date=datetime(2026, 10, 10))
    _entry(client, who, None, "2026-11-01", "Loose cash")

    body = _upcoming(client, who, start_date=_start("2026-11-01"), end_date=_end("2026-11-30"))
    assert _pairs(body) == [("2026-11-01", rent)]

    _put(client, who, gym, {"is_active": True})
    assert gym in [i["entry_id"] for i in _upcoming(client, who)["items"]]


def test_limited_views_are_dropped_and_shared_editors_listed(sw, sw_client, sw_db, monkeypatch):
    client = sw_client
    a, b, v, d, s = sw["a"], sw["b"], sw["v"], sw["d"], sw["s"]
    joint_rent = _entry(client, a, sw["joint"], "2026-11-05", "Joint rent")
    private = _entry(client, a, sw["a_private"], "2026-11-05", f"{PRIVATE} bill")
    pin_clock(monkeypatch, REF)
    params = {"start_date": _start("2026-11-01"), "end_date": _end("2026-11-30")}

    bodies = {k: _upcoming(client, w, **params) for k, w in
              (("a", a), ("b", b), ("d", d), ("v", v), ("s", s))}
    assert [(i["entry_id"], i["view"], i["can_mark_paid"], i["recordable"])
            for i in bodies["a"]["items"]] == [
        (joint_rent, "full", True, True), (private, "full", True, True)]
    for k in ("b", "d"):
        assert [(i["entry_id"], i["view"], i["can_mark_paid"], i["recordable"],
                 i["account_name"]) for i in bodies[k]["items"]] == [
            (joint_rent, "shared_full", True, True, "Joint account")]
    assert bodies["v"]["items"] == []  # their view of it is Limited
    assert bodies["s"]["items"] == []
    for k in ("b", "d", "v", "s"):
        assert PRIVATE not in json.dumps(bodies[k])
        assert sw_leaks(bodies[k], private_ids=[private]) == []


def test_a_tag_viewer_gets_nothing(hh, sw_client, monkeypatch):
    client, a, c = sw_client, hh["a"], hh["c"]
    rent = _entry(client, a, hh["joint"], "2026-11-05", "Joint rent")
    pin_clock(monkeypatch, REF)
    assert _days(_upcoming(client, a), rent)[0] == "2026-11-05"
    assert _upcoming(client, c)["items"] == []


# --- capped and auto-post -----------------------------------------------------------------------

def test_a_capped_entry_lists_its_remaining_months_and_records_the_first(me):
    client, who = me.client, me.who
    sofa = _entry(client, who, me.checking, "2026-11-10", "Sofa",
                  end_mode="after_occurrences", max_occurrences=3)
    body = _upcoming(client, who)
    assert [(i["occurrence_date"], i["capped"], i["recordable"]) for i in body["items"]
            if i["entry_id"] == sofa] == [
        ("2026-11-10", True, True), ("2026-12-10", True, False), ("2027-01-10", True, False)]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    return make_world(sw_client, sw_db, sw_people, monkeypatch)


def test_card_installments_carry_their_auto_post_state(world):
    w, db = world, world["db"]
    on = _installment(w, name="On", next_day="2026-11-05", remaining=3)
    _flags(db, on, reviewed=True, on=True)
    off = _installment(w, name="Off", next_day="2026-11-05", remaining=3)
    _flags(db, off, reviewed=True, on=False)
    unreviewed = _installment(w, name="Unreviewed", next_day="2026-11-05", remaining=3)
    _flags(db, unreviewed, reviewed=False, on=False)

    def rows(who, entry_id):
        return [(i["occurrence_date"], i["auto_post"], i["recordable"], i["can_review"],
                 i["can_mark_paid"], i["block_reason"])
                for i in _upcoming(w["client"], w[who])["items"] if i["entry_id"] == entry_id]

    months = ["2026-11-05", "2026-12-05", "2027-01-05"]
    # Auto-post on: never recordable by hand, the first month included.
    assert rows("o", on) == [(m, "on", False, True, True, None) for m in months]
    assert rows("o", off) == [(m, "off", m == months[0], True, True, None) for m in months]
    assert rows("o", unreviewed) == [
        (m, "unreviewed", m == months[0], True, True, None) for m in months]
    assert rows("e", unreviewed) == rows("o", unreviewed)  # an editor can review
    for who in ("v", "t"):  # Limited: no row at all
        assert _upcoming(w["client"], w[who])["items"] == []


def test_review_is_offered_only_to_whom_it_can_be(world):
    """The creator turned viewer of the card keeps a full view of their own
    installment but can neither record nor review it; a foreign-currency
    installment cannot be reviewed for auto-post at all."""
    w, db = world, world["db"]
    eli = _installment(w, name="Eli's", next_day="2026-11-05", remaining=2, who=w["e"])
    _flags(db, eli, reviewed=False, on=False)
    db.execute(text("UPDATE account_shares SET role = 'viewer' WHERE account_id = :card "
                    "AND user_id = :e"), {"card": w["card"], "e": w["e"]["id"]})
    db.commit()
    usd = _installment(w, name="Usd", next_day="2026-11-05", remaining=2, currency="USD")
    _flags(db, usd, reviewed=False, on=False)

    items = _upcoming(w["client"], w["e"])["items"]
    assert [(i["view"], i["auto_post"], i["can_mark_paid"], i["recordable"], i["can_review"])
            for i in items if i["entry_id"] == eli] == [
        ("full", "unreviewed", False, False, False)] * 2
    items = _upcoming(w["client"], w["o"])["items"]
    assert [(i["auto_post"], i["can_review"], i["recordable"]) for i in items
            if i["entry_id"] == usd] == [("unreviewed", False, True), ("unreviewed", False, False)]


# --- long-stale history -------------------------------------------------------------------------

def test_a_long_stale_entry_walks_its_history(me):
    client, db, who = me.client, me.db, me.who
    rent = _entry(client, who, me.checking, "2026-11-20", "Rent")
    _set(db, rent, next_occurrence=datetime(2016, 10, 20))
    capped = _entry(client, who, me.checking, "2026-11-20", "Loan", amount=500,
                    end_mode="after_occurrences", max_occurrences=12)
    _set(db, capped, next_occurrence=datetime(2023, 10, 20))

    body = _upcoming(client, who, limit=500)

    months = [date(2026 + (9 + i) // 12, (9 + i) % 12 + 1, 20) for i in range(24)]
    assert months[0] == date(2026, 10, 20) and months[-1] == date(2028, 9, 20)
    assert _days(body, rent) == [m.isoformat() for m in months]
    # Its 12 months were all due in its unrecorded history: none is left to list.
    assert _days(body, capped) == []


# --- included -----------------------------------------------------------------------------------

def test_wallet_spending_card_subscriptions_and_transfers_are_listed(me):
    client, who = me.client, me.who
    card = _card(client, who, me.checking)
    wallet = _account(client, who, "GCash", "checking", 2_000, is_spending_wallet=True)
    savings = _account(client, who, "Savings", "savings", 0)
    coffee = _entry(client, who, wallet, "2026-11-01", "Coffee", amount=150)
    spotify = _entry(client, who, card, "2026-11-02", "Spotify", amount=279)
    save = _entry(client, who, me.checking, "2026-11-03", "Save",
                  transfer_to_account_id=savings)

    body = _upcoming(client, who, start_date=_start("2026-11-01"), end_date=_end("2026-11-30"))
    assert [(i["entry_id"], i["kind"], i["is_transfer"], i["account_name"],
             i["transfer_to_account_name"], i["recordable"]) for i in body["items"]] == [
        (coffee, "cash", False, "GCash", None, True),
        (spotify, "subscription", False, "Card C", None, True),
        (save, None, True, "Checking", "Savings", True)]


# --- filters ------------------------------------------------------------------------------------

def test_filters(sw, sw_client, sw_db, monkeypatch):
    client = sw_client
    a, b = sw["a"], sw["b"]
    savings = _account(client, a, "Savings", "savings", 0)
    food = sw_post(client, a, "/categories/", {"name": "Food"})["id"]
    groceries = _entry(client, a, sw["joint"], "2026-11-01", "Groceries", category_id=food)
    salary = _entry(client, a, sw["joint"], "2026-11-02", "Salary", entry_type="income")
    save = _entry(client, a, sw["joint"], "2026-11-03", "Save", transfer_to_account_id=savings)
    gym = _entry(client, a, savings, "2026-11-04", "Gym")
    bea = _entry(client, b, sw["joint"], "2026-11-05", "Bea bill")
    tag = sw_post(client, a, "/tags/", {"name": "Home"}, expect=(201,))["id"]
    _put(client, a, gym, {"tag_ids": [tag]})
    pin_clock(monkeypatch, REF)

    def ids(**params):
        body = _upcoming(client, a, start_date=_start("2026-11-01"),
                         end_date=_end("2026-11-30"), **params)
        return [i["entry_id"] for i in body["items"]]

    assert ids() == [groceries, salary, save, gym, bea]
    assert ids(account_ids=[savings]) == [save, gym]
    assert ids(account_ids=[sw["s_bank"]]) == []  # not viewable: matches nothing
    assert ids(account_ids=[sw["s_bank"], savings]) == [save, gym]
    assert ids(transaction_types=["debit"]) == [groceries, gym, bea]
    assert ids(transaction_types=["credit"]) == [salary]
    assert ids(transaction_types=["transfer"]) == [save]
    assert ids(transaction_types=["CREDIT", "transfer"]) == [salary, save]
    assert ids(category_names=["Food"]) == [groceries]
    assert ids(uncategorized=True) == [salary, gym, bea]
    assert ids(category_names=["Food"], uncategorized=True) == [groceries, salary, gym, bea]
    assert ids(category_names=["Nope"]) == []
    assert ids(entered_by="me") == [groceries, salary, save, gym]
    assert ids(search="ALA") == [salary]
    assert ids(tag=tag) == [gym]
    assert ids(tag=999_999_999) == []

    r = client.get(f"{API}/budget-entries/upcoming-occurrences", headers=a["headers"],
                   params={"transaction_types": ["bogus"]})
    assert r.status_code == 400, r.text


def test_category_filters_read_the_shown_category(me, sw_people):
    """A category counts only while its creator owns it and keeps it active
    (``Redactor.category_name``): an entry pointing at an inactive category or
    at another user's reads as uncategorized, whatever the stored name."""
    client, db, who = me.client, me.db, me.who
    other = sw_people("Oscar", "Other")
    food = sw_post(client, who, "/categories/", {"name": "Food"})["id"]
    old = sw_post(client, who, "/categories/", {"name": "Old"})["id"]
    theirs = sw_post(client, other, "/categories/", {"name": "Food"})["id"]
    groceries = _entry(client, who, me.checking, "2026-11-01", "Groceries", category_id=food)
    stale = _entry(client, who, me.checking, "2026-11-02", "Stale", category_id=old)
    foreign = _entry(client, who, me.checking, "2026-11-03", "Foreign")
    db.execute(text("UPDATE categories SET is_active = false WHERE id = :id"), {"id": old})
    db.commit()
    _set(db, foreign, category_id=theirs)

    def ids(**params):
        body = _upcoming(client, who, start_date=_start("2026-11-01"),
                         end_date=_end("2026-11-30"), **params)
        return [i["entry_id"] for i in body["items"]]

    assert ids(category_names=["Food"]) == [groceries]
    assert ids(category_names=["Old"]) == []
    assert ids(uncategorized=True) == [stale, foreign]


def _lost_share(sw, sw_client, sw_db, monkeypatch) -> int:
    """Bea's own entry on the joint account, after her share of it is removed:
    she still reads the entry (its creator), but not the account."""
    from app.models.account_share import AccountShare

    bill = _entry(sw_client, sw["b"], sw["joint"], "2026-11-05", "Bea bill")
    sw_db.query(AccountShare).filter(AccountShare.id == sw["shares"]["b"]).delete()
    sw_db.commit()
    pin_clock(monkeypatch, REF)
    return bill


def test_an_entry_on_an_account_the_caller_cannot_view_is_not_listed(
        sw, sw_client, sw_db, monkeypatch):
    """A creator who can no longer view the entry's account sees it Limited
    (``view_all`` needs every touched account viewable), so it is not listed,
    and no listed row ever names an account its caller cannot view."""
    bill = _lost_share(sw, sw_client, sw_db, monkeypatch)
    a_body = _upcoming(sw_client, sw["a"])
    assert bill in [i["entry_id"] for i in a_body["items"]]  # listed to the owner
    body = _upcoming(sw_client, sw["b"])
    assert bill not in [i["entry_id"] for i in body["items"]]
    assert "Joint account" not in json.dumps(body)


# --- the route ----------------------------------------------------------------------------------

def test_the_route_is_declared_before_the_entry_route(me):
    client, who = me.client, me.who
    rent = _entry(client, who, me.checking, "2026-11-01", "Rent")
    r = client.get(f"{API}/budget-entries/upcoming-occurrences", headers=who["headers"])
    assert r.status_code == 200, r.text
    r = client.get(f"{API}/budget-entries/{rent}", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["id"] == rent
    r = client.get(f"{API}/budget-entries/upcoming-occurrences")
    assert r.status_code == 401

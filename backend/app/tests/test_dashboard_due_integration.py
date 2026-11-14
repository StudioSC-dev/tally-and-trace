"""``GET /dashboard/due``: the Transactions page's Due card in one request (STU-599, PERF-4).

On the realistic dataset (``app/tests/fixtures/realistic.py``), for each of its four
callers and a stranger:

- AC1: every list the response shares with ``/dashboard/snapshot`` equals the
  snapshot's;
- AC2: ``linked_pending`` equals ``GET /transactions?ids=...&is_posted=false`` for the
  same ids, and the two occurrence lists equal the two
  ``GET /budget-entries/upcoming-occurrences`` responses the card makes;
- ``unposted`` equals the unposted transactions list cut at the Manila day, without
  the limited rows the card never lists;
- AC4: a stranger gets 200 with nothing of anyone else's.

On small worlds of their own: the linked rows of missed occurrences (the fixture has
none), the Manila-day boundary of ``unposted``, and (AC5) its paging over 450 overdue
rows. The statement and byte budgets (AC3) are in ``test_perf_budgets.py``.
"""
import json
from datetime import date, datetime, timedelta

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.fixtures.realistic import CALLERS, pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

SHARED = ("today", "payables", "upcoming_this_month", "card_charges", "missed",
          "card_statements_due", "installment_review", "installment_auto_post",
          "autopay_due", "auto_post_scheduled")
LISTS = ("payables", "upcoming_this_month", "card_charges", "missed", "card_statements_due",
         "installment_review", "installment_auto_post", "autopay_due", "linked_pending")


def _get(client, headers, path, **params):
    r = client.get(f"{API}{path}", headers=headers, params=params)
    assert r.status_code == 200, (path, r.status_code, r.text[:500])
    return r.json()


def _due(client, headers, **params):
    return _get(client, headers, "/dashboard/due", **params)


def _linked_ids(body) -> list:
    ids = set()
    for card in body["card_charges"]:
        for m in card["missed"]:
            ids.update(m["pending_transaction_ids"])
    for m in body["missed"]:
        ids.update(m["pending_transaction_ids"])
    return sorted(ids)


def _window(today: date):
    return (f"{today + timedelta(days=1)}T00:00:00",
            f"{today + timedelta(days=30)}T23:59:59.999999Z")


# --- the realistic dataset, every caller -------------------------------------------------------

@pytest.fixture(scope="module")
def stranger(realistic, sw_client):
    from app.core.database import SessionLocal
    from app.tests.fixtures import golden

    db = SessionLocal()
    who = golden.make_stranger(sw_client, db, tag="due")
    try:
        yield who
    finally:
        golden.remove_stranger(db, who)
        db.close()


@pytest.mark.parametrize("caller", CALLERS)
def test_shared_lists_equal_the_snapshots(realistic, sw_client, caller):
    """AC1: the lists the card reads are the snapshot's own, field for field."""
    headers = realistic.callers[caller].headers
    snapshot = _get(sw_client, headers, "/dashboard/snapshot")
    due = _due(sw_client, headers)
    assert {k: due[k] for k in SHARED} == {k: snapshot[k] for k in SHARED}
    assert due["today"] == realistic.today.isoformat()


def test_the_owners_lists_are_not_empty(realistic, sw_client):
    """The comparisons above compare something: the owner has rows in every kind."""
    due = _due(sw_client, realistic.callers["owner"].headers)
    for key in ("payables", "upcoming_this_month", "card_charges", "missed",
                "card_statements_due"):
        assert due[key], key
    assert due["upcoming_occurrences"]["items"] and due["subscription_occurrences"]["items"]
    assert due["unposted"]["total"] > 0


@pytest.mark.parametrize("caller", CALLERS)
def test_linked_rows_and_occurrences_equal_the_cards_requests(realistic, sw_client, caller):
    """AC2 on the dataset: the rows the card fetched in a second round, and its two
    occurrence requests, come in the one response unchanged."""
    headers = realistic.callers[caller].headers
    due = _due(sw_client, headers)
    ids = _linked_ids(due)
    if ids:
        listed = _get(sw_client, headers, "/transactions/", ids=ids, is_posted="false",
                      limit=len(ids))
        assert due["linked_pending"] == listed["items"]
    else:
        assert due["linked_pending"] == []
    start, end = _window(realistic.today)
    for key, plan in (("upcoming_occurrences", "none"),
                      ("subscription_occurrences", "subscription")):
        assert due[key] == _get(sw_client, headers, "/budget-entries/upcoming-occurrences",
                                start_date=start, end_date=end, plan=plan, limit=500), key


@pytest.mark.parametrize("caller", CALLERS)
def test_unposted_is_the_pending_list_through_today_without_limited_rows(
        realistic, sw_client, caller):
    headers = realistic.callers[caller].headers
    due = _due(sw_client, headers)
    listed = _get(sw_client, headers, "/transactions/", is_posted="false",
                  end_date=f"{realistic.today}T23:59:59.999999", limit=1000)
    assert listed["has_more"] is False
    want = [t for t in listed["items"] if t["view"] != "limited"]
    page = due["unposted"]
    assert page["items"] == want[:200]
    assert (page["total"], page["page"], page["page_size"], page["has_more"]) == (
        len(want), 1, 200, len(want) > 200)
    if caller == "viewer":  # every pending row the viewer reads is limited
        assert listed["items"] and not want


def test_a_stranger_sees_nothing(realistic, sw_client, stranger):
    """AC4: a user with no role on anything gets an empty answer, not someone else's."""
    due = _due(sw_client, stranger.headers)
    for key in LISTS:
        assert due[key] == [], key
    for key in ("upcoming_occurrences", "subscription_occurrences"):
        assert (due[key]["items"], due[key]["total"]) == ([], 0)
    assert (due["unposted"]["items"], due["unposted"]["total"]) == ([], 0)
    owner = _due(sw_client, realistic.callers["owner"].headers)
    names = {t["description"] for t in owner["unposted"]["items"]}
    assert not any(name in json.dumps(due) for name in names)


def test_conditional_get(realistic, sw_client):
    """Opted in to ETag/304 (PERF-7): a repeat with the tag is a bodiless 304, and
    another page of ``unposted`` is another tag."""
    headers = realistic.callers["owner"].headers
    first = sw_client.get(f"{API}/dashboard/due", headers=headers)
    tag = first.headers["etag"]
    again = sw_client.get(f"{API}/dashboard/due", headers={**headers, "If-None-Match": tag})
    assert again.status_code == 304 and again.content == b""
    other = sw_client.get(f"{API}/dashboard/due?unposted_page=2", headers=headers)
    assert other.status_code == 200 and other.headers["etag"] != tag


# --- small worlds ---------------------------------------------------------------------------

# Friday 2026-11-13, 15:30 UTC: 23:30 on Friday in Manila, so the UTC day and the
# Manila day are the same, and Manila's tomorrow is half an hour away.
NOW = datetime(2026, 11, 13, 15, 30)


@pytest.fixture
def me(sw_client, sw_people, monkeypatch):
    pin_clock(monkeypatch, NOW)
    who = sw_people("Due", "Owner")
    checking = sw_post(sw_client, who, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 50_000})["id"]
    return who, checking


def _debit(client, who, account_id, when, description, posted=False, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": 100,
        "description": description, "transaction_date": when, "is_posted": posted,
        **extra})["id"]


def test_linked_pending_rows_of_missed_occurrences(sw_client, me):
    """AC2: a pending row a missed occurrence links is in ``linked_pending`` as the
    transactions list shows it, whatever its date."""
    client, (who, checking) = sw_client, me
    rent = sw_post(client, who, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 1_000, "cadence": "monthly",
        "next_occurrence": "2026-08-13T00:00:00", "account_id": checking})["id"]
    aug = _debit(client, who, checking, "2026-08-13T00:00:00", "Rent Aug", budget_entry_id=rent)
    sep = _debit(client, who, checking, "2026-09-13T00:00:00", "Rent Sep", budget_entry_id=rent)
    due = _due(client, who["headers"])
    assert _linked_ids(due) == sorted([aug, sep])
    listed = _get(client, who["headers"], "/transactions/", ids=[aug, sep], is_posted="false",
                  limit=2)
    assert due["linked_pending"] == listed["items"]
    assert [t["id"] for t in due["linked_pending"]] == [sep, aug]


def test_unposted_ends_at_the_manila_day(sw_client, me):
    """Rows dated on or before today are listed, later ones are not (they are the
    upcoming-transactions request's), and posted rows never are."""
    client, (who, checking) = sw_client, me
    old = _debit(client, who, checking, "2026-10-01T09:00:00", "Old")
    last = _debit(client, who, checking, "2026-11-13T23:59:59", "Last of today")
    _debit(client, who, checking, "2026-11-14T00:00:00", "Tomorrow")
    _debit(client, who, checking, "2026-11-20T00:00:00", "Next week")
    _debit(client, who, checking, "2026-11-01T00:00:00", "Posted", posted=True)
    page = _due(client, who["headers"])["unposted"]
    assert [t["id"] for t in page["items"]] == [last, old]
    assert (page["total"], page["has_more"]) == (2, False)


def test_unposted_pages_of_200(sw_client, sw_db, me):
    """AC5: 450 overdue unposted rows come as 200, 200 and 50, newest first, each page
    with the exact total; a page past the end is empty with the same total."""
    from app.models.transaction import Transaction

    client, (who, checking) = sw_client, me
    template = sw_db.get(Transaction, _debit(client, who, checking, "2026-01-01T00:00:00",
                                             "Overdue 0"))
    copy = {c.name: getattr(template, c.name) for c in Transaction.__table__.columns
            if c.name not in ("id", "created_at", "updated_at")}
    start = datetime(2026, 1, 1)
    sw_db.add_all([Transaction(**{**copy, "description": f"Overdue {n}",
                                  "transaction_date": start + timedelta(hours=n)})
                   for n in range(1, 450)])
    sw_db.commit()

    pages = [_due(client, who["headers"], unposted_page=n)["unposted"] for n in (1, 2, 3, 4)]
    assert [len(p["items"]) for p in pages] == [200, 200, 50, 0]
    assert {p["total"] for p in pages} == {450}
    assert [p["has_more"] for p in pages] == [True, True, False, False]
    assert [p["page"] for p in pages] == [1, 2, 3, 4]
    got = [t["description"] for p in pages for t in p["items"]]
    assert got == [f"Overdue {n}" for n in range(449, -1, -1)]
    r = client.get(f"{API}/dashboard/due?unposted_page=0", headers=who["headers"])
    assert r.status_code == 422

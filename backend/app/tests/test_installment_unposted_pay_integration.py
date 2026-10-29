"""Unposted installment months on card statements (STU-343 Plan B, B2 commit 7).
Skips without a database.

Reference Sunday 2026-10-18, 10:00 in Manila. O owns Checking (50,000) and Card
C (closes on the 24th, due 21 days later, paid from Checking, limit 128,000).
A is an admin, E an editor and V a viewer on Card C. "Tablet" is O's 5,000 on
the 5th, capped at 24, next 2026-07-05: Jul 5 to Oct 5 are due. Jul 5, Aug 5
and Sep 5 are on cycles that closed on Jul 24, Aug 24 and Sep 24 (due Aug 14,
Sep 14 and Oct 15); Oct 5 is on the cycle closing Oct 24, still open.

An unposted month is a due month of an active, reviewed card installment that
no posted row stands for, with no pending linked row and not held, on a cycle
that closed before Manila's today. ``postable`` is whether the caller's Post
now would record it (``posting.post_plan``). Reviewed and auto-post flags are
written straight to the row.
"""
import sys
from datetime import date, datetime

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_leaks, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 18, 2, 0)  # Sunday, 10:00 in Manila


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name, account_type, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    client, db = sw_client, sw_db
    o = sw_people("Olive", "Owner")
    a = sw_people("Ada", "Admin")
    e = sw_people("Eli", "Editor")
    v = sw_people("Vic", "Viewer")
    checking = _account(client, o, "Checking", "checking", 50_000)
    card = _account(client, o, "Card C", "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking,
                    credit_limit=128_000)
    sw_share(db, card, a["id"], "admin", o["id"])
    sw_share(db, card, e["id"], "editor", o["id"])
    sw_share(db, card, v["id"], "viewer", o["id"])
    pin_clock(monkeypatch, REF)
    return {"client": client, "db": db, "o": o, "a": a, "e": e, "v": v,
            "checking": checking, "card": card}


def _installment(w, name="Tablet", next_day="2026-07-05", remaining=24, card=None,
                 reviewed=True, on=True, amount=5_000):
    entry_id = sw_post(w["client"], w["o"], "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": card or w["card"],
        "end_mode": "after_occurrences", "max_occurrences": remaining})["id"]
    w["db"].execute(text(
        "UPDATE budget_entries SET installment_reviewed_at = CASE WHEN :r THEN now() "
        "ELSE NULL END, auto_post_enabled = :on WHERE id = :id"),
        {"r": reviewed, "on": on, "id": entry_id})
    w["db"].commit()
    return entry_id


def _txn(w, when, amount=5_000, kind="debit", card=None, **extra):
    return sw_post(w["client"], w["o"], "/transactions/", {
        "account_id": card or w["card"], "amount": amount, "transaction_type": kind,
        "description": "Card line", "transaction_date": f"{when}T00:00:00",
        "is_posted": True, **extra})["id"]


def _detail(w, who=None, card=None, expect=200):
    r = w["client"].get(f"{API}/cards/{card or w['card']}/credit",
                        headers=(who or w["o"])["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _per_statement(w, who=None, card=None):
    """``{close: (unposted_installments, unposted_postable)}`` of the Pay statements."""
    return {s["close_date"]: (s["unposted_installments"], s["unposted_postable"])
            for s in _detail(w, who, card)["statements"]}


def _due_rows(w, who=None):
    r = w["client"].get(f"{API}/dashboard/snapshot", headers=(who or w["o"])["headers"])
    assert r.status_code == 200, r.text
    return {row["account_id"]: row for row in r.json()["card_statements_due"]}


def _backstop(w, who=None):
    r = w["client"].post(f"{API}/budget-entries/post-due-installments",
                         json={"trigger": "button"}, headers=(who or w["o"])["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _months(w, who, card=None):
    from app.models.account import Account
    from app.models.user import User
    from app.services.card_credit import unposted_months

    db = w["db"]
    db.rollback()
    db.expire_all()
    return unposted_months(db, db.get(Account, card or w["card"]), db.get(User, who["id"]))


def test_unposted_summary_with_no_recorded_statements(world):
    w = world
    _installment(w)

    detail = _detail(w)
    assert detail["statements"] == []
    assert detail["unposted"] == {"count": 3, "postable": 3, "oldest_close": "2026-07-24",
                                  "oldest_due": "2026-08-14"}
    assert _due_rows(w)[w["card"]] == {
        "account_id": w["card"], "name": "Card C", "currency": "PHP",
        "close_date": "2026-09-24", "due_date": "2026-10-15", "clear_through": 0,
        "statement_count": 3, "oldest_due": "2026-08-14", "overdue": True,
        "incomplete": False, "unposted_installments": 3, "unposted_postable": 3}

    assert _backstop(w)["posted"] == 4

    assert _detail(w)["unposted"] is None
    assert _due_rows(w)[w["card"]] == {
        "account_id": w["card"], "name": "Card C", "currency": "PHP",
        "close_date": "2026-09-24", "due_date": "2026-10-15", "clear_through": 15_000,
        "statement_count": 3, "oldest_due": "2026-08-14", "overdue": True,
        "incomplete": False, "unposted_installments": 0, "unposted_postable": 0}


def test_unposted_counts_are_cumulative_on_recorded_statements(world):
    w = world
    _txn(w, "2026-06-30", 1_000)
    _installment(w)

    assert _per_statement(w) == {"2026-07-24": (1, 1), "2026-08-24": (2, 2),
                                 "2026-09-24": (3, 3)}
    row = _due_rows(w)[w["card"]]
    assert (row["clear_through"], row["statement_count"], row["oldest_due"],
            row["unposted_installments"], row["unposted_postable"]) == (
        1_000, 3, "2026-08-14", 3, 3)


def test_unposted_only_row_is_gated_by_the_window(world):
    """Card L closes on the 17th, due 45 days later. Oct 10's cycle closed on Oct
    17 and is due Dec 1, after the window's end (Nov 18): no row."""
    w = world
    card_l = _account(w["client"], w["o"], "Card L", "credit", billing_cycle_start=17,
                      days_until_due_date=45, payment_account_id=w["checking"])
    _installment(w, name="Lamp", next_day="2026-10-10", card=card_l)

    assert card_l not in _due_rows(w)
    assert _detail(w, card=card_l)["unposted"] == {
        "count": 1, "postable": 1, "oldest_close": "2026-10-17", "oldest_due": "2026-12-01"}


def test_unposted_split_postable_vs_blocked(world):
    """Tablet's Aug 5 is held by O's Aug 7 charge: Jul 5 and Sep 5 count, and only
    Jul 5 is postable (Sep 5 is behind the held month). "Off" has Sep 5 due and
    auto-post off: it counts and is not postable."""
    w = world
    _installment(w)
    _txn(w, "2026-08-07")
    _installment(w, name="Off", next_day="2026-09-05", remaining=12, on=False)

    assert _detail(w)["unposted"] == {"count": 3, "postable": 1,
                                      "oldest_close": "2026-07-24", "oldest_due": "2026-08-14"}
    assert _per_statement(w) == {"2026-08-24": (1, 1), "2026-09-24": (3, 1)}
    row = _due_rows(w)[w["card"]]
    assert (row["unposted_installments"], row["unposted_postable"]) == (3, 1)


def test_paid_card_with_unposted_months_counts_only_those_months(world):
    """A 3,000 debit on May 30 (statement Jun 24) and a 5,000 refund on Aug 30
    (statement Sep 24): the refund's net credit pays June, so nothing is owed
    and the latest ``clear_through`` is 0."""
    from app.models.account import Account
    from app.models.user import User
    from app.services.card_credit import closed_statements

    w = world
    db = w["db"]
    _txn(w, "2026-05-30", 3_000)
    _txn(w, "2026-08-30", 5_000, kind="credit")

    db.rollback()
    db.expire_all()
    closed = closed_statements(db, db.get(User, w["o"]["id"]), db.get(Account, w["card"]), None)
    assert closed and all(s["owed"] == 0 and s["status"] == "paid" for s in closed)
    assert closed[-1]["clear_through"] == 0
    assert w["card"] not in _due_rows(w)

    _installment(w)

    row = _due_rows(w)[w["card"]]
    assert (row["clear_through"], row["statement_count"], row["oldest_due"], row["overdue"],
            row["unposted_installments"]) == (0, 3, "2026-08-14", True, 3)


def test_recorded_overdue_keeps_the_statement_status(world):
    w = world
    _txn(w, "2026-05-30", 3_000)
    row = _due_rows(w)[w["card"]]
    assert {k: row[k] for k in ("clear_through", "statement_count", "oldest_due", "overdue",
                                "unposted_installments", "unposted_postable")} == {
        "clear_through": 3_000, "statement_count": 1, "oldest_due": "2026-07-15",
        "overdue": True, "unposted_installments": 0, "unposted_postable": 0}

    # Card L: a 2,000 charge on Sep 10 (statement Sep 17, due Nov 1) and an
    # installment whose only month, Sep 10, is unposted on that same cycle.
    card_l = _account(w["client"], w["o"], "Card L", "credit", billing_cycle_start=17,
                      days_until_due_date=45, payment_account_id=w["checking"])
    _txn(w, "2026-09-10", 2_000, card=card_l)
    _installment(w, name="Lamp", next_day="2026-09-10", remaining=1, card=card_l)

    statuses = {s["close_date"]: s["status"] for s in _detail(w, card=card_l)["statements"]}
    assert statuses["2026-09-17"] != "overdue"
    row = _due_rows(w)[card_l]
    assert (row["clear_through"], row["statement_count"], row["oldest_due"], row["overdue"],
            row["unposted_installments"]) == (2_000, 1, "2026-11-01", False, 1)


def test_unposted_count_skips_held_and_pending_linked_months(world):
    """Aug 5 is held by O's Aug 7 charge, and Sep 5 has a pending linked row (on
    the card already, and posting it posts that row): only Jul 5 counts."""
    w = world
    _txn(w, "2026-06-30", 1_000)
    tablet = _installment(w)
    _txn(w, "2026-08-07")
    _txn(w, "2026-09-05", budget_entry_id=tablet, is_posted=False)

    assert _per_statement(w) == {"2026-07-24": (1, 1), "2026-08-24": (1, 1),
                                 "2026-09-24": (1, 1)}
    assert _detail(w)["unposted"]["count"] == 1


def test_unposted_count_ignores_unreviewed_entries(world):
    w = world
    _txn(w, "2026-06-30", 1_000)
    _installment(w, reviewed=False, on=False)

    assert _per_statement(w) == {"2026-07-24": (0, 0), "2026-08-24": (0, 0),
                                 "2026-09-24": (0, 0)}
    assert _detail(w)["unposted"] is None
    row = _due_rows(w)[w["card"]]
    assert (row["statement_count"], row["unposted_installments"], row["unposted_postable"]) \
        == (1, 0, 0)


def test_unposted_count_includes_reviewed_entries_with_auto_post_off(world):
    w = world
    _txn(w, "2026-06-30", 1_000)
    _installment(w, on=False)

    assert _per_statement(w) == {"2026-07-24": (1, 0), "2026-08-24": (2, 0),
                                 "2026-09-24": (3, 0)}
    assert _detail(w)["unposted"] == {"count": 3, "postable": 0,
                                      "oldest_close": "2026-07-24", "oldest_due": "2026-08-14"}


def test_unposted_count_is_for_card_managers_only(world):
    w = world
    _txn(w, "2026-06-30", 1_000)
    _installment(w)

    row = _due_rows(w)[w["card"]]
    assert row["unposted_installments"] == 3
    assert sw_leaks(row, numbers=[5000]) == []
    assert _due_rows(w, w["a"])[w["card"]] == row
    for who in (w["e"], w["v"]):
        assert w["card"] not in _due_rows(w, who)
        _detail(w, who, expect=404)


def test_unposted_postable_follows_the_caller(world):
    """``postable`` is the caller's ``post_plan``: the owner and the admin can post
    every month; the viewer cannot edit the card, so none is postable for them."""
    w = world
    _installment(w)

    def summary(who):
        return [(m.day, m.close, m.due, m.postable) for m in _months(w, who)]

    owner = summary(w["o"])
    assert owner == [
        (date(2026, 7, 5), date(2026, 7, 24), date(2026, 8, 14), True),
        (date(2026, 8, 5), date(2026, 8, 24), date(2026, 9, 14), True),
        (date(2026, 9, 5), date(2026, 9, 24), date(2026, 10, 15), True),
    ]
    assert summary(w["a"]) == owner
    assert summary(w["v"]) == [(day, close, due, False) for day, close, due, _ in owner]

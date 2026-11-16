"""An installment's last payment bills ``final_amount`` (STU-658). Skips without a database.

A card installment split from its total bills the total ÷ N rounded to the
centavo each month, and the last payment absorbs the difference, as Metrobank
and HSBC state. The entry stores that last figure as ``final_amount``; every
reader of a recurring occurrence's amount reads it through
``forecast.occurrence_amount``: ``final_amount`` on the last occurrence,
``amount`` on every other.

World (``hh``): owner A's card (cycle on the 15th, due 21 days later, paid from
A's private bank), and C, who holds A's Household tag share. "Laptop" is A's
10,000.00 installment over three months tagged Household: 3,333.33 on
2026-12-15 and 2027-01-15, then 3,333.34 on 2027-02-15. Each reader case runs
with no payments paid before import and with two (``occurrences_paid_offset``),
which must not change which occurrence is the last. Today is 2026-11-16 in
Manila unless a phase moves the clock.
"""
import sys
from datetime import date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 16, 2, 0)  # 10:00 in Manila
TOKEN = "test-job-token"
MONTHLY, LAST = 3333.33, 3333.34
DAYS = ["2026-12-15", "2027-01-15", "2027-02-15"]
CLOSES = [date(2026, 12, 15), date(2027, 1, 15), date(2027, 2, 15)]


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def on_day(monkeypatch, day: str) -> None:
    pin_clock(monkeypatch, datetime.fromisoformat(f"{day}T02:00:00"))


def _get(w, path, who=None, **params):
    r = w["client"].get(f"{API}{path}", params=params, headers=(who or w["a"])["headers"])
    assert r.status_code == 200, (path, r.text)
    return r.json()


def _laptop(w, offset=0, **extra) -> dict:
    body = {"name": "Laptop", "entry_type": "expense", "amount": MONTHLY, "final_amount": LAST,
            "cadence": "monthly", "next_occurrence": "2026-12-05T00:00:00",
            "end_mode": "after_occurrences", "max_occurrences": 3,
            "occurrences_paid_offset": offset, "account_id": w["a_card"],
            "tag_ids": [w["hh_a"]], **extra}
    return sw_post(w["client"], w["a"], "/budget-entries/", body)


@pytest.fixture
def world(hh, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "JOB_TOKEN", TOKEN)
    pin_clock(monkeypatch, REF)
    return {**hh, "client": hh.get("client"), "monkeypatch": monkeypatch}


@pytest.fixture
def w(world, sw_client, sw_db):
    return {**world, "client": sw_client, "db": sw_db}


def _txn_amounts(w, entry_id) -> list:
    w["db"].rollback()
    return [(r.occurrence_date.date().isoformat(), float(r.amount), r.is_posted)
            for r in w["db"].execute(text(
                "SELECT occurrence_date, amount, is_posted FROM transactions "
                "WHERE budget_entry_id = :e ORDER BY occurrence_date, id"), {"e": entry_id})]


def _mark_paid(w, entry_id, times) -> list:
    out = []
    for _ in range(times):
        r = w["client"].post(f"{API}/budget-entries/{entry_id}/materialize", json={},
                             headers=w["a"]["headers"])
        assert r.status_code == 201, r.text
        out.append((r.json()["transaction_date"][:10], r.json()["amount"]))
    return out


def _auto_post_off(w, entry_id) -> None:
    r = w["client"].post(f"{API}/budget-entries/{entry_id}/auto-post", json={"enabled": False},
                         headers=w["a"]["headers"])
    assert r.status_code == 200, r.text


def _first_two_paid(w, entry_id) -> None:
    """Phase B: the first two months recorded by Mark paid on 2027-02-01, so the
    last is the only one left."""
    _auto_post_off(w, entry_id)
    on_day(w["monkeypatch"], "2027-02-01")
    assert _mark_paid(w, entry_id, 2) == [(DAYS[0], MONTHLY), (DAYS[1], MONTHLY)]


# --- the reader cases -------------------------------------------------------------------------

def case_occurrence_expansion(w, entry):
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import _naive, iter_occurrences, occurrence_amount

    w["db"].expire_all()
    row = w["db"].get(BudgetEntry, entry["id"])
    walk = list(iter_occurrences(row, _naive(row.next_occurrence), datetime.max))
    assert [(o.date().isoformat(), float(occurrence_amount(row, o))) for o in walk] == [
        (DAYS[0], MONTHLY), (DAYS[1], MONTHLY), (DAYS[2], LAST)]
    rows = _get(w, "/transactions/scheduled")["items"]
    assert [(r["occurrence"]["occurrence_date"], r["occurrence"]["amount"]) for r in rows
            if r["kind"] == "occurrence" and r["occurrence"]["entry_id"] == entry["id"]] == [
        (DAYS[0], MONTHLY), (DAYS[1], MONTHLY), (DAYS[2], LAST)]


def case_forecast(w, entry):
    items = _get(w, "/forecast/upcoming", days=200)["items"]
    assert [(i["occurrence_date"], i["amount"]) for i in items
            if i["source"] == "budget_entry" and i["source_id"] == entry["id"]] == [
        (DAYS[0], MONTHLY), (DAYS[1], MONTHLY), (DAYS[2], LAST)]


def case_projection(w, entry):
    body = _get(w, "/forecast/timeline", days=200)
    statements = [(e["date"], e["amount"]) for e in body["events"]
                  if e["name"].endswith("card statement")]
    # Each statement holds one month, due 21 days after its close.
    assert statements == [("2027-01-05", -MONTHLY), ("2027-02-05", -MONTHLY),
                          ("2027-03-08", -LAST)]


def case_statement_engine(w, entry):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc
    from app.services.statements import get_statement_payables

    db = w["db"]
    db.expire_all()
    row, card = db.get(BudgetEntry, entry["id"]), db.get(Account, w["a_card"])
    start, end = datetime(2026, 11, 16), datetime(2027, 6, 1)
    charges = fc._card_entry_charges(db, [row], {card.id: card}, start, end, None)
    assert [(line.transaction_date.date(), abs(float(line.amount))) for line in charges[card.id]] == [
        (CLOSES[0], MONTHLY), (CLOSES[1], MONTHLY), (CLOSES[2], LAST)]
    payables = get_statement_payables(db, [card], start, end, charges,
                                      viewable_ids={card.id, w["a_private"]})
    # Each statement's payable is its one month, as cash out (negative).
    assert [(p["statement_close"].date(), -float(p["amount"])) for p in payables] == [
        (CLOSES[0], MONTHLY), (CLOSES[1], MONTHLY), (CLOSES[2], LAST)]


def case_stored_statements(w, entry):
    on_day(w["monkeypatch"], "2027-02-16")
    r = w["client"].post(f"{API}/jobs/post-due-installments", headers={"X-Job-Token": TOKEN})
    assert r.status_code == 200 and r.json()["posted"] == 3, r.text
    on_day(w["monkeypatch"], "2027-03-20")
    listed = _get(w, f"/cards/{w['a_card']}/statements")["statements"]
    assert {s["close_date"] for s in listed} >= {d.isoformat() for d in CLOSES}
    w["db"].rollback()
    stored = dict(w["db"].execute(text(
        "SELECT close, line_balance FROM card_statements WHERE card_id = :c"),
        {"c": w["a_card"]}).all())
    assert [float(stored[d]) for d in CLOSES] == [MONTHLY, MONTHLY, LAST]
    lines = _get(w, f"/cards/{w['a_card']}/statements/{CLOSES[2].isoformat()}")["lines"]
    assert [line["amount"] for line in lines] == [LAST]


def case_due_card(w, entry):
    def charges():
        cards = _get(w, "/dashboard/due")["card_charges"]
        return [(c["occurrence_date"], c["amount"]) for card in cards
                for c in card["charges"] if c.get("source_id") == entry["id"]]

    on_day(w["monkeypatch"], "2026-12-01")
    assert charges() == [(DAYS[0], MONTHLY)]
    _first_two_paid(w, entry["id"])
    assert charges() == [(DAYS[2], LAST)]


def case_dashboard_due(w, entry):
    def payables():
        return [(p["statement_close"], p["amount"])
                for p in _get(w, "/dashboard/snapshot")["payables"]
                if p["source"] == "statement" and p["source_id"] == w["a_card"]]

    on_day(w["monkeypatch"], "2026-12-20")
    assert payables() == [(DAYS[0], MONTHLY)]
    on_day(w["monkeypatch"], "2027-02-20")
    assert payables()[-1] == (DAYS[2], LAST)


def case_installment_plan_remaining_total(w, entry):
    def plan():
        (item,) = [i for i in _get(w, "/budget-entries/installment-plans")["items"]
                   if i["entry_id"] == entry["id"]]
        return item["next_charge"], item["amount"], item["remaining_total"], item["payments_left"]

    assert plan() == (DAYS[0], MONTHLY, 10000.0, 3)
    _first_two_paid(w, entry["id"])
    assert plan() == (DAYS[2], LAST, LAST, 1)


def case_card_credit(w, entry):
    def credit():
        return _get(w, f"/cards/{w['a_card']}/credit")["credit"]

    assert credit()["opening"]["installment_hold"] == 10000.0  # 3,333.33 x 2 + 3,333.34
    _first_two_paid(w, entry["id"])
    body = credit()
    assert body["opening"]["installment_hold"] == LAST
    assert [(c["occurrence_date"], c["amount"]) for c in body["checks"]
            if c["source_id"] == entry["id"]] == [(DAYS[2], LAST)]


def _household_items(w, reference=REF):
    from app.tests.projection_lists import upcoming_rows

    w["db"].expire_all()
    return [(i["date"], i["face_amount"])
            for i in upcoming_rows(w["db"], w["c"]["id"], days=200,
                                   reference=reference.replace(hour=0))
            if i.get("kind") == "household"]


def _household_cover(w, start=datetime(2026, 11, 16), end=datetime(2027, 6, 1)):
    """``{occurrence day: (face, remainder)}`` of A's Household occurrences as C sees them."""
    from app.core.access import RecordAccess, viewable_account_ids, VIEW_ROLES
    from app.models.user import User
    from app.services.household import household_accounts, household_occurrences, household_view

    db = w["db"]
    db.expire_all()
    user = db.get(User, w["c"]["id"])
    grant = household_view(db, user.id, w["a"]["id"])
    occurrences = household_occurrences(
        db, grant, household_accounts(db, user, grant), start, end, recorded=False,
        viewable_ids=viewable_account_ids(db, user, roles=VIEW_ROLES), access=RecordAccess(db, user))
    return {o.extra["occurrence"].date().isoformat(): (float(o.face), float(o.remainder))
            for o in occurrences if getattr(o.record, "name", None) == "Laptop"}


def case_household_cover(w, entry):
    assert _household_items(w) == [(DAYS[0], MONTHLY), (DAYS[1], MONTHLY), (DAYS[2], LAST)]
    # Nothing in the Household scope pays A's card, so each month is left whole.
    assert _household_cover(w) == {DAYS[0]: (MONTHLY, MONTHLY), DAYS[1]: (MONTHLY, MONTHLY),
                                   DAYS[2]: (LAST, LAST)}


def case_auto_post(w, entry):
    on_day(w["monkeypatch"], "2027-01-15")
    r = w["client"].post(f"{API}/jobs/post-due-installments", headers={"X-Job-Token": TOKEN})
    assert r.status_code == 200 and r.json()["posted"] == 2, r.text
    on_day(w["monkeypatch"], "2027-02-15")
    r = w["client"].post(f"{API}/jobs/post-due-installments", headers={"X-Job-Token": TOKEN})
    assert r.status_code == 200 and r.json()["posted"] == 1, r.text
    assert _txn_amounts(w, entry["id"]) == [
        (DAYS[0], MONTHLY, True), (DAYS[1], MONTHLY, True), (DAYS[2], LAST, True)]


def case_installment_review(w, entry):
    # A backdated installment starts unreviewed: its three months (Aug, Sep and
    # Oct 15) are all missed, and the review posts each at its own amount.
    late = _laptop(w, offset=entry["occurrences_paid_offset"], name="Backdated",
                   next_occurrence="2026-08-05T00:00:00", tag_ids=[])
    review = _get(w, f"/budget-entries/{late['id']}/auto-post-review")
    assert [m["occurrence_date"] for m in review["missed"]] == [
        "2026-08-15", "2026-09-15", "2026-10-15"]
    r = w["client"].post(f"{API}/budget-entries/{late['id']}/auto-post-review", json={
        "entry_version": review["entry_version"], "review_token": review["review_token"],
        "links": []}, headers=w["a"]["headers"])
    assert r.status_code == 200, r.text
    assert _txn_amounts(w, late["id"]) == [
        ("2026-08-15", MONTHLY, True), ("2026-09-15", MONTHLY, True),
        ("2026-10-15", LAST, True)]


def case_mark_paid(w, entry):
    _first_two_paid(w, entry["id"])
    on_day(w["monkeypatch"], "2027-02-15")
    assert _mark_paid(w, entry["id"], 1) == [(DAYS[2], LAST)]
    assert _txn_amounts(w, entry["id"]) == [
        (DAYS[0], MONTHLY, True), (DAYS[1], MONTHLY, True), (DAYS[2], LAST, True)]


CASES = {
    "occurrence_expansion": case_occurrence_expansion,
    "forecast": case_forecast,
    "projection": case_projection,
    "statement_engine": case_statement_engine,
    "stored_statements": case_stored_statements,
    "due_card": case_due_card,
    "dashboard_due": case_dashboard_due,
    "installment_plan_remaining_total": case_installment_plan_remaining_total,
    "card_credit": case_card_credit,
    "household_cover": case_household_cover,
    "auto_post": case_auto_post,
    "installment_review": case_installment_review,
    "mark_paid": case_mark_paid,
}


@pytest.mark.parametrize("offset", [0, 2], ids=["offset0", "offset2"])
@pytest.mark.parametrize("case", list(CASES))
def test_occurrence_amount_reader(w, case, offset):
    """AC3: the last occurrence reads ``final_amount``, every other ``amount``."""
    entry = _laptop(w, offset)
    assert (entry["amount"], entry["final_amount"]) == (MONTHLY, LAST)
    assert entry["next_occurrence"].startswith(DAYS[0])
    CASES[case](w, entry)


@pytest.mark.parametrize("offset", [0, 2], ids=["offset0", "offset2"])
def test_household_engine_last_cycle_agree(w, offset):
    """AC3: Household and the statement engine bill the last cycle the same figure."""
    from app.tests.projection_lists import payable_rows

    entry = _laptop(w, offset)
    on_day(w["monkeypatch"], "2027-02-20")
    w["db"].expire_all()
    engine = [(p["statement_close"], p["amount"])
              for p in payable_rows(w["db"], w["a"]["id"], days=60,
                                    reference=datetime(2027, 2, 20))
              if p["source"] == "statement" and p["source_id"] == w["a_card"]]
    household = _household_cover(w, start=datetime(2027, 2, 1), end=datetime(2027, 4, 1))
    assert engine[-1] == (DAYS[2], LAST)
    assert household == {DAYS[2]: (LAST, LAST)}
    assert entry["id"]


# --- null final_amount and existing records (AC4) ---------------------------------------------

def test_null_final_amount_uniform_occurrences(w):
    entry = _laptop(w, final_amount=None)
    assert entry["final_amount"] is None
    items = _get(w, "/forecast/upcoming", days=200)["items"]
    assert [(i["occurrence_date"], i["amount"]) for i in items
            if i["source"] == "budget_entry" and i["source_id"] == entry["id"]] == [
        (d, MONTHLY) for d in DAYS]
    (plan,) = [i for i in _get(w, "/budget-entries/installment-plans")["items"]
               if i["entry_id"] == entry["id"]]
    assert (plan["amount"], plan["remaining_total"]) == (MONTHLY, 9999.99)
    assert _get(w, f"/cards/{w['a_card']}/credit")["credit"]["opening"][
        "installment_hold"] == 9999.99
    _auto_post_off(w, entry["id"])
    on_day(w["monkeypatch"], "2027-02-15")
    _mark_paid(w, entry["id"], 3)
    assert _txn_amounts(w, entry["id"]) == [(d, MONTHLY, True) for d in DAYS]


def test_existing_installment_figures_unchanged(w):
    """An installment saved under STU-631 (the remainder on the first payment, the
    entry at the rounded-down rest, no ``final_amount``) keeps its figures: nothing
    is backfilled, and every remaining payment still reads 3,333.33."""
    r = w["client"].post(f"{API}/transactions/repeating", json={
        "transaction": {"account_id": w["a_card"], "amount": 3333.34,
                        "transaction_type": "debit", "transaction_date": "2026-11-16T00:00:00",
                        "description": "Old laptop"},
        "repeat": {"cadence": "monthly", "end_mode": "after_occurrences", "max_occurrences": 3,
                   "amount": "3333.33"}}, headers=w["a"]["headers"])
    assert r.status_code == 201, r.text
    entry_id = r.json()["entry"]["id"]
    w["db"].rollback()
    row = w["db"].execute(text(
        "SELECT amount, final_amount, max_occurrences FROM budget_entries WHERE id = :e"),
        {"e": entry_id}).one()
    assert (row.amount, row.final_amount, row.max_occurrences) == (Decimal("3333.33"), None, 2)
    assert [a for _, a, _ in _txn_amounts(w, entry_id)] == [3333.34]
    items = _get(w, "/forecast/upcoming", days=200)["items"]
    assert [i["amount"] for i in items
            if i["source"] == "budget_entry" and i["source_id"] == entry_id] == [MONTHLY, MONTHLY]


def test_repeating_saves_final_amount(w):
    """AC5 (API): ``repeat.final_amount`` is the entry's last payment."""
    r = w["client"].post(f"{API}/transactions/repeating", json={
        "transaction": {"account_id": w["a_card"], "amount": 6666.67,
                        "transaction_type": "debit", "transaction_date": "2026-11-16T00:00:00",
                        "description": "Phone"},
        "repeat": {"cadence": "monthly", "end_mode": "after_occurrences", "max_occurrences": 3,
                   "amount": "6666.67", "final_amount": "6666.66"}}, headers=w["a"]["headers"])
    assert r.status_code == 201, r.text
    entry = r.json()["entry"]
    assert (entry["amount"], entry["final_amount"], entry["max_occurrences"]) == (
        6666.67, 6666.66, 2)
    items = _get(w, "/forecast/upcoming", days=200)["items"]
    assert [i["amount"] for i in items
            if i["source"] == "budget_entry" and i["source_id"] == entry["id"]] == [
        6666.67, 6666.66]


# --- validation (AC2) -------------------------------------------------------------------------

def test_final_amount_validation(w):
    client, headers = w["client"], w["a"]["headers"]

    def create(**extra):
        body = {"name": "Probe", "entry_type": "expense", "amount": 100, "cadence": "monthly",
                "next_occurrence": "2026-12-05T00:00:00", "end_mode": "after_occurrences",
                "max_occurrences": 3, "account_id": w["a_card"], **extra}
        return client.post(f"{API}/budget-entries/", json=body, headers=headers)

    def entries():
        w["db"].rollback()
        return w["db"].execute(text("SELECT count(*) FROM budget_entries WHERE user_id = :u"),
                               {"u": w["a"]["id"]}).scalar_one()

    before = entries()
    for bad in (0, -5, 0.001, 12.345):
        assert create(final_amount=bad).status_code == 422, bad
    # Without a finite occurrence count.
    assert create(final_amount=99, end_mode="indefinite", max_occurrences=None).status_code == 422
    assert create(final_amount=99, end_mode="on_date", max_occurrences=None,
                  end_date="2027-06-01T00:00:00").status_code == 422
    assert create(final_amount=99, max_occurrences=None).status_code == 422
    assert entries() == before

    entry = create(final_amount=101.5).json()
    assert entry["final_amount"] == 101.5
    url = f"{API}/budget-entries/{entry['id']}"
    for bad in ({"final_amount": 0}, {"final_amount": -1}, {"final_amount": 1.005},
                {"end_mode": "indefinite", "max_occurrences": None}):
        assert client.put(url, json=bad, headers=headers).status_code == 422, bad
    w["db"].rollback()
    assert w["db"].execute(text(
        "SELECT final_amount, end_mode FROM budget_entries WHERE id = :e"),
        {"e": entry["id"]}).one() == (Decimal("101.50"), "after_occurrences")
    # An open-ended entry cannot be given one.
    open_ended = create(end_mode="indefinite", max_occurrences=None).json()
    assert client.put(f"{API}/budget-entries/{open_ended['id']}", json={"final_amount": 5},
                      headers=headers).status_code == 422
    # Cleared, every occurrence is ``amount`` again; a later edit may set it.
    r = client.put(url, json={"final_amount": None}, headers=headers)
    assert r.status_code == 200 and r.json()["final_amount"] is None, r.text
    r = client.put(url, json={"final_amount": "99.99"}, headers=headers)
    assert r.status_code == 200 and r.json()["final_amount"] == 99.99, r.text

    # ``repeat.final_amount`` follows the same rules, and a refusal saves nothing.
    before = entries()
    for repeat in ({"end_mode": "after_occurrences", "max_occurrences": 3, "final_amount": 0},
                   {"end_mode": "after_occurrences", "max_occurrences": 3,
                    "final_amount": "1.001"},
                   {"end_mode": "indefinite", "final_amount": "5"}):
        r = client.post(f"{API}/transactions/repeating", json={
            "transaction": {"account_id": w["a_card"], "amount": 5, "transaction_type": "debit",
                            "transaction_date": "2026-11-16T00:00:00", "description": "Probe"},
            "repeat": {"cadence": "monthly", **repeat}}, headers=headers)
        assert r.status_code == 422, (repeat, r.text)
    assert entries() == before

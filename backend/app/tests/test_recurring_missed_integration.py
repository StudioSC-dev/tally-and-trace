"""Missed recurring entries, pending links and row permissions on ``/dashboard/snapshot``
(STU-384, the snapshot extension).

``missed`` lists every active entry seen in full or shared_full with occurrences
before Manila's today that no posted row records: cash expenses, income,
transfers and capped entries. Open-ended card subscriptions and bills stay in
``card_charges``' ``missed``; wallet-funded spending, paused, ended and
accountless entries are never listed. A pending linked row is split out
(``unlinked_count``, ``pending_transaction_ids``). Full budget-entry rows in
``payables`` and ``upcoming_this_month`` carry ``kind`` and ``can_mark_paid``;
upcoming budget-entry rows carry ``occurrence_date`` and ``overdue``. Skips
without a database.
"""
import json
import sys
from datetime import date, datetime
from types import SimpleNamespace

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
MISSED_KEYS = {"view", "entry_id", "name", "entry_type", "kind", "is_transfer", "capped",
               "account_name", "count", "oldest", "unlinked_count", "oldest_unlinked",
               "pending_transaction_ids", "can_mark_paid"}


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking, name="Card C"):
    return _account(client, who, name, "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)


def _entry(client, who, account_id, next_day, name, amount=1_000, **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id, **extra})["id"]


def _debit(client, who, account_id, day, description, posted=False, amount=1_000, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account_id, "transaction_type": "debit", "amount": amount,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": posted, **extra})["id"]


def _put(client, who, entry_id, body):
    r = client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _snapshot(client, who, **params):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"], params=params)
    assert r.status_code == 200, r.text
    body = r.json()
    for row in body["missed"]:
        assert set(row) == MISSED_KEYS
    return body


def _missed(body):
    return {row["entry_id"]: row for row in body["missed"]}


def _rows(items, entry_id):
    return [i for i in items if i.get("source") == "budget_entry"
            and i.get("source_id") == entry_id]


@pytest.fixture
def me(sw_client, sw_people, monkeypatch):
    who = sw_people()
    checking = _account(sw_client, who)
    pin_clock(monkeypatch, REF)
    return SimpleNamespace(client=sw_client, who=who, checking=checking)


def test_rule_counts_occurrences_before_today_and_splits_pending_links(me):
    client, who = me.client, me.who
    rent = _entry(client, who, me.checking, "2026-07-18", "Rent")
    _debit(client, who, me.checking, "2026-07-18", "Rent Jul", posted=True, budget_entry_id=rent)
    today_bill = _entry(client, who, me.checking, "2026-10-18", "Today bill")

    missed = _missed(_snapshot(client, who))
    assert today_bill not in missed
    assert missed[rent] == {
        "view": "full", "entry_id": rent, "name": "Rent", "entry_type": "expense",
        "kind": "cash", "is_transfer": False, "capped": False, "account_name": "Checking",
        "count": 2, "oldest": "2026-08-18", "unlinked_count": 2,
        "oldest_unlinked": "2026-08-18", "pending_transaction_ids": [], "can_mark_paid": True}

    # A pending row linked by hand to a missed day: still missed, but not unlinked.
    pending = _debit(client, who, me.checking, "2026-08-18", "Rent Aug", budget_entry_id=rent)
    row = _missed(_snapshot(client, who))[rent]
    assert (row["count"], row["oldest"], row["unlinked_count"], row["oldest_unlinked"],
            row["pending_transaction_ids"]) == (2, "2026-08-18", 1, "2026-09-18", [pending])


def test_clamped_semi_monthly_days_count_once(sw_client, sw_people, monkeypatch):
    client, who = sw_client, sw_people()
    checking = _account(client, who)
    gym = _entry(client, who, checking, "2027-01-30", "Gym", cadence="semi_monthly",
                 semi_monthly_day_1=30, semi_monthly_day_2=31)
    pin_clock(monkeypatch, datetime(2027, 3, 31, 2, 0))

    row = _missed(_snapshot(client, who))[gym]
    assert (row["count"], row["oldest"]) == (4, "2027-01-30")
    r = client.get(f"{API}/budget-entries/{gym}/occurrences", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["due_unposted"] == row["count"] + 1  # today's too


def test_income_transfers_and_loan_payments_are_listed(me):
    client, who = me.client, me.who
    savings = _account(client, who, "Savings", "savings", 0)
    loan = _account(client, who, "Car loan", "loan", -100_000, loan_kind="auto",
                    loan_annual_rate=12, loan_term_months=24, loan_payment_amount=5_000,
                    loan_first_payment_date="2026-09-20", payment_account_id=me.checking)
    salary = _entry(client, who, me.checking, "2026-09-01", "Salary", entry_type="income")
    save = _entry(client, who, me.checking, "2026-09-05", "Save",
                  transfer_to_account_id=savings)
    loan_pay = _entry(client, who, me.checking, "2026-09-20", "Loan pay", amount=5_000,
                      transfer_to_account_id=loan)

    missed = _missed(_snapshot(client, who))
    got = {k: (missed[k]["entry_type"], missed[k]["kind"], missed[k]["is_transfer"],
               missed[k]["capped"], missed[k]["count"], missed[k]["oldest"],
               missed[k]["can_mark_paid"])
           for k in (salary, save, loan_pay)}
    assert got == {
        salary: ("income", None, False, False, 2, "2026-09-01", True),
        save: ("expense", None, True, False, 2, "2026-09-05", True),
        loan_pay: ("expense", None, True, False, 1, "2026-09-20", True),
    }


def test_capped_entries_are_listed_with_their_real_months(me):
    client, who = me.client, me.who
    card = _card(client, who, me.checking)
    iphone = _entry(client, who, card, "2026-08-25", "iPhone", amount=5_000,
                    end_mode="after_occurrences", max_occurrences=12)
    bonus = _entry(client, who, me.checking, "2026-09-25", "Bonus", entry_type="income",
                   end_mode="after_occurrences", max_occurrences=6)
    sofa = _entry(client, who, me.checking, "2026-09-10", "Sofa",
                  end_mode="after_occurrences", max_occurrences=6)

    body = _snapshot(client, who)
    missed = _missed(body)
    assert {k: (missed[k]["kind"], missed[k]["capped"], missed[k]["count"], missed[k]["oldest"])
            for k in (iphone, bonus, sofa)} == {
        iphone: ("installment", True, 2, "2026-08-25"),
        bonus: (None, True, 1, "2026-09-25"),
        sofa: ("cash", True, 2, "2026-09-10"),
    }

    # A billed card's lapsed installment months are in no card list.
    for section in body["card_charges"]:
        assert iphone not in [m["entry_id"] for m in section["missed"]]
        for charge in section["charges"]:
            if charge.get("source") == "budget_entry" and charge.get("source_id") == iphone:
                assert charge["overdue"] is False and charge["occurrence_date"] >= "2026-10-18"

    # The capped income's overdue month sits on the window start, with its real day.
    assert [(u["due_date"], u["occurrence_date"], u["overdue"], u["kind"], u["can_mark_paid"])
            for u in _rows(body["upcoming_this_month"], bonus)] == [
        ("2026-10-18", "2026-09-25", True, None, True),
        ("2026-10-25", "2026-10-25", False, None, True)]

    # The capped cash installment is overdue in payables too.
    assert [(p["occurrence_date"], p["overdue"], p["kind"], p["can_mark_paid"])
            for p in _rows(body["payables"], sofa) if p["overdue"]] == [
        ("2026-09-10", True, "cash", True), ("2026-10-10", True, "cash", True)]


def test_exclusions(me):
    client, who = me.client, me.who
    card = _card(client, who, me.checking)
    wallet = _account(client, who, "GCash", "checking", 2_000, is_spending_wallet=True)
    rent = _entry(client, who, me.checking, "2026-09-01", "Rent")
    gym = _entry(client, who, me.checking, "2026-09-01", "Gym")
    _put(client, who, gym, {"is_active": False})
    course = _entry(client, who, me.checking, "2026-09-01", "Course",
                    end_mode="after_occurrences", max_occurrences=1)
    r = client.post(f"{API}/budget-entries/{course}/materialize", json={},
                    headers=who["headers"])
    assert r.status_code == 201, r.text
    spotify = _entry(client, who, card, "2026-09-01", "Spotify", amount=279)
    coffee = _entry(client, who, wallet, "2026-09-01", "Coffee", amount=150)
    _entry(client, who, None, "2026-09-01", "Loose cash")

    body = _snapshot(client, who)
    assert [row["entry_id"] for row in body["missed"]] == [rent]
    assert coffee not in _missed(body)
    (section,) = [c for c in body["card_charges"] if c["account_id"] == card]
    assert [m["entry_id"] for m in section["missed"]] == [spotify]


def test_visibility(sw, sw_client, sw_db, monkeypatch):
    client = sw_client
    a, b, v, d, s = sw["a"], sw["b"], sw["v"], sw["d"], sw["s"]
    joint_rent = _entry(client, a, sw["joint"], "2026-09-05", "Joint rent")
    private = _entry(client, a, sw["a_private"], "2026-09-05", f"{PRIVATE} bill")
    tag = sw_post(client, a, "/tags/", {"name": "Home"}, expect=(201,))["id"]
    _put(client, a, joint_rent, {"tag_ids": [tag]})
    pin_clock(monkeypatch, REF)

    bodies = {k: _snapshot(client, w) for k, w in (("a", a), ("b", b), ("d", d), ("v", v),
                                                     ("s", s))}
    assert {k: (r["view"], r["can_mark_paid"], r["count"])
            for k, r in _missed(bodies["a"]).items()} == {
        joint_rent: ("full", True, 2), private: ("full", True, 2)}
    for k in ("b", "d"):
        assert {e: (r["view"], r["can_mark_paid"], r["account_name"])
                for e, r in _missed(bodies[k]).items()} == {
            joint_rent: ("shared_full", True, "Joint account")}
    assert bodies["v"]["missed"] == []  # their view of it is Limited
    assert bodies["s"]["missed"] == []
    for k in ("b", "d", "v", "s"):
        assert PRIVATE not in json.dumps(bodies[k]["missed"])
        assert sw_leaks(bodies[k]["missed"], private_ids=[private]) == []

    assert [r["entry_id"] for r in _snapshot(client, a, tag=tag)["missed"]] == [joint_rent]
    assert _snapshot(client, a, tag=999_999_999)["missed"] == []


def test_pending_ids_hold_only_readable_full_rows(me, sw_db):
    from app.core.redaction import FULL, LIMITED
    from app.models.budget_entry import BudgetEntry
    from app.services import forecast as fc
    from app.services.missed import split_pending_links

    client, who = me.client, me.who
    rent = _entry(client, who, me.checking, "2026-09-01", "Rent")
    pending = _debit(client, who, me.checking, "2026-09-01", "Rent Sep", budget_entry_id=rent)
    entry = sw_db.query(BudgetEntry).filter(BudgetEntry.id == rent).one()
    unrecorded = fc.unrecorded_occurrences(sw_db, [entry], through=date(2026, 10, 17))

    class Redactor:
        def __init__(self, readable, view):
            self.access = SimpleNamespace(readable=lambda record: readable)
            self._view = view

        def view(self, record):
            return self._view

    assert split_pending_links(sw_db, [entry], unrecorded, Redactor(True, FULL))[rent] == {
        "unlinked_count": 1, "oldest_unlinked": "2026-10-01",
        "pending_transaction_ids": [pending]}
    # Unreadable or Limited: never named, and the occurrence stays unlinked.
    for redactor in (Redactor(False, FULL), Redactor(True, LIMITED)):
        assert split_pending_links(sw_db, [entry], unrecorded, redactor)[rent] == {
            "unlinked_count": 2, "oldest_unlinked": "2026-09-01",
            "pending_transaction_ids": []}


def test_a_limited_pending_row_stays_unlinked(sw, sw_client, sw_db, monkeypatch):
    """B sees the entry shared_full but its hand-linked pending row Limited (it
    also touches A's private account): the row is not named, and its occurrence
    stays unlinked, so it is still listed as missed."""
    from app.models.transaction import Transaction, TransactionType
    from app.tests.conftest import sw_share

    client, db, a, b = sw_client, sw_db, sw["a"], sw["b"]
    savings = _account(client, a, "Joint savings", "savings", 0)
    sw_share(db, savings, b["id"], "editor", a["id"])
    save = _entry(client, a, sw["joint"], "2026-09-05", "Save", transfer_to_account_id=savings)
    txn = Transaction(user_id=a["id"], account_id=sw["a_private"], budget_entry_id=save,
                      amount=1_000, transaction_type=TransactionType.TRANSFER,
                      transfer_from_account_id=sw["joint"], transfer_to_account_id=savings,
                      description="Save Sep", is_posted=False,
                      transaction_date=datetime(2026, 9, 5))
    db.add(txn)
    db.commit()
    pin_clock(monkeypatch, REF)

    def links(who):
        row = _missed(_snapshot(client, who))[save]
        return (row["view"], row["count"], row["unlinked_count"], row["oldest_unlinked"],
                row["pending_transaction_ids"])

    assert links(a) == ("full", 2, 1, "2026-10-05", [txn.id])
    assert links(b) == ("shared_full", 2, 2, "2026-09-05", [])


def test_row_fields_on_snapshot_rows_only(sw, sw_client, sw_db, monkeypatch):
    from app.models.account_share import AccountShare
    from app.services import forecast as fc

    client = sw_client
    a, b, v = sw["a"], sw["b"], sw["v"]
    rent = _entry(client, a, sw["joint"], "2026-10-25", "Joint rent")
    salary = _entry(client, a, sw["joint"], "2026-10-30", "Salary", entry_type="income")
    loose = _entry(client, a, None, "2026-10-26", "Loose cash")
    bea = _entry(client, b, sw["joint"], "2026-10-27", "Bea bill")
    # Bea keeps a full view of her own entry but loses the right to post it.
    sw_db.query(AccountShare).filter(AccountShare.id == sw["shares"]["b"]).update(
        {"role": "viewer"})
    sw_db.commit()
    pin_clock(monkeypatch, REF)

    body = _snapshot(client, a)
    fields = {(k, i["source_id"]): (i["kind"], i["can_mark_paid"])
              for k in ("payables", "upcoming_this_month") for i in body[k]
              if i.get("source") == "budget_entry" and i["source_id"] in (rent, salary, loose)}
    assert fields == {
        ("payables", rent): ("cash", True),
        ("upcoming_this_month", rent): ("cash", True),
        ("upcoming_this_month", salary): (None, True),
        ("payables", loose): ("cash", False),
        ("upcoming_this_month", loose): ("cash", False),
    }

    body = _snapshot(client, b)
    assert {(i["kind"], i["can_mark_paid"]) for k in ("payables", "upcoming_this_month")
            for i in _rows(body[k], bea)} == {("cash", False)}

    # Limited rows keep their public shape (their own ``kind`` label included).
    body = _snapshot(client, v)
    limited = [i for k in ("payables", "upcoming_this_month") for i in body[k]
               if i.get("view") == "limited"]
    assert limited and all("can_mark_paid" not in i for i in limited)

    # /forecast/upcoming gets the occurrence fields but not the row permissions,
    # and the payables service is unchanged.
    r = client.get(f"{API}/forecast/upcoming", headers=a["headers"])
    assert r.status_code == 200, r.text
    items = _rows(r.json()["items"], rent)
    assert [(i["occurrence_date"], i["overdue"]) for i in items] == [("2026-10-25", False)]
    assert all("kind" not in i and "can_mark_paid" not in i for i in items)
    payables = fc.payables_by_currency(sw_db, a["id"], days=30)
    assert _rows(payables, rent)
    assert all("kind" not in p and "can_mark_paid" not in p for p in payables if p)


def test_recording_clears_the_row(me):
    client, who = me.client, me.who
    rent = _entry(client, who, me.checking, "2026-08-05", "Rent")
    salary = _entry(client, who, me.checking, "2026-09-01", "Salary", entry_type="income")
    missed = _missed(_snapshot(client, who))
    assert (missed[rent]["count"], missed[salary]["count"]) == (3, 2)

    r = client.post(f"{API}/budget-entries/{rent}/materialize-due", headers=who["headers"])
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == 3
    for _ in range(2):
        r = client.post(f"{API}/budget-entries/{salary}/materialize", json={},
                        headers=who["headers"])
        assert r.status_code == 201, r.text
    assert _snapshot(client, who)["missed"] == []


def test_a_resumed_entry_has_no_missed_row(me):
    client, who = me.client, me.who
    gym = _entry(client, who, me.checking, "2026-08-10", "Gym")
    assert gym in _missed(_snapshot(client, who))
    _put(client, who, gym, {"is_active": False})
    assert gym not in _missed(_snapshot(client, who))
    _put(client, who, gym, {"is_active": True})
    assert gym not in _missed(_snapshot(client, who))

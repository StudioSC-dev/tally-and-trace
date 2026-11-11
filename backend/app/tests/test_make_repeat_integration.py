"""Make a saved transaction repeat (STU-585): ``POST /transactions/{id}/repeat``.

One request applies the Edit dialog's changes to a saved row (as PUT would),
starts the recurring entry it becomes the first occurrence of, and links the
row to that occurrence, with no new transaction. The entry starts on the row's
date (a card installment on the statement close holding it). A posted row or
an unposted card expense advances the schedule, as Mark paid or Charged would;
any other unposted row does not. Everything commits together, and any refusal
leaves the row as it was and no entry. Skips without a database.

Reference: Wednesday 2026-11-04, 02:00 UTC (10:00 in Manila). "Card" closes on
the 2nd.
"""
import threading
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 4, 2, 0)
TODAY = "2026-11-04"
AUTOPAY_DUE = ("Turn autopay on from the recurring entry, where you confirm the "
               "payments it would post")
TRANSFER_REFUSED = "A transfer can't be made to repeat; add a recurring transfer instead"
NOT_CREATOR = "Only the transaction's creator can make it repeat"
ALREADY_LINKED = "This transaction already belongs to a recurring entry"


def _account(client, who, name, account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people("Rhea", "Repeat")
    checking = _account(sw_client, me, "Checking")
    card = _account(sw_client, me, "Card", "credit", 0, billing_cycle_start=2,
                    days_until_due_date=21, credit_limit=200_000, payment_account_id=checking)
    return {"client": sw_client, "db": sw_db, "me": me, "people": sw_people,
            "checking": checking, "card": card}


def _txn(account_id, day=TODAY, amount=549, description="Netflix", kind="debit",
         posted=True, **extra):
    return {"account_id": account_id, "transaction_type": kind, "amount": amount,
            "description": description, "transaction_date": f"{day}T00:00:00",
            "is_posted": posted, **extra}


def _saved(client, who, transaction):
    return sw_post(client, who, "/transactions/", transaction)["id"]


def _make(client, who, txn_id, edits=None, expect=201, **repeat):
    body = {"repeat": {"cadence": "monthly", "end_mode": "indefinite", **repeat}}
    if edits is not None:
        body["transaction"] = edits
    r = client.post(f"{API}/transactions/{txn_id}/repeat", json=body,
                    headers=who["headers"] if who else {})
    assert r.status_code == expect, r.text
    return r.json()


def _entry(client, who, entry_id):
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _stored(db, txn_id):
    """The row as stored, read fresh."""
    db.expire_all()
    return db.execute(text(
        "SELECT amount, description, transaction_date, is_posted, budget_entry_id, "
        "occurrence_date, is_recurring, recurrence_frequency, updated_at, category_id, "
        "account_id, transaction_type FROM transactions WHERE id = :i"),
        {"i": txn_id}).mappings().one()


def _tags(db, table, column, record_id):
    db.expire_all()
    return sorted(db.execute(text(f"SELECT tag_id FROM {table} WHERE {column} = :i"),
                             {"i": record_id}).scalars())


def _written(db, who):
    """``(entries, transactions)`` the user owns, read fresh."""
    db.expire_all()
    return tuple(db.execute(text(f"SELECT count(*) FROM {table} WHERE user_id = :u"),
                            {"u": who["id"]}).scalar_one()
                 for table in ("budget_entries", "transactions"))


def _balance(db, account_id):
    db.expire_all()
    return db.execute(text("SELECT balance FROM accounts WHERE id = :i"),
                      {"i": account_id}).scalar_one()


def _day(value):
    return value[:10] if isinstance(value, str) else value.date().isoformat()


# --- 1. AC3: a posted row is linked, not duplicated, and the schedule advances ---------------

def test_posted_row_becomes_first_occurrence(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    assert _balance(db, checking) == Decimal("49451.00")

    body = _make(client, me, txn_id)
    entry, txn = body["entry"], body["transaction"]
    assert txn["id"] == txn_id
    assert (entry["name"], entry["amount"], entry["currency"]) == ("Netflix", 549, "PHP")
    assert (entry["entry_type"], entry["cadence"], entry["anchor_day"]) == ("expense", "monthly", 20)
    assert entry["account_id"] == checking and entry["lead_time_days"] == 0
    assert _day(entry["next_occurrence"]) == "2026-11-20"
    row = _stored(db, txn_id)
    assert row["budget_entry_id"] == entry["id"] and row["is_recurring"] is True
    assert row["recurrence_frequency"].lower() == "monthly"
    assert _day(row["occurrence_date"]) == "2026-10-20"
    assert txn["budget_entry_id"] == entry["id"] and txn["is_recurring"] is True
    assert _written(db, me) == (1, 1)
    assert _balance(db, checking) == Decimal("49451.00")

    r = client.get(f"{API}/budget-entries/{entry['id']}/occurrences", headers=me["headers"])
    assert r.status_code == 200, r.text
    offered = [o["occurrence_date"] for o in r.json()["occurrences"]]
    assert "2026-10-20" not in offered and offered[0] == "2026-11-20"
    assert r.json()["due_unposted"] == 0

    r = client.get(f"{API}/dashboard/snapshot", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert [m for m in r.json()["missed"] if m["entry_id"] == entry["id"]] == []


# --- 2. AC3: weekly and every 2 weeks ---------------------------------------------------------

@pytest.mark.parametrize("cadence, following", [("weekly", "2026-10-27"),
                                                ("biweekly", "2026-11-03")])
def test_weekly_and_biweekly_next_after_date(world, cadence, following):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20", description="Groceries"))
    entry = _make(client, me, txn_id, cadence=cadence)["entry"]
    assert entry["cadence"] == cadence
    assert _day(entry["next_occurrence"]) == following
    assert _day(_stored(db, txn_id)["occurrence_date"]) == "2026-10-20"
    assert _written(db, me) == (1, 1)


# --- 3. AC3: a pending bank row stands for occurrence 1 ---------------------------------------

def test_pending_row_links_without_advance(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-11-14", description="Gym",
                                     posted=False))
    entry = _make(client, me, txn_id)["entry"]
    assert _day(entry["next_occurrence"]) == "2026-11-14" and entry["anchor_day"] == 14
    row = _stored(db, txn_id)
    assert row["is_posted"] is False and row["budget_entry_id"] == entry["id"]
    assert _day(row["occurrence_date"]) == "2026-11-14"
    assert _balance(db, checking) == Decimal("50000.00")

    r = client.get(f"{API}/transactions/scheduled", headers=me["headers"],
                   params={"end_date": "2026-12-01T00:00:00", "limit": 100})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [(i["kind"], i["day"]) for i in items if i["kind"] == "transaction"
            and i["transaction"]["id"] == txn_id] == [("transaction", "2026-11-14")]
    assert [i for i in items if i["kind"] == "occurrence"
            and i["occurrence"]["entry_id"] == entry["id"]] == []

    # Mark paid on the 14th posts that same row and advances.
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=me["headers"],
                    json={"occurrence_date": "2026-11-14T00:00:00"})
    assert r.status_code == 200, r.text
    assert r.headers["X-Occurrence-Outcome"] == "posted_pending"
    assert r.json()["id"] == txn_id and r.json()["is_posted"] is True
    assert _day(_entry(client, me, entry["id"])["next_occurrence"]) == "2026-12-14"
    assert _written(db, me) == (1, 1)


# --- 4. AC3: card Charged and card installment ------------------------------------------------

def test_card_charge_advances(world):
    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    txn_id = _saved(client, me, _txn(card, description="Spotify", amount=279, posted=False))
    entry = _make(client, me, txn_id)["entry"]
    assert (entry["kind"], entry["billing_kind"]) == ("subscription", "subscription")
    assert _day(entry["next_occurrence"]) == "2026-12-04"
    assert _day(_stored(db, txn_id)["occurrence_date"]) == TODAY
    assert _written(db, me) == (1, 1)


def test_card_installment_on_close(world):
    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    # Dated 3 days after the 2 Nov close: month 1 is the 2 Dec close.
    txn_id = _saved(client, me, _txn(card, day="2026-11-05", description="Laptop",
                                     amount=5_000, posted=False))
    entry = _make(client, me, txn_id, end_mode="after_occurrences", max_occurrences=12)["entry"]
    assert entry["kind"] == "installment" and entry["anchor_day"] == 2
    row = _stored(db, txn_id)
    assert _day(row["occurrence_date"]) == "2026-12-02"
    assert _day(row["transaction_date"]) == "2026-11-05"
    assert _day(entry["next_occurrence"]) == "2027-01-02"
    # "n of m": the row is payment 1 of 12.
    assert entry["max_occurrences"] == 11 and entry["occurrences_paid"] == 1
    assert _written(db, me) == (1, 1)


# --- 5. AC3: the edits shape the entry and commit with it -------------------------------------

def test_edits_and_entry_commit_together(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    old_tag = sw_post(client, me, "/tags/", {"name": "Streaming"})["id"]
    new_tag = sw_post(client, me, "/tags/", {"name": "Family"})["id"]
    category = sw_post(client, me, "/categories/", {
        "name": "Subscriptions", "category_type": "expense"})["id"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20", tag_ids=[old_tag]))

    body = _make(client, me, txn_id, edits={
        "description": "  Netflix Premium ", "amount": 649,
        "transaction_date": "2026-10-22T00:00:00", "category_id": category,
        "tag_ids": [new_tag]})
    entry, txn = body["entry"], body["transaction"]
    assert (entry["name"], entry["amount"]) == ("Netflix Premium", 649)
    assert entry["category_id"] == category and entry["anchor_day"] == 22
    assert _day(entry["next_occurrence"]) == "2026-11-22"
    assert _tags(db, "budget_entry_tags", "budget_entry_id", entry["id"]) == [new_tag]
    assert txn["amount"] == 649 and txn["category_id"] == category
    row = _stored(db, txn_id)
    assert _day(row["transaction_date"]) == "2026-10-22"
    assert _day(row["occurrence_date"]) == "2026-10-22"
    assert _tags(db, "transaction_tags", "transaction_id", txn_id) == [new_tag]
    assert _balance(db, checking) == Decimal("49351.00")
    assert _written(db, me) == (1, 1)


def test_projected_face_is_the_entry_amount(world):
    client, me, checking = world["client"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, description="iCloud", amount=580,
                                     projected_amount=10, projected_currency="USD"))
    entry = _make(client, me, txn_id)["entry"]
    assert (entry["amount"], entry["currency"]) == (10, "USD")


# --- 6. AC4: a refusal after the entry was flushed leaves nothing -----------------------------

def test_atomic_autopay_refusal(world, monkeypatch):
    from app.routers import budget_entries

    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    old_tag = sw_post(client, me, "/tags/", {"name": "Utilities"})["id"]
    new_tag = sw_post(client, me, "/tags/", {"name": "House"})["id"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20", description="Water",
                                     amount=300, posted=False, tag_ids=[old_tag]))
    before = (_stored(db, txn_id), _balance(db, checking), _written(db, me))
    flushed = []
    real = budget_entries.add_budget_entry

    def spy(*args, **kwargs):
        entry = real(*args, **kwargs)
        flushed.append(entry.id)
        return entry

    monkeypatch.setattr(budget_entries, "add_budget_entry", spy)
    r = _make(client, me, txn_id, edits={"description": "Water bill", "amount": 350,
                                         "tag_ids": [new_tag]},
              settlement="autopay", expect=422)
    assert r["detail"] == AUTOPAY_DUE
    assert len(flushed) == 1 and flushed[0] is not None  # refused after the entry was flushed
    assert (_stored(db, txn_id), _balance(db, checking), _written(db, me)) == before
    assert _written(db, me) == (0, 1)
    assert _tags(db, "transaction_tags", "transaction_id", txn_id) == [old_tag]
    assert db.execute(text("SELECT count(*) FROM budget_entry_tags WHERE tag_id IN (:a, :b)"),
                      {"a": old_tag, "b": new_tag}).scalar_one() == 0


# --- 7. AC4: a refusal before the entry -------------------------------------------------------

def test_atomic_edit_refusal(world):
    client, db, me, checking, people = (world["client"], world["db"], world["me"],
                                        world["checking"], world["people"])
    stranger = people("Sam", "Stranger")
    theirs = _account(client, stranger, "Sam bank")
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    before = (_stored(db, txn_id), _balance(db, checking), _balance(db, theirs))
    r = _make(client, me, txn_id, edits={"account_id": theirs, "amount": 10}, expect=404)
    assert r["detail"] == "Account not found"
    assert (_stored(db, txn_id), _balance(db, checking), _balance(db, theirs)) == before
    assert _written(db, me) == (0, 1)


# --- 8. AC4: each refusal names the field in the request body ---------------------------------

@pytest.mark.parametrize("case, edits, repeat, loc", [
    ("blank description", {"description": "   "}, {}, ["body", "transaction", "description"]),
    ("negative amount", {"amount": -1}, {}, ["body", "transaction", "amount"]),
    ("budget_entry_id", {"budget_entry_id": 1}, {}, ["body", "transaction", "budget_entry_id"]),
    ("budget_entry_id null", {"budget_entry_id": None}, {},
     ["body", "transaction", "budget_entry_id"]),
    ("unknown field", {"every": 2}, {}, ["body", "transaction", "every"]),
])
def test_refusal_locations(world, case, edits, repeat, loc):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    before = (_stored(db, txn_id), _balance(db, checking))
    r = _make(client, me, txn_id, edits=edits, expect=422, **repeat)
    locs = [e["loc"][:len(loc)] for e in r["detail"]]
    assert loc in locs, (case, r)
    assert (_stored(db, txn_id), _balance(db, checking)) == before
    assert _written(db, me) == (0, 1)


def test_end_before_start_is_accepted_as_on_repeating(world):
    """Parity with ``POST /transactions/repeating``: an entry check refuses no end
    before the start, so the entry is made already ended and the row is linked."""
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    entry = _make(client, me, txn_id, end_mode="on_date",
                  end_date="2026-10-01T00:00:00")["entry"]
    assert entry["is_active"] is False and _day(entry["end_date"]) == "2026-10-01"
    assert _stored(db, txn_id)["budget_entry_id"] == entry["id"]
    assert _written(db, me) == (1, 1)


def test_anchor_mismatch_is_a_plain_422_as_on_repeating(world):
    """Parity with ``POST /transactions/repeating``: the day rule's refusal is a
    422 with a string detail (no location), and nothing is written."""
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    before = (_stored(db, txn_id), _balance(db, checking))
    r = _make(client, me, txn_id, edits={"description": "Edited"}, anchor_day=5, expect=422)
    assert isinstance(r["detail"], str) and r["detail"]
    assert (_stored(db, txn_id), _balance(db, checking)) == before
    assert _written(db, me) == (0, 1)


# --- 9. AC5: no semi-monthly ------------------------------------------------------------------

def test_semi_monthly_refused(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    before = _stored(db, txn_id)
    r = _make(client, me, txn_id, cadence="semi_monthly", expect=422)
    assert [e["loc"] for e in r["detail"]] == [["body", "repeat", "cadence"]]
    assert _stored(db, txn_id) == before and _written(db, me) == (0, 1)


# --- 10. AC1 / D3 on the server ---------------------------------------------------------------

def test_already_linked_409(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    # A row recorded by "Repeat" (STU-584).
    r = client.post(f"{API}/transactions/repeating", headers=me["headers"], json={
        "transaction": _txn(checking, description="Rent"),
        "repeat": {"cadence": "monthly", "end_mode": "indefinite"}})
    assert r.status_code == 201, r.text
    repeating = r.json()["transaction"]["id"]
    # A row linked by hand to an entry made on its own.
    entry_id = sw_post(client, me, "/budget-entries/", {
        "name": "Power", "entry_type": "expense", "amount": 2_000, "cadence": "monthly",
        "next_occurrence": "2026-11-20T00:00:00", "account_id": checking})["id"]
    linked = _saved(client, me, _txn(checking, day="2026-10-20", description="Power"))
    r = client.put(f"{API}/transactions/{linked}", headers=me["headers"],
                   json={"budget_entry_id": entry_id})
    assert r.status_code == 200, r.text
    written = _written(db, me)

    for txn_id in (repeating, linked):
        before = _stored(db, txn_id)
        r = _make(client, me, txn_id, edits={"amount": 1}, expect=409)
        assert r["detail"] == ALREADY_LINKED
        assert _stored(db, txn_id) == before
    assert _written(db, me) == written


def test_legacy_recurring_flag_alone_is_not_a_link(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    db.execute(text("UPDATE transactions SET is_recurring = true, "
                    "recurrence_frequency = 'monthly' WHERE id = :i"), {"i": txn_id})
    db.commit()
    entry = _make(client, me, txn_id)["entry"]
    assert _stored(db, txn_id)["budget_entry_id"] == entry["id"]


def test_second_call_409_one_entry(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    entry = _make(client, me, txn_id)["entry"]
    r = _make(client, me, txn_id, expect=409)
    assert r["detail"] == ALREADY_LINKED
    assert _written(db, me) == (1, 1)
    assert _stored(db, txn_id)["budget_entry_id"] == entry["id"]


def test_concurrent_calls_one_entry(world, monkeypatch):
    """Two requests in flight at once, each on its own database session: both
    have read the row before either takes the owner's budget lock, so the lock
    alone decides. One makes the entry, the other sees the link and gets 409."""
    from app.routers import transactions

    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    txn_id = _saved(client, me, _txn(checking, day="2026-10-20"))
    both_read = threading.Barrier(2, timeout=30)
    real = transactions._locked_for_edit

    def read_then_lock(db_, user, transaction_id):
        from app.core.access import get_record_or_404
        from app.models.transaction import Transaction

        get_record_or_404(db_, Transaction, transaction_id, user, "Transaction not found")
        both_read.wait()
        return real(db_, user, transaction_id)

    monkeypatch.setattr(transactions, "_locked_for_edit", read_then_lock)
    results = []

    def call():
        r = client.post(f"{API}/transactions/{txn_id}/repeat", headers=me["headers"],
                        json={"repeat": {"cadence": "monthly", "end_mode": "indefinite"}})
        results.append((r.status_code, r.json()))

    threads = [threading.Thread(target=call) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert sorted(code for code, _ in results) == [201, 409], results
    assert [body["detail"] for code, body in results if code == 409] == [ALREADY_LINKED]
    assert _written(db, me) == (1, 1)
    created = next(body for code, body in results if code == 201)
    assert _stored(db, txn_id)["budget_entry_id"] == created["entry"]["id"]


def test_transfer_refused(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    savings = _account(client, me, "Savings", "savings")
    stored = _saved(client, me, _txn(checking, kind="transfer", amount=1_000, description="Move",
                                     transfer_from_account_id=checking,
                                     transfer_to_account_id=savings))
    debit = _saved(client, me, _txn(checking, day="2026-10-20"))
    balances = (_balance(db, checking), _balance(db, savings))
    for txn_id, edits in ((stored, None),
                          (stored, {"transaction_type": "debit"}),
                          (debit, {"transaction_type": "transfer",
                                   "transfer_from_account_id": checking,
                                   "transfer_to_account_id": savings})):
        before = _stored(db, txn_id)
        r = _make(client, me, txn_id, edits=edits, expect=400)
        assert r["detail"] == TRANSFER_REFUSED
        assert _stored(db, txn_id) == before
    assert _written(db, me) == (0, 2)
    assert (_balance(db, checking), _balance(db, savings)) == balances


# --- 12. AC7: who may make a row repeat -------------------------------------------------------

def test_who_makes_a_row_repeat(sw, sw_client, sw_db, monkeypatch):
    from app.models.account_share import AccountShare

    pin_clock(monkeypatch, REF)
    client, db = sw_client, sw_db
    a, b = sw["a"], sw["b"]
    own_tag = sw_post(client, a, "/tags/", {"name": "Bills"})["id"]
    b_tag = sw_post(client, b, "/tags/", {"name": "Bea's"})["id"]
    row = _saved(client, a, _txn(sw["joint"], day="2026-10-20", description="Internet",
                                 amount=1_500, tag_ids=[own_tag]))
    # The partner's own tag on the row stays off the owner's entry.
    r = client.put(f"{API}/transactions/{row}", headers=b["headers"], json={"tag_ids": [b_tag]})
    assert r.status_code == 200, r.text

    # Refused callers first, each leaving the row as it was; then its creator.
    expected = {"d": 400, "b": 400, "v": 404, "s": 404, None: 401, "a": 201}
    for who, code in expected.items():
        caller = sw[who] if who else None
        before = _stored(db, row)
        r = _make(client, caller, row, expect=code)
        if code == 201:
            assert r["entry"]["view"] == "full"
            entry_id = r["entry"]["id"]
            assert db.execute(text("SELECT user_id FROM budget_entries WHERE id = :i"),
                              {"i": entry_id}).scalar_one() == a["id"]
            assert _tags(db, "budget_entry_tags", "budget_entry_id", entry_id) == [own_tag]
            continue
        if code == 400:
            assert r["detail"] == NOT_CREATOR
        elif code == 404:
            assert r["detail"] == "Transaction not found"
        assert _stored(db, row) == before
        assert _written(db, a) == (0, 1)
        if who:
            assert _written(db, sw[who]) == (0, 0)

    # The editor's own row on the joint account: the entry is the editor's.
    own = _saved(client, b, _txn(sw["joint"], day="2026-10-21", description="Shared bill"))
    body = _make(client, b, own)
    assert db.execute(text("SELECT user_id FROM budget_entries WHERE id = :i"),
                      {"i": body["entry"]["id"]}).scalar_one() == b["id"]
    assert _written(db, b) == (1, 1) and _written(db, a) == (1, 1)

    # A creator demoted to viewer can no longer change their row: 404, as PUT.
    demoted = _saved(client, b, _txn(sw["joint"], day="2026-10-22", description="Snacks"))
    db.query(AccountShare).filter(AccountShare.id == sw["shares"]["b"]).update(
        {"role": "viewer"})
    db.commit()
    before = _stored(db, demoted)
    r = _make(client, b, demoted, expect=404)
    assert r["detail"] == "Transaction not found"
    assert _stored(db, demoted) == before and _written(db, b) == (1, 2)

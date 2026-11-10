"""A transaction that repeats (STU-584 PR 3): ``POST /transactions/repeating``.

One request records the transaction and starts the recurring entry it is the
first occurrence of. The entry starts on the transaction's date (a card
installment on the statement close holding it) and the row is linked to that
occurrence. A posted row or an unposted card expense advances the schedule, as
Mark paid or Charged would; any other unposted row does not. Everything commits
together, and any refusal leaves nothing. Skips without a database.

Reference: Wednesday 2026-11-04, 02:00 UTC (10:00 in Manila). "Card" closes on
the 2nd.
"""
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 4, 2, 0)
TODAY = "2026-11-04"
AUTOPAY_DUE = ("Turn autopay on from the recurring entry, where you confirm the "
               "payments it would post")


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


def _repeat(client, who, transaction, expect=201, **repeat):
    body = {"transaction": transaction,
            "repeat": {"cadence": "monthly", "end_mode": "indefinite", **repeat}}
    r = client.post(f"{API}/transactions/repeating", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _entry(client, who, entry_id):
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _row(client, who, txn_id):
    r = client.get(f"{API}/transactions/{txn_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _occurrence_date(db, txn_id):
    return db.execute(text("SELECT occurrence_date FROM transactions WHERE id = :i"),
                      {"i": txn_id}).scalar_one()


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


# --- 1 ----------------------------------------------------------------------------------------

def test_repeat_posted_advances(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    body = _repeat(client, me, _txn(checking))
    entry, txn = body["entry"], body["transaction"]

    assert (entry["name"], entry["amount"], entry["currency"]) == ("Netflix", 549, "PHP")
    assert (entry["entry_type"], entry["cadence"], entry["anchor_day"]) == ("expense", "monthly", 4)
    assert entry["lead_time_days"] == 0 and entry["is_active"] is True
    assert _day(entry["next_occurrence"]) == "2026-12-04"
    assert txn["budget_entry_id"] == entry["id"] and txn["is_posted"] is True
    assert _day(_occurrence_date(db, txn["id"])) == TODAY
    assert _balance(db, checking) == Decimal("49451.00")
    assert _written(db, me) == (1, 1)

    r = client.get(f"{API}/dashboard/snapshot", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert [m for m in r.json()["missed"] if m["entry_id"] == entry["id"]] == []

    r = client.get(f"{API}/budget-entries/upcoming-occurrences", headers=me["headers"],
                   params={"end_date": "2026-12-31T00:00:00"})
    assert r.status_code == 200, r.text
    days = [i["occurrence_date"] for i in r.json()["items"] if i["entry_id"] == entry["id"]]
    assert days == ["2026-12-04"]


# --- 2 ----------------------------------------------------------------------------------------

def test_repeat_planned_links_without_advance(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    body = _repeat(client, me, _txn(checking, day="2026-11-14", description="Gym", posted=False))
    entry, txn = body["entry"], body["transaction"]
    assert _day(entry["next_occurrence"]) == "2026-11-14" and entry["anchor_day"] == 14
    assert txn["is_posted"] is False and txn["budget_entry_id"] == entry["id"]
    assert _day(_occurrence_date(db, txn["id"])) == "2026-11-14"
    assert _balance(db, checking) == Decimal("50000.00")

    r = client.get(f"{API}/transactions/scheduled", headers=me["headers"],
                   params={"end_date": "2026-12-01T00:00:00", "limit": 100})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [(i["kind"], i["day"]) for i in items if i["kind"] == "transaction"
            and i["transaction"]["id"] == txn["id"]] == [("transaction", "2026-11-14")]
    assert [i for i in items if i["kind"] == "occurrence"
            and i["occurrence"]["entry_id"] == entry["id"]] == []

    # Mark paid on the 14th posts that same row and advances.
    r = client.post(f"{API}/budget-entries/{entry['id']}/materialize", headers=me["headers"],
                    json={"occurrence_date": "2026-11-14T00:00:00"})
    assert r.status_code == 200, r.text
    assert r.headers["X-Occurrence-Outcome"] == "posted_pending"
    assert r.json()["id"] == txn["id"] and r.json()["is_posted"] is True
    assert _day(_entry(client, me, entry["id"])["next_occurrence"]) == "2026-12-14"
    assert _written(db, me) == (1, 1)


# --- 3 ----------------------------------------------------------------------------------------

def test_repeat_card_charge_advances(world):
    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    body = _repeat(client, me, _txn(card, description="Spotify", amount=279, posted=False))
    entry, txn = body["entry"], body["transaction"]
    assert (entry["kind"], entry["billing_kind"]) == ("subscription", "subscription")
    assert _day(entry["next_occurrence"]) == "2026-12-04"
    assert _day(_occurrence_date(db, txn["id"])) == TODAY
    before = _entry(client, me, entry["id"])

    r = client.put(f"{API}/transactions/{txn['id']}", headers=me["headers"],
                   json={"is_posted": True})
    assert r.status_code == 200, r.text
    after = _entry(client, me, entry["id"])
    keys = ("next_occurrence", "is_active", "max_occurrences", "updated_at", "auto_post_enabled")
    assert {k: after[k] for k in keys} == {k: before[k] for k in keys}


# --- 4 ----------------------------------------------------------------------------------------

def test_repeat_card_installment(world):
    from app.models.account import Account
    from app.services.statements import statement_close

    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    # Dated 3 days after the 2 Nov close: month 1 is the 2 Dec close.
    body = _repeat(client, me, _txn(card, day="2026-11-05", description="Laptop", amount=5_000,
                                    posted=False),
                   end_mode="after_occurrences", max_occurrences=12)
    entry, txn = body["entry"], body["transaction"]
    assert entry["kind"] == "installment" and entry["anchor_day"] == 2
    assert _day(_occurrence_date(db, txn["id"])) == "2026-12-02"
    assert _day(txn["transaction_date"]) == "2026-11-05"
    db.expire_all()
    assert statement_close(db.get(Account, card), datetime(2026, 11, 5).date()).isoformat() \
        == "2026-12-02"
    assert _day(entry["next_occurrence"]) == "2027-01-02"
    assert entry["max_occurrences"] == 11
    assert entry["installment_reviewed"] is True and entry["auto_post_enabled"] is True

    # A charge in a closed cycle: month 1 is the 2 Nov close, before today.
    body = _repeat(client, me, _txn(card, day="2026-10-30", description="Phone", amount=3_000,
                                    posted=True),
                   end_mode="after_occurrences", max_occurrences=6)
    entry, txn = body["entry"], body["transaction"]
    assert _day(_occurrence_date(db, txn["id"])) == "2026-11-02"
    assert _day(entry["next_occurrence"]) == "2026-12-02" and entry["max_occurrences"] == 5
    assert entry["installment_reviewed"] is False and entry["auto_post_enabled"] is False


# --- 5 ----------------------------------------------------------------------------------------

def test_repeat_face_amount(world):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    body = _repeat(client, me, _txn(checking, description="iCloud", amount=580,
                                    projected_amount=10, projected_currency="USD"))
    entry, txn = body["entry"], body["transaction"]
    assert (entry["amount"], entry["currency"]) == (10, "USD")
    assert (txn["amount"], txn["currency"]) == (580, "PHP")
    assert (txn["projected_amount"], txn["projected_currency"]) == (10, "USD")
    assert _balance(db, checking) == Decimal("49420.00")


# --- 6 ----------------------------------------------------------------------------------------

def test_repeat_transfers(world):
    client, db, me, checking, card = (world["client"], world["db"], world["me"],
                                      world["checking"], world["card"])
    loan = _account(client, me, "Car loan", "loan", balance=-100_000, loan_kind="auto",
                    loan_annual_rate=12, loan_term_months=24, loan_payment_amount=5_000,
                    loan_first_payment_date="2026-10-20", payment_account_id=checking)
    body = _repeat(client, me, _txn(checking, kind="transfer", amount=5_000,
                                    description="Car loan payment",
                                    transfer_from_account_id=checking,
                                    transfer_to_account_id=loan))
    entry, txn = body["entry"], body["transaction"]
    assert entry["transfer_to_account_id"] == loan and entry["entry_type"] == "expense"
    assert (entry["amount"], entry["currency"]) == (5_000, "PHP")
    assert _day(entry["next_occurrence"]) == "2026-12-04"
    assert txn["loan_payment_kind"] == "scheduled" and txn["budget_entry_id"] == entry["id"]
    assert _day(_occurrence_date(db, txn["id"])) == TODAY
    written, balances = _written(db, me), (_balance(db, checking), _balance(db, card))

    savings = _account(client, me, "Savings", "savings")
    for source, destination, detail in (
            (checking, card, "A recurring transfer cannot be paid into a credit card"),
            (card, savings, "A recurring transfer cannot be funded from a credit card")):
        r = _repeat(client, me, _txn(source, kind="transfer", amount=1_000, description="Move",
                                     transfer_from_account_id=source,
                                     transfer_to_account_id=destination), expect=400)
        assert r["detail"] == detail
    assert _written(db, me) == written
    assert (_balance(db, checking), _balance(db, card)) == balances


# --- 7 ----------------------------------------------------------------------------------------

def test_repeat_atomic(world, monkeypatch):
    from app.routers import budget_entries

    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    usd = _account(client, me, "Dollar savings", "savings", balance=1_000, currency="USD")
    tag = sw_post(client, me, "/tags/", {"name": "Moves"})["id"]
    flushed = []
    real = budget_entries.add_budget_entry

    def spy(*args, **kwargs):
        entry = real(*args, **kwargs)
        flushed.append(entry.id)
        return entry

    monkeypatch.setattr(budget_entries, "add_budget_entry", spy)
    before = (_written(db, me), _balance(db, checking), _balance(db, usd))
    r = _repeat(client, me, _txn(checking, kind="transfer", amount=5_800, description="To USD",
                                 transfer_from_account_id=checking, transfer_to_account_id=usd,
                                 tag_ids=[tag]), expect=400)
    assert r["detail"] == "Enter the amount received"
    assert len(flushed) == 1 and flushed[0] is not None  # refused after the entry was flushed
    assert (_written(db, me), _balance(db, checking), _balance(db, usd)) == before
    assert db.execute(text("SELECT count(*) FROM budget_entries WHERE id = :i"),
                      {"i": flushed[0]}).scalar_one() == 0
    for table in ("budget_entry_tags", "transaction_tags"):
        assert db.execute(text(f"SELECT count(*) FROM {table} WHERE tag_id = :t"),
                          {"t": tag}).scalar_one() == 0


def test_repeat_atomic_after_the_advance(world):
    """Refused after the row moved both balances, its tags were linked, the
    schedule advanced and the loan's autopay was cleared: one payment ends the
    entry, so autopay is refused as ended (409), and nothing stays."""
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    loan = _account(client, me, "Car loan", "loan", balance=-100_000, loan_kind="auto",
                    loan_annual_rate=12, loan_term_months=24, loan_payment_amount=5_000,
                    loan_first_payment_date="2026-10-20", payment_account_id=checking)
    db.execute(text("UPDATE accounts SET auto_post_enabled = true WHERE id = :i"), {"i": loan})
    db.commit()
    tag = sw_post(client, me, "/tags/", {"name": "Car"})["id"]
    before = (_written(db, me), _balance(db, checking), _balance(db, loan))
    r = _repeat(client, me, _txn(checking, kind="transfer", amount=5_000, description="Car",
                                 transfer_from_account_id=checking, transfer_to_account_id=loan,
                                 tag_ids=[tag]),
                end_mode="after_occurrences", max_occurrences=1, settlement="autopay",
                expect=409)
    assert r["detail"] == "This entry has ended"
    assert (_written(db, me), _balance(db, checking), _balance(db, loan)) == before
    assert db.execute(text("SELECT auto_post_enabled FROM accounts WHERE id = :i"),
                      {"i": loan}).scalar_one() is True
    for table in ("budget_entry_tags", "transaction_tags"):
        assert db.execute(text(f"SELECT count(*) FROM {table} WHERE tag_id = :t"),
                          {"t": tag}).scalar_one() == 0


# --- 8 ----------------------------------------------------------------------------------------

def test_repeat_autopay(world):
    client, db, me, checking, card = (world["client"], world["db"], world["me"],
                                      world["checking"], world["card"])
    body = _repeat(client, me, _txn(checking, description="Rent", amount=10_000),
                   settlement="autopay")
    assert body["entry"]["auto_post_enabled"] is True
    assert body["entry"]["settlement"] == "autopay"
    written, balance = _written(db, me), _balance(db, checking)

    # An unposted past-dated first record is still due.
    r = _repeat(client, me, _txn(checking, day="2026-10-20", description="Water", posted=False),
                settlement="autopay", expect=422)
    assert r["detail"] == AUTOPAY_DUE
    # A past date with missed steps: 1 Oct and 1 Nov would be due.
    r = _repeat(client, me, _txn(checking, day="2026-09-01", description="Power"),
                settlement="autopay", expect=422)
    assert r["detail"] == AUTOPAY_DUE
    # A settlement block: a card subscription isn't a cash entry.
    r = _repeat(client, me, _txn(card, description="Spotify", posted=False),
                settlement="autopay", expect=400)
    assert r["detail"] == "Only a cash entry can settle by autopay"
    assert _written(db, me) == written and _balance(db, checking) == balance


# --- 9 ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("case", ["budget_entry_id", "empty_description", "anchor_day",
                                  "last_weekday", "unknown_field"])
def test_repeat_refusals(world, case):
    client, db, me, checking = world["client"], world["db"], world["me"], world["checking"]
    existing = _repeat(client, me, _txn(checking, description="Existing"))["entry"]["id"]
    written, balance = _written(db, me), _balance(db, checking)
    txn, repeat = _txn(checking), {}
    if case == "budget_entry_id":
        txn["budget_entry_id"] = existing
    elif case == "empty_description":
        txn["description"] = "   "
    elif case == "anchor_day":
        repeat["anchor_day"] = 5  # the date is the 4th
    elif case == "last_weekday":
        repeat["day_rule"] = "last_weekday"  # 4 Nov is not November's last weekday
    else:
        repeat["every"] = 2
    r = _repeat(client, me, txn, expect=422, **repeat)
    if case in ("budget_entry_id", "empty_description"):
        field = case if case == "budget_entry_id" else "description"
        assert any(e["loc"][-1] == field for e in r["detail"]), r
    if case == "unknown_field":
        assert any(e["loc"][-1] == "every" for e in r["detail"]), r
    assert _written(db, me) == written and _balance(db, checking) == balance


def test_repeat_refusal_locations(world):
    """A 422 names the field in the request body, so the dialog can show it there."""
    from app.services.repeat import _request_loc
    from app.schemas.transaction import TransactionCreate

    client, me, checking = world["client"], world["me"], world["checking"]
    r = _repeat(client, me, _txn(checking, amount=0), expect=422)
    assert [e["loc"] for e in r["detail"]] == [["body", "transaction", "amount"]]
    assert _written(world["db"], me) == (0, 0)

    plain = TransactionCreate(**_txn(checking))
    face = TransactionCreate(**_txn(checking, projected_amount=10, projected_currency="USD"))
    assert _request_loc(("name",), plain) == ("body", "transaction", "description")
    assert _request_loc(("amount",), plain) == ("body", "transaction", "amount")
    assert _request_loc(("amount",), face) == ("body", "transaction", "projected_amount")
    assert _request_loc(("tag_ids", 0), plain) == ("body", "transaction", "tag_ids", 0)
    assert _request_loc(("max_occurrences",), plain) == ("body", "repeat", "max_occurrences")
    assert _request_loc((), plain) == ("body", "repeat")


# --- 10 ---------------------------------------------------------------------------------------

def test_repeat_access(world):
    client, db, owner, people = world["client"], world["db"], world["me"], world["people"]
    editor, viewer = people("Bea", "Editor"), people("Vic", "Viewer")
    joint = _account(client, owner, "Joint")
    sw_share(db, joint, editor["id"], "editor", owner["id"])
    sw_share(db, joint, viewer["id"], "viewer", owner["id"])

    r = _repeat(client, viewer, _txn(joint), expect=404)
    assert r["detail"] == "Account not found"
    assert _written(db, viewer) == (0, 0) and _written(db, owner) == (0, 0)
    assert _balance(db, joint) == Decimal("50000.00")

    body = _repeat(client, editor, _txn(joint, description="Shared bill"))
    assert _written(db, editor) == (1, 1) and _written(db, owner) == (0, 0)
    assert body["entry"]["view"] == "full" and body["transaction"]["view"] == "full"
    assert _row(client, editor, body["transaction"]["id"])["budget_entry_id"] == body["entry"]["id"]

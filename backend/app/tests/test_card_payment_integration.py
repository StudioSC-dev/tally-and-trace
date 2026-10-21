"""Pay a card (STU-343 Plan C, 2.6 and 4.1 commit 6).

``POST /cards/{id}/payments`` records one transfer from a same-currency bank,
cash or e-wallet account into the card, for any amount. Payments settle the
oldest statement first, so no statement is targeted. Owner and admin only. A
day after Manila's today is a planned (pending) payment. The endpoint takes
the global lock order itself and re-runs its rules on the locked rows.
Statement payables name their statement's close. Skips without a database.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). Card M as in
``test_statement_minimum_integration``.
"""
import os
import threading
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text

from app.tests.conftest import API, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share
from app.tests.test_balance_locking_integration import JOIN_TIMEOUT, _race
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_statement_minimum_integration import (
    REF, _account, _card_m, _debit, _detail, _m2, _statements,
)

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

USD_REFUSAL = ("Pay this card from a PHP account. Card payments are in the card's currency; "
               "move the money into a PHP account first.")


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def holder(sw_client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=50_000)
    savings = _account(sw_client, me, "Savings", "savings", balance=100_000)
    w = {"client": sw_client, "db": sw_db, "me": me, "checking": checking,
         "savings": savings, "people": sw_people}
    w["card"] = _card_m(sw_client, me, savings)
    return w


def _pay(client, who, card, source, amount, day="2027-03-18", expect=201, **extra):
    r = client.post(f"{API}/cards/{card}/payments", json={
        "amount": amount, "from_account_id": source, "payment_date": day, **extra},
        headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _balance(client, who, account) -> float:
    r = client.get(f"{API}/accounts/{account}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()["balance"]


def _rows_from(db, account) -> int:
    from app.models.transaction import Transaction

    db.rollback()
    return db.query(Transaction).filter(Transaction.account_id == account).count()


def _march(client, who, card):
    return _statements(client, who, card)["2027-03-03"]


# --- paying -----------------------------------------------------------------------------------

def test_pay_minimum_today_posts(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    before = _balance(client, me, card)
    assert _march(client, me, card)["minimum_due"]["remaining"] == 1_650.0

    txn = _pay(client, me, card, w["checking"], 1_650)
    assert (txn["is_posted"], txn["transaction_type"], txn["transfer_from_account_id"],
            txn["transfer_to_account_id"], txn["amount"], txn["description"],
            txn["transaction_date"][:10]) == (
        True, "transfer", w["checking"], card, 1_650.0, "Card payment", "2027-03-18")
    assert _balance(client, me, w["checking"]) == 48_350.0
    assert _balance(client, me, card) == before + 1_650
    march = _march(client, me, card)
    assert (march["owed"], march["minimum_due"]["remaining"]) == (53_350.0, 0.0)


def test_pay_other_amount_on_a_future_date_is_planned(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    before = (_balance(client, me, w["checking"]), _balance(client, me, card))
    txn = _pay(client, me, card, w["checking"], 10_000, day="2027-03-25",
               description="Early payment")
    assert (txn["is_posted"], txn["description"]) == (False, "Early payment")
    assert (_balance(client, me, w["checking"]), _balance(client, me, card)) == before
    assert _march(client, me, card)["owed"] == 45_000.0
    credit = _detail(client, me, card)["credit"]
    assert {"date": "2027-03-25", "amount": 10_000.0, "counted": True,
            "reason": None} in credit["planned_payments"]


def test_pay_full_clears_the_statement(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    full = _march(client, me, card)["clear_through"]
    assert full == 55_000.0
    _pay(client, me, card, w["savings"], full)
    march = _march(client, me, card)
    assert (march["status"], march["owed"], march["clear_through"]) == ("paid", 0.0, 0.0)


# --- who and what may pay ---------------------------------------------------------------------

def test_foreign_paying_account_is_refused(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    usd = _account(client, me, "USD savings", "savings", balance=1_000, currency="USD")
    r = client.post(f"{API}/cards/{card}/payments", json={
        "amount": 100, "from_account_id": usd, "payment_date": "2027-03-18"},
        headers=me["headers"])
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == USD_REFUSAL
    assert _rows_from(w["db"], usd) == 0


def test_payer_rules(world):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    loan = _account(client, me, "Car loan", "loan", balance=-100_000, loan_kind="auto",
                    loan_annual_rate=12, loan_term_months=24, loan_payment_amount=5_000,
                    loan_first_payment_date="2026-10-20", payment_account_id=w["checking"])
    other_card = _account(client, me, "Other card", "credit", 0, billing_cycle_start=10)
    for payer in (loan, other_card):
        r = client.post(f"{API}/cards/{card}/payments", json={
            "amount": 100, "from_account_id": payer, "payment_date": "2027-03-18"},
            headers=me["headers"])
        assert r.status_code == 400, r.text
        assert r.json()["detail"] == "Pay a card from a bank, cash or e-wallet account"
        assert _rows_from(w["db"], payer) == 0
    _pay(client, me, card, card, 100, expect=400)

    stranger = w["people"]("Sam", "Stranger")
    theirs = _account(client, stranger, "Sam bank", balance=1_000)
    r = client.post(f"{API}/cards/{card}/payments", json={
        "amount": 100, "from_account_id": theirs, "payment_date": "2027-03-18"},
        headers=me["headers"])
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "from_account_id account not found"

    wallet = _account(client, me, "E-wallet", "e_wallet", balance=5_000,
                      is_spending_wallet=True)
    _pay(client, me, card, wallet, 500)
    assert _balance(client, me, wallet) == 4_500.0

    for body in ({"amount": 0}, {"amount": -5}, {"amount": 1.234},
                 {"amount": 100, "payment_date": "not-a-date"}):
        r = client.post(f"{API}/cards/{card}/payments", json={
            "from_account_id": w["checking"], "payment_date": "2027-03-18", **body},
            headers=me["headers"])
        assert r.status_code == 422, (body, r.text)


def test_pay_per_role(sw, sw_client, sw_db, sw_people, monkeypatch):
    client, db = sw_client, sw_db
    a, b, v, d = sw["a"], sw["b"], sw["v"], sw["d"]
    c = sw_people("Cal", "Third")
    pin_clock(monkeypatch, REF)
    card = sw_post(client, a, "/accounts/", {
        "name": "Joint card", "account_type": "credit", "balance": 0,
        "credit_limit": 77_777, "billing_cycle_start": 24, "days_until_due_date": 21,
        "payment_account_id": sw["joint"], "tag_ids": [hh_household(db, a)]})["id"]
    for who, role in ((b, "editor"), (d, "admin"), (v, "viewer")):
        sw_share(db, card, who["id"], role, a["id"])
    hh_tag_share(db, a, c)

    for who in (b, v, c):
        own = _account(client, who, "Own bank", balance=1_000)
        r = client.post(f"{API}/cards/{card}/payments", json={
            "amount": 100, "from_account_id": own, "payment_date": "2027-03-18"},
            headers=who["headers"])
        assert r.status_code == 404, r.text
        assert _rows_from(db, own) == 0

    d_checking = _account(client, d, "Dee checking", balance=1_000)
    txn = _pay(client, d, card, d_checking, 250)
    assert txn["is_posted"] is True
    assert _balance(client, a, card) == 250.0


def test_payment_settles_oldest_first_and_clears_the_latest(world):
    w = world
    client, me = w["client"], w["me"]
    card = _m2(w)
    statements = _statements(client, me, card)
    assert statements["2027-03-03"]["clear_through"] == 21_000.0
    _pay(client, me, card, w["savings"], 21_000)
    assert {s["status"] for s in _statements(client, me, card).values()} == {"paid"}

    card = _m2(w, "Card M2 over")
    _pay(client, me, card, w["savings"], 25_000)
    statements = _statements(client, me, card)
    assert {s["status"] for s in statements.values()} == {"paid"}
    assert statements["2027-03-03"]["clear_through"] == 0.0
    assert _balance(client, me, card) == 4_000.0
    # The ₱4,000 left over pays the next statement.
    _debit(client, me, card, "2027-03-10", 3_000)
    r = client.get(f"{API}/accounts/{card}/statements", headers=me["headers"])
    assert r.status_code == 200, r.text
    (april,) = [s for s in r.json()["statements"] if s["close_date"].startswith("2027-04-03")]
    assert april["amount_due"] == 0.0


def test_inactive_payer_is_refused(world):
    from app.models.account import Account

    w = world
    client, me, card, db = w["client"], w["me"], w["card"], w["db"]
    db.query(Account).filter(Account.id == w["checking"]).update({"is_active": False})
    db.commit()
    r = client.post(f"{API}/cards/{card}/payments", json={
        "amount": 100, "from_account_id": w["checking"], "payment_date": "2027-03-18"},
        headers=me["headers"])
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "This account is inactive"
    assert _rows_from(db, w["checking"]) == 0


# --- locking ----------------------------------------------------------------------------------

def test_pay_and_transfer_run_concurrently(world, engine, holder):
    from app.models.user import User
    from app.routers.transactions import add_transaction
    from app.schemas.transaction import TransactionCreate

    w = world
    client, me, card = w["client"], w["me"], w["card"]
    before = Decimal(str(_balance(client, me, card)))

    # A generic transfer into Card M held open, then Pay started behind it.
    add_transaction(holder, holder.get(User, me["id"]), TransactionCreate(
        account_id=w["savings"], transaction_type="transfer",
        transfer_from_account_id=w["savings"], transfer_to_account_id=card, amount=5_000,
        description="Transfer", transaction_date="2027-03-18T00:00:00", is_posted=True))
    holder.flush()
    r = _race(engine, holder, lambda: client.post(f"{API}/cards/{card}/payments", json={
        "amount": 1_650, "from_account_id": w["checking"], "payment_date": "2027-03-18"},
        headers=me["headers"]))
    assert r.status_code == 201, r.text
    assert Decimal(str(_balance(client, me, card))) == before + 5_000 + 1_650

    # Both started together on two connections: both complete.
    results = {}

    def pay():
        results["pay"] = client.post(f"{API}/cards/{card}/payments", json={
            "amount": 100, "from_account_id": w["checking"], "payment_date": "2027-03-18"},
            headers=me["headers"])

    def transfer():
        results["transfer"] = client.post(f"{API}/transactions/", json={
            "account_id": w["savings"], "transaction_type": "transfer",
            "transfer_from_account_id": w["savings"], "transfer_to_account_id": card,
            "amount": 200, "description": "Transfer", "is_posted": True,
            "transaction_date": "2027-03-18T00:00:00"}, headers=me["headers"])

    threads = [threading.Thread(target=fn, daemon=True) for fn in (pay, transfer)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(JOIN_TIMEOUT)
    assert not any(t.is_alive() for t in threads), "a write did not finish"
    assert results["pay"].status_code == 201, results["pay"].text
    assert results["transfer"].status_code == 200, results["transfer"].text
    assert Decimal(str(_balance(client, me, card))) == before + 5_000 + 1_650 + 100 + 200
    assert _balance(client, me, w["checking"]) == 50_000 - 1_650 - 100
    assert _balance(client, me, w["savings"]) == 100_000 - 20_000 - 5_000 - 200


@pytest.mark.parametrize("change, detail", [
    ("is_active = false", "This account is inactive"),
    ("account_type = 'loan', loan_kind = 'personal'",
     "Pay a card from a bank, cash or e-wallet account"),
])
def test_a_payer_changed_while_pay_waits_is_refused(world, engine, holder, change, detail):
    w = world
    client, me, card = w["client"], w["me"], w["card"]
    holder.execute(text("SELECT id FROM accounts WHERE id = :p FOR UPDATE"),
                   {"p": w["checking"]})
    holder.execute(text(f"UPDATE accounts SET {change} WHERE id = :p"), {"p": w["checking"]})
    r = _race(engine, holder, lambda: client.post(f"{API}/cards/{card}/payments", json={
        "amount": 100, "from_account_id": w["checking"], "payment_date": "2027-03-18"},
        headers=me["headers"]))
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == detail
    assert _rows_from(w["db"], w["checking"]) == 0


@pytest.mark.parametrize("grant, change", [
    ("card", "DELETE FROM account_shares WHERE id = :s"),
    ("card", "UPDATE account_shares SET role = 'viewer' WHERE id = :s"),
    ("payer", "UPDATE account_shares SET role = 'viewer' WHERE id = :s"),
])
def test_a_grant_changed_while_pay_waits_is_refused(world, engine, holder, grant, change):
    """D administers Card M and edits A's Checking. While D's Pay waits on its
    lock, connection 2 revokes or downgrades one of those grants: the locked
    recheck reads D's roles afresh, so Pay is 404 with no row."""
    w = world
    client, me, card, db = w["client"], w["me"], w["card"], w["db"]
    d = w["people"]("Dee", "Admin")
    shares = {"card": sw_share(db, card, d["id"], "admin", me["id"]),
              "payer": sw_share(db, w["checking"], d["id"], "editor", me["id"])}
    locked = card if grant == "card" else w["checking"]
    holder.execute(text("SELECT id FROM accounts WHERE id = :a FOR UPDATE"), {"a": locked})
    holder.execute(text(change), {"s": shares[grant]})
    r = _race(engine, holder, lambda: client.post(f"{API}/cards/{card}/payments", json={
        "amount": 100, "from_account_id": w["checking"], "payment_date": "2027-03-18"},
        headers=d["headers"]))
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == ("Account not found" if grant == "card"
                                  else "from_account_id account not found")
    assert _rows_from(db, w["checking"]) == 0


# --- payables ---------------------------------------------------------------------------------

def test_statement_payable_names_its_close(world):
    from app.models.account import Account

    w = world
    client, me, db = w["client"], w["me"], w["db"]
    m2 = _m2(w)
    db.query(Account).filter(Account.id.in_([w["card"], m2])).update(
        {"payment_account_id": w["checking"]}, synchronize_session=False)
    db.commit()
    r = client.get(f"{API}/dashboard/snapshot", headers=me["headers"])
    assert r.status_code == 200, r.text
    rows = [p for p in r.json()["payables"] if p.get("source") == "statement"]
    by_card = {}
    for p in rows:
        by_card.setdefault(p["source_id"], []).append((p["due_date"], p["statement_close"]))
    assert by_card[w["card"]] == [("2027-03-24", "2027-03-03")]
    # M2's statements are overdue: listed on the window start, still naming their close.
    assert sorted(by_card[m2]) == [("2027-03-18", "2027-01-03"), ("2027-03-18", "2027-02-03")]
    for p in r.json()["payables"]:
        if p.get("source") != "statement":
            assert "statement_close" not in p

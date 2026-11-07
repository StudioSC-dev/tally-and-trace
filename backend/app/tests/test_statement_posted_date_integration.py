"""Card rows are placed on statements by their posted day (``statements.statement_day``).

The owner's real shape: a card closing on the 5th, read on Saturday
2026-11-07 (02:00 UTC, 10:00 in Manila). Three charges dated before the Nov 5
close were posted by the bank on Nov 6, one of them marked posted by an older
build that stored the click instant (Nov 5 23:00 UTC, Nov 6 in Manila). They
are on the Dec 5 statement, not the Nov 5 one, and every surface agrees.
Skips without a database.
"""
from datetime import date, datetime
from decimal import Decimal

import pytest

from app.tests.conftest import API, hh_household, sw_db_reachable, sw_post
from app.tests.test_card_charges_integration import pin_clock

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 11, 7, 2, 0)
START = datetime(2026, 11, 7)  # Manila midnight, as every production window starts
END = datetime(2027, 1, 31)
NOV_5, DEC_5 = date(2026, 11, 5), date(2026, 12, 5)

# On the Nov 5 statement by their own day (no posted day): 5,000 + 2,345.67 - 345.67.
KEPT = (("2026-10-08", "5000.00", "debit"), ("2026-10-15", "345.67", "credit"),
        ("2026-10-30", "2345.67", "debit"))
NOV_5_TOTAL = Decimal("7000.00")
# Dated before the close, posted Nov 6: the last one as the pre-#85 instant.
MOVED = (("2026-11-01", "1100.10", "2026-11-06T00:00:00Z"),
         ("2026-11-03", "2200.20", "2026-11-06T00:00:00Z"),
         ("2026-11-04", "3300.30", "2026-11-05T23:00:00Z"))
OPEN = ("2026-11-06", "500.00")
DEC_5_TOTAL = Decimal("7100.60")


def _post(client, who, card, day, amount, kind="debit", posting=None, tags=()):
    body = {"account_id": card, "transaction_type": kind, "amount": amount,
            "description": "Purchase", "transaction_date": f"{day}T00:00:00",
            "is_posted": True, "tag_ids": list(tags)}
    if posting is not None:
        body["posting_date"] = posting
    return sw_post(client, who, "/transactions/", body)["id"]


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    client, db = sw_client, sw_db
    me = sw_people()
    household = hh_household(db, me)
    checking = sw_post(client, me, "/accounts/", {
        "name": "Checking", "account_type": "checking", "balance": 100_000})["id"]
    card = sw_post(client, me, "/accounts/", {
        "name": "Card 5", "account_type": "credit", "balance": 0, "billing_cycle_start": 5,
        "days_until_due_date": 20, "credit_limit": 200_000,
        "payment_account_id": checking})["id"]
    kept = [_post(client, me, card, day, amount, kind, tags=[household])
            for day, amount, kind in KEPT]
    moved = [_post(client, me, card, day, amount, posting=posting, tags=[household])
             for day, amount, posting in MOVED]
    opened = _post(client, me, card, *OPEN, tags=[household])
    return {"client": client, "db": db, "me": me, "card": card, "kept": kept,
            "moved": moved, "open": opened}


def _statements(w):
    """``{close: statement}`` from ``GET /accounts/{card}/statements`` (full view)."""
    r = w["client"].get(f"{API}/accounts/{w['card']}/statements", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return {datetime.fromisoformat(s["close_date"]).date(): s for s in r.json()["statements"]}


def _credit_statements(w):
    r = w["client"].get(f"{API}/cards/{w['card']}/credit", headers=w["me"]["headers"])
    assert r.status_code == 200, r.text
    return {date.fromisoformat(s["close_date"]): s for s in r.json()["statements"]}


def _payables(w):
    """``{close: statement_balance}`` of the card's payables over [START, END)."""
    from app.core.access import viewable_account_ids
    from app.models.account import Account
    from app.services.statements import get_statement_payables

    db = w["db"]
    db.expire_all()
    return {p["statement_close"].date(): p["statement_balance"] for p in get_statement_payables(
        db, [db.get(Account, w["card"])], START, END,
        viewable_ids=viewable_account_ids(db, w["me"]["id"]))}


def _household_dues(w):
    """``{transaction id: due}`` of each Household line, as Household cover settles it."""
    from app.core.access import viewable_account_ids
    from app.models.account import Account
    from app.services.household import _card_household_cover

    db = w["db"]
    db.expire_all()
    cover = _card_household_cover(
        db, db.get(Account, w["card"]), set(), START, END, recorded=False,
        viewable_ids=viewable_account_ids(db, w["me"]["id"]), readable=lambda record: True)
    return {key[1]: due.date() for key, (_, _, due, _) in cover.items() if key[0] == "t"}


def _members(statement):
    return sorted(line["transaction_id"] for line in statement["lines"])


def test_three_rows_posted_after_close_move_to_next_statement(world):
    w = world
    statements = _statements(w)
    nov, dec = statements[NOV_5], statements[DEC_5]
    assert _members(nov) == sorted(w["kept"])
    assert Decimal(str(nov["statement_balance"])) == NOV_5_TOTAL
    assert sum(Decimal(str(line["amount"])) for line in nov["lines"]) == NOV_5_TOTAL
    assert _members(dec) == sorted([*w["moved"], w["open"]])
    assert Decimal(str(dec["statement_balance"])) == DEC_5_TOTAL
    # Each moved line keeps its own date on the statement it moved to.
    assert sorted(line["date"][:10] for line in dec["lines"]) == [
        "2026-11-01", "2026-11-03", "2026-11-04", "2026-11-06"]


def test_statement_total_equals_listed_rows(world):
    for statement in _statements(world).values():
        listed = sum((Decimal(str(line["amount"])) for line in statement["lines"]), Decimal("0"))
        assert listed == Decimal(str(statement["statement_balance"])), statement["close_date"]


def test_every_surface_agrees_on_membership(world):
    w = world
    statements = _statements(w)
    payables = _payables(w)
    assert payables == {NOV_5: NOV_5_TOTAL, DEC_5: DEC_5_TOTAL}
    for close, balance in payables.items():
        assert Decimal(str(statements[close]["statement_balance"])) == balance

    credit = _credit_statements(w)
    assert list(credit) == [NOV_5]  # the closed statements only
    assert Decimal(str(credit[NOV_5]["owed"])) == NOV_5_TOTAL
    assert Decimal(str(credit[NOV_5]["outstanding"])) == NOV_5_TOTAL
    assert credit[NOV_5]["due_date"] == statements[NOV_5]["due_date"][:10]

    dues = _household_dues(w)
    by_statement = {txn_id: datetime.fromisoformat(s["due_date"]).date()
                    for s in statements.values() for txn_id in _members(s)}
    debits = [*w["kept"][:1], *w["kept"][2:], *w["moved"], w["open"]]  # credits are not keyed
    assert sorted(dues) == sorted(debits)
    assert {txn_id: dues[txn_id] for txn_id in debits} == {
        txn_id: by_statement[txn_id] for txn_id in debits}


def test_moving_rows_conserves_total_and_card_balance(world):
    from app.models.account import Account
    from app.models.transaction import Transaction

    w = world
    db = w["db"]

    def figures():
        db.expire_all()
        statements = _statements(w)
        return (statements, sum((Decimal(str(s["statement_balance"]))
                                 for s in statements.values()), Decimal("0")),
                db.get(Account, w["card"]).balance)

    statements, total, balance = figures()
    # Without their posted day the three rows sit on the Nov 5 statement again.
    db.query(Transaction).filter(Transaction.id.in_(w["moved"])).update(
        {"posting_date": None}, synchronize_session=False)
    db.commit()
    before, total_before, balance_before = figures()
    assert Decimal(str(before[NOV_5]["statement_balance"])) == Decimal("13600.60")
    assert Decimal(str(statements[NOV_5]["statement_balance"])) == NOV_5_TOTAL
    assert (total, balance) == (total_before, balance_before)
    assert total == NOV_5_TOTAL + DEC_5_TOTAL


# --- Household reads the same Manila day ---------------------------------------------------------

def _household_card(client, db, who):
    """``who``'s Household-tagged joint account and a Household-tagged card
    (closing on the 5th, due 20 days later) paid from it."""
    household = hh_household(db, who)
    joint = sw_post(client, who, "/accounts/", {
        "name": "Joint", "account_type": "checking", "balance": 100_000,
        "tag_ids": [household]})["id"]
    card = sw_post(client, who, "/accounts/", {
        "name": "Joint card", "account_type": "credit", "balance": 0, "billing_cycle_start": 5,
        "days_until_due_date": 20, "credit_limit": 200_000, "payment_account_id": joint,
        "tag_ids": [household]})["id"]
    return household, joint, card


def test_household_monthly_reads_manila_today(sw_client, sw_db, sw_people, monkeypatch):
    """At 04:00 on Nov 6 in Manila (Nov 5 20:00 UTC) the Nov 5 statement is
    closed: an unposted charge dated Nov 3 is on the open Dec 5 statement in
    Household monthly (no reference, as the router calls it), as in the
    statement history."""
    from app.core.access import viewable_account_ids
    from app.core.time import manila_midnight
    from app.models.account import Account
    from app.services.statements import statement_history

    pin_clock(monkeypatch, datetime(2026, 11, 5, 20, 0))
    client, db = sw_client, sw_db
    me = sw_people()
    household, _, card = _household_card(client, db, me)
    charge = sw_post(client, me, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": 1_234.5,
        "description": "Groceries", "transaction_date": "2026-11-03T00:00:00",
        "is_posted": False, "tag_ids": [household]})["id"]

    db.expire_all()
    history = statement_history(db, db.get(Account, card), manila_midnight(),
                                viewable_account_ids(db, me["id"]))
    (holding,) = [s for s in history if charge in [line["transaction"].id for line in s["lines"]]]
    assert holding["close"].date() == DEC_5
    due_month = holding["due"].strftime("%Y-%m")
    assert due_month == "2026-12"

    r = client.get(f"{API}/household/{me['id']}/monthly", params={"from": "2026-11", "to": "2026-12"},
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    expense = {m["month"]: sum(line["expense"] for line in m["currencies"])
               for m in r.json()["months"]}
    assert expense == {"2026-11": 0, "2026-12": 1_234.5}
    assert expense[due_month] == float(holding["balance"])
    # The dashboard's month is Manila's too.
    r = client.get(f"{API}/household/{me['id']}/dashboard", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["month"]["month"] == "2026-11"


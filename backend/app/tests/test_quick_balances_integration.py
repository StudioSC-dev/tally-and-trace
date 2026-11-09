"""The dashboard's quick balance tiles (STU-578, PR 1): ``GET /dashboard/quick-balances``.

The defaults are the caller's busiest debit account (checking or savings),
credit card and e-wallet, by posted legs dated in the last 90 Manila days;
ties go to the main account, then the latest leg, then the lowest id. Card
tiles carry the latest closed statement's amount due with its due date and
the charges not yet on a statement (``card``), and available credit
(``credit``) where the caller manages every card in the group. The snapshot
is unchanged. Skips without a database.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). The movement
window is 2026-12-19 through 2027-03-18.
"""
import re
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.tests.conftest import API, fx_rates, hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_shared_limit_credit_integration import AMEX, PLATINUM, _pair
from app.tests.test_statement_minimum_integration import REF, _card, _card_m, _debit, _m2, _pay

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BODY_KEYS = {"pinned", "max_tiles", "tiles"}
TILE_KEYS = {"account_id", "name", "account_type", "currency", "balance", "slot"}
CARD_KEYS = {"amount_due", "due_date", "overdue", "incomplete", "unbilled"}
CREDIT_KEYS = {"limit", "available_now", "complete", "shared_with"}


# --- helpers ----------------------------------------------------------------------------------

@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    return {"client": sw_client, "db": sw_db, "people": sw_people}


def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _loan(client, who, name, paying):
    return _account(client, who, name, "loan", -90_000, loan_kind="auto",
                    loan_amortization="fixed", loan_annual_rate=6, loan_term_months=12,
                    loan_payment_amount=8_000, loan_first_payment_date="2027-03-25",
                    loan_payments_made_offset=0, payment_account_id=paying)


def _rows(db, who, account, n, day="2027-03-01", kind="debit", posted=True, to=None,
          source=None, amount="1.00"):
    """``n`` rows written directly (movement only reads rows; balances are not
    the point). A transfer goes from ``account`` (or ``source`` as
    ``transfer_from_account_id`` when given; None leaves it unset) to ``to``."""
    from app.models.transaction import Transaction, TransactionType

    when = datetime.fromisoformat(day) if "T" in day else datetime.fromisoformat(f"{day}T00:00")
    for _ in range(n):
        txn = Transaction(user_id=who["id"], account_id=account, amount=Decimal(amount),
                          transaction_type=TransactionType(kind), is_posted=posted,
                          transaction_date=when, description="Movement")
        if kind == "transfer":
            txn.transfer_from_account_id = account if source == "self" else source
            txn.transfer_to_account_id = to
        db.add(txn)
    db.commit()


def _quick(client, who):
    r = client.get(f"{API}/dashboard/quick-balances", headers=who["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == BODY_KEYS
    assert body["pinned"] is False and body["max_tiles"] == 6
    for tile in body["tiles"]:
        assert TILE_KEYS <= set(tile) <= TILE_KEYS | {"card", "credit"}, tile
        if "card" in tile:
            assert set(tile["card"]) == CARD_KEYS
        if "credit" in tile:
            assert set(tile["credit"]) == CREDIT_KEYS
    return body


def _picked(client, who):
    return [(t["name"], t["slot"]) for t in _quick(client, who)["tiles"]]


def _tile(client, who, account_id):
    return next(t for t in _quick(client, who)["tiles"] if t["account_id"] == account_id)


def _detail(client, who, card):
    r = client.get(f"{API}/cards/{card}/credit", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _snapshot(client, who):
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _user(db, who):
    from app.models.user import User

    db.expire_all()
    return db.get(User, who["id"])


# --- 1. the owner's shape ---------------------------------------------------------------------

def test_defaults_owner_shape(world):
    client, db = world["client"], world["db"]
    me = world["people"]("Seth", "Owner")
    security = _account(client, me, "Security Bank", balance=84_210.55)
    bpi = _account(client, me, "BPI Savings", "savings", balance=200_000)
    amex, platinum = _pair(client, me, security)
    gcash = _account(client, me, "GCash", "e_wallet", balance=3_402.10)
    maya = _account(client, me, "Maya", "e_wallet", balance=900)
    cash = _account(client, me, "Wallet cash", "cash", balance=2_000)
    loan = _loan(client, me, "Car loan", security)
    _rows(db, me, security, 30)
    _rows(db, me, bpi, 10)
    _rows(db, me, amex, 12)
    _rows(db, me, platinum, 5)
    _rows(db, me, gcash, 20)
    _rows(db, me, maya, 8)
    _rows(db, me, cash, 60)  # the busiest account of all, never a default
    _rows(db, me, cash, 40, kind="transfer", source="self", to=loan)

    tiles = _quick(client, me)["tiles"]
    assert [(t["name"], t["slot"], t["account_type"]) for t in tiles] == [
        ("Security Bank", "debit", "checking"),
        (AMEX, "credit", "credit"),
        ("GCash", "e_wallet", "e_wallet")]
    assert [t["account_id"] for t in tiles] == [security, amex, gcash]
    assert "card" in tiles[1] and "credit" in tiles[1]
    assert all("card" not in t and "credit" not in t for t in (tiles[0], tiles[2]))


def test_defaults_follow_movement_not_names(world):
    """Arbitrary names, no Security Bank or GCash: each type's busiest account
    wins, and a second user with the same names but other habits gets other
    winners."""
    client, db = world["client"], world["db"]
    people = world["people"]

    def household(who, legs):
        ids = {
            "Alpha": _account(client, who, "Alpha"),
            "Bravo": _account(client, who, "Bravo", "savings"),
            "Card One": _card(client, who, "Card One"),
            "Card Two": _card(client, who, "Card Two"),
            "Wallet X": _account(client, who, "Wallet X", "e_wallet"),
            "Wallet Y": _account(client, who, "Wallet Y", "e_wallet"),
        }
        for name, n in legs.items():
            _rows(db, who, ids[name], n)
        return ids

    first, second = people("First", "User"), people("Second", "User")
    household(first, {"Alpha": 5, "Bravo": 9, "Card One": 3, "Card Two": 7,
                      "Wallet X": 2, "Wallet Y": 1})
    household(second, {"Alpha": 9, "Bravo": 5, "Card One": 7, "Card Two": 3,
                       "Wallet X": 1, "Wallet Y": 2})

    assert _picked(client, first) == [
        ("Bravo", "debit"), ("Card Two", "credit"), ("Wallet X", "e_wallet")]
    assert _picked(client, second) == [
        ("Alpha", "debit"), ("Card One", "credit"), ("Wallet Y", "e_wallet")]


# --- 2. movement ------------------------------------------------------------------------------

def test_movement_posted_legs_in_window(world):
    from app.services.quick_balances import movement

    client, db = world["client"], world["db"]
    me = world["people"]()
    a = _account(client, me, "A")
    b = _account(client, me, "B", "savings")
    _rows(db, me, a, 3, day="2027-03-01")
    _rows(db, me, a, 1, day="2027-03-18T23:59")  # today, late
    _rows(db, me, a, 1, day="2026-12-19")  # the window's first day
    _rows(db, me, a, 1, kind="credit", day="2027-02-01")
    # Not counted: unposted, 90 days ago, future-dated.
    _rows(db, me, a, 5, day="2027-03-10", posted=False)
    _rows(db, me, a, 5, day="2026-12-18T23:59")
    _rows(db, me, a, 5, day="2027-03-19")
    _rows(db, me, b, 5, day="2027-03-19")
    _rows(db, me, b, 5, day="2027-03-05", posted=False, kind="transfer", source="self", to=a)
    # A transfer: one leg on each side; a legacy one without
    # ``transfer_from_account_id`` counts on its ``account_id``.
    _rows(db, me, a, 1, day="2027-03-05", kind="transfer", source="self", to=b)
    _rows(db, me, b, 1, day="2027-03-06", kind="transfer", source=None, to=a)

    counts = {k: v[0] for k, v in movement(db, [a, b]).items()}
    assert counts == {a: 3 + 1 + 1 + 1 + 1 + 1, b: 2}
    assert movement(db, [a])[a][1] == datetime(2027, 3, 18, 23, 59)


# --- 3. count, not amount ---------------------------------------------------------------------

def test_count_not_amount(world):
    client, db = world["client"], world["db"]
    me = world["people"]()
    a = _account(client, me, "A")
    b = _account(client, me, "B")
    cash = _account(client, me, "Cash", "cash")
    _rows(db, me, cash, 1, kind="transfer", source="self", to=a, amount="1000000.00")
    _rows(db, me, b, 20, amount="15.00")
    assert _picked(client, me) == [("B", "debit")]


# --- 4. tie-breaks ----------------------------------------------------------------------------

def test_tie_breaks(world):
    client, db = world["client"], world["db"]
    people = world["people"]

    # (a) The main account wins a tie on count, even against a later leg and a lower id.
    me = people("Main", "Tie")
    a = _account(client, me, "A")
    b = _account(client, me, "B")
    _rows(db, me, a, 2, day="2027-03-10")
    _rows(db, me, a, 1, day="2027-03-17")
    _rows(db, me, b, 3, day="2027-03-01")
    assert _picked(client, me) == [("A", "debit")]
    r = client.put(f"{API}/auth/me", json={"main_account_id": b}, headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _picked(client, me) == [("B", "debit")]

    # (b) No main account: the latest posted leg wins, over a lower id.
    me = people("Latest", "Tie")
    a = _account(client, me, "A")
    b = _account(client, me, "B")
    _rows(db, me, a, 3, day="2027-03-01")
    _rows(db, me, b, 2, day="2027-03-01")
    _rows(db, me, b, 1, day="2027-03-02")
    assert _picked(client, me) == [("B", "debit")]

    # (c) Same count, same latest leg: the lowest id (the oldest account).
    me = people("Id", "Tie")
    a = _account(client, me, "A")
    b = _account(client, me, "B")
    assert a < b
    _rows(db, me, b, 3, day="2027-03-01")
    _rows(db, me, a, 3, day="2027-03-01")
    assert _picked(client, me) == [("A", "debit")]
    # With no legs at all, the lone candidate of a slot still wins.
    _account(client, me, "Quiet wallet", "e_wallet")
    assert _picked(client, me) == [("A", "debit"), ("Quiet wallet", "e_wallet")]


# --- 5. scope ---------------------------------------------------------------------------------

def test_default_scope(world):
    from app.models.account import Account

    client, db = world["client"], world["db"]
    people = world["people"]
    me, other = people("Me", "Caller"), people("Other", "Sharer")
    mine = _account(client, me, "Mine")
    _rows(db, me, mine, 1)
    old = _account(client, me, "Old bank")
    _rows(db, me, old, 50)
    db.query(Account).filter(Account.id == old).update({"is_active": False})
    db.commit()

    editor = _account(client, other, "Shared as editor")
    viewer = _account(client, other, "Shared as viewer", "savings")
    tagged = _account(client, other, "Household bank", tag_ids=[hh_household(db, other)])
    admin_wallet = _account(client, other, "Shared as admin", "e_wallet")
    sw_share(db, editor, me["id"], "editor", other["id"])
    sw_share(db, viewer, me["id"], "viewer", other["id"])
    sw_share(db, admin_wallet, me["id"], "admin", other["id"])
    hh_tag_share(db, other, me)
    for account in (editor, viewer, tagged):
        _rows(db, other, account, 50)

    # Every one of them is in the caller's view.
    seen = {a["id"] for a in _snapshot(client, me)["balances"]["by_account"]}
    assert {mine, editor, viewer, tagged, admin_wallet} <= seen

    # Only the caller's own and administered accounts are candidates.
    assert _picked(client, me) == [("Mine", "debit"), ("Shared as admin", "e_wallet")]


# --- 6. missing slots -------------------------------------------------------------------------

def test_missing_slots(world):
    client = world["client"]
    people = world["people"]

    no_wallet = people()
    _account(client, no_wallet, "Bank")
    _card(client, no_wallet, "Card")
    _account(client, no_wallet, "Pocket cash", "cash")
    assert _picked(client, no_wallet) == [("Bank", "debit"), ("Card", "credit")]

    bank_only = people()
    bank = _account(client, bank_only, "Bank")
    _loan(client, bank_only, "Loan", bank)
    assert _picked(client, bank_only) == [("Bank", "debit")]

    cash_only = people()
    _account(client, cash_only, "Pocket cash", "cash")
    assert _quick(client, cash_only)["tiles"] == []

    nothing = people()
    assert _quick(client, nothing)["tiles"] == []


# --- 7. amount due ----------------------------------------------------------------------------

def test_card_amount_due_matches_snapshot(world):
    client = world["client"]
    people = world["people"]

    def single(who, card):
        listed = {i["account_id"]: i for i in _snapshot(client, who)["card_statements_due"]}
        return _tile(client, who, card)["card"], listed.get(card)

    # Card M: 55,000 on the Mar 3 statement, due Mar 24.
    m = people()
    savings = _account(client, m, "Savings", "savings", balance=100_000)
    card = _card_m(client, m, savings)
    tile, row = single(m, card)
    assert tile["amount_due"] == row["clear_through"] == 55_000.0
    assert (tile["due_date"], tile["overdue"], tile["incomplete"]) == (
        row["due_date"], row["overdue"], row["incomplete"]) == ("2027-03-24", False, False)

    # Card M2: two older statements still owed, so overdue.
    m2_owner = people()
    m2 = _m2({"client": client, "me": m2_owner})
    tile, row = single(m2_owner, m2)
    assert tile["amount_due"] == row["clear_through"] == 21_000.0
    assert (tile["due_date"], tile["overdue"]) == (row["due_date"], row["overdue"]) == (
        "2027-03-24", True)

    # Paid in full: not in the snapshot; 0, with the latest statement's due date.
    paid = people()
    bank = _account(client, paid, "Bank", balance=100_000)
    card = _card(client, paid, "Paid card")
    _debit(client, paid, card, "2027-02-20", 5_000)
    _pay(client, paid, bank, card, "2027-03-10", 5_000)
    tile, row = single(paid, card)
    assert row is None
    latest = _detail(client, paid, card)["statements"][-1]
    assert tile == {"amount_due": 0.0, "due_date": latest["due_date"], "overdue": False,
                    "incomplete": False, "unbilled": 0.0}
    assert latest["due_date"] == "2027-03-24"

    # No closed statement: 0 and no due date.
    fresh = people()
    card = _card(client, fresh, "Fresh card")
    _debit(client, fresh, card, "2027-03-10", 700)
    tile, row = single(fresh, card)
    assert row is None
    assert tile == {"amount_due": 0.0, "due_date": None, "overdue": False,
                    "incomplete": False, "unbilled": 700.0}


def test_card_due_and_unbilled(world):
    """Owner ruling 2026-11-09: the latest closed statement's amount due with
    its due date, and the charges not yet on a statement beside it."""
    client = world["client"]
    me = world["people"]()
    savings = _account(client, me, "Savings", "savings", balance=100_000)
    card = _card_m(client, me, savings)  # 55,000 on the Mar 3 statement, due Mar 24
    _debit(client, me, card, "2027-03-05", 2_500)
    _debit(client, me, card, "2027-03-10", 1_200)
    sw_post(client, me, "/transactions/", {
        "account_id": card, "transaction_type": "credit", "amount": 200,
        "description": "Refund", "transaction_date": "2027-03-12T00:00:00", "is_posted": True})
    # Charged Mar 2, posted by the bank Mar 4: after the close, so not billed yet.
    _debit(client, me, card, "2027-03-02", 300, posting_date="2027-03-04T00:00:00")
    _debit(client, me, card, "2027-03-15", 999, posted=False)  # pending: not counted
    _pay(client, me, savings, card, "2027-03-08", 5_000)  # pays the statement, not netted

    tile = _tile(client, me, card)
    listed = {i["account_id"]: i for i in _snapshot(client, me)["card_statements_due"]}
    assert tile["card"] == {"amount_due": 50_000.0, "due_date": "2027-03-24", "overdue": False,
                            "incomplete": False, "unbilled": 3_800.0}
    assert listed[card]["clear_through"] == 50_000.0
    # The two meanings differ: everything owed now is the statement plus the unbilled.
    assert -tile["balance"] != tile["card"]["amount_due"]


def test_card_without_cycle_has_no_unbilled(world):
    client = world["client"]
    me = world["people"]()
    card = _account(client, me, "Store card", "credit", 0, credit_limit=10_000)
    _debit(client, me, card, "2027-03-10", 700)
    assert _tile(client, me, card)["card"] == {
        "amount_due": 0.0, "due_date": None, "overdue": False, "incomplete": False,
        "unbilled": None}


# --- 8. available credit ----------------------------------------------------------------------

def test_card_available_and_shared(world):
    from app.models.account import Account
    from app.services import quick_balances

    client, db = world["client"], world["db"]
    people = world["people"]
    me = people("Seth", "Owner")
    bank = _account(client, me, "Security Bank", balance=500_000)
    amex, platinum = _pair(client, me, bank)
    _debit(client, me, amex, "2027-03-01", 100_000)
    _debit(client, me, platinum, "2027-03-02", 20_000)
    _debit(client, me, amex, "2027-03-03", 1_000)

    tile = _tile(client, me, amex)
    assert tile["slot"] == "credit"
    amex_credit = _detail(client, me, amex)["credit"]
    platinum_credit = _detail(client, me, platinum)["credit"]
    assert tile["credit"] == {key: amex_credit[key] for key in CREDIT_KEYS}
    assert tile["credit"]["available_now"] == platinum_credit["available_now"] == 359_000.0
    assert tile["credit"]["shared_with"] == [{"account_id": platinum, "name": PLATINUM}]

    # The linked card's own tile reports the same group figure.
    user = _user(db, me)
    linked = quick_balances.tiles(db, user, [(None, db.get(Account, platinum))], fx_rates())
    assert linked[0]["credit"]["available_now"] == 359_000.0
    assert linked[0]["credit"]["shared_with"] == [{"account_id": amex, "name": AMEX}]

    # An admin of the Amex only: the card's figures, but no group credit.
    admin = people("Dee", "Admin")
    sw_share(db, amex, admin["id"], "admin", me["id"])
    tile = _tile(client, admin, amex)
    assert "card" in tile and "credit" not in tile

    # An editor or viewer gets neither key (pinned tiles come in PR 2).
    for role in ("editor", "viewer"):
        who = people(role.title(), "Share")
        sw_share(db, amex, who["id"], role, me["id"])
        out = quick_balances.tiles(db, _user(db, who), [(None, db.get(Account, amex))],
                                   fx_rates())
        assert set(out[0]) == TILE_KEYS


# --- 9. native currency -----------------------------------------------------------------------

def test_balance_native_currency(world):
    client = world["client"]
    me = world["people"]()
    usd = _account(client, me, "Dollar account", balance=1_234.56, currency="USD")
    wallet = _account(client, me, "Overdrawn wallet", "e_wallet", balance=-50)
    tiles = _quick(client, me)["tiles"]
    assert [(t["account_id"], t["currency"], t["balance"]) for t in tiles] == [
        (usd, "USD", 1_234.56), (wallet, "PHP", -50.0)]


# --- 10. query count --------------------------------------------------------------------------

def test_quick_balances_query_count(world):
    from app.core.database import engine

    client, db = world["client"], world["db"]
    me = world["people"]()
    bank = _account(client, me, "Bank", balance=100_000)
    card = _card(client, me, "Card")
    wallet = _account(client, me, "Wallet", "e_wallet", balance=1_000)
    _debit(client, me, card, "2027-02-20", 1_000)
    # A payment already in place: its source's cycle settings are read once
    # (``statements._card_rows``), whatever the number of rows.
    _pay(client, me, bank, card, "2027-03-01", 500)

    def count():
        seen = []

        def record(conn, cursor, statement, parameters, context, executemany):
            seen.append(statement)

        event.listen(engine, "before_cursor_execute", record)
        try:
            body = _quick(client, me)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        return body, len(seen)

    before, n_before = count()
    _rows(db, me, bank, 20)
    _rows(db, me, card, 15, day="2027-03-10")
    _rows(db, me, wallet, 10)
    _rows(db, me, bank, 5, kind="transfer", source="self", to=card)
    after, n_after = count()
    assert [t["account_id"] for t in after["tiles"]] == [bank, card, wallet]
    assert after["tiles"][1]["card"]["unbilled"] == 15.0  # the new rows were read
    assert n_after == n_before, (n_before, n_after)


# --- 11. the snapshot -------------------------------------------------------------------------

SNAPSHOT_KEYS = {
    "balances", "upcoming_this_month", "monthly_summary", "forecast_next_3_months",
    "goals_progress", "wishlist_next_up", "available_cash", "account_closings", "payables",
    "card_charges", "card_statements_due", "missed", "installment_review",
    "installment_auto_post", "autopay_due", "auto_post_scheduled", "today", "currencies", "fx"}
BALANCES_KEYS = {"total", "by_account", "by_currency"}
BY_ACCOUNT_KEYS = {"id", "name", "balance", "currency", "is_spending_wallet"}
BY_CURRENCY_KEYS = {"currency", "total", "available_cash"}
STATEMENT_DUE_KEYS = {"account_id", "name", "currency", "close_date", "due_date",
                      "clear_through", "statement_count", "oldest_due", "overdue", "incomplete",
                      "unposted_installments", "unposted_postable"}


def test_snapshot_shape_unchanged(world):
    """The quick balances live on their own endpoint: the snapshot's keys and
    the shape of its balance and owed-statement rows stay as they were."""
    client = world["client"]
    me = world["people"]()
    savings = _account(client, me, "Savings", "savings", balance=100_000)
    _account(client, me, "Wallet", "e_wallet", balance=500)
    _card_m(client, me, savings)
    body = _snapshot(client, me)
    assert set(body) == SNAPSHOT_KEYS
    assert set(body["balances"]) == BALANCES_KEYS
    assert body["balances"]["by_account"]
    for row in body["balances"]["by_account"]:
        assert set(row) == BY_ACCOUNT_KEYS
        assert not {"account_type", "slot", "card", "credit"} & set(row)
    for row in body["balances"]["by_currency"]:
        assert set(row) == BY_CURRENCY_KEYS
    assert body["card_statements_due"]
    for row in body["card_statements_due"]:
        assert set(row) == STATEMENT_DUE_KEYS
    assert not any(re.search("quick", key) for key in body)

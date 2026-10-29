"""Each closed statement's minimum amount due (STU-343 Plan C, 2.5 and 4.1 commit 5).

``GET /cards/{id}/credit`` lists the card's closed statements with their
minimum: the override entered from the bank's statement, else the estimate
from the card's rule, carrying the minimums left unpaid by earlier statements
already due. Owner and admin only. Skips without a database.

Reference: Thursday 2027-03-18, 02:00 UTC (10:00 in Manila). "Card M": BDO
rule, PHP, limit ₱200,000, closes on the 3rd, due 21 days later.
"""
from datetime import datetime
from pathlib import Path

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_minimum_due_rule_integration import _alembic, scratch_url  # noqa: F401

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
REF = datetime(2027, 3, 18, 2, 0)
RULE_REVISION = "644091f19b93"
OVERRIDE_REVISION = "20604a414c22"

BDO = {"version": 1, "preset": "bdo", "base_percent": "3",
       "base_excludes": ["installments", "overlimit"], "installment_percent": "3",
       "floor": {"PHP": "850", "USD": "17"}, "floored_terms": [],
       "added_terms": ["installments", "overdue", "overlimit"], "annual_fee": None,
       "rounding": "down"}

STATEMENT_KEYS = {"close_date", "due_date", "status", "owed", "clear_through", "outstanding",
                  "incomplete", "minimum_due"}
MINIMUM_KEYS = {"amount", "remaining", "source", "reason", "complete", "assumptions", "inputs"}


# --- helpers ----------------------------------------------------------------------------------

def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, name="Card M", due_in=21, rule=BDO, limit=200_000):
    body = {"billing_cycle_start": 3, "days_until_due_date": due_in}
    if limit is not None:
        body["credit_limit"] = limit
    if rule is not None:
        body["minimum_due_rule"] = rule
    return _account(client, who, name, "credit", 0, **body)


def _debit(client, who, card, day, amount, description="Purchase", posted=True, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": amount,
        "description": description, "transaction_date": f"{day}T00:00:00",
        "is_posted": posted, **extra})["id"]


def _pay(client, who, src, card, day, amount, posted=True):
    return sw_post(client, who, "/transactions/", {
        "account_id": src, "transaction_type": "transfer", "transfer_from_account_id": src,
        "transfer_to_account_id": card, "amount": amount, "description": "Card payment",
        "transaction_date": f"{day}T00:00:00", "is_posted": posted})["id"]


def _installment(client, who, card, next_day, amount, name, months=6, **extra):
    entry = sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": amount, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": months, **extra})
    assert entry["kind"] == "installment"
    return entry["id"]


def _mark_paid(client, who, entry):
    r = client.post(f"{API}/budget-entries/{entry}/materialize", json={},
                    headers=who["headers"])
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _foreign_debit(client, who, card, day, amount, currency="EUR"):
    return _debit(client, who, card, day, amount, "Foreign shop", posted=False,
                  currency="PHP", projected_amount=amount, projected_currency=currency)


def _detail(client, who, card, expect=200):
    r = client.get(f"{API}/cards/{card}/credit", headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def _statements(client, who, card):
    body = _detail(client, who, card)
    for statement in body["statements"]:
        assert set(statement) == STATEMENT_KEYS
        assert set(statement["minimum_due"]) == MINIMUM_KEYS
    return {s["close_date"]: s for s in body["statements"]}


def _minimum(client, who, card, close):
    return _statements(client, who, card)[close]["minimum_due"]


def _set_rule(client, who, card, rule):
    r = client.put(f"{API}/accounts/{card}", json={"minimum_due_rule": rule},
                   headers=who["headers"])
    assert r.status_code == 200, r.text


def _override(client, who, card, close, amount=None, expect=200):
    path = f"{API}/cards/{card}/statements/{close}/minimum-due"
    if amount is None:
        r = client.delete(path, headers=who["headers"])
    else:
        r = client.put(path, json={"amount": amount}, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _card_m(client, who, savings, **card):
    """Card M's rows: Jan 20 ₱20,000; Laptop ₱4,000 (Feb 10) and Sofa ₱6,000
    (Feb 20) Marked paid; ₱20,000 paid from Savings Feb 12; Feb 15 ₱30,000 and
    Feb 25 ₱15,000."""
    card_id = _card(client, who, **card)
    _debit(client, who, card_id, "2027-01-20", 20_000)
    laptop = _installment(client, who, card_id, "2027-02-10", 4_000, "Laptop")
    sofa = _installment(client, who, card_id, "2027-02-20", 6_000, "Sofa")
    _mark_paid(client, who, laptop)
    _mark_paid(client, who, sofa)
    _pay(client, who, savings, card_id, "2027-02-12", 20_000)
    _debit(client, who, card_id, "2027-02-15", 30_000)
    _debit(client, who, card_id, "2027-02-25", 15_000)
    return card_id


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    checking = _account(sw_client, me, "Checking", balance=50_000)
    savings = _account(sw_client, me, "Savings", "savings", balance=100_000)
    return {"client": sw_client, "db": sw_db, "me": me, "checking": checking,
            "savings": savings, "people": sw_people}


@pytest.fixture
def card_m(world):
    world["card"] = _card_m(world["client"], world["me"], world["savings"])
    return world


def _m2(w, name="Card M2", due_in=21, debits=(("2026-12-20", 20_000), ("2027-01-25", 1_000))):
    card = _card(w["client"], w["me"], name, due_in=due_in)
    for day, amount in debits:
        _debit(w["client"], w["me"], card, day, amount)
    return card


# --- the estimate -----------------------------------------------------------------------------

def test_estimate_from_the_bdo_rule(card_m):
    w = card_m
    client, me, card = w["client"], w["me"], w["card"]
    body = _detail(client, me, card)
    assert body["rule"] == BDO
    statements = _statements(client, me, card)
    assert list(statements) == ["2027-02-03", "2027-03-03"]

    march = statements["2027-03-03"]
    assert (march["due_date"], march["outstanding"], march["owed"], march["status"],
            march["clear_through"], march["incomplete"]) == (
        "2027-03-24", 55_000.0, 55_000.0, "open", 55_000.0, False)
    assert march["minimum_due"] == {
        "amount": 1_650.0, "remaining": 1_650.0, "source": "estimate", "reason": None,
        "complete": True, "assumptions": ["fees_not_itemised", "installments_linked_only"],
        "inputs": {"outstanding": 55_000.0, "installments": 10_000.0,
                   "new_transactions": 45_000.0, "overdue": 0.0, "overlimit": 0.0}}

    february = statements["2027-02-03"]
    assert (february["status"], february["owed"], february["minimum_due"]["amount"],
            february["minimum_due"]["remaining"]) == ("paid", 0.0, 850.0, 0.0)

    _set_rule(client, me, card, {**BDO, "base_excludes": [
        "installments", "overlimit", "new_transactions"]})
    minimum = _minimum(client, me, card, "2027-03-03")
    assert minimum["amount"] == 1_150.0
    assert "new_transactions_excluded" in minimum["assumptions"]


def test_override_replaces_one_statement_and_feeds_overdue(card_m):
    w = card_m
    client, me, card = w["client"], w["me"], w["card"]
    r = _override(client, me, card, "2027-03-03", 1_234.56)
    assert r.json() == {"close_date": "2027-03-03", "amount": 1_234.56}
    assert _minimum(client, me, card, "2027-03-03") == {
        "amount": 1_234.56, "remaining": 1_234.56, "source": "statement", "reason": None,
        "complete": True, "assumptions": [], "inputs": None}
    assert _minimum(client, me, card, "2027-02-03")["source"] == "estimate"
    # A second PUT replaces it.
    _override(client, me, card, "2027-03-03", 1_000)
    assert _minimum(client, me, card, "2027-03-03")["amount"] == 1_000.0

    r = _override(client, me, card, "2027-03-03", expect=204)
    assert r.content == b""
    minimum = _minimum(client, me, card, "2027-03-03")
    assert (minimum["amount"], minimum["source"]) == (1_650.0, "estimate")

    for close in ("2027-03-04", "2027-04-03", "not-a-date"):
        _override(client, me, card, close, 100, expect=422)
    _override(client, me, card, "2027-03-03", -1, expect=422)
    _override(client, me, card, "2027-03-03", 1.234, expect=422)

    editor = w["people"]("Ed", "Itor")
    sw_share(w["db"], card, editor["id"], "editor", me["id"])
    _override(client, editor, card, "2027-03-03", 100, expect=404)
    _override(client, editor, card, "2027-03-03", expect=404)
    _detail(client, editor, card, expect=404)

    # A card without cycle settings.
    plain = _account(client, me, "Plain card", "credit", 0, credit_limit=10_000)
    _override(client, me, plain, "2027-03-03", 100, expect=400)


# --- the overdue carry ------------------------------------------------------------------------

def test_overdue_carries_the_previous_minimum_left_unpaid(world):
    w = world
    client, me = w["client"], w["me"]
    card = _m2(w)
    minimum = _minimum(client, me, card, "2027-02-03")
    assert (minimum["inputs"]["overdue"], minimum["amount"]) == (850.0, 1_700.0)

    _override(client, me, card, "2027-01-03", 1_000)
    minimum = _minimum(client, me, card, "2027-02-03")
    assert (minimum["inputs"]["overdue"], minimum["amount"]) == (1_000.0, 1_850.0)


def test_overdue_waits_for_the_due_date(world, monkeypatch):
    w = world
    client, me = w["client"], w["me"]
    pin_clock(monkeypatch, datetime(2027, 4, 10, 2, 0))  # Apr 3 has closed
    card = _m2(w, "Card M3", due_in=45, debits=(("2026-12-20", 20_000),))
    statements = _statements(client, me, card)
    assert list(statements) == ["2027-01-03", "2027-02-03", "2027-03-03", "2027-04-03"]
    assert statements["2027-01-03"]["due_date"] == "2027-02-17"

    def carry(close):
        minimum = _statements(client, me, card)[close]["minimum_due"]
        return minimum["inputs"]["overdue"], minimum["amount"]

    assert carry("2027-02-03") == (0.0, 850.0)
    assert carry("2027-03-03") == (850.0, 1_700.0)
    assert carry("2027-04-03") == (1_700.0, 2_550.0)

    # One ₱850 payment clears January's obligation only.
    _pay(client, me, w["savings"], card, "2027-02-10", 850)
    assert carry("2027-03-03")[0] == 0.0
    assert carry("2027-04-03")[0] == 850.0

    # Due 31 days after close: January is due Feb 3, not before the Feb 3 close.
    pin_clock(monkeypatch, REF)
    card = _m2(w, "Card M4", due_in=31, debits=(("2026-12-20", 20_000),))
    minimum = _minimum(client, me, card, "2027-02-03")
    assert (minimum["inputs"]["overdue"], minimum["amount"]) == (0.0, 850.0)


def test_late_payment_before_the_next_close_reduces_overdue(world):
    w = world
    client, me = w["client"], w["me"]
    rows = (("2026-12-20", 20_000), ("2027-01-26", 1_000))
    for paid, overdue, outstanding, amount in ((20_000, 0.0, 1_000.0, 850.0),
                                               (500, 350.0, 20_500.0, 1_200.0)):
        card = _m2(w, f"Card late {paid}", debits=rows)
        assert _minimum(client, me, card, "2027-01-03")["amount"] == 850.0
        _pay(client, me, w["savings"], card, "2027-01-25", paid)
        minimum = _minimum(client, me, card, "2027-02-03")
        assert (minimum["inputs"]["overdue"], minimum["inputs"]["outstanding"],
                minimum["amount"]) == (overdue, outstanding, amount), paid


def test_a_payment_spreads_over_every_unpaid_obligation(world):
    """Synthetic BDO statements closing Jan 3 and Feb 3 (₱20,000 on Dec 20, due 21
    days later): each leaves a ₱850 obligation unpaid, so March carries ₱1,700.
    A payment on Feb 25 is spread oldest first over both, and only the rest of
    it is ignored: one ₱1,700 payment and two ₱850 payments that day give the
    same March minimum, and one ₱1,200 payment spans the two."""
    w = world
    client, me = w["client"], w["me"]
    rows = (("2026-12-20", 20_000),)

    def march(card):
        minimum = _minimum(client, me, card, "2027-03-03")
        return minimum["inputs"]["overdue"], minimum["amount"]

    unpaid = _m2(w, "Card unpaid", debits=rows)
    assert march(unpaid) == (1_700.0, 2_550.0)

    combined = _m2(w, "Card combined", debits=rows)
    _pay(client, me, w["savings"], combined, "2027-02-25", 1_700)
    split = _m2(w, "Card split", debits=rows)
    _pay(client, me, w["savings"], split, "2027-02-25", 850)
    _pay(client, me, w["savings"], split, "2027-02-25", 850)
    assert march(combined) == march(split) == (0.0, 850.0)

    spanning = _m2(w, "Card spanning", debits=rows)
    _pay(client, me, w["savings"], spanning, "2027-02-25", 1_200)
    # January's ₱850 is met and ₱350 goes to February's, leaving ₱500.
    assert march(spanning) == (500.0, 1_350.0)


def test_remaining_minimum_after_a_payment(card_m):
    w = card_m
    client, me, card = w["client"], w["me"], w["card"]
    _pay(client, me, w["savings"], card, "2027-03-20", 500, posted=False)
    march = _statements(client, me, card)["2027-03-03"]
    assert (march["owed"], march["minimum_due"]["amount"],
            march["minimum_due"]["remaining"]) == (54_500.0, 1_650.0, 1_150.0)


def test_minimum_is_cumulative_on_a_carried_balance(world):
    w = world
    client, me = w["client"], w["me"]
    card = _m2(w)
    statements = _statements(client, me, card)
    assert statements["2027-02-03"]["minimum_due"]["amount"] == 1_700.0
    march = statements["2027-03-03"]
    assert (march["minimum_due"]["inputs"]["overdue"], march["minimum_due"]["amount"],
            march["minimum_due"]["remaining"], march["clear_through"]) == (
        1_700.0, 2_550.0, 2_550.0, 21_000.0)

    card = _m2(w, "Card M2 paid")
    _pay(client, me, w["savings"], card, "2027-02-10", 850)
    statements = _statements(client, me, card)
    assert statements["2027-01-03"]["minimum_due"]["remaining"] == 0.0
    march = statements["2027-03-03"]["minimum_due"]
    assert (march["inputs"]["overdue"], march["amount"], march["remaining"]) == (
        850.0, 1_700.0, 1_700.0)


# --- completeness -----------------------------------------------------------------------------

def test_earlier_unconverted_line_makes_later_minimums_incomplete(world):
    w = world
    client, me = w["client"], w["me"]
    card = _card(client, me, "Card EUR")
    _foreign_debit(client, me, card, "2027-01-20", 100)
    _debit(client, me, card, "2027-02-15", 30_000)
    march = _statements(client, me, card)["2027-03-03"]
    assert march["incomplete"] is True
    assert march["minimum_due"]["complete"] is False
    assert "unconverted_lines_left_out" in march["minimum_due"]["assumptions"]

    _override(client, me, card, "2027-03-03", 900)
    minimum = _minimum(client, me, card, "2027-03-03")
    assert (minimum["complete"], minimum["source"], minimum["amount"]) == (
        True, "statement", 900.0)


def test_unconverted_line_marks_the_minimum_incomplete(card_m):
    w = card_m
    client, me, card = w["client"], w["me"], w["card"]
    _foreign_debit(client, me, card, "2027-02-28", 50)
    march = _statements(client, me, card)["2027-03-03"]
    minimum = march["minimum_due"]
    assert (minimum["amount"], minimum["complete"], march["incomplete"]) == (
        1_650.0, False, True)
    assert minimum["assumptions"] == ["fees_not_itemised", "installments_linked_only",
                                      "unconverted_lines_left_out"]
    assert _statements(client, me, card)["2027-02-03"]["incomplete"] is False


def test_minimum_unavailable_without_rule_and_open_cycle_excluded(world):
    w = world
    client, me = w["client"], w["me"]
    card = _card_m(client, me, w["savings"], rule=None)
    body = _detail(client, me, card)
    assert body["rule"] is None
    assert [s["close_date"] for s in body["statements"]] == ["2027-02-03", "2027-03-03"]
    assert body["open_cycle"] == {"close_date": "2027-04-03", "due_date": "2027-04-24"}
    assert body["statements"][1]["minimum_due"] == {
        "amount": None, "remaining": None, "source": "unavailable", "reason": "no_rule",
        "complete": False, "assumptions": [], "inputs": None}


def test_older_statements_still_owed_are_listed(world):
    """The six most recent closed statements, plus any older one still owed."""
    w = world
    client, me = w["client"], w["me"]
    card = _card(client, me, "Card long")
    _debit(client, me, card, "2026-06-20", 1_000)
    _debit(client, me, card, "2026-07-20", 500)
    _pay(client, me, w["savings"], card, "2026-08-20", 500)  # half of June's
    statements = _statements(client, me, card)
    assert list(statements) == ["2026-07-03", "2026-08-03", "2026-10-03", "2026-11-03",
                                "2026-12-03", "2027-01-03", "2027-02-03", "2027-03-03"]
    assert (statements["2026-07-03"]["owed"], statements["2026-08-03"]["owed"]) == (
        500.0, 500.0)
    assert statements["2027-03-03"]["clear_through"] == 1_000.0


# --- what the caller sees ---------------------------------------------------------------------

def test_hidden_installment_link_does_not_change_the_minimum(sw, sw_client, sw_db, monkeypatch):
    from app.models.transaction import Transaction

    client, db = sw_client, sw_db
    a, b = sw["a"], sw["b"]
    pin_clock(monkeypatch, REF)
    card = _card(client, a, "Joint card")
    sw_share(db, card, b["id"], "editor", a["id"])
    _debit(client, a, card, "2027-02-15", 30_000)
    # B's own installment, touching B's private bank: Limited for A.
    entry = _installment(client, b, card, "2027-02-10", 4_000, f"{PRIVATE} bike",
                         overflow_account_id=sw["b_private"])
    row = _mark_paid(client, b, entry)
    assert db.get(Transaction, row).budget_entry_id == entry

    linked = _minimum(client, a, card, "2027-03-03")
    assert linked["inputs"] == {"outstanding": 34_000.0, "installments": 0.0,
                                "new_transactions": 34_000.0, "overdue": 0.0,
                                "overlimit": 0.0}

    db.query(Transaction).filter(Transaction.id == row).update({"budget_entry_id": None})
    db.commit()
    assert _minimum(client, a, card, "2027-03-03") == linked

    db.query(Transaction).filter(Transaction.id == row).update({"budget_entry_id": entry})
    db.commit()
    r = client.put(f"{API}/budget-entries/{entry}", json={"billing_kind": "bill"},
                   headers=b["headers"])
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "bill"
    assert _minimum(client, a, card, "2027-03-03") == linked

    # A's own installment linked the same way does count in I.
    own = _installment(client, a, card, "2027-02-20", 4_000, "Desk")
    _mark_paid(client, a, own)
    minimum = _minimum(client, a, card, "2027-03-03")
    assert (minimum["inputs"]["installments"], minimum["inputs"]["new_transactions"]) == (
        4_000.0, 34_000.0)


# --- migration and export ---------------------------------------------------------------------

def test_override_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert OVERRIDE_REVISION in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(OVERRIDE_REVISION).down_revision == RULE_REVISION


def test_upgrade_adds_the_override_table_and_downgrade_drops_it(scratch_url):  # noqa: F811
    from sqlalchemy import create_engine, inspect

    def tables():
        engine = create_engine(scratch_url)
        try:
            with engine.connect() as c:
                found = inspect(c)
                return (set(found.get_table_names()),
                        {col["name"] for col in found.get_columns("accounts")})
        finally:
            engine.dispose()

    _alembic(scratch_url, "upgrade", OVERRIDE_REVISION)
    names, columns = tables()
    assert "card_statement_minimums" in names
    _alembic(scratch_url, "downgrade", RULE_REVISION)
    names, columns = tables()
    assert "card_statement_minimums" not in names
    # Only the override table goes: the rule column stays at its own revision.
    assert "minimum_due_rule" in columns


def test_the_export_carries_the_overrides(card_m):
    w = card_m
    client, me, card = w["client"], w["me"], w["card"]
    _override(client, me, card, "2027-03-03", 1_234.56)
    r = client.get(f"{API}/data/export.json", headers=me["headers"])
    assert r.status_code == 200, r.text
    (row,) = r.json()["card_statement_minimums"]
    assert (row["account_id"], row["statement_close"], row["amount"]) == (
        card, "2027-03-03", "1234.56")
    assert list(row) == ["id", "account_id", "statement_close", "amount", "created_at",
                         "updated_at"]

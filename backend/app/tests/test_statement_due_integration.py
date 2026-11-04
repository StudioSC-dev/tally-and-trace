"""A statement's printed due date (``card_statement_due_overrides``).

The bank's printed due replaces the rolled due of one statement, identified by
its close, in every cycle consumer: payables, status, the overdue carry, the
forecast and Household. The close, the window and the minimum are unchanged.
Owner and admin only. The migration sits on the single Alembic head and its
downgrade drops the table. Skips without a database.

Reference: Friday 2026-11-20, 02:00 UTC (10:00 in Manila). "Card A" closes on
the 4th, due 25 days later: the 4 Oct statement is due Thu 29 Oct, 4 Nov's
computed due (Sun 29 Nov) rolls past Bonifacio Day to Tue 1 Dec, 4 Dec's is
Tue 29 Dec and 4 Jan's Fri 29 Jan. The statements closing 4 Dec and 4 Jan
are the next two; 4 Feb is the third.
"""
from datetime import datetime
from pathlib import Path

import pytest

from app.tests.conftest import API, hh_tag_share, sw_db_reachable, sw_post, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_minimum_due_rule_integration import _alembic, scratch_url  # noqa: F401
from app.tests.test_statement_minimum_integration import BDO

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "e7a1d3f5b9c2"
DUE_REVISION = "8f4493e073df"
REF = datetime(2026, 11, 20, 2, 0)


# --- helpers ----------------------------------------------------------------------------------

def _account(client, who, name, account_type="checking", balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card_a(client, who, name="Card A", **extra):
    return _account(client, who, name, "credit", 0, billing_cycle_start=4,
                    days_until_due_date=25, credit_limit=200_000, **extra)


def _debit(client, who, card, day, amount):
    return sw_post(client, who, "/transactions/", {
        "account_id": card, "transaction_type": "debit", "amount": amount,
        "description": "Purchase", "transaction_date": f"{day}T00:00:00",
        "is_posted": True})["id"]


def _set_due(client, who, card, close, due=None, expect=200):
    path = f"{API}/cards/{card}/statements/{close}/due-date"
    if due is None:
        r = client.delete(path, headers=who["headers"])
    else:
        r = client.put(path, json={"due_date": due}, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _detail(client, who, card):
    r = client.get(f"{API}/cards/{card}/credit", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _statements(client, who, card):
    return {s["close_date"]: s for s in _detail(client, who, card)["statements"]}


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    me = sw_people()
    savings = _account(sw_client, me, "Savings", "savings", balance=100_000)
    card = _card_a(sw_client, me, payment_account_id=savings)
    _debit(sw_client, me, card, "2026-10-20", 20_000)  # on the 4 Nov statement
    return {"client": sw_client, "db": sw_db, "me": me, "savings": savings, "card": card,
            "people": sw_people, "monkeypatch": monkeypatch}


# --- access -----------------------------------------------------------------------------------

def test_owner_sets_due(world):
    client, me, card = world["client"], world["me"], world["card"]
    r = _set_due(client, me, card, "2026-11-04", "2026-12-02")
    assert r.json() == {"close_date": "2026-11-04", "due_date": "2026-12-02",
                        "computed_due": "2026-12-01"}
    nov = _statements(client, me, card)["2026-11-04"]
    assert (nov["due_date"], nov["due_overridden"], nov["computed_due_date"]) == (
        "2026-12-02", True, "2026-12-01")
    # Setting it again replaces it.
    _set_due(client, me, card, "2026-11-04", "2026-12-03")
    assert _statements(client, me, card)["2026-11-04"]["due_date"] == "2026-12-03"
    # The open cycle (closing 4 Dec) takes one too.
    _set_due(client, me, card, "2026-12-04", "2026-12-28")
    assert _detail(client, me, card)["open_cycle"] == {
        "close_date": "2026-12-04", "due_date": "2026-12-28", "due_overridden": True,
        "computed_due_date": "2026-12-29"}
    _set_due(client, me, card, "2026-11-04", expect=204)
    nov = _statements(client, me, card)["2026-11-04"]
    assert (nov["due_date"], nov["due_overridden"]) == ("2026-12-01", False)


def test_admin_can_set(world):
    client, db, me, card = world["client"], world["db"], world["me"], world["card"]
    admin = world["people"]("Ad", "Min")
    sw_share(db, card, admin["id"], "admin", me["id"])
    _set_due(client, admin, card, "2026-11-04", "2026-12-02")
    _set_due(client, admin, card, "2026-11-04", expect=204)
    _set_due(client, admin, card, "2026-11-04", "2026-12-02")
    assert _statements(client, me, card)["2026-11-04"]["due_date"] == "2026-12-02"


def test_editor_viewer_tag_viewer_get_404(world):
    from app.tests.conftest import hh_household

    client, db, me = world["client"], world["db"], world["me"]
    card = _card_a(client, me, "Card A shared", tag_ids=[hh_household(db, me)])
    editor, viewer, tagged = (world["people"](n, "X") for n in ("Ed", "Vi", "Tag"))
    sw_share(db, card, editor["id"], "editor", me["id"])
    sw_share(db, card, viewer["id"], "viewer", me["id"])
    hh_tag_share(db, me, tagged)
    for who in (editor, viewer, tagged):
        _set_due(client, who, card, "2026-11-04", "2026-12-02", expect=404)
        _set_due(client, who, card, "2026-11-04", expect=404)
        # The same 404 whatever the path's close.
        _set_due(client, who, card, "not-a-date", "2026-12-02", expect=404)
    stranger = world["people"]("Sam", "Stranger")
    _set_due(client, stranger, card, "2026-11-04", "2026-12-02", expect=404)
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    # A non-card and a card without cycle settings.
    _set_due(client, me, world["savings"], "2026-11-04", "2026-12-02", expect=400)
    plain = _account(client, me, "Plain card", "credit", 0, credit_limit=10_000)
    _set_due(client, me, plain, "2026-11-04", "2026-12-02", expect=400)
    _set_due(client, me, plain, "2026-11-04", expect=400)


# --- validation -------------------------------------------------------------------------------

def test_due_on_or_before_close_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    for due in ("2026-11-04", "2026-11-03"):
        _set_due(client, me, card, "2026-11-04", due, expect=422)
    r = client.put(f"{API}/cards/{card}/statements/2026-11-04/due-date",
                   json={"due_date": "2026-12-02", "extra": 1}, headers=me["headers"])
    assert r.status_code == 422
    assert _statements(client, me, card)["2026-11-04"]["due_overridden"] is False


def test_due_not_between_neighbouring_dues_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    # 4 Dec is due 29 Dec: 4 Nov's due is strictly before it (and after its close).
    for due in ("2026-12-29", "2027-01-15"):
        _set_due(client, me, card, "2026-11-04", due, expect=422)
    _set_due(client, me, card, "2026-11-04", "2026-11-05")
    _set_due(client, me, card, "2026-11-04", "2026-12-28")
    # A neighbour with its own printed due bounds it instead of the rolled one.
    _set_due(client, me, card, "2026-11-04", "2026-12-10")
    _set_due(client, me, card, "2026-12-04", "2026-12-20")
    for due in ("2026-12-20", "2026-12-22"):
        _set_due(client, me, card, "2026-11-04", due, expect=422)
    _set_due(client, me, card, "2026-11-04", "2026-12-19")
    # And from the other side: 4 Dec's printed due must stay after 4 Nov's.
    _set_due(client, me, card, "2026-12-04", "2026-12-19", expect=422)
    _set_due(client, me, card, "2026-10-04", "2026-12-19", expect=422)
    assert _statements(client, me, card)["2026-11-04"]["due_date"] == "2026-12-19"


def test_unknown_close_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    for close in ("2026-11-05", "2026-11-03", "garbage", "2026-02-30"):
        _set_due(client, me, card, close, "2026-12-02", expect=422)
        _set_due(client, me, card, close, expect=422)


def test_third_future_cycle_is_422(world):
    client, me, card = world["client"], world["me"], world["card"]
    _set_due(client, me, card, "2027-01-04", "2027-01-28")
    _set_due(client, me, card, "2027-02-04", "2027-02-26", expect=422)
    _set_due(client, me, card, "2027-02-04", expect=422)
    # An old closed statement is accepted.
    _set_due(client, me, card, "2025-11-04", "2025-12-02")


def test_far_due_between_neighbours_is_accepted(world):
    """No fixed cap: 4 Dec and 4 Jan both printed late leave room for 4 Nov."""
    client, me, card = world["client"], world["me"], world["card"]
    _set_due(client, me, card, "2027-01-04", "2027-02-20")
    _set_due(client, me, card, "2026-12-04", "2027-02-10")
    _set_due(client, me, card, "2026-11-04", "2027-02-01")
    nov = _statements(client, me, card)["2026-11-04"]
    assert (nov["due_date"], nov["status"]) == ("2027-02-01", "open")


# --- delete -----------------------------------------------------------------------------------

def test_delete_is_idempotent_204(world):
    client, me, card = world["client"], world["me"], world["card"]
    _set_due(client, me, card, "2026-11-04", expect=204)
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    _set_due(client, me, card, "2026-11-04", expect=204)
    _set_due(client, me, card, "2026-11-04", expect=204)
    assert _statements(client, me, card)["2026-11-04"]["due_overridden"] is False


def test_delete_breaking_order_is_409(world):
    client, me, card = world["client"], world["me"], world["card"]
    # 4 Oct printed 10 Dec is after 4 Nov's rolled due (1 Dec): only 4 Nov's
    # printed 20 Dec keeps the order, so it cannot be cleared first.
    _set_due(client, me, card, "2026-11-04", "2026-12-20")
    _set_due(client, me, card, "2026-10-04", "2026-12-10")
    _set_due(client, me, card, "2026-11-04", expect=409)
    assert _statements(client, me, card)["2026-11-04"]["due_date"] == "2026-12-20"
    _set_due(client, me, card, "2026-10-04", expect=204)
    _set_due(client, me, card, "2026-11-04", expect=204)


# --- downstream -------------------------------------------------------------------------------

def test_overdue_carry_respects_due_override(world, monkeypatch):
    """With 4 Nov's due printed 5 Dec, after the 4 Dec close, the 4 Dec
    statement carries nothing overdue; the 4 Jan one carries it."""
    client, me = world["client"], world["me"]
    pin_clock(monkeypatch, datetime(2027, 1, 10, 2, 0))
    card = _card_a(client, me, "Card A rule", minimum_due_rule=BDO)
    _debit(client, me, card, "2026-10-20", 20_000)

    def overdue(close):
        return _statements(client, me, card)[close]["minimum_due"]["inputs"]["overdue"]

    assert overdue("2026-12-04") == 850.0
    _set_due(client, me, card, "2026-11-04", "2026-12-05")
    assert overdue("2026-12-04") == 0.0
    assert overdue("2027-01-04") > 0.0


def test_forecast_payable_moves_with_due_override(world):
    from app.services import forecast as fc

    client, db, me, card = world["client"], world["db"], world["me"], world["card"]

    def payable():
        db.expire_all()
        (row,) = [p for p in fc.payables_by_currency(db, me["id"], days=30)
                  if p and p.get("source") == "statement" and p["source_id"] == card]
        return row["statement_close"], row["due_date"]

    assert payable() == ("2026-11-04", "2026-12-01")
    _set_due(client, me, card, "2026-11-04", "2026-12-03")
    assert payable() == ("2026-11-04", "2026-12-03")


def test_household_settlement_uses_overridden_due(hh, sw_client, sw_db, monkeypatch):
    """A Household charge on 14 Oct is on the statement closing 15 Oct, due
    5 Nov. A joint payment on 7 Nov is after that due, so it does not cover the
    line; printed due 9 Nov, it does."""
    from app.tests.test_household_views_integration import (
        FIELDS, OCT, PROJECTED, _charge, _monthly, _recurring_payment,
    )

    pin_clock(monkeypatch, PROJECTED)
    _charge(sw_client, hh, "projected", when="2026-10-14T00:00:00")
    _recurring_payment(sw_db, hh["a"], hh["joint"], hh["a_card"], 100, datetime(2026, 11, 7))

    def october():
        months = _monthly(sw_db, hh["c"], hh["a"], PROJECTED, OCT, OCT)
        return {m["month"]: m["currencies"] for m in months}["2026-10"]

    assert october() == [{"currency": "PHP", **dict.fromkeys(FIELDS, 0.0),
                          "paid_from_other_accounts": 100.0}]
    _set_due(sw_client, hh["a"], hh["a_card"], "2026-10-15", "2026-11-09")
    assert october() == []


def test_statement_status_uses_overridden_due(world, monkeypatch):
    """On 2 Dec the 4 Nov statement (due 1 Dec) is overdue; printed due 3 Dec,
    it is open, in the credit detail and in the statements list."""
    client, me, card = world["client"], world["me"], world["card"]
    pin_clock(monkeypatch, datetime(2026, 12, 2, 2, 0))

    def listed():
        r = client.get(f"{API}/accounts/{card}/statements", headers=me["headers"])
        assert r.status_code == 200, r.text
        (nov,) = [s for s in r.json()["statements"] if s["close_date"].startswith("2026-11-04")]
        return nov["due_date"][:10], nov["status"]

    assert _statements(client, me, card)["2026-11-04"]["status"] == "overdue"
    assert listed() == ("2026-12-01", "overdue")
    _set_due(client, me, card, "2026-11-04", "2026-12-03")
    assert _statements(client, me, card)["2026-11-04"]["status"] == "open"
    assert listed() == ("2026-12-03", "open")


# --- housekeeping -----------------------------------------------------------------------------

def test_minimum_unaffected_by_due_override(world):
    client, me = world["client"], world["me"]
    card = _card_a(client, me, "Card A rule", minimum_due_rule=BDO)
    _debit(client, me, card, "2026-10-20", 20_000)
    before = _statements(client, me, card)["2026-11-04"]["minimum_due"]
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    assert _statements(client, me, card)["2026-11-04"]["minimum_due"] == before
    # The entered minimum and the printed due live side by side.
    r = client.put(f"{API}/cards/{card}/statements/2026-11-04/minimum-due",
                   json={"amount": 900}, headers=me["headers"])
    assert r.status_code == 200, r.text
    nov = _statements(client, me, card)["2026-11-04"]
    assert (nov["minimum_due"]["amount"], nov["due_date"]) == (900.0, "2026-12-02")


def test_export_includes_due_overrides(world):
    client, me, card = world["client"], world["me"], world["card"]
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    r = client.get(f"{API}/data/export.json", headers=me["headers"])
    assert r.status_code == 200, r.text
    (row,) = r.json()["card_statement_due_overrides"]
    assert (row["account_id"], row["statement_close"], row["due_date"]) == (
        card, "2026-11-04", "2026-12-02")
    assert list(row) == ["id", "account_id", "statement_close", "due_date", "created_at",
                         "updated_at"]
    r = client.get(f"{API}/data/export.csv?table=card_statement_due_overrides",
                   headers=me["headers"])
    assert r.status_code == 200, r.text
    assert r.text.splitlines()[0] == "id,account_id,statement_close,due_date,created_at,updated_at"


def test_card_delete_cascades_due_overrides(world):
    from sqlalchemy import text

    client, db, me = world["client"], world["db"], world["me"]
    card = _card_a(client, me, "Card A spare")
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    count = text("SELECT count(*) FROM card_statement_due_overrides WHERE account_id = :a")
    assert db.execute(count, {"a": card}).scalar_one() == 1
    db.execute(text("DELETE FROM accounts WHERE id = :a"), {"a": card})
    db.commit()
    assert db.execute(count, {"a": card}).scalar_one() == 0


# --- migration --------------------------------------------------------------------------------

def test_due_override_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert DUE_REVISION in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(DUE_REVISION).down_revision == PREVIOUS


def test_upgrade_adds_the_due_override_table_and_downgrade_drops_it(scratch_url):  # noqa: F811
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.exc import IntegrityError

    def tables():
        engine = create_engine(scratch_url)
        try:
            with engine.connect() as c:
                return set(inspect(c).get_table_names())
        finally:
            engine.dispose()

    _alembic(scratch_url, "upgrade", DUE_REVISION)
    assert "card_statement_due_overrides" in tables()
    engine = create_engine(scratch_url)
    try:
        with engine.begin() as c:
            user = c.execute(text(
                "INSERT INTO users (email, password_hash, first_name, last_name) "
                "VALUES ('due@example.com', 'x', 'D', 'U') RETURNING id")).scalar_one()
            card = c.execute(text(
                "INSERT INTO accounts (user_id, name, account_type, balance) "
                "VALUES (:u, 'Card', 'credit', 0) RETURNING id"), {"u": user}).scalar_one()
        # The due is strictly after the close.
        with pytest.raises(IntegrityError):
            with engine.begin() as c:
                c.execute(text(
                    "INSERT INTO card_statement_due_overrides (account_id, statement_close, "
                    "due_date) VALUES (:a, '2026-11-04', '2026-11-04')"), {"a": card})
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO card_statement_due_overrides (account_id, statement_close, "
                "due_date) VALUES (:a, '2026-11-04', '2026-12-02')"), {"a": card})
        # One per statement.
        with pytest.raises(IntegrityError):
            with engine.begin() as c:
                c.execute(text(
                    "INSERT INTO card_statement_due_overrides (account_id, statement_close, "
                    "due_date) VALUES (:a, '2026-11-04', '2026-12-03')"), {"a": card})
    finally:
        engine.dispose()
    _alembic(scratch_url, "downgrade", PREVIOUS)
    assert "card_statement_due_overrides" not in tables()


# --- the cycle-identity guard -----------------------------------------------------------------

def _update(client, who, card, body, expect=200):
    r = client.put(f"{API}/accounts/{card}", json=body, headers=who["headers"])
    assert r.status_code == expect, r.text
    return r.json()


def test_close_day_change_with_due_override_is_409(world):
    client, me, card = world["client"], world["me"], world["card"]
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    for body in ({"billing_cycle_start": 5}, {"billing_cycle_start": None},
                 {"billing_cycle_start": 5, "days_until_due_date": 24}):
        _update(client, me, card, body, expect=409)
    # Unchanged values and other fields still save.
    _update(client, me, card, {"billing_cycle_start": 4, "name": "Card A renamed"})
    _set_due(client, me, card, "2026-11-04", expect=204)
    _update(client, me, card, {"billing_cycle_start": 5})


def test_legacy_card_days_change_moving_close_with_override_is_409(world):
    """Due day 29 with 25 days closes on the 4th; 24 days would close on the 5th."""
    client, me = world["client"], world["me"]
    card = _account(client, me, "Legacy card", "credit", 0, due_date=29,
                    days_until_due_date=25, credit_limit=50_000)
    _debit(client, me, card, "2026-10-20", 1_000)
    nov = _statements(client, me, card)["2026-11-04"]
    assert nov["due_date"] == "2026-12-01"
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    _update(client, me, card, {"days_until_due_date": 24}, expect=409)
    _update(client, me, card, {"due_date": 30}, expect=409)
    _update(client, me, card, {"due_date": None}, expect=409)
    # Setting the close day it already resolves to keeps every statement.
    _update(client, me, card, {"billing_cycle_start": 4})
    assert _statements(client, me, card)["2026-11-04"]["due_date"] == "2026-12-02"


def test_days_change_breaking_due_override_order_is_409(world):
    client, me, card = world["client"], world["me"], world["card"]
    # 28 Dec is before 4 Dec's due (29 Dec); with 20 days that due is 24 Dec or
    # the next banking day, before it.
    _set_due(client, me, card, "2026-11-04", "2026-12-28")
    _update(client, me, card, {"days_until_due_date": 20}, expect=409)
    # 5 Nov is after 4 Oct's due (29 Oct); with 35 days that due is 8 Nov.
    _set_due(client, me, card, "2026-11-04", "2026-11-05")
    _update(client, me, card, {"days_until_due_date": 35}, expect=409)
    assert _statements(client, me, card)["2026-11-04"]["due_date"] == "2026-11-05"


def test_days_change_respecting_due_override_is_ok(world):
    client, me, card = world["client"], world["me"], world["card"]
    _set_due(client, me, card, "2026-11-04", "2026-12-02")
    assert _update(client, me, card, {"days_until_due_date": 21})["days_until_due_date"] == 21
    statements = _statements(client, me, card)
    assert (statements["2026-11-04"]["due_date"],
            statements["2026-11-04"]["computed_due_date"]) == ("2026-12-02", "2026-11-25")
    # The next statement is recomputed with 21 days: 25 Dec, rolled.
    from datetime import date

    from app.services.banking_days import next_banking_day

    assert _detail(client, me, card)["open_cycle"]["due_date"] == (
        next_banking_day(date(2026, 12, 25)).isoformat())


def test_close_day_change_without_overrides_is_ok(world):
    client, me, card = world["client"], world["me"], world["card"]
    other = _card_a(client, me, "Card A other")
    _set_due(client, me, other, "2026-11-04", "2026-12-02")
    assert _update(client, me, card, {"billing_cycle_start": 2})["billing_cycle_start"] == 2
    assert "2026-11-02" in _statements(client, me, card)

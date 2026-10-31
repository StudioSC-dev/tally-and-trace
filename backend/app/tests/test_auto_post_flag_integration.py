"""Review and auto-post flags on card installments (STU-343 Plan B, B2 commit 1).

``installment_reviewed_at`` (shown as ``installment_reviewed``) is the settlement
status and ``auto_post_enabled`` the scheduling flag. Create sets both for a new
eligible installment dated from Manila's today; a PUT never turns either on and
clears both on a reviewed entry when the card changes, the next date moves
earlier or the edited entry stops being eligible (pausing is not a reason). Both
show on the full and shared_full views and in the export, never on Limited.
Skips without a database.
"""
import sys
from datetime import datetime

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

AUTO_POST_REVISION = "b3d7f1a9c5e2"
PARENT_REVISION = "20604a414c22"
# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
FLAGS = ("installment_reviewed", "auto_post_enabled")


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name, account_type, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _card(client, who, checking, name="Card C", **extra):
    return _account(client, who, name, "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking, **extra)


def _installment(client, who, card, name="Tablet", next_day="2026-11-05", remaining=24, **extra):
    body = {"name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
            "next_occurrence": f"{next_day}T00:00:00", "account_id": card,
            "end_mode": "after_occurrences", "max_occurrences": remaining, **extra}
    return sw_post(client, who, "/budget-entries/", body)


def _get(client, who, entry_id) -> dict:
    r = client.get(f"{API}/budget-entries/{entry_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _put(client, who, entry_id, body) -> dict:
    r = client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _flags(body: dict) -> tuple:
    return (body["installment_reviewed"], body["auto_post_enabled"])


@pytest.fixture
def world(sw_client, sw_people, monkeypatch):
    client = sw_client
    owner = sw_people("Olive", "Owner")
    checking = _account(client, owner, "Checking", "checking", 50_000)
    card = _card(client, owner, checking)
    pin_clock(monkeypatch, REF)
    return {"client": client, "o": owner, "checking": checking, "card": card}


def _script():
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    return ScriptDirectory.from_config(Config(str(backend / "alembic.ini")))


def test_auto_post_migration_is_the_single_head():
    script = _script()
    (head,) = script.get_heads()
    assert AUTO_POST_REVISION in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(AUTO_POST_REVISION).down_revision == PARENT_REVISION


def test_existing_installments_start_unreviewed_and_off(world, sw_db):
    from sqlalchemy import text

    from app.models.budget_entry import BudgetEntry

    cols = {r.column_name: r for r in sw_db.execute(text(
        "SELECT column_name, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = 'budget_entries' "
        "AND column_name IN ('auto_post_enabled', 'installment_reviewed_at')"))}
    assert cols["auto_post_enabled"].is_nullable == "NO"
    assert cols["auto_post_enabled"].column_default == "false"
    assert cols["installment_reviewed_at"].is_nullable == "YES"

    # A row written without either flag, as every pre-migration row is.
    client, o = world["client"], world["o"]
    created = _installment(client, o, world["card"], next_day="2026-09-05")
    sw_db.expire_all()
    row = sw_db.get(BudgetEntry, created["id"])
    assert (row.installment_reviewed_at, row.auto_post_enabled) == (None, False)
    assert _flags(_get(client, o, created["id"])) == (False, False)


def test_new_card_installment_from_today_is_reviewed_and_on(world, sw_db):
    from app.models.budget_entry import BudgetEntry

    client, o, card = world["client"], world["o"], world["card"]

    for day in ("2026-10-18", "2026-11-05"):
        body = _installment(client, o, card, next_day=day)
        assert _flags(body) == (True, True), day
        assert _flags(_get(client, o, body["id"])) == (True, True)
        sw_db.expire_all()
        assert sw_db.get(BudgetEntry, body["id"]).installment_reviewed_at is not None


def test_backdated_new_installment_is_off(world):
    client, o, card = world["client"], world["o"], world["card"]

    body = _installment(client, o, card, next_day="2026-10-17")

    assert _flags(body) == (False, False)


def test_ineligible_entries_start_off(world):
    client, o = world["client"], world["o"]
    card, checking = world["card"], world["checking"]
    no_cycle = _account(client, o, "Loose card", "credit", payment_account_id=checking)
    cases = {
        "subscription": dict(account_id=card, end_mode="indefinite", max_occurrences=None),
        "cash installment": dict(account_id=checking),
        "foreign currency": dict(account_id=card, currency="USD"),
        "no statement cycle": dict(account_id=no_cycle),
        "paused": dict(account_id=card, is_active=False),
        "bill": dict(account_id=card, end_mode="indefinite", max_occurrences=None,
                     billing_kind="bill"),
    }
    for label, fields in cases.items():
        body = _installment(client, o, card, name=label, **fields)
        assert _flags(body) == (False, False), label


def test_put_cannot_turn_auto_post_on(world):
    client, o, card = world["client"], world["o"], world["card"]
    off = _installment(client, o, card, next_day="2026-10-17")
    on = _installment(client, o, card, name="Phone")

    body = _put(client, o, off["id"], {
        "name": "Tablet 2", "auto_post_enabled": True, "installment_reviewed": True,
        "installment_reviewed_at": "2026-10-18T00:00:00"})
    assert body["name"] == "Tablet 2"
    assert _flags(body) == (False, False)
    assert _flags(_get(client, o, off["id"])) == (False, False)

    body = _put(client, o, on["id"], {"auto_post_enabled": False, "installment_reviewed": False})
    assert _flags(body) == (True, True)


def test_put_clears_both_on_a_card_change_or_an_earlier_date(world):
    client, o, card, checking = world["client"], world["o"], world["card"], world["checking"]
    other = _card(client, o, checking, name="Card D")

    def fresh(name):
        body = _installment(client, o, card, name=name)
        assert _flags(body) == (True, True)
        return body["id"]

    # Kept: a name, amount or later date edit.
    kept = fresh("Kept")
    assert _flags(_put(client, o, kept, {"name": "Kept 2", "amount": 4_000})) == (True, True)
    body = _put(client, o, kept, {"next_occurrence": "2026-12-05T00:00:00"})
    assert _flags(body) == (True, True)

    moved = fresh("Moved card")
    assert _flags(_put(client, o, moved, {"account_id": other})) == (False, False)

    earlier = fresh("Earlier")
    assert _flags(_put(client, o, earlier, {"next_occurrence": "2026-10-20T00:00:00"})) == (
        False, False)

    ended = fresh("Open ended")
    body = _put(client, o, ended, {"end_mode": "indefinite"})
    assert _flags(body) == (False, False)

    foreign = fresh("Foreign")
    assert _flags(_put(client, o, foreign, {"currency": "USD"})) == (False, False)

    cash = fresh("To cash")
    assert _flags(_put(client, o, cash, {"account_id": checking})) == (False, False)

    # Cleared stays cleared when the cause is undone.
    assert _flags(_put(client, o, earlier, {"next_occurrence": "2026-11-05T00:00:00"})) == (
        False, False)


def test_pausing_keeps_both(world):
    client, o, card = world["client"], world["o"], world["card"]
    tablet = _installment(client, o, card)

    paused = _put(client, o, tablet["id"], {"is_active": False})
    assert paused["is_active"] is False
    assert _flags(paused) == (True, True)

    resumed = _put(client, o, tablet["id"], {"is_active": True})
    assert resumed["is_active"] is True
    assert _flags(resumed) == (True, True)


def test_card_with_a_statement_cycle_is_eligible_without_a_due_offset(world, sw_db):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services.recurring_kinds import auto_post_block
    from app.services.statements import resolve_cycle_fields

    client, o, checking = world["client"], world["o"], world["checking"]
    legacy = _account(client, o, "Legacy", "credit", due_date=15, payment_account_id=checking)
    loose = _account(client, o, "Loose", "credit", payment_account_id=checking)
    # The column is NOT NULL, so a stored card never lacks an offset; the null
    # case is an in-memory card (a close day, no due offset).
    sw_db.query(Account).filter(Account.id == legacy).update({"billing_cycle_start": None})
    sw_db.commit()

    card = sw_db.get(Account, legacy)
    assert (card.billing_cycle_start, card.due_date) == (None, 15)
    assert resolve_cycle_fields(card) is not None
    body = _installment(client, o, legacy, name="Legacy tablet")
    assert _flags(body) == (True, True)
    sw_db.expire_all()
    entry = sw_db.get(BudgetEntry, body["id"])
    assert auto_post_block(entry, card) is None
    # A legacy card keeps its flags through an unrelated edit.
    assert _flags(_put(client, o, body["id"], {"name": "Legacy tablet 2"})) == (True, True)

    offsetless = Account(account_type="credit", currency=card.currency,
                         billing_cycle_start=24, days_until_due_date=None)
    assert resolve_cycle_fields(offsetless) is not None
    assert auto_post_block(entry, offsetless) is None

    bare = sw_db.get(Account, loose)
    assert resolve_cycle_fields(bare) is None
    body = _installment(client, o, loose, name="No cycle")
    assert _flags(body) == (False, False)
    sw_db.expire_all()
    assert auto_post_block(sw_db.get(BudgetEntry, body["id"]), bare) == "no_statement_cycle"


def test_block_order_reports_foreign_currency_before_inactive(world, sw_db):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services.recurring_kinds import auto_post_block

    client, o, card = world["client"], world["o"], world["card"]
    tablet = _installment(client, o, card)
    assert _flags(tablet) == (True, True)

    # One edit that both pauses the entry and takes it out of the card's currency:
    # the block is foreign_currency, so (unlike a plain pause) the flags clear.
    body = _put(client, o, tablet["id"], {"is_active": False, "currency": "USD"})
    assert body["is_active"] is False
    assert _flags(body) == (False, False)
    sw_db.expire_all()
    entry = sw_db.get(BudgetEntry, tablet["id"])
    assert auto_post_block(entry, sw_db.get(Account, card)) == "foreign_currency"


def test_flag_per_view_and_export(world, sw_people, sw_db):
    from app.services.export import TABLE_FIELDS

    client, o, card, checking = world["client"], world["o"], world["card"], world["checking"]
    editor = sw_people("Eddie", "Editor")
    viewer = sw_people("Vic", "Viewer")
    sw_share(sw_db, card, editor["id"], "editor", o["id"])
    sw_share(sw_db, card, viewer["id"], "viewer", o["id"])
    sw_share(sw_db, checking, editor["id"], "editor", o["id"])
    sw_share(sw_db, checking, viewer["id"], "viewer", o["id"])
    tablet = _installment(client, o, card)
    entry_id = tablet["id"]

    full = _get(client, o, entry_id)
    assert full["view"] == "full"
    assert _flags(full) == (True, True)

    shared = _get(client, editor, entry_id)
    assert shared["view"] == "shared_full"
    assert _flags(shared) == (True, True)
    listed = client.get(f"{API}/budget-entries/", headers=editor["headers"]).json()["items"]
    assert _flags(next(e for e in listed if e["id"] == entry_id)) == (True, True)

    limited = _get(client, viewer, entry_id)
    assert limited["view"] == "limited"
    assert not set(FLAGS) & set(limited)
    listed = client.get(f"{API}/budget-entries/", headers=viewer["headers"]).json()["items"]
    assert not set(FLAGS) & set(next(e for e in listed if e["id"] == entry_id))

    exported = client.get(f"{API}/data/export.json", headers=o["headers"]).json()
    (row,) = [e for e in exported["budget_entries"] if e["id"] == entry_id]
    assert row["auto_post_enabled"] is True
    assert row["installment_reviewed_at"] is not None
    assert "auto_post_enabled" in TABLE_FIELDS["budget_entries"]
    assert "installment_reviewed_at" in TABLE_FIELDS["budget_entries"]

    # The editor's own installment on the owner's card is the owner's Limited export row.
    theirs = _installment(client, editor, card, name="Theirs")
    assert _flags(theirs) == (True, True)
    exported = client.get(f"{API}/data/export.json", headers=o["headers"]).json()
    (other_row,) = [e for e in exported["others_budget_entries"] if e["id"] == theirs["id"]]
    assert not set(FLAGS) & set(other_row)
    assert "auto_post_enabled" not in other_row
    assert "installment_reviewed_at" not in other_row
    own = client.get(f"{API}/data/export.csv", params={"table": "budget_entries"},
                     headers=o["headers"]).text
    header = own.splitlines()[0]
    assert "auto_post_enabled" in header and "installment_reviewed_at" in header

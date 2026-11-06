"""One settlement flag: ``auto_post_enabled`` (settlement plan, PR 2).

``settlement`` on the snapshot's full budget-entry rows is derived from the flag
alone, never from ``is_autopay``, and is null on a row that names no settlement.
Nothing new starts on but a card installment, and an edit clears the flag when
it makes the entry ineligible. Skips without a database.
"""
import sys
from datetime import datetime
from types import SimpleNamespace

import pytest

from app.models.account import AccountType
from app.models.budget_entry import BudgetEntryType
from app.services.recurring_kinds import auto_post_block, settlement, settlement_block
from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = [pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable"),
              pytest.mark.usefixtures("legacy_card_installments")]

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
TODAY = "2026-10-18T00:00:00"
SOON = "2026-10-25T00:00:00"


def _pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name, account_type, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": 50_000, **extra})["id"]


def _entry(client, who, account, name="Rent", **extra):
    body = {"name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
            "next_occurrence": SOON, "account_id": account, **extra}
    return sw_post(client, who, "/budget-entries/", body)


def _put(client, who, entry_id, body) -> dict:
    r = client.put(f"{API}/budget-entries/{entry_id}", json=body, headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _switch_on(db, entry_id) -> None:
    """The flag on a cash entry, written directly: the toggle comes later."""
    from app.models.budget_entry import BudgetEntry

    db.query(BudgetEntry).filter(BudgetEntry.id == entry_id).update({"auto_post_enabled": True})
    db.commit()
    db.expire_all()


def _rows(client, who, entry_id) -> list:
    r = client.get(f"{API}/dashboard/snapshot", headers=who["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    rows = [row for row in (*body["payables"], *body["upcoming_this_month"])
            if row.get("source") == "budget_entry" and row.get("source_id") == entry_id]
    assert rows, f"entry {entry_id} on no snapshot list"
    return rows


def _settlements(client, who, entry_id) -> set:
    return {row["settlement"] for row in _rows(client, who, entry_id)}


@pytest.fixture
def world(sw_client, sw_people, monkeypatch):
    client = sw_client
    owner = sw_people("Olive", "Owner")
    checking = _account(client, owner, "Checking", "checking")
    card = _account(client, owner, "Card", "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)
    _pin_clock(monkeypatch, REF)
    return {"client": client, "o": owner, "checking": checking, "card": card}


# --- settlement_block and the wire value, on plain objects ------------------------------------

def _plain_entry(**extra):
    fields = dict(entry_type=BudgetEntryType.EXPENSE, transfer_to_account_id=None,
                  end_mode="indefinite", max_occurrences=None, billing_kind=None,
                  currency="PHP", is_active=True, auto_post_enabled=False)
    return SimpleNamespace(**{**fields, **extra})


def _plain_account(account_type=AccountType.CHECKING, **extra):
    fields = dict(account_type=account_type, currency="PHP", is_spending_wallet=False,
                  billing_cycle_start=24, days_until_due_date=21, due_date=None)
    return SimpleNamespace(**{**fields, **extra})


BANK = _plain_account()
CARD = _plain_account(AccountType.CREDIT)
WALLET = _plain_account(AccountType.CASH, is_spending_wallet=True)
CAPPED = dict(end_mode="after_occurrences", max_occurrences=12)


@pytest.mark.parametrize("entry, account, block, wire", [
    (_plain_entry(), BANK, None, "manual"),
    (_plain_entry(billing_kind="subscription"), BANK, None, "manual"),
    (_plain_entry(auto_post_enabled=True), BANK, None, "autopay"),
    (_plain_entry(is_autopay=True), BANK, None, "manual"),
    (_plain_entry(is_active=False), BANK, "inactive", "manual"),
    (_plain_entry(currency="USD"), BANK, "foreign_currency", "manual"),
    (_plain_entry(), None, "no_account", None),
    (_plain_entry(), WALLET, "spending_wallet", None),
    (_plain_entry(is_active=False), WALLET, "spending_wallet", None),
    (_plain_entry(transfer_to_account_id=9), BANK, "not_cash", None),
    (_plain_entry(entry_type=BudgetEntryType.INCOME), BANK, "not_cash", None),
    (_plain_entry(), CARD, "not_cash", None),
    (_plain_entry(billing_kind="bill"), CARD, "not_cash", None),
    (_plain_entry(auto_post_enabled=True), CARD, "not_cash", None),
    (_plain_entry(**CAPPED), CARD, None, "manual"),
    (_plain_entry(**CAPPED, auto_post_enabled=True), CARD, None, "autopay"),
    (_plain_entry(**CAPPED, is_active=False), CARD, "inactive", "manual"),
    (_plain_entry(**CAPPED, currency="USD"), CARD, "foreign_currency", "manual"),
    (_plain_entry(**CAPPED), _plain_account(AccountType.CREDIT, billing_cycle_start=None,
                                            days_until_due_date=None),
     "no_statement_cycle", "manual"),
])
def test_settlement_block_and_wire_value(entry, account, block, wire):
    assert settlement_block(entry, account) == block
    assert settlement(entry, account) == wire


def test_auto_post_block_is_not_widened_to_cash_entries():
    # The create gate turns an entry on when this returns None.
    assert auto_post_block(_plain_entry(), BANK) == "not_installment"
    assert auto_post_block(_plain_entry(billing_kind="subscription"), BANK) == "not_installment"


# --- the create gate --------------------------------------------------------------------------

@pytest.mark.parametrize("next_day", [TODAY, SOON])
def test_a_new_cash_entry_starts_manual(world, next_day):
    client, o = world["client"], world["o"]
    created = _entry(client, o, world["checking"], next_occurrence=next_day, is_autopay=True)
    assert created["auto_post_enabled"] is False
    assert created["is_autopay"] is True
    assert _settlements(client, o, created["id"]) == {"manual"}


def test_a_new_card_installment_dated_today_still_starts_on(world):
    client, o = world["client"], world["o"]
    created = _entry(client, o, world["card"], "Tablet", next_occurrence=TODAY,
                     end_mode="after_occurrences", max_occurrences=12)
    assert (created["installment_reviewed"], created["auto_post_enabled"]) == (True, True)


# --- settlement on the snapshot rows ----------------------------------------------------------

def test_a_card_subscription_and_a_card_bill_name_no_settlement(world):
    client, o, card = world["client"], world["o"], world["card"]
    subscription = _entry(client, o, card, "Streaming", billing_kind="subscription")
    bill = _entry(client, o, card, "Power", billing_kind="bill")
    assert subscription["kind"] == "subscription" and bill["kind"] == "bill"
    assert _settlements(client, o, subscription["id"]) == {None}
    assert _settlements(client, o, bill["id"]) == {None}


def test_a_recurring_transfer_names_no_settlement(world):
    client, o = world["client"], world["o"]
    savings = _account(client, o, "Savings", "savings")
    transfer = _entry(client, o, world["checking"], "Top-up", transfer_to_account_id=savings)
    assert _settlements(client, o, transfer["id"]) == {None}


def test_income_names_no_settlement(world):
    client, o = world["client"], world["o"]
    income = _entry(client, o, world["checking"], "Salary", entry_type="income")
    assert _settlements(client, o, income["id"]) == {None}


def test_wallet_spending_names_no_settlement(world, sw_db):
    from app.core.redaction import Redactor
    from app.models.user import User
    from app.services.missed import entry_row_fields

    client, o = world["client"], world["o"]
    wallet = _account(client, o, "Wallet", "cash", is_spending_wallet=True)
    spending = _entry(client, o, wallet, "Lunch")
    # The projection skips wallet spending, so no snapshot list shows it.
    rows = [{"source": "budget_entry", "source_id": spending["id"]}]
    entry_row_fields(sw_db, rows, Redactor(sw_db, sw_db.get(User, o["id"])))
    assert rows[0]["kind"] == "cash" and rows[0]["settlement"] is None


def test_a_cash_entry_and_a_card_installment_are_set(world, sw_db):
    client, o = world["client"], world["o"]
    rent = _entry(client, o, world["checking"], billing_kind="subscription")
    assert _settlements(client, o, rent["id"]) == {"manual"}
    _switch_on(sw_db, rent["id"])
    assert _settlements(client, o, rent["id"]) == {"autopay"}

    installment = _entry(client, o, world["card"], "Tablet", next_occurrence=TODAY,
                         end_mode="after_occurrences", max_occurrences=12)
    assert _settlements(client, o, installment["id"]) == {"autopay"}
    backdated = _entry(client, o, world["card"], "Chair", next_occurrence="2026-10-05T00:00:00",
                       end_mode="after_occurrences", max_occurrences=12)
    assert backdated["auto_post_enabled"] is False
    assert _settlements(client, o, backdated["id"]) == {"manual"}


def test_rows_read_the_flag_and_never_is_autopay(world, sw_db):
    client, o = world["client"], world["o"]
    stale = _entry(client, o, world["checking"], "Old rent", is_autopay=True)
    assert _settlements(client, o, stale["id"]) == {"manual"}
    opted = _entry(client, o, world["checking"], "Opted", is_autopay=False)
    _switch_on(sw_db, opted["id"])
    assert _settlements(client, o, opted["id"]) == {"autopay"}


def test_a_limited_row_carries_no_settlement(sw, sw_client, monkeypatch):
    _pin_clock(monkeypatch, REF)
    _entry(sw_client, sw["a"], sw["joint"])
    r = sw_client.get(f"{API}/dashboard/snapshot", headers=sw["v"]["headers"])
    assert r.status_code == 200, r.text
    body = r.json()
    limited = [row for row in (*body["payables"], *body["upcoming_this_month"])
               if row.get("view") == "limited"]
    assert limited and all("settlement" not in row for row in limited)


# --- the edit guard ---------------------------------------------------------------------------

@pytest.fixture
def opted(world, sw_db):
    """An opted-in rent on the checking account."""
    entry = _entry(world["client"], world["o"], world["checking"])
    _switch_on(sw_db, entry["id"])
    return entry["id"]


def test_moving_to_a_card_clears_the_flag(world, opted):
    body = _put(world["client"], world["o"], opted, {"account_id": world["card"]})
    assert (body["kind"], body["auto_post_enabled"]) == ("subscription", False)


def test_turning_into_a_transfer_clears_the_flag(world, opted):
    client, o = world["client"], world["o"]
    savings = _account(client, o, "Savings", "savings")
    body = _put(client, o, opted, {"transfer_to_account_id": savings})
    assert body["auto_post_enabled"] is False


def test_a_foreign_currency_clears_the_flag(world, opted):
    body = _put(world["client"], world["o"], opted, {"currency": "USD"})
    assert body["auto_post_enabled"] is False


def test_an_earlier_next_occurrence_clears_the_flag(world, opted):
    body = _put(world["client"], world["o"], opted, {"next_occurrence": "2026-10-20T00:00:00"})
    assert body["auto_post_enabled"] is False


def test_becoming_a_card_installment_clears_the_flag(world, opted, sw_db):
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry

    client, o = world["client"], world["o"]
    body = _put(client, o, opted, {"account_id": world["card"], "end_mode": "after_occurrences",
                                   "max_occurrences": 12})
    assert body["kind"] == "installment"
    assert (body["installment_reviewed"], body["auto_post_enabled"]) == (False, False)
    # Eligible by every block: only the "never on without a review" rule clears it.
    sw_db.expire_all()
    entry = sw_db.get(BudgetEntry, opted)
    assert settlement_block(entry, sw_db.get(Account, world["card"])) is None


def test_pausing_a_cash_entry_clears_the_flag(world, opted):
    body = _put(world["client"], world["o"], opted, {"is_active": False})
    assert body["auto_post_enabled"] is False


@pytest.mark.parametrize("change", [
    {"name": "Rent, renamed"},
    {"amount": 6_000},
    {"next_occurrence": "2026-11-25T00:00:00"},
    {"billing_kind": "subscription"},
])
def test_an_ordinary_edit_keeps_the_flag(world, opted, change):
    body = _put(world["client"], world["o"], opted, change)
    assert body["auto_post_enabled"] is True


def test_moving_to_another_bank_keeps_the_flag(world, opted):
    client, o = world["client"], world["o"]
    other = _account(client, o, "Other bank", "savings")
    assert _put(client, o, opted, {"account_id": other})["auto_post_enabled"] is True


def test_an_edit_never_turns_the_flag_on(world):
    client, o = world["client"], world["o"]
    entry = _entry(client, o, world["checking"])
    body = _put(client, o, entry["id"], {"is_autopay": True, "auto_post_enabled": True})
    assert body["auto_post_enabled"] is False

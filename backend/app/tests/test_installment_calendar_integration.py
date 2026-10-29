"""A reviewed card installment bills its missed months (STU-343 Plan B, B2 commit 2).

A reviewed card installment (``installment_reviewed_at`` set) keeps its lapsed
months: each unrecorded month is billed on its own statement, overdue on the
window start when that statement is already due. Its months dated on or before
the window start settle as recorded rows, so recording them moves no payable,
and a longer window changes no payable inside a shorter one. Unreviewed entries
keep the lapsed drop. The household settlement and the account close guard
follow the same rule. Tablet's statuses are set directly. Skips without a
database.
"""
import sys
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.tests.conftest import sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

# Sunday 2026-10-18, 02:00 UTC: 10:00 in Manila.
REF = datetime(2026, 10, 18, 2, 0)
WALL = datetime(2026, 10, 18, 10, 0)   # the same instant on Manila's wall clock
START = datetime(2026, 10, 18)         # the window start: Manila midnight


def pin_clock(monkeypatch, when: datetime) -> None:
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _account(client, who, name, account_type, balance=0, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _txn(client, who, account, amount, when, kind="debit", **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": amount, "transaction_type": kind,
        "transaction_date": f"{when}T00:00:00", "is_posted": True,
        "description": "Unrelated", **extra})["id"]


def _installment(client, who, card, name="Tablet", next_day="2026-07-05", remaining=24,
                 **extra):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": 5_000, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": card,
        "end_mode": "after_occurrences", "max_occurrences": remaining, **extra})["id"]


def _set_status(db, entry_id, *, reviewed: bool, auto_post: bool) -> None:
    from app.core.time import utc_now
    from app.models.budget_entry import BudgetEntry

    db.expire_all()
    entry = db.get(BudgetEntry, entry_id)
    entry.installment_reviewed_at = utc_now() if reviewed else None
    entry.auto_post_enabled = auto_post
    db.commit()


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    client = sw_client
    o = sw_people("Olive", "Owner")
    checking = _account(client, o, "Checking", "checking", 50_000)
    card = _account(client, o, "Card C", "credit", billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=checking)
    pin_clock(monkeypatch, REF)
    tablet = _installment(client, o, card)
    return {"client": client, "db": sw_db, "o": o, "checking": checking, "card": card,
            "tablet": tablet}


def _statements(db, who, days=60):
    """Card C's statement payables: ``(due_date, statement_close, amount)``."""
    from app.services.forecast import payables_by_currency

    db.expire_all()
    return [(p["due_date"], p["statement_close"], Decimal(str(p["amount"])))
            for p in payables_by_currency(db, who["id"], days=days, reference=WALL)
            if p["source"] == "statement"]


def _overdue(db, who, days=60):
    """``{statement close: original due date}`` of the overdue statement events."""
    from app.services.forecast import collect_events

    db.expire_all()
    return {e["statement_close"].date().isoformat(): e["original_date"].date().isoformat()
            for e in collect_events(db, START, START + timedelta(days=days + 1),
                                    user_id=who["id"])
            if e.get("source") == "statement" and e.get("overdue")}


FIVE = Decimal("5000")
MISSED = [
    ("2026-10-18", "2026-07-24", FIVE),
    ("2026-10-18", "2026-08-24", FIVE),
    ("2026-10-18", "2026-09-24", FIVE),
    ("2026-11-14", "2026-10-24", FIVE),
    ("2026-12-15", "2026-11-24", FIVE),
]


def test_reviewed_stale_installment_bills_its_missed_months(world):
    db, o = world["db"], world["o"]
    _set_status(db, world["tablet"], reviewed=True, auto_post=True)

    assert _statements(db, o) == MISSED
    assert _overdue(db, o) == {"2026-07-24": "2026-08-14", "2026-08-24": "2026-09-14",
                               "2026-09-24": "2026-10-15"}


def test_reviewed_installment_with_auto_post_off_still_bills_its_missed_months(world):
    db, o = world["db"], world["o"]
    _set_status(db, world["tablet"], reviewed=True, auto_post=False)

    assert _statements(db, o) == MISSED


def test_unreviewed_installment_keeps_dropping_lapsed_months(world):
    db, o = world["db"], world["o"]

    assert _statements(db, o) == MISSED[3:]
    assert _overdue(db, o) == {}


def _record_due_months(db, who, entry_id, days):
    from app.core import locking
    from app.models.user import User
    from app.schemas.budget_entry import BudgetEntryMaterialize
    from app.services import posting

    db.expire_all()
    locking.lock_owner_budgets(db, who["id"])
    entry = locking.lock_entry(db, entry_id)
    actor = db.get(User, who["id"])
    outcomes = [posting.record_occurrence(db, entry, actor, BudgetEntryMaterialize(),
                                          datetime(2026, month, 5)).outcome
                for month in days]
    db.commit()
    return outcomes


def test_mixed_ledger_payables_do_not_move_when_installments_post(world):
    from app.services import posting

    client, db, o = world["client"], world["db"], world["o"]
    card, checking = world["card"], world["checking"]
    _set_status(db, world["tablet"], reviewed=True, auto_post=True)
    _txn(client, o, card, 5_000, "2026-10-03")
    _txn(client, o, checking, 5_000, "2026-10-10", kind="transfer",
         transfer_from_account_id=checking, transfer_to_account_id=card)
    expected = [
        ("2026-10-18", "2026-08-24", FIVE),
        ("2026-10-18", "2026-09-24", FIVE),
        ("2026-11-14", "2026-10-24", Decimal("10000")),
        ("2026-12-15", "2026-11-24", FIVE),
    ]

    before = _statements(db, o)
    assert before == expected

    outcomes = _record_due_months(db, o, world["tablet"], (7, 8, 9, 10))
    assert outcomes == [posting.Outcome.CREATED] * 4

    assert _statements(db, o) == before


def test_window_length_does_not_change_payables_inside_it(world):
    client, db, o = world["client"], world["db"], world["o"]
    _set_status(db, world["tablet"], reviewed=True, auto_post=True)
    _txn(client, o, world["card"], 4_000, "2026-12-01", kind="credit")

    short = _statements(db, o, days=30)        # [Oct 18, Nov 18)
    long = _statements(db, o, days=120)

    # The Dec 1 refund's net credit pays July first; nothing projected after
    # the window start draws on it, however long the window.
    assert short == [
        ("2026-10-18", "2026-07-24", Decimal("1000")),
        ("2026-10-18", "2026-08-24", FIVE),
        ("2026-10-18", "2026-09-24", FIVE),
        ("2026-11-14", "2026-10-24", FIVE),
    ]
    assert [row for row in long if row[0] < "2026-11-18"] == short


def test_household_card_settlement_matches(world, monkeypatch):
    """The household settlement of Card C owes, per statement, what the statement
    payables say, on the mixed ledger; its listing has nothing before the start."""
    from app.core.access import RecordAccess, own_household_grant, viewable_account_ids
    from app.services import household
    from app.tests.conftest import hh_household

    client, db, o = world["client"], world["db"], world["o"]
    card, checking = world["card"], world["checking"]
    hh = hh_household(db, o)
    _set_status(db, world["tablet"], reviewed=True, auto_post=True)
    client.put(f"/api/v1/budget-entries/{world['tablet']}", json={"tag_ids": [hh]},
               headers=o["headers"]).raise_for_status()
    _txn(client, o, card, 5_000, "2026-10-03")
    _txn(client, o, checking, 5_000, "2026-10-10", kind="transfer",
         transfer_from_account_id=checking, transfer_to_account_id=card)

    settled = []
    real = household._settle_with_sources

    def spy(cycles, *args, **kwargs):
        owed, in_scope = real(cycles, *args, **kwargs)
        settled.append((cycles, owed))
        return owed, in_scope

    monkeypatch.setattr(household, "_settle_with_sources", spy)
    end = START + timedelta(days=61)
    db.expire_all()
    occurrences = household.household_occurrences(
        db, own_household_grant(db, o["id"]), [], START, end, recorded=False,
        viewable_ids=viewable_account_ids(db, o["id"]), access=RecordAccess(db, o["id"]))

    # The first settlement is the window's own; later ones are per-due covers.
    cycles, owed = settled[0]
    by_due = {(START if c["due"] < START else c["due"]).date().isoformat()
              + "/" + c["close"].date().isoformat(): amount
              for c, amount in zip(cycles, owed) if amount > 0 and c["due"] < end}
    assert by_due == {f"{due}/{close}": amount for due, close, amount in _statements(db, o)}
    assert by_due == {"2026-10-18/2026-08-24": FIVE, "2026-10-18/2026-09-24": FIVE,
                      "2026-11-14/2026-10-24": Decimal("10000"),
                      "2026-12-15/2026-11-24": FIVE}
    listed = [occ.date for occ in occurrences if occ.record.id == world["tablet"]]
    assert listed == [datetime(2026, 11, 5), datetime(2026, 12, 5)]
    assert all(occ.date >= START for occ in occurrences)


def test_close_guard_sees_reviewed_lapsed_months(world):
    """Tablet3: Jul 5, Aug 5 and Sep 5, every statement due before Oct 18."""
    from app.models.account import Account
    from app.models.budget_entry import BudgetEntry
    from app.services.forecast import card_entries_still_bill

    client, db, o, card = world["client"], world["db"], world["o"], world["card"]
    db.query(BudgetEntry).filter(BudgetEntry.id == world["tablet"]).delete()
    db.commit()
    tablet3 = _installment(client, o, card, name="Tablet3", remaining=3)

    def still_bills() -> bool:
        db.expire_all()
        return card_entries_still_bill(db, db.get(Account, card),
                                       [db.get(BudgetEntry, tablet3)], START)

    assert still_bills() is False
    _set_status(db, tablet3, reviewed=True, auto_post=True)
    assert still_bills() is True


def test_unreviewed_installment_due_month_stays_projected_on_a_mixed_ledger(world):
    """Guard: only a reviewed installment's months settle as recorded.

    Tablet is unreviewed, so its Oct 5 line (statement closing Oct 24, due Nov
    14, not lapsed) is projected, not a recorded row. A recorded Nov 1 charge
    takes the Oct 10 payment as the only recorded balance, leaving Tablet's
    Oct 5 charge owing. Were that line moved into the recorded ones, the payment
    would settle it first and the Nov 1 charge would owe instead.
    """
    client, db, o = world["client"], world["db"], world["o"]
    card, checking = world["card"], world["checking"]
    _txn(client, o, card, 5_000, "2026-11-01")
    _txn(client, o, checking, 5_000, "2026-10-10", kind="transfer",
         transfer_from_account_id=checking, transfer_to_account_id=card)

    assert _statements(db, o) == [
        ("2026-11-14", "2026-10-24", FIVE),     # Tablet's Oct 5 charge, still owing
        ("2026-12-15", "2026-11-24", FIVE),     # Tablet's Nov 5 charge; Nov 1 is paid
    ]

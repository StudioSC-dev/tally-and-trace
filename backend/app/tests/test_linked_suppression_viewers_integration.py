"""STU-269: linked-row suppression for the viewers who read an entry by another path.

``linked_transactions`` decides sharing from the accounts an entry touches, not
from each viewer's read path (owner ruling 2026-11-15: accepted and documented,
no access-rule change). These tests pin what that does to two viewers:

* an overflow-only viewer: shares the entry's overflow account, not its main one;
* a rule (c) reader: holds the creator's Household tag share, and the entry
  carries that tag while none of its accounts does.

Each sees the entry's occurrences as ``limited`` events with no cash leg. The
creator's row on the occurrence's day (one they can't read) removes that
occurrence from their upcoming list, and moves none of their balances.
"""
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.tests.conftest import hh_household, hh_tag_share, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

REF = datetime(2026, 10, 10)
END = REF + timedelta(days=60)
FIRST, SECOND = datetime(2026, 10, 25), datetime(2026, 11, 25)


def _days(db, who):
    """The days of the occurrences ``who`` is listed, as the projection builds them."""
    from app.services.forecast import collect_events

    db.expire_all()
    return sorted(e["date"] for e in collect_events(db, REF, END, user_id=who["id"]))


def _closings(db, who):
    from app.services.forecast import project_running_balance

    db.expire_all()
    result = project_running_balance(db, who["id"], days=60, reference=REF)
    return sorted((a["account_id"], a["closing_balance"]) for a in result["by_account"])


def _cash_deltas(db, who):
    """Every event's cash legs for ``who``: none for the viewers pinned here."""
    from app.services.forecast import collect_events

    db.expire_all()
    return [e["legs"] for e in collect_events(db, REF, END, user_id=who["id"])
            if e.get("legs")]


def _record(db, owner, account, entry, when, *, by_hand=False):
    """The creator's row for the occurrence on ``when``: materialised from the
    entry, or (``by_hand``) linked to it with no ``occurrence_date``."""
    from app.models.transaction import Transaction, TransactionType

    db.add(Transaction(
        user_id=owner["id"], created_by_actor=owner["id"], account_id=account,
        transaction_type=TransactionType.DEBIT, amount=100, transfer_fee=0,
        currency="PHP", transaction_date=when, occurrence_date=None if by_hand else when, is_posted=False,
        is_recurring=False, budget_entry_id=entry, description="Rent"))
    db.commit()


def _entry(client, owner, account, **extra):
    return sw_post(client, owner, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 100, "cadence": "monthly",
        "next_occurrence": FIRST.isoformat(), "account_id": account, **extra})["id"]


def test_overflow_only_viewer_pinned(sw_client, sw_db, sw_people):
    """AC1: the entry is on the owner's private account with the joint account as
    overflow; the viewer holds a share on the joint account only. The owner's row
    on the private account (the entry's own account, unreadable to the viewer)
    removes the 25 Oct occurrence from the viewer's upcoming list, and the
    viewer's balances stay as they were."""
    owner = sw_people("Olga", "Owner")
    viewer = sw_people("Vera", "Viewer")
    private = sw_post(sw_client, owner, "/accounts/", {
        "name": "Private", "account_type": "checking", "balance": 1_000})["id"]
    joint = sw_post(sw_client, owner, "/accounts/", {
        "name": "Joint", "account_type": "checking", "balance": 1_000})["id"]
    sw_share(sw_db, joint, viewer["id"], "viewer", owner["id"])
    entry = _entry(sw_client, owner, private, overflow_account_id=joint)

    assert _days(sw_db, viewer) == [FIRST, SECOND]
    before = _closings(sw_db, viewer)
    assert before and _cash_deltas(sw_db, viewer) == []

    _record(sw_db, owner, private, entry, FIRST)

    assert _days(sw_db, viewer) == [SECOND]
    assert _closings(sw_db, viewer) == before
    assert _cash_deltas(sw_db, viewer) == []


def test_rule_c_reader_pinned(sw_client, sw_db, sw_people):
    """AC2: the entry carries the owner's Household tag but sits on a private
    account that doesn't, so it counts as unshared and a row of the creator's on
    any account stands for the occurrence. The Household tag reader (no account
    of the owner's in their scope) loses the 25 Oct occurrence, and their
    balances stay as they were."""
    owner = sw_people("Olga", "Owner")
    reader = sw_people("Rhea", "Reader")
    private = sw_post(sw_client, owner, "/accounts/", {
        "name": "Private", "account_type": "checking", "balance": 1_000})["id"]
    other = sw_post(sw_client, owner, "/accounts/", {
        "name": "Other", "account_type": "checking", "balance": 1_000})["id"]
    reader_bank = sw_post(sw_client, reader, "/accounts/", {
        "name": "Reader bank", "account_type": "checking", "balance": 500})["id"]
    hh_tag_share(sw_db, owner, reader)
    entry = _entry(sw_client, owner, private, tag_ids=[hh_household(sw_db, owner)])

    assert _days(sw_db, reader) == [FIRST, SECOND]
    before = _closings(sw_db, reader)
    assert before == [(reader_bank, 500)] and _cash_deltas(sw_db, reader) == []

    # A row linked by hand on another account of the owner's: with nothing shared
    # it still counts.
    _record(sw_db, owner, other, entry, FIRST, by_hand=True)

    assert _days(sw_db, reader) == [SECOND]
    assert _closings(sw_db, reader) == before
    assert _cash_deltas(sw_db, reader) == []


def test_pinned_viewer_behaviour_documented():
    """AC3: the ``linked_transactions`` docstring and the README both say that
    suppression removes upcoming occurrences for overflow-only and rule (c)
    viewers without changing their balances."""
    from app.services.forecast import linked_transactions

    doc = " ".join((linked_transactions.__doc__ or "").split())
    for phrase in ("overflow account", "rule (c) reader", "upcoming list",
                   "changes no balance"):
        assert phrase in doc, phrase

    readme = " ".join((Path(__file__).resolve().parents[3] / "README.md")
                      .read_text(encoding="utf-8").split())
    start = readme.index("Linked-row suppression")
    paragraph = readme[start:start + 700]
    for phrase in ("overflow account", "Household tag reader", "upcoming occurrence",
                   "balances don't change"):
        assert phrase in paragraph, phrase

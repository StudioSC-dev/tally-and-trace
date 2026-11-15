"""STU-268: a share held by an account's own owner makes nothing shared.

The API refuses an owner sharing an account (or their Household tag) with
themselves, but the database allows the row. ``linked_transactions`` must treat
such a row, written directly, as no share at all: an account with only a self
share keeps the result of an unshared one, while a genuine share (account or
Household tag) still switches on the shared-account rule.

Each case reads one hand-linked row of the owner's on an account other than the
entry's: it stands for an occurrence when the entry touches no shared account,
and stands for nothing when it does.
"""
from datetime import datetime

import pytest

from app.tests.conftest import hh_household, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _linked_world(sw_client, sw_db, sw_people):
    """An owner, a second user, the entry's account, and an entry with a row of
    the owner's on another of their accounts linked to it by hand."""
    from app.models.transaction import Transaction, TransactionType

    owner = sw_people("Olga", "Owner")
    other_user = sw_people("Omar", "Other")
    main = sw_post(sw_client, owner, "/accounts/", {
        "name": "Main", "account_type": "checking", "balance": 1_000})["id"]
    side = sw_post(sw_client, owner, "/accounts/", {
        "name": "Side", "account_type": "checking", "balance": 1_000})["id"]
    entry = sw_post(sw_client, owner, "/budget-entries/", {
        "name": "Rent", "entry_type": "expense", "amount": 100, "cadence": "monthly",
        "next_occurrence": "2026-10-25T00:00:00", "account_id": main})["id"]
    sw_db.add(Transaction(
        user_id=owner["id"], created_by_actor=owner["id"], account_id=side,
        transaction_type=TransactionType.DEBIT, amount=100, transfer_fee=0,
        currency="PHP", transaction_date=datetime(2026, 10, 25), is_posted=True,
        is_recurring=False, budget_entry_id=entry, description="Rent"))
    sw_db.commit()
    return owner, other_user, main, entry


def _linked(db, entry):
    from app.services.forecast import linked_transactions

    db.expire_all()
    return linked_transactions(db, [entry])


def _tag_main(sw_client, owner, main, db):
    r = sw_client.put(f"/api/v1/accounts/{main}", headers=owner["headers"],
                      json={"tag_ids": [hh_household(db, owner)]})
    assert r.status_code == 200, r.text


def _self_account_share(db, owner, main):
    sw_share(db, main, owner["id"], "viewer", owner["id"])


def _self_tag_share(db, owner):
    from app.models.tag_share import TagShare

    db.add(TagShare(tag_id=hh_household(db, owner), user_id=owner["id"]))
    db.commit()


def test_unshared_linked_rows_unchanged(sw_client, sw_db, sw_people):
    """AC6: no shares at all: the owner's row on another account counts."""
    owner, _, main, entry = _linked_world(sw_client, sw_db, sw_people)
    assert [e for e, _ in _linked(sw_db, entry)] == [entry]


def test_self_account_share_ignored_in_linked_rows(sw_client, sw_db, sw_people):
    """AC1: a self account-share, inserted directly, leaves the account unshared."""
    owner, _, main, entry = _linked_world(sw_client, sw_db, sw_people)
    _self_account_share(sw_db, owner, main)
    assert [e for e, _ in _linked(sw_db, entry)] == [entry]


def test_self_tag_share_still_ignored(sw_client, sw_db, sw_people):
    """AC2: the owner's Household tag on the account, shared with themselves only."""
    owner, _, main, entry = _linked_world(sw_client, sw_db, sw_people)
    _tag_main(sw_client, owner, main, sw_db)
    _self_tag_share(sw_db, owner)
    assert [e for e, _ in _linked(sw_db, entry)] == [entry]


@pytest.mark.parametrize("kind", ["account", "tag", "account_and_self", "tag_and_self"])
def test_real_share_still_counted(sw_client, sw_db, sw_people, kind):
    """AC3: a genuine account share or Household tag share still makes the
    account shared (so the row on another account stands for nothing), with or
    without a self share beside it."""
    from app.models.tag_share import TagShare

    owner, other, main, entry = _linked_world(sw_client, sw_db, sw_people)
    if kind.startswith("account"):
        sw_share(sw_db, main, other["id"], "viewer", owner["id"])
    else:
        _tag_main(sw_client, owner, main, sw_db)
        sw_db.add(TagShare(tag_id=hh_household(sw_db, owner), user_id=other["id"]))
        sw_db.commit()
    if kind.endswith("_and_self"):
        if kind.startswith("account"):
            _self_account_share(sw_db, owner, main)
        else:
            _self_tag_share(sw_db, owner)
    assert _linked(sw_db, entry) == []

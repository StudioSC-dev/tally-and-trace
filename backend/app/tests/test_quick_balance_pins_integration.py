"""Pinned quick balances (STU-578, PR 2): ``PUT /dashboard/quick-balances``.

A pinned list replaces the default tiles, in the order sent, with ``slot``
null. It is stored per user and re-checked on every read: an account that is
no longer pinnable is skipped and the stored list is kept. Skips without a
database.
"""
import pytest

from app.tests.conftest import API, hh_household, hh_tag_share, sw_db_reachable, sw_share
from app.tests.test_card_charges_integration import pin_clock
from app.tests.test_quick_balances_integration import (
    TILE_KEYS, _account, _loan, _quick, _rows, _user)
from app.tests.test_statement_minimum_integration import REF, _card

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


@pytest.fixture
def world(sw_client, sw_db, sw_people, monkeypatch):
    pin_clock(monkeypatch, REF)
    return {"client": sw_client, "db": sw_db, "people": sw_people}


def _put(client, who, ids, expect=200):
    r = client.put(f"{API}/dashboard/quick-balances", json={"account_ids": ids},
                   headers=who["headers"])
    assert r.status_code == expect, r.text
    return r


def _get(client, who):
    r = client.get(f"{API}/dashboard/quick-balances", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _set_active(db, account_id, active):
    from app.models.account import Account

    db.expire_all()
    db.get(Account, account_id).is_active = active
    db.commit()


def test_pin_order_roundtrip(world):
    client, me = world["client"], world["people"]("Seth", "Owner")
    gcash = _account(client, me, "GCash", "e_wallet", 1_500)
    bank = _account(client, me, "Security Bank", balance=20_000)
    loan = _loan(client, me, "Car loan", bank)
    _account(client, me, "Unpinned")

    put = _put(client, me, [gcash, bank, loan]).json()
    got = _get(client, me)
    assert put == got
    assert got["pinned"] is True and got["max_tiles"] == 6
    assert [t["account_id"] for t in got["tiles"]] == [gcash, bank, loan]
    assert all(t["slot"] is None for t in got["tiles"])
    assert all(TILE_KEYS <= set(t) for t in got["tiles"])
    by_id = {t["account_id"]: t for t in got["tiles"]}
    assert by_id[gcash]["balance"] == 1_500.0
    assert by_id[loan]["balance"] == -90_000.0
    assert by_id[loan]["account_type"] == "loan"

    # The order is the order sent.
    assert [t["account_id"] for t in _put(client, me, [loan, gcash, bank]).json()["tiles"]
            ] == [loan, gcash, bank]


def test_empty_pins_reset(world):
    client, db, me = world["client"], world["db"], world["people"]("Seth", "Owner")
    bank = _account(client, me, "Anything")
    _rows(db, me, bank, 2)
    other = _account(client, me, "Pinned instead", "savings")
    _put(client, me, [other])
    assert _user(db, me).quick_balance_account_ids == [other]

    reset = _put(client, me, []).json()
    assert _user(db, me).quick_balance_account_ids is None
    assert reset["pinned"] is False
    assert [(t["account_id"], t["slot"]) for t in reset["tiles"]] == [(bank, "debit")]
    assert _quick(client, me) == reset


def test_pin_refusals(world):
    client, db, people = world["client"], world["db"], world["people"]
    me, other = people("Seth", "Owner"), people("Dee", "Stranger")
    mine = [_account(client, me, f"Mine {i}") for i in range(7)]
    theirs = _account(client, other, "Private Savings Name")
    tagged = _account(client, other, "Household only", tag_ids=[hh_household(db, other)])
    hh_tag_share(db, other, me)
    inactive = _account(client, me, "Closed")
    _set_active(db, inactive, False)
    _put(client, me, [mine[0]])

    assert _put(client, me, mine, 422)  # seven
    assert _put(client, me, [mine[0], mine[1], mine[0]], 422)  # a duplicate
    for bad in (theirs, tagged, inactive, 987_654_321):
        r = _put(client, me, [mine[0], bad], 404)
        assert "Private Savings Name" not in r.text and "Household only" not in r.text
        assert r.json()["detail"] == "Account not found"

    # Nothing was stored by a refusal.
    assert _user(db, me).quick_balance_account_ids == [mine[0]]
    assert [t["account_id"] for t in _get(client, me)["tiles"]] == [mine[0]]
    # Six is allowed.
    assert len(_put(client, me, mine[:6]).json()["tiles"]) == 6


def test_pin_shared_card_redacted(world):
    client, db, people = world["client"], world["db"], world["people"]
    me = people("Seth", "Owner")
    card = _card(client, me, "Shared card")
    for role in ("editor", "viewer"):
        who = people(role.title(), "Share")
        sw_share(db, card, who["id"], role, me["id"])
        got = _put(client, who, [card]).json()
        (tile,) = got["tiles"]
        assert got["pinned"] is True and tile["account_id"] == card and tile["slot"] is None
        assert set(tile) == TILE_KEYS

    # The owner's own tile for it keeps the card figures.
    (tile,) = _put(client, me, [card]).json()["tiles"]
    assert "card" in tile


def test_pins_rechecked_on_read(world):
    client, db, people = world["client"], world["db"], world["people"]
    me, other = people("Seth", "Owner"), people("Dee", "Sharer")
    first = _account(client, me, "First")
    second = _account(client, me, "Second", "savings")
    shared = _account(client, other, "Shared in")
    share = sw_share(db, shared, me["id"], "viewer", other["id"])
    default = _account(client, me, "Default pick", "e_wallet")
    _put(client, me, [first, shared, second])

    def ids():
        return [t["account_id"] for t in _get(client, me)["tiles"]]

    assert ids() == [first, shared, second]
    _set_active(db, first, False)
    assert ids() == [shared, second]
    _set_active(db, first, True)
    assert ids() == [first, shared, second]

    from app.models.account_share import AccountShare

    db.query(AccountShare).filter(AccountShare.id == share).delete()
    db.commit()
    assert ids() == [first, second]
    assert _user(db, me).quick_balance_account_ids == [first, shared, second]
    sw_share(db, shared, me["id"], "viewer", other["id"])
    assert ids() == [first, shared, second]

    # Every pin skipped: the defaults show, and the stored list is kept.
    for account in (first, second):
        _set_active(db, account, False)
    db.query(AccountShare).filter(AccountShare.account_id == shared).delete()
    db.commit()
    body = _get(client, me)
    assert body["pinned"] is False
    assert [(t["account_id"], t["slot"]) for t in body["tiles"]] == [(default, "e_wallet")]
    assert _user(db, me).quick_balance_account_ids == [first, shared, second]


def test_pins_per_user(world):
    client, db, people = world["client"], world["db"], world["people"]
    a, b = people("Ann", "Pins"), people("Bob", "Defaults")
    a_wallet = _account(client, a, "A wallet", "e_wallet")
    b_bank = _account(client, b, "B bank")
    _rows(db, b, b_bank, 1)
    before = _get(client, b)
    _put(client, a, [a_wallet])
    assert _get(client, b) == before
    assert before["pinned"] is False
    _put(client, b, [b_bank])
    assert [t["account_id"] for t in _get(client, a)["tiles"]] == [a_wallet]

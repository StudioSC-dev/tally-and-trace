"""Linking a credit card to another card's credit limit (PR 1 of the shared limit).

A linked card (the secondary) stores ``shares_limit_with_account_id``, pointing
at the card that holds the limit (the primary), and no limit of its own. This
module covers the link itself: storing it, its refusals, the locks that keep
two writes from making a chain or an inactive linked card, who sees the field,
and unlinking. The credit figures that read it ship separately.

Until they do, the API refuses every link (``SHARED_LIMITS_ENABLED`` off,
``test_link_refused_until_enabled``). Every other test here lifts that gate with
the ``enabled`` fixture, a test-only override of the module flag; the next PR
removes the flag and the fixture with it.

Races follow test_balance_locking_integration.py: a holder session runs the
first write up to its commit, a worker thread sends the second, the probe waits
until the worker blocks on the holder, then the holder commits. Skips without a
database.
"""
import os

import pytest
from sqlalchemy import create_engine

from app.tests.conftest import (
    API, PRIVATE, sw_db_reachable, sw_post, sw_share,
)
from app.tests.test_balance_locking_integration import _race

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

FIELD = "shares_limit_with_account_id"
NOT_FOUND = "shares_limit_with_account_id account not found"
UNLINK_FIRST = "Unlink the shared credit limit first"
GATE = "Shared credit limits are not enabled yet"


@pytest.fixture
def enabled(monkeypatch):
    """Lift the rollout gate (test-only; the shared credit calculation removes it)."""
    from app.routers import accounts

    monkeypatch.setattr(accounts, "SHARED_LIMITS_ENABLED", True)


@pytest.fixture
def engine():
    e = create_engine(os.environ["DATABASE_URL"])
    yield e
    e.dispose()


@pytest.fixture
def holder(sw_client):
    from app.core.database import SessionLocal

    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _bank(client, who, name="Security Bank", currency="PHP"):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": "checking", "balance": 50_000,
        "currency": currency})["id"]


def _card(client, who, name, limit=None, **extra):
    body = {"name": name, "account_type": "credit", "balance": 0, "credit_limit": limit,
            "billing_cycle_start": 4, "days_until_due_date": 25}
    body.update(extra)
    return sw_post(client, who, "/accounts/", body)["id"]


def _get(client, who, account_id):
    r = client.get(f"{API}/accounts/{account_id}", headers=who["headers"])
    assert r.status_code == 200, r.text
    return r.json()


def _put(client, who, account_id, body):
    return client.put(f"{API}/accounts/{account_id}", json=body, headers=who["headers"])


def _stored(db, account_id):
    from app.models.account import Account

    db.expire_all()
    account = db.get(Account, account_id)
    return (account.shares_limit_with_account_id,
            None if account.credit_limit is None else int(account.credit_limit),
            account.is_active)


@pytest.fixture
def owner(sw_client, sw_people):
    """An owner with Security Bank and an Amex-like card holding 480,000."""
    me = sw_people("Seth", "Owner")
    bank = _bank(sw_client, me)
    amex = _card(sw_client, me, "BDO Amex", 480_000, payment_account_id=bank)
    return {"me": me, "bank": bank, "amex": amex}


# --- Gate ----------------------------------------------------------------------------------

def test_link_refused_until_enabled(sw_client, sw_db, owner):
    """Until the shared credit calculation ships, no link can be stored."""
    client, me, amex = sw_client, owner["me"], owner["amex"]
    r = client.post(f"{API}/accounts/", json={
        "name": "BDO Platinum Mastercard", "account_type": "credit", FIELD: amex},
        headers=me["headers"])
    assert (r.status_code, r.json()["detail"]) == (400, GATE)

    other = _card(client, me, "Other card", 10_000)
    r = _put(client, me, other, {FIELD: amex, "credit_limit": None})
    assert (r.status_code, r.json()["detail"]) == (400, GATE)
    assert _stored(sw_db, other) == (None, 10_000, True)

    # Null (no link) is not a link: an ordinary edit still saves.
    r = _put(client, me, other, {FIELD: None, "name": "Other card 2"})
    assert r.status_code == 200, r.text
    assert r.json()[FIELD] is None


# --- 2, 3: creating and linking ------------------------------------------------------------

def test_create_card_linked_to_limit(sw_client, sw_db, owner, enabled):
    client, me, amex = sw_client, owner["me"], owner["amex"]
    platinum = sw_post(client, me, "/accounts/", {
        "name": "BDO Platinum Mastercard", "account_type": "credit", "currency": "PHP",
        "billing_cycle_start": 14, "days_until_due_date": 25,
        "payment_account_id": owner["bank"], FIELD: amex})
    assert (platinum[FIELD], platinum["credit_limit"]) == (amex, None)
    assert _stored(sw_db, platinum["id"]) == (amex, None, True)

    read = _get(client, me, platinum["id"])
    assert (read[FIELD], read["credit_limit"], read["billing_cycle_start"],
            read["days_until_due_date"], read["payment_account_id"]) == (
        amex, None, 14, 25, owner["bank"])
    primary = _get(client, me, amex)
    assert (primary[FIELD], primary["credit_limit"]) == (None, 480_000)
    listed = {a["id"]: a for a in client.get(
        f"{API}/accounts/", params={"limit": 100}, headers=me["headers"]).json()["items"]}
    assert listed[platinum["id"]][FIELD] == amex


def test_link_clears_secondary_limit(sw_client, sw_db, owner, enabled):
    client, me, amex = sw_client, owner["me"], owner["amex"]
    card = _card(client, me, "Has its own limit", 50_000)
    r = _put(client, me, card, {FIELD: amex})
    assert r.status_code == 200, r.text
    assert (r.json()[FIELD], r.json()["credit_limit"]) == (amex, None)
    assert _stored(sw_db, card) == (amex, None, True)
    assert _stored(sw_db, amex) == (None, 480_000, True)


# --- 4, 5: refusals ------------------------------------------------------------------------

NOT_CREDIT = "Only a credit card can share another credit card's limit"
NOT_ACTIVE = "Both cards must be active to share a credit limit"
OWN_LIMIT = "A card that shares another card's limit has no limit of its own"


def test_link_refusals(sw_client, sw_db, owner, enabled):
    client, me, amex, bank = sw_client, owner["me"], owner["amex"], owner["bank"]
    card = _card(client, me, "Linkable", 20_000)

    def refused(account_id, body, status=400):
        r = (_put(client, me, account_id, body) if account_id is not None
             else client.post(f"{API}/accounts/", json=body, headers=me["headers"]))
        assert r.status_code == status, (body, r.status_code, r.text)
        return r.json()["detail"]

    # Target not a credit card.
    assert refused(card, {FIELD: bank}) == NOT_CREDIT
    # This card not a credit card: on create, and on an update judged on the resulting type.
    assert refused(None, {"name": "Checking", "account_type": "checking",
                          FIELD: amex}) == NOT_CREDIT
    assert refused(card, {FIELD: amex, "account_type": "checking"}) == NOT_CREDIT
    # Another currency.
    usd = _card(client, me, "USD card", currency="USD")
    assert refused(usd, {FIELD: amex}) == "Cards sharing a credit limit must be in one currency"
    # Target inactive.
    dead = _card(client, me, "Closed card", 5_000)
    r = client.delete(f"{API}/accounts/{dead}", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert refused(card, {FIELD: dead}) == NOT_ACTIVE
    # This card inactive, stored or in the same request.
    sleeping = _card(client, me, "Sleeping card", is_active=False)
    assert refused(sleeping, {FIELD: amex}) == NOT_ACTIVE
    assert refused(card, {FIELD: amex, "is_active": False}) == NOT_ACTIVE
    # Itself.
    assert refused(card, {FIELD: card, "credit_limit": None}) == (
        "A card cannot share its own credit limit")
    # A target without a limit of its own.
    no_limit = _card(client, me, "No limit card")
    assert refused(card, {FIELD: no_limit}) == "That card has no credit limit to share"
    # A link carrying a limit of its own.
    assert refused(card, {FIELD: amex, "credit_limit": 1_000}) == OWN_LIMIT
    assert refused(None, {"name": "With limit", "account_type": "credit", FIELD: amex,
                          "credit_limit": 1_000}) == OWN_LIMIT

    assert _stored(sw_db, card) == (None, 20_000, True)
    assert _stored(sw_db, sleeping) == (None, None, False)


def test_link_refuses_chain_and_cycle(sw_client, sw_db, owner, enabled):
    client, me, amex = sw_client, owner["me"], owner["amex"]
    platinum = _card(client, me, "Platinum")
    assert _put(client, me, platinum, {FIELD: amex}).status_code == 200
    third = _card(client, me, "Third", 30_000)

    # The target is linked itself.
    r = _put(client, me, third, {FIELD: platinum})
    assert r.status_code == 409, r.text
    # This card is already a primary.
    r = _put(client, me, amex, {FIELD: third, "credit_limit": None})
    assert r.status_code == 409, r.text

    # A -> B, then B -> A.
    a = _card(client, me, "Card A", 10_000)
    b = _card(client, me, "Card B", 20_000)
    assert _put(client, me, a, {FIELD: b}).status_code == 200
    r = _put(client, me, b, {FIELD: a, "credit_limit": None})
    assert r.status_code == 409, r.text
    assert _stored(sw_db, a) == (b, None, True)
    assert _stored(sw_db, b) == (None, 20_000, True)
    assert _stored(sw_db, amex) == (None, 480_000, True)
    assert _stored(sw_db, third) == (None, 30_000, True)


# --- 6, 11a: races -------------------------------------------------------------------------

def _hold(holder, fn, *args, user_id):
    """Run a router function in ``holder`` up to its commit (left open)."""
    from app.models.user import User

    holder.commit = lambda: None
    holder.refresh = lambda *a, **k: None
    try:
        return fn(*args, db=holder, current_user=holder.get(User, user_id))
    finally:
        del holder.commit
        del holder.refresh


def test_concurrent_links_leave_no_cycle(sw_client, sw_db, owner, engine, holder, enabled):
    """A -> B held open, B -> A sent: the second waits on the first and is refused."""
    from app.routers.accounts import update_account
    from app.schemas.account import AccountUpdate

    client, me = sw_client, owner["me"]
    a = _card(client, me, "Race A", 10_000)
    b = _card(client, me, "Race B", 20_000)

    _hold(holder, update_account, a, AccountUpdate(**{FIELD: b}), user_id=me["id"])
    r = _race(engine, holder, lambda: _put(client, me, b, {FIELD: a, "credit_limit": None}))

    assert r.status_code == 409, r.text
    assert _stored(sw_db, a) == (b, None, True)
    assert _stored(sw_db, b) == (None, 20_000, True)


def test_concurrent_link_and_delete(sw_client, sw_db, owner, engine, holder, enabled):
    """A link to a card and the card's delete take turns, in either order.

    The link first: the delete waits, then sees the link (409). The delete
    first: the link waits, then sees an inactive target (400). Never an
    inactive linked card.
    """
    from app.routers.accounts import delete_account, update_account
    from app.schemas.account import AccountUpdate

    client, me = sw_client, owner["me"]

    # The link held open, the delete sent.
    target = _card(client, me, "Delete race target 1", 40_000)
    source = _card(client, me, "Delete race source 1")
    _hold(holder, update_account, source, AccountUpdate(**{FIELD: target}), user_id=me["id"])
    r = _race(engine, holder, lambda: client.delete(
        f"{API}/accounts/{target}", headers=me["headers"]))
    assert (r.status_code, r.json()["detail"]) == (409, UNLINK_FIRST)
    assert _stored(sw_db, source) == (target, None, True)
    assert _stored(sw_db, target) == (None, 40_000, True)

    # The delete held open, the link sent.
    target = _card(client, me, "Delete race target 2", 40_000)
    source = _card(client, me, "Delete race source 2")
    _hold(holder, delete_account, target, user_id=me["id"])
    r = _race(engine, holder, lambda: _put(client, me, source, {FIELD: target}))
    assert r.status_code == 400, r.text
    assert _stored(sw_db, source) == (None, None, True)
    assert _stored(sw_db, target) == (None, 40_000, False)


# --- 7, 8: access and redaction ------------------------------------------------------------

def test_link_access(sw_client, sw_db, sw_people, owner, enabled):
    client, me, amex = sw_client, owner["me"], owner["amex"]
    card = _card(client, me, "Mine", 10_000)

    # Another owner's card, and an id that is no card at all.
    stranger = sw_people("Sam", "Stranger")
    theirs = _card(client, stranger, f"{PRIVATE} their card", 99_000)
    for target in (theirs, 2_000_000_000):
        r = _put(client, me, card, {FIELD: target})
        assert (r.status_code, r.json()["detail"]) == (404, NOT_FOUND)
        assert PRIVATE not in r.text

    # An admin of the card who doesn't manage the target (no role, or only a view).
    admin = sw_people("Dee", "Admin")
    sw_share(sw_db, card, admin["id"], "admin", me["id"])
    r = _put(client, admin, card, {FIELD: amex})
    assert (r.status_code, r.json()["detail"]) == (404, NOT_FOUND)
    sw_share(sw_db, amex, admin["id"], "viewer", me["id"])
    r = _put(client, admin, card, {FIELD: amex})
    assert (r.status_code, r.json()["detail"]) == (404, NOT_FOUND)

    # An admin of a card linking to a card the admin manages but someone else owns.
    admins_own = _card(client, admin, "Admin's own", 5_000)
    r = _put(client, admin, card, {FIELD: admins_own})
    assert (r.status_code, r.json()["detail"]) == (404, NOT_FOUND)
    assert _stored(sw_db, card) == (None, 10_000, True)

    # Managing both of the owner's cards, the admin may link them.
    other = _card(client, me, "Admin managed", 7_000)
    sw_share(sw_db, other, admin["id"], "admin", me["id"])
    r = _put(client, admin, card, {FIELD: other})
    assert r.status_code == 200, r.text
    assert _stored(sw_db, card) == (other, None, True)


def test_link_field_redaction(hh, sw_client, sw_db, sw_people, enabled):
    client, db, a = sw_client, sw_db, hh["a"]
    primary = hh["a_card"]
    platinum = sw_post(client, a, "/accounts/", {
        "name": "Household Platinum", "account_type": "credit", FIELD: primary,
        "tag_ids": [hh["hh_a"]]})["id"]
    assert _get(client, a, platinum)[FIELD] == primary

    editor, viewer = hh["b"], sw_people("Vic", "Viewer")
    sw_share(db, platinum, editor["id"], "editor", a["id"])
    sw_share(db, platinum, viewer["id"], "viewer", a["id"])
    other = _card(client, a, "Another limit", 9_000)
    sw_share(db, other, editor["id"], "editor", a["id"])
    sw_share(db, other, viewer["id"], "viewer", a["id"])
    for who in (editor, viewer):
        read = _get(client, who, platinum)
        assert read["my_role"] in ("editor", "viewer")
        assert (read[FIELD], read["credit_limit"]) == (None, None)
        r = _put(client, who, platinum, {FIELD: other})
        assert r.status_code == 404, r.text
        r = _put(client, who, platinum, {FIELD: None})
        assert r.status_code == 404, r.text
    assert _stored(db, platinum) == (primary, None, True)

    # A tag viewer (Household share) gets the minimal shape: no such key at all.
    c = hh["c"]
    read = _get(client, c, platinum)
    assert read["my_role"] == "tag_viewer"
    assert FIELD not in read
    listed = [x for x in client.get(f"{API}/accounts/", params={"limit": 100},
                                    headers=c["headers"]).json()["items"]
              if x["id"] == platinum]
    assert len(listed) == 1 and FIELD not in listed[0]


# --- 9, 10, 11: edits while linked ---------------------------------------------------------

@pytest.fixture
def linked(sw_client, owner, enabled):
    platinum = sw_post(sw_client, owner["me"], "/accounts/", {
        "name": "BDO Platinum Mastercard", "account_type": "credit",
        "billing_cycle_start": 14, "days_until_due_date": 25,
        "payment_account_id": owner["bank"], FIELD: owner["amex"]})["id"]
    return {**owner, "platinum": platinum}


def test_limit_edits_while_linked(sw_client, sw_db, linked):
    client, me, amex, platinum = sw_client, linked["me"], linked["amex"], linked["platinum"]
    r = _put(client, me, platinum, {"credit_limit": 1_000})
    assert (r.status_code, r.json()["detail"]) == (
        400, "This card shares its limit with BDO Amex; change the limit there")
    r = _put(client, me, amex, {"credit_limit": None})
    assert r.status_code == 409, r.text
    # Resending the stored null, or changing the primary's limit, still saves.
    assert _put(client, me, platinum, {"credit_limit": None, "name": "Platinum"}).status_code == 200
    assert _put(client, me, amex, {"credit_limit": 500_000}).status_code == 200
    assert _stored(sw_db, platinum) == (amex, None, True)
    assert _stored(sw_db, amex) == (None, 500_000, True)


def test_currency_and_type_locked_while_linked(sw_client, sw_db, linked):
    client, me, amex, platinum = sw_client, linked["me"], linked["amex"], linked["platinum"]
    for side in (platinum, amex):
        for body in ({"currency": "USD"}, {"account_type": "checking"}):
            r = _put(client, me, side, body)
            assert r.status_code == 409, (side, body, r.text)
        # Resending the stored values is no change.
        r = _put(client, me, side, {"currency": "PHP", "account_type": "credit"})
        assert r.status_code == 200, r.text
    assert _get(client, me, platinum)["currency"] == "PHP"
    assert _get(client, me, amex)["account_type"] == "credit"


def test_deactivate_linked_card_refused(sw_client, sw_db, linked):
    from app.routers.accounts import CARD_OPEN_STATEMENT_DETAIL

    client, me, amex, platinum = sw_client, linked["me"], linked["amex"], linked["platinum"]
    sw_post(client, me, "/transactions/", {
        "account_id": amex, "amount": 100, "transaction_type": "debit",
        "description": "Amex charge", "transaction_date": "2026-11-05T00:00:00"})
    for side in (platinum, amex):
        r = _put(client, me, side, {"is_active": False})
        assert (r.status_code, r.json()["detail"]) == (409, UNLINK_FIRST)
        r = client.delete(f"{API}/accounts/{side}", headers=me["headers"])
        assert (r.status_code, r.json()["detail"]) == (409, UNLINK_FIRST)
    assert _stored(sw_db, platinum) == (amex, None, True)
    assert _stored(sw_db, amex) == (None, 480_000, True)

    # Unlinked, the existing guards apply as before.
    assert _put(client, me, platinum, {FIELD: None}).status_code == 200
    r = client.delete(f"{API}/accounts/{amex}", headers=me["headers"])
    assert (r.status_code, r.json()["detail"]) == (400, CARD_OPEN_STATEMENT_DETAIL)
    r = client.delete(f"{API}/accounts/{platinum}", headers=me["headers"])
    assert r.status_code == 200, r.text
    assert _stored(sw_db, platinum) == (None, None, False)


# --- 12: unlinking -------------------------------------------------------------------------

def test_unlink(sw_client, sw_db, linked):
    client, me, amex, platinum = sw_client, linked["me"], linked["amex"], linked["platinum"]
    r = _put(client, me, platinum, {FIELD: None})
    assert r.status_code == 200, r.text
    assert (r.json()[FIELD], r.json()["credit_limit"]) == (None, None)
    assert _stored(sw_db, platinum) == (None, None, True)
    assert _stored(sw_db, amex) == (None, 480_000, True)

    # Linked again, then unlinked with a limit of its own in the same request.
    assert _put(client, me, platinum, {FIELD: amex}).status_code == 200
    r = _put(client, me, platinum, {FIELD: None, "credit_limit": 100_000})
    assert r.status_code == 200, r.text
    assert _stored(sw_db, platinum) == (None, 100_000, True)
    assert _stored(sw_db, amex) == (None, 480_000, True)

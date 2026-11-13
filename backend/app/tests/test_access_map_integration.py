"""Access as data (STU-597): ``AccessMap`` gives every role ``account_role`` always gave.

The oracle below is the rule as it was read from the ORM graph before STU-597
(``account.shares``, ``account.tag_links`` and each tag's ``shares``), here loaded
explicitly with ``selectinload``. Every user's role on every account is compared,
through each public entry point, on the Household-share world plus the awkward
cases: a share and a tag share on the same account (the share wins), another
user's Household tag on the account (grants nothing), a non-system tag shared
(grants nothing), a tag shared with its own owner, an inactive account.

The relationships themselves no longer load implicitly: a lazy load raises.

Skips without a database.
"""
import pytest
from sqlalchemy.exc import InvalidRequestError

from app.tests.conftest import hh_tag_share, sw_db_reachable, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _oracle_role(uid, account) -> str:
    """The pre-STU-597 ``account_role``, over relationships loaded explicitly."""
    if account.user_id == uid:
        return "owner"
    for share in account.shares:
        if share.user_id == uid:
            return share.role
    for tag in account.tag_links:
        if (tag.is_system and tag.user_id == account.user_id
                and any(s.user_id == uid for s in tag.shares)):
            return "tag_viewer"
    return "none"


def _oracle_shared_out(account) -> bool:
    return bool(account.shares) or any(
        t.is_system and t.user_id == account.user_id for t in account.tag_links)


@pytest.fixture
def world(hh, sw_db, sw_people):
    from app.models.account import Account
    from app.models.tag import Tag, account_tags
    from app.models.tag_share import TagShare

    db, w = sw_db, dict(hh)
    w["s"] = sw_people("Sam", "Stranger")
    # B holds A's Household tag share as well as the editor share on the joint account.
    hh_tag_share(db, w["a"], w["b"])
    # B put their own Household tag on A's joint account: C holds B's tag, which
    # grants nothing on an account B does not own.
    db.execute(account_tags.insert(), [{"tag_id": w["hh_b"], "account_id": w["joint"]}])
    # A's own non-system tag on the private bank, "shared" with C by a raw row.
    trip = Tag(user_id=w["a"]["id"], name="Trip", is_system=False)
    db.add(trip)
    db.flush()
    db.execute(account_tags.insert(), [{"tag_id": trip.id, "account_id": w["a_private"]}])
    db.add(TagShare(tag_id=trip.id, user_id=w["c"]["id"]))
    # A tag share with the tag's own owner.
    db.add(TagShare(tag_id=w["hh_a"], user_id=w["a"]["id"]))
    # The wallet carries A's Household tag (shared with C and B); the card is
    # inactive and shared to C as a viewer.
    db.execute(account_tags.insert(), [{"tag_id": w["hh_a"], "account_id": w["a_wallet"]}])
    db.commit()
    sw_share(db, w["a_card"], w["c"]["id"], "viewer", w["a"]["id"])
    db.query(Account).filter(Account.id == w["a_card"]).update({"is_active": False})
    db.commit()
    return w


def _accounts(db, w):
    from sqlalchemy.orm import selectinload

    from app.models.account import Account
    from app.models.tag import Tag

    users = [w[k]["id"] for k in ("a", "b", "c", "s")]
    return (db.query(Account).filter(Account.user_id.in_(users))
            .options(selectinload(Account.shares),
                     selectinload(Account.tag_links).selectinload(Tag.shares))
            .order_by(Account.id).all())


def test_every_entry_point_matches_the_relationship_rule(world, sw_db):
    from app.core.access import (
        DIRECT_ROLES, EDIT_ROLES, VIEW_ROLES, RecordAccess, access_map, account_role,
        editable_account_ids, role_map, viewable_account_ids,
    )

    db, w = sw_db, world
    accounts = _accounts(db, w)
    assert len(accounts) == 7  # five of A's, one each of B and C; the stranger has none
    seen_roles = set()
    for key in ("a", "b", "c", "s"):
        uid = w[key]["id"]
        want = {a.id: _oracle_role(uid, a) for a in accounts}
        seen_roles.update(want.values())
        held = access_map(db, uid)
        access = RecordAccess(db, uid)
        for a in accounts:
            assert account_role(uid, a) == want[a.id], (key, a.name)
            assert held.of(a) == want[a.id] == held.role(a.id), (key, a.name)
            assert access.role(a.id) == want[a.id], (key, a.name)
            assert access_map(db, uid, [a.id]).role(a.id) == want[a.id], (key, a.name)
        assert role_map(db, uid) == {i: r for i, r in want.items() if r != "none"}
        for roles in (DIRECT_ROLES, VIEW_ROLES, EDIT_ROLES):
            assert viewable_account_ids(db, uid, roles=roles) == {
                i for i, r in want.items() if r in roles}, (key, roles)
            assert viewable_account_ids(db, uid, roles=roles, active_only=True) == {
                a.id for a in accounts if want[a.id] in roles and a.is_active is True}
        assert editable_account_ids(db, uid) == {i for i, r in want.items() if r in EDIT_ROLES}
    # The world exercises every role there is.
    assert seen_roles == {"owner", "editor", "viewer", "tag_viewer", "none"}
    roles = {(k, a.id): _oracle_role(w[k]["id"], a) for k in "abc" for a in accounts}
    assert roles[("b", w["joint"])] == "editor"  # the share outranks the tag share
    assert roles[("c", w["joint"])] == "tag_viewer"
    assert roles[("c", w["a_private"])] == "none"  # a non-system tag grants nothing
    assert roles[("c", w["a_card"])] == "viewer"


def test_shared_out_matches_the_relationship_rule(world, sw_db):
    from app.core.access import shared_out_ids

    db = sw_db
    accounts = _accounts(db, world)
    assert shared_out_ids(db, accounts) == {a.id for a in accounts if _oracle_shared_out(a)}
    assert shared_out_ids(db, []) == set()


def test_access_relationships_never_load_implicitly(world, sw_db):
    from app.models.account import Account
    from app.models.tag import Tag

    db = sw_db
    account = db.get(Account, world["joint"])
    for name in ("shares", "tag_links"):
        with pytest.raises(InvalidRequestError, match="lazy='raise'"):
            getattr(account, name)
    tag = db.get(Tag, world["hh_a"])
    with pytest.raises(InvalidRequestError, match="lazy='raise'"):
        tag.shares

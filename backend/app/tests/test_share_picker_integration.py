"""The share picker matches only verified users (STU-241).

A user who registered an email and never verified it may hold someone else's
address, under a name they chose. Lookup and both share-creation paths
(account shares and Household tag shares) answer such an email exactly as they
answer an unknown one: the same 404 "No matching user", with no share row
written. Unknown, inactive and demo recipients keep that same answer; an
active, verified, non-demo recipient still matches and can be shared with.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

UNKNOWN = "nobody-stu241@example.com"
NO_MATCH_BODY = '{"detail":"No matching user"}'
TAG_PATH = "/tags/household/shares"


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    from app.routers.shares import _lookups

    _lookups.clear()
    yield
    _lookups.clear()


def _call(client, who, method, path, **kw):
    return getattr(client, method)(f"{API}{path}", headers=who["headers"], **kw)


def _set(db, user_id, **fields):
    from app.models.user import User

    db.query(User).filter(User.id == user_id).update(fields)
    db.commit()


def _shares_held(db, user_id) -> int:
    from app.models.account_share import AccountShare
    from app.models.tag_share import TagShare

    return (db.query(AccountShare).filter(AccountShare.user_id == user_id).count()
            + db.query(TagShare).filter(TagShare.user_id == user_id).count())


def _response(r):
    """Everything a caller can see of a response, minus the per-request date."""
    headers = {k: v for k, v in r.headers.items() if k.lower() != "date"}
    return r.status_code, r.content, headers


@pytest.fixture
def owner(sw_client, sw_people):
    """A sharer with an account of their own."""
    a = sw_people("Alice", "Owner")
    r = _call(sw_client, a, "post", "/accounts/",
              json={"name": "Joint account", "account_type": "checking", "balance": 100})
    assert r.status_code in (200, 201), r.text
    return {**a, "account": r.json()["id"]}


def _lookup(client, who, email):
    return _call(client, who, "get", "/users/lookup", params={"email": email})


def _account_share(client, who, email):
    return _call(client, who, "post", f"/accounts/{who['account']}/shares",
                 json={"email": email, "role": "viewer"})


def _tag_share(client, who, email):
    return _call(client, who, "post", TAG_PATH, json={"email": email})


PATHS = {"lookup": _lookup, "account_share": _account_share, "tag_share": _tag_share}


@pytest.fixture
def unverified(sw_db, sw_people):
    """A user who registered and never verified (their email in every case shape)."""
    u = sw_people("Mallory", "Squatter")
    _set(sw_db, u["id"], is_verified=False)
    return u


# --- AC1-AC3: the is_verified check ------------------------------------------------------

def _assert_uniform_404(client, owner, call, unverified_email):
    unknown = call(client, owner, UNKNOWN)
    for email in (unverified_email, unverified_email.upper(), f"  {unverified_email.title()} "):
        r = call(client, owner, email)
        assert (r.status_code, r.text) == (404, NO_MATCH_BODY), email
        assert _response(r) == _response(unknown), email


def test_lookup_unverified_is_uniform_404(sw_client, owner, unverified):
    _assert_uniform_404(sw_client, owner, _lookup, unverified["email"])


def test_create_account_share_unverified_404(sw_client, sw_db, owner, unverified):
    _assert_uniform_404(sw_client, owner, _account_share, unverified["email"])
    assert _shares_held(sw_db, unverified["id"]) == 0


def test_create_tag_share_unverified_404(sw_client, sw_db, owner, unverified):
    _assert_uniform_404(sw_client, owner, _tag_share, unverified["email"])
    assert _shares_held(sw_db, unverified["id"]) == 0


def test_lookup_verified_still_matches(sw_client, sw_db, owner, unverified):
    r = _lookup(sw_client, owner, unverified["email"])
    assert r.status_code == 404
    _set(sw_db, unverified["id"], is_verified=True)  # once they verify, they match
    r = _lookup(sw_client, owner, f" {unverified['email'].upper()} ")
    assert r.status_code == 200, r.text
    assert r.json() == {"id": unverified["id"], "display_name": "Mallory S."}


# --- AC9: existing behaviour unchanged ---------------------------------------------------

@pytest.mark.parametrize("path", sorted(PATHS))
@pytest.mark.parametrize("kind", ["unknown", "inactive", "demo"])
def test_existing_recipient_exclusions_unchanged(sw_client, sw_db, sw_people, owner, path, kind):
    from app.core.seed import DEMO_EMAIL

    if kind == "unknown":
        email = UNKNOWN
    elif kind == "demo":
        email = DEMO_EMAIL
    else:
        inactive = sw_people("Ina", "Active")
        _set(sw_db, inactive["id"], is_active=False)
        email = inactive["email"]
    r = PATHS[path](sw_client, owner, email)
    assert (r.status_code, r.text) == (404, NO_MATCH_BODY)
    assert _response(r) == _response(PATHS[path](sw_client, owner, UNKNOWN))
    if kind == "inactive":
        assert _shares_held(sw_db, inactive["id"]) == 0


@pytest.mark.parametrize("path", ["account_share", "tag_share"])
def test_verified_share_creation_unchanged(sw_client, sw_db, sw_people, owner, path):
    target = sw_people("Vera", "Verified")
    assert _lookup(sw_client, owner, target["email"]).json() == {
        "id": target["id"], "display_name": "Vera V."}
    r = PATHS[path](sw_client, owner, f"  {target['email'].upper()} ")
    assert r.status_code == 201, r.text
    assert r.json()["user_id"] == target["id"]
    assert _shares_held(sw_db, target["id"]) == 1
    if path == "account_share":
        got = _call(sw_client, target, "get", f"/accounts/{owner['account']}")
        assert got.status_code == 200, got.text
    else:
        held = _call(sw_client, target, "get", "/shares/received/household")
        assert held.status_code == 200 and len(held.json()) == 1, held.text

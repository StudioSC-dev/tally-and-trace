"""Household tag shares: the endpoints (STU-233, plan §4).

``/tags/household/shares`` shares the caller's own Household system tag, by
exact email through the picker's rate-limited lookup; ``/shares/received/household``
lists and leaves the ones the caller holds. What a share grants is tested in
``test_household_access_integration.py``.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

PATH = "/tags/household/shares"


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    from app.routers.shares import _lookups

    _lookups.clear()
    yield
    _lookups.clear()


def _call(client, who, method, path, **kw):
    headers = who["headers"] if who else {}
    return getattr(client, method)(f"{API}{path}", headers=headers, **kw)


def _household_id(client, who):
    return _call(client, who, "get", PATH).json()["tag_id"]


@pytest.fixture
def demo(sw_client):
    from app.core.seed import DEMO_EMAIL, DEMO_PASSWORD

    r = sw_client.post(f"{API}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    return {"email": DEMO_EMAIL, "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}


def test_owner_shares_lists_and_revokes_their_household_tag(sw_client, sw_people):
    a, c = sw_people("Alice", "Owner"), sw_people("Cal", "Third")
    tag = _household_id(sw_client, a)
    assert _call(sw_client, a, "get", PATH).json() == {"tag_id": tag, "shares": []}

    r = _call(sw_client, a, "post", PATH, json={"email": c["email"].upper()})
    assert r.status_code == 201, r.text
    share = r.json()
    assert set(share) == {"id", "tag_id", "user_id", "display_name", "created_at"}
    assert (share["tag_id"], share["user_id"], share["display_name"]) == (tag, c["id"], "Cal T.")
    listed = _call(sw_client, a, "get", PATH).json()
    assert [s["id"] for s in listed["shares"]] == [share["id"]]

    received = _call(sw_client, c, "get", "/shares/received/household").json()
    assert [(s["id"], s["tag_id"], s["sharer_id"], s["sharer_name"]) for s in received] == [
        (share["id"], tag, a["id"], "Alice O.")]
    # It is not an account share.
    assert _call(sw_client, c, "get", "/shares/received").json() == []

    assert _call(sw_client, a, "delete", f"{PATH}/{share['id']}").status_code == 204
    assert _call(sw_client, a, "get", PATH).json()["shares"] == []
    assert _call(sw_client, c, "get", "/shares/received/household").json() == []
    assert _call(sw_client, a, "delete", f"{PATH}/{share['id']}").status_code == 404


def test_only_the_tag_owner_manages_its_shares(sw_client, sw_people):
    a, b, c = sw_people("Alice", "Owner"), sw_people("Bea", "Partner"), sw_people("Cal", "Third")
    share = _call(sw_client, a, "post", PATH, json={"email": c["email"]}).json()
    # B's routes name B's own tag: A's share is not there to see or remove.
    assert _call(sw_client, b, "get", PATH).json()["shares"] == []
    assert _call(sw_client, b, "delete", f"{PATH}/{share['id']}").status_code == 404
    # The holder can't remove it through the owner's route, only leave it.
    assert _call(sw_client, c, "delete", f"{PATH}/{share['id']}").status_code == 404
    assert _call(sw_client, b, "delete", f"/shares/received/household/{share['id']}").status_code == 404
    assert len(_call(sw_client, a, "get", PATH).json()["shares"]) == 1
    assert _call(sw_client, None, "get", PATH).status_code == 401
    assert _call(sw_client, None, "post", PATH, json={"email": c["email"]}).status_code == 401


def test_only_the_household_system_tag_can_be_shared(sw_client, sw_people):
    """No route names a tag: a custom tag, or someone else's, has no share route."""
    a, c = sw_people("Alice", "Owner"), sw_people("Cal", "Third")
    custom = _call(sw_client, a, "post", "/tags/", json={"name": "Business"}).json()["id"]
    for path in (f"/tags/{custom}/shares", f"/tags/{_household_id(sw_client, c)}/shares"):
        r = _call(sw_client, a, "post", path, json={"email": c["email"]})
        assert r.status_code in (404, 405), (path, r.status_code)
    share = _call(sw_client, a, "post", PATH, json={"email": c["email"]}).json()
    assert share["tag_id"] == _household_id(sw_client, a)


def test_conflicts_and_unknown_targets(sw_client, sw_people, demo):
    a, c = sw_people("Alice", "Owner"), sw_people("Cal", "Third")
    assert _call(sw_client, a, "post", PATH, json={"email": c["email"]}).status_code == 201
    assert _call(sw_client, a, "post", PATH, json={"email": c["email"]}).status_code == 409
    assert _call(sw_client, a, "post", PATH, json={"email": a["email"]}).status_code == 409
    for email in ("nobody-here@example.com", demo["email"], "demo.partner@example.com"):
        r = _call(sw_client, a, "post", PATH, json={"email": email})
        assert (r.status_code, r.json()["detail"]) == (404, "No matching user"), email
    assert _call(sw_client, a, "post", PATH, json={"email": c["email"], "role": "editor"}).status_code == 422


def test_demo_users_get_403_on_every_tag_share_route(sw_client, sw_people, demo):
    c = sw_people("Cal", "Third")
    for method, path, body in (
        ("get", PATH, None), ("post", PATH, {"email": c["email"]}), ("delete", f"{PATH}/1", None),
        ("get", "/shares/received/household", None),
        ("delete", "/shares/received/household/1", None),
    ):
        kw = {"json": body} if body else {}
        assert _call(sw_client, demo, method, path, **kw).status_code == 403, (method, path)


def test_creating_a_tag_share_counts_against_the_picker_rate_limit(sw_client, sw_people):
    from app.routers.shares import LOOKUP_LIMIT

    a = sw_people("Alice", "Owner")
    for i in range(LOOKUP_LIMIT):
        r = _call(sw_client, a, "post", PATH, json={"email": f"nobody-{i}@example.com"})
        assert r.status_code == 404
    assert _call(sw_client, a, "post", PATH, json={"email": "x@example.com"}).status_code == 429
    assert _call(sw_client, a, "get", "/users/lookup", params={"email": "x@example.com"}).status_code == 429


def test_the_holder_leaves_a_tag_share(sw_client, sw_people):
    a, c = sw_people("Alice", "Owner"), sw_people("Cal", "Third")
    share = _call(sw_client, a, "post", PATH, json={"email": c["email"]}).json()
    assert _call(sw_client, c, "delete", f"/shares/received/household/{share['id']}").status_code == 204
    assert _call(sw_client, c, "get", "/shares/received/household").json() == []
    assert _call(sw_client, a, "get", PATH).json()["shares"] == []
    assert _call(sw_client, c, "delete", f"/shares/received/household/{share['id']}").status_code == 404
    # A can share again after the holder left.
    assert _call(sw_client, a, "post", PATH, json={"email": c["email"]}).status_code == 201

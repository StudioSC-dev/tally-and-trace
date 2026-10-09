"""Account shares and the user picker (STU-232, plan §4)."""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

WHEN = "2026-11-01T00:00:00"


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    from app.routers.shares import _lookups

    _lookups.clear()
    yield
    _lookups.clear()


def _call(client, who, method, path, **kw):
    headers = who["headers"] if who else {}
    return getattr(client, method)(f"{API}{path}", headers=headers, **kw)


@pytest.fixture
def demo(sw_client):
    """The seeded demo user, logged in."""
    from app.core.seed import DEMO_EMAIL, DEMO_PASSWORD

    r = sw_client.post(f"{API}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    me = sw_client.get(f"{API}/auth/me", headers={
        "Authorization": f"Bearer {r.json()['access_token']}"}).json()
    return {"id": me["id"], "email": DEMO_EMAIL,
            "headers": {"Authorization": f"Bearer {r.json()['access_token']}"}}


# --- who manages shares -----------------------------------------------------------------

def test_who_lists_an_accounts_shares(sw, sw_client):
    path = f"/accounts/{sw['joint']}/shares"
    expected = {"a": 200, "d": 200, "b": 403, "v": 403, "s": 404}
    for who, code in expected.items():
        assert _call(sw_client, sw[who], "get", path).status_code == code, who
    assert _call(sw_client, None, "get", path).status_code == 401
    body = _call(sw_client, sw["a"], "get", path).json()
    assert body["owner"] == {"user_id": sw["a"]["id"], "display_name": "Alice O.",
                             "role": "owner"}
    assert sorted((s["user_id"], s["role"], s["display_name"]) for s in body["shares"]) == sorted([
        (sw["b"]["id"], "editor", "Bea P."), (sw["v"]["id"], "viewer", "Vic V."),
        (sw["d"]["id"], "admin", "Dee A.")])
    assert all(set(s) == {"id", "account_id", "user_id", "display_name", "role", "created_at"}
               for s in body["shares"])
    # An unshared account: only its owner manages it.
    private = f"/accounts/{sw['a_private']}/shares"
    for who in ("b", "v", "d", "s"):
        assert _call(sw_client, sw[who], "get", private).status_code == 404, who


def test_owner_shares_with_a_picked_user_who_then_reads_the_account(sw, sw_client, sw_people):
    newcomer = sw_people("Nia", "New")
    r = _call(sw_client, sw["a"], "get", "/users/lookup", params={"email": newcomer["email"].upper()})
    assert r.status_code == 200 and r.json() == {"id": newcomer["id"], "display_name": "Nia N."}
    assert _call(sw_client, newcomer, "get", f"/accounts/{sw['a_private']}").status_code == 404
    r = _call(sw_client, sw["a"], "post", f"/accounts/{sw['a_private']}/shares",
              json={"email": newcomer["email"], "role": "viewer"})
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "viewer" and r.json()["display_name"] == "Nia N."
    account = _call(sw_client, newcomer, "get", f"/accounts/{sw['a_private']}")
    assert account.status_code == 200 and account.json()["my_role"] == "viewer"
    received = _call(sw_client, newcomer, "get", "/shares/received").json()
    assert [(s["account_id"], s["role"], s["owner_name"]) for s in received] == [
        (sw["a_private"], "viewer", "Alice O.")]


def test_share_creation_conflicts_and_unknown_targets(sw, sw_client, demo):
    path = f"/accounts/{sw['joint']}/shares"
    dup = _call(sw_client, sw["a"], "post", path, json={"email": sw["b"]["email"], "role": "viewer"})
    assert dup.status_code == 409
    owner = _call(sw_client, sw["d"], "post", path, json={"email": sw["a"]["email"], "role": "viewer"})
    assert owner.status_code == 409
    unknown = _call(sw_client, sw["a"], "post", path, json={"email": "nobody@example.com",
                                                            "role": "viewer"})
    demo_target = _call(sw_client, sw["a"], "post", path, json={"email": demo["email"],
                                                                "role": "viewer"})
    assert unknown.status_code == demo_target.status_code == 404
    assert unknown.json() == demo_target.json() == {"detail": "No matching user"}
    bad_role = _call(sw_client, sw["a"], "post", path, json={"email": sw["s"]["email"],
                                                             "role": "owner"})
    assert bad_role.status_code == 422


def test_editors_and_viewers_cannot_change_shares(sw, sw_client):
    base = f"/accounts/{sw['joint']}/shares"
    for who in ("b", "v"):
        assert _call(sw_client, sw[who], "post", base,
                     json={"email": sw["s"]["email"], "role": "viewer"}).status_code == 403
        assert _call(sw_client, sw[who], "patch", f"{base}/{sw['shares']['v']}",
                     json={"role": "editor"}).status_code == 403
        assert _call(sw_client, sw[who], "delete",
                     f"{base}/{sw['shares']['v']}").status_code == 403
    assert _call(sw_client, sw["s"], "delete", f"{base}/{sw['shares']['v']}").status_code == 404


def test_only_the_owner_grants_admin(sw, sw_client, sw_people):
    base = f"/accounts/{sw['joint']}/shares"
    newcomer = sw_people("Nia", "New")
    r = _call(sw_client, sw["d"], "post", base, json={"email": newcomer["email"], "role": "admin"})
    assert r.status_code == 403
    r = _call(sw_client, sw["d"], "patch", f"{base}/{sw['shares']['b']}", json={"role": "admin"})
    assert r.status_code == 403
    r = _call(sw_client, sw["d"], "post", base, json={"email": newcomer["email"], "role": "editor"})
    assert r.status_code == 201
    r = _call(sw_client, sw["a"], "patch", f"{base}/{sw['shares']['b']}", json={"role": "admin"})
    assert r.status_code == 200 and r.json()["role"] == "admin"


def test_an_admin_cannot_demote_or_remove_another_admin(sw, sw_client, sw_people):
    base = f"/accounts/{sw['joint']}/shares"
    other = sw_people("Ola", "Admin")
    second = sw_post(sw_client, sw["a"], base, {"email": other["email"], "role": "admin"})["id"]
    assert _call(sw_client, sw["d"], "patch", f"{base}/{second}",
                 json={"role": "viewer"}).status_code == 403
    assert _call(sw_client, sw["d"], "delete", f"{base}/{second}").status_code == 403
    # The owner has no share row to remove or demote; the owner can do both to an admin.
    assert _call(sw_client, sw["a"], "patch", f"{base}/{second}",
                 json={"role": "editor"}).status_code == 200
    assert _call(sw_client, sw["d"], "delete", f"{base}/{second}").status_code == 204
    ids = [s["user_id"] for s in _call(sw_client, sw["a"], "get", base).json()["shares"]]
    assert other["id"] not in ids and sw["a"]["id"] not in ids


def test_an_admin_manages_editors_and_viewers(sw, sw_client):
    base = f"/accounts/{sw['joint']}/shares"
    r = _call(sw_client, sw["d"], "patch", f"{base}/{sw['shares']['v']}", json={"role": "editor"})
    assert r.status_code == 200 and r.json()["role"] == "editor"
    assert _call(sw_client, sw["d"], "delete", f"{base}/{sw['shares']['v']}").status_code == 204
    assert _call(sw_client, sw["v"], "get", f"/accounts/{sw['joint']}").status_code == 404


def test_a_share_id_from_another_account_is_not_found(sw, sw_client):
    base = f"/accounts/{sw['a_private']}/shares/{sw['shares']['b']}"
    assert _call(sw_client, sw["a"], "patch", base, json={"role": "viewer"}).status_code == 404
    assert _call(sw_client, sw["a"], "delete", base).status_code == 404


# --- revocation, demotion and leaving ----------------------------------------------------

def _entries(sw, client, who):
    joint = sw_post(client, sw[who], "/budget-entries/", {
        "name": "Joint bill", "entry_type": "expense", "amount": 40,
        "next_occurrence": WHEN, "account_id": sw["joint"]})["id"]
    own = sw_post(client, sw[who], "/budget-entries/", {
        "name": "Own bill", "entry_type": "expense", "amount": 30,
        "next_occurrence": WHEN, "account_id": sw["b_private"]})["id"]
    return joint, own


def _active(db, entry_id):
    from app.models.budget_entry import BudgetEntry

    db.expire_all()
    return db.get(BudgetEntry, entry_id).is_active


def _projected(db, who, name):
    from app.services.forecast import project_running_balance

    db.expire_all()
    result = project_running_balance(db, who["id"], days=120)
    return name in {e["name"] for e in result["events"]}


def test_revocation_deactivates_the_former_sharees_entries(sw, sw_client, sw_db):
    joint, own = _entries(sw, sw_client, "b")
    assert _projected(sw_db, sw["b"], "Joint bill")
    r = _call(sw_client, sw["a"], "delete", f"/accounts/{sw['joint']}/shares/{sw['shares']['b']}")
    assert r.status_code == 204
    assert not _active(sw_db, joint) and _active(sw_db, own)
    assert not _projected(sw_db, sw["b"], "Joint bill")
    assert not _projected(sw_db, sw["a"], "Joint bill")
    assert _projected(sw_db, sw["b"], "Own bill")
    assert _call(sw_client, sw["b"], "get", f"/accounts/{sw['joint']}").status_code == 404


def test_demotion_to_viewer_deactivates_entries_and_keeps_reading(sw, sw_client, sw_db):
    joint, own = _entries(sw, sw_client, "b")
    txn = sw_post(sw_client, sw["b"], "/transactions/", {
        "account_id": sw["joint"], "amount": 12, "transaction_type": "debit",
        "transaction_date": WHEN, "is_posted": False, "description": "Groceries"})["id"]
    r = _call(sw_client, sw["a"], "patch", f"/accounts/{sw['joint']}/shares/{sw['shares']['b']}",
              json={"role": "viewer"})
    assert r.status_code == 200
    assert not _active(sw_db, joint) and _active(sw_db, own)
    assert not _projected(sw_db, sw["b"], "Joint bill")
    body = _call(sw_client, sw["b"], "get", f"/transactions/{txn}").json()
    assert body["view"] == "full" and body["description"] == "Groceries"
    assert body["permissions"]["can_delete"] is True
    assert not any(v for k, v in body["permissions"].items() if k != "can_delete")
    account = _call(sw_client, sw["b"], "get", f"/accounts/{sw['joint']}").json()
    assert account["my_role"] == "viewer"
    assert not any(account["permissions"].values())


def test_editor_to_admin_keeps_entries_active(sw, sw_client, sw_db):
    joint, _ = _entries(sw, sw_client, "b")
    _call(sw_client, sw["a"], "patch", f"/accounts/{sw['joint']}/shares/{sw['shares']['b']}",
          json={"role": "admin"})
    assert _active(sw_db, joint)


def test_leaving_a_received_share(sw, sw_client, sw_db):
    joint, own = _entries(sw, sw_client, "b")
    received = _call(sw_client, sw["b"], "get", "/shares/received").json()
    assert [(s["id"], s["account_name"], s["role"], s["owner_name"]) for s in received] == [
        (sw["shares"]["b"], "Joint account", "editor", "Alice O.")]
    # Someone else's share id is not found, and changes nothing.
    assert _call(sw_client, sw["b"], "delete",
                 f"/shares/received/{sw['shares']['v']}").status_code == 404
    assert _call(sw_client, sw["v"], "get", f"/accounts/{sw['joint']}").status_code == 200
    assert _call(sw_client, sw["b"], "delete",
                 f"/shares/received/{sw['shares']['b']}").status_code == 204
    assert not _active(sw_db, joint) and _active(sw_db, own)
    assert _call(sw_client, sw["b"], "get", f"/accounts/{sw['joint']}").status_code == 404
    assert _call(sw_client, sw["b"], "get", "/shares/received").json() == []
    assert _call(sw_client, None, "delete", f"/shares/received/{sw['shares']['b']}").status_code == 401


# --- the picker --------------------------------------------------------------------------

def test_picker_matches_exactly_and_answers_no_match_uniformly(sw, sw_client, sw_db, demo):
    from app.models.user import User

    b_email = sw["b"]["email"]
    exact = _call(sw_client, sw["a"], "get", "/users/lookup", params={"email": f"  {b_email.upper()} "})
    assert exact.status_code == 200 and exact.json() == {"id": sw["b"]["id"],
                                                         "display_name": "Bea P."}
    sw_db.query(User).filter(User.id == sw["s"]["id"]).update({User.is_active: False})
    sw_db.commit()
    misses = [b_email[:-1], b_email.split("@")[0], "%", "share-%@example.com",
              "nobody@example.com", sw["a"]["email"], sw_db.get(User, sw["s"]["id"]).email,
              demo["email"]]
    answers = [_call(sw_client, sw["a"], "get", "/users/lookup", params={"email": m})
               for m in misses]
    assert {(r.status_code, r.text) for r in answers} == {(404, '{"detail":"No matching user"}')}
    sw_db.query(User).filter(User.id == sw["s"]["id"]).update({User.is_active: True})
    sw_db.commit()


def test_picker_is_rate_limited_per_caller(sw, sw_client):
    from app.routers.shares import LOOKUP_LIMIT

    for _ in range(LOOKUP_LIMIT):
        assert _call(sw_client, sw["a"], "get", "/users/lookup",
                     params={"email": "nobody@example.com"}).status_code == 404
    assert _call(sw_client, sw["a"], "get", "/users/lookup",
                 params={"email": sw["b"]["email"]}).status_code == 429
    # Another caller has their own budget.
    assert _call(sw_client, sw["d"], "get", "/users/lookup",
                 params={"email": sw["b"]["email"]}).status_code == 200


def test_picker_needs_a_login(sw_client):
    assert _call(sw_client, None, "get", "/users/lookup",
                 params={"email": "x@example.com"}).status_code == 401


def test_demo_users_get_403_on_lookup_and_every_share_route(sw, sw_client, demo):
    accounts = _call(sw_client, demo, "get", "/accounts/").json()["items"]
    mine = accounts[0]["id"]
    routes = [
        ("get", "/users/lookup", {"params": {"email": sw["a"]["email"]}}),
        ("get", f"/accounts/{mine}/shares", {}),
        ("post", f"/accounts/{mine}/shares", {"json": {"email": sw["a"]["email"],
                                                       "role": "viewer"}}),
        ("patch", f"/accounts/{mine}/shares/1", {"json": {"role": "viewer"}}),
        ("delete", f"/accounts/{mine}/shares/1", {}),
        ("get", "/shares/received", {}),
        ("delete", "/shares/received/1", {}),
    ]
    for method, path, kw in routes:
        r = _call(sw_client, demo, method, path, **kw)
        assert r.status_code == 403, (method, path, r.status_code)


# --- Sharing by exact email only (audit round 1, F) --------------------------------------

def test_a_share_cannot_be_created_by_user_id(sw, sw_client, sw_people):
    newcomer = sw_people("Nia", "New")
    path = f"/accounts/{sw['a_private']}/shares"
    for body in ({"user_id": newcomer["id"], "role": "viewer"},
                 {"user_id": newcomer["id"], "email": newcomer["email"], "role": "viewer"}):
        r = _call(sw_client, sw["a"], "post", path, json=body)
        assert r.status_code == 422, r.text
    assert _call(sw_client, newcomer, "get", f"/accounts/{sw['a_private']}").status_code == 404
    r = _call(sw_client, sw["a"], "post", path,
              json={"email": f"  {newcomer['email'].upper()} ", "role": "viewer"})
    assert r.status_code == 201, r.text
    assert (r.json()["user_id"], r.json()["display_name"]) == (newcomer["id"], "Nia N.")


def test_share_creation_answers_no_match_uniformly(sw, sw_client, sw_db, demo):
    from app.core.seed import DEMO_PARTNER_EMAIL
    from app.models.user import User

    sw_db.query(User).filter(User.id == sw["s"]["id"]).update({User.is_active: False})
    sw_db.commit()
    path = f"/accounts/{sw['joint']}/shares"
    b_email = sw["b"]["email"]
    misses = [b_email[:-1], b_email.split("@")[0], "%", "share-%@example.com",
              "nobody@example.com", sw_db.get(User, sw["s"]["id"]).email, demo["email"],
              DEMO_PARTNER_EMAIL]
    answers = [_call(sw_client, sw["a"], "post", path, json={"email": m, "role": "viewer"})
               for m in misses]
    assert {(r.status_code, r.text) for r in answers} == {(404, '{"detail":"No matching user"}')}
    sw_db.query(User).filter(User.id == sw["s"]["id"]).update({User.is_active: True})
    sw_db.commit()


def test_share_creation_counts_toward_the_lookup_limit(sw, sw_client, sw_people):
    from app.routers.shares import LOOKUP_LIMIT

    path = f"/accounts/{sw['joint']}/shares"
    newcomer = sw_people("Nia", "New")
    for i in range(LOOKUP_LIMIT - 1):
        assert _call(sw_client, sw["a"], "post", path,
                     json={"email": f"nobody{i}@example.com", "role": "viewer"}
                     ).status_code == 404
    assert _call(sw_client, sw["a"], "get", "/users/lookup",
                 params={"email": "nobody@example.com"}).status_code == 404
    # The limit is spent: a real match is refused too, by lookup and by share.
    assert _call(sw_client, sw["a"], "post", path,
                 json={"email": newcomer["email"], "role": "viewer"}).status_code == 429
    assert _call(sw_client, sw["a"], "get", "/users/lookup",
                 params={"email": newcomer["email"]}).status_code == 429
    # Every POST counts, even one refused before the lookup.
    for _ in range(LOOKUP_LIMIT):
        _call(sw_client, sw["b"], "post", path, json={"email": "x@example.com", "role": "viewer"})
    assert _call(sw_client, sw["b"], "get", "/users/lookup",
                 params={"email": newcomer["email"]}).status_code == 429

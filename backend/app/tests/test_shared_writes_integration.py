"""Shared accounts (STU-232): who may write what.

The write rule: an edit role on every account a record touches, for the
caller and for the record's creator, before and after the change. The
account owner exemption lets the owner of every touched account post, revert
or delete a record whose creator lost access; an unposted record may always be
deleted by its creator and by an owner of any account it touches.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"


def _call(client, who, method, path, body=None):
    headers = who["headers"] if who else {}
    return client.request(method, f"{API}{path}", json=body, headers=headers)


def _debit(client, who, account, amount=100, posted=True, **extra):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": amount, "transaction_type": "debit",
        "description": "Debit", "transaction_date": DAY, "is_posted": posted, **extra})


def _transfer(client, who, frm, to, amount=100, posted=True):
    return sw_post(client, who, "/transactions/", {
        "account_id": frm, "transfer_from_account_id": frm, "transfer_to_account_id": to,
        "amount": amount, "transaction_type": "transfer", "description": "Move",
        "transaction_date": DAY, "is_posted": posted})


def _entry(client, who, account, **extra):
    body = {"name": "Bill", "entry_type": "expense", "amount": 40,
            "next_occurrence": "2026-10-05T00:00:00", "account_id": account, **extra}
    return sw_post(client, who, "/budget-entries/", body)


def _set_role(db, sw, who, role):
    """Demote, promote or (``None``) revoke a share row directly."""
    from app.models.account_share import AccountShare

    share = db.get(AccountShare, sw["shares"][who])
    if role is None:
        db.delete(share)
    else:
        share.role = role
    db.commit()


ROLES = ["a", "d", "b", "v", "s", None]  # owner, admin, editor, viewer, stranger, anonymous
EDITORS = {"a", "d", "b"}


def _expect(who, allowed, ok):
    if who is None:
        return 401
    return ok if who in allowed else 404


# --- Who calls --------------------------------------------------------------------------

@pytest.mark.parametrize("who", ROLES)
def test_who_reads_the_shared_account_and_its_records(sw, sw_client, who):
    txn = _debit(sw_client, sw["a"], sw["joint"])["id"]
    entry = _entry(sw_client, sw["a"], sw["joint"])["id"]
    caller = sw[who] if who else None
    readers = {"a", "d", "b", "v"}
    for path in (f"/accounts/{sw['joint']}", f"/accounts/{sw['joint']}/balance",
                 f"/transactions/{txn}", f"/budget-entries/{entry}"):
        assert _call(sw_client, caller, "GET", path).status_code == _expect(who, readers, 200), path


@pytest.mark.parametrize("who", ROLES)
def test_who_reads_an_unshared_account_and_its_records(sw, sw_client, who):
    txn = _debit(sw_client, sw["a"], sw["a_private"])["id"]
    entry = _entry(sw_client, sw["a"], sw["a_private"])["id"]
    caller = sw[who] if who else None
    for path in (f"/accounts/{sw['a_private']}", f"/accounts/{sw['a_private']}/balance",
                 f"/accounts/{sw['a_loan']}/loan-schedule",
                 f"/transactions/{txn}", f"/budget-entries/{entry}"):
        assert _call(sw_client, caller, "GET", path).status_code == _expect(who, {"a"}, 200), path


@pytest.mark.parametrize("who", ROLES)
def test_who_writes_records_on_the_shared_account(sw, sw_client, who):
    a, joint = sw["a"], sw["joint"]
    caller = sw[who] if who else None
    body = {"account_id": joint, "amount": 5, "transaction_type": "debit",
            "transaction_date": DAY}
    assert _call(sw_client, caller, "POST", "/transactions/", body).status_code == \
        _expect(who, EDITORS, 200)
    txn = _debit(sw_client, a, joint)["id"]
    assert _call(sw_client, caller, "PUT", f"/transactions/{txn}",
                 {"amount": 7}).status_code == _expect(who, EDITORS, 200)
    assert _call(sw_client, caller, "DELETE", f"/transactions/{txn}").status_code == \
        _expect(who, EDITORS, 200)
    entry_body = {"name": "Water", "entry_type": "expense", "amount": 9,
                  "next_occurrence": "2026-10-05T00:00:00", "account_id": joint}
    assert _call(sw_client, caller, "POST", "/budget-entries/", entry_body).status_code == \
        _expect(who, EDITORS, 201)
    entry = _entry(sw_client, a, joint)["id"]
    assert _call(sw_client, caller, "PUT", f"/budget-entries/{entry}",
                 {"amount": 11}).status_code == _expect(who, EDITORS, 200)
    assert _call(sw_client, caller, "POST", f"/budget-entries/{entry}/materialize",
                 {}).status_code == _expect(who, EDITORS, 201)
    assert _call(sw_client, caller, "DELETE", f"/budget-entries/{entry}").status_code == \
        _expect(who, EDITORS, 204)


@pytest.mark.parametrize("who", ROLES)
def test_who_writes_records_on_an_unshared_account(sw, sw_client, who):
    a, private = sw["a"], sw["a_private"]
    caller = sw[who] if who else None
    body = {"account_id": private, "amount": 5, "transaction_type": "debit",
            "transaction_date": DAY}
    assert _call(sw_client, caller, "POST", "/transactions/", body).status_code == \
        _expect(who, {"a"}, 200)
    txn = _debit(sw_client, a, private)["id"]
    entry = _entry(sw_client, a, private)["id"]
    assert _call(sw_client, caller, "PUT", f"/transactions/{txn}",
                 {"amount": 7}).status_code == _expect(who, {"a"}, 200)
    assert _call(sw_client, caller, "PUT", f"/budget-entries/{entry}",
                 {"amount": 7}).status_code == _expect(who, {"a"}, 200)
    assert _call(sw_client, caller, "POST", f"/budget-entries/{entry}/materialize",
                 {}).status_code == _expect(who, {"a"}, 201)
    assert _call(sw_client, caller, "DELETE", f"/transactions/{txn}").status_code == \
        _expect(who, {"a"}, 200)
    assert _call(sw_client, caller, "DELETE", f"/budget-entries/{entry}").status_code == \
        _expect(who, {"a"}, 204)


@pytest.mark.parametrize("who", ROLES)
def test_who_changes_the_shared_account_settings(sw, sw_client, who):
    caller = sw[who] if who else None
    joint = sw["joint"]
    assert _call(sw_client, caller, "PUT", f"/accounts/{joint}",
                 {"name": "Joint renamed"}).status_code == _expect(who, {"a", "d"}, 200)
    # Deactivating (or deleting) the account is its owner's alone.
    assert _call(sw_client, caller, "PUT", f"/accounts/{joint}",
                 {"is_active": False}).status_code == _expect(who, {"a"}, 200)
    assert _call(sw_client, caller, "DELETE", f"/accounts/{joint}").status_code == \
        _expect(who, {"a"}, 200)


@pytest.mark.parametrize("who", ["a", "d", "b", "v", "s"])
def test_tagging_an_account_follows_the_settings_rule(sw, sw_client, who):
    caller = sw[who]
    tag = sw_post(sw_client, caller, "/tags/", {"name": f"Mine {who}"}, expect=(201,))["id"]
    r = _call(sw_client, caller, "PUT", f"/accounts/{sw['joint']}", {"tag_ids": [tag]})
    assert r.status_code == (200 if who in {"a", "d"} else 404)


@pytest.mark.parametrize("who", ["d", "b"])
def test_tagging_a_record_needs_the_write_rule(sw, sw_client, who):
    caller = sw[who]
    tag = sw_post(sw_client, caller, "/tags/", {"name": f"Mine {who}"}, expect=(201,))["id"]
    txn = _debit(sw_client, sw["a"], sw["joint"])["id"]
    assert _call(sw_client, caller, "PUT", f"/transactions/{txn}",
                 {"tag_ids": [tag]}).status_code == 200
    v_tag = sw_post(sw_client, sw["v"], "/tags/", {"name": "Viewer tag"}, expect=(201,))["id"]
    assert _call(sw_client, sw["v"], "PUT", f"/transactions/{txn}",
                 {"tag_ids": [v_tag]}).status_code == 404


# --- Writes involving an account the caller can't edit -----------------------------------

def test_editor_cannot_transfer_from_joint_to_the_owners_private_account(sw, sw_client):
    r = _call(sw_client, sw["b"], "POST", "/transactions/", {
        "account_id": sw["joint"], "transfer_from_account_id": sw["joint"],
        "transfer_to_account_id": sw["a_private"], "amount": 10,
        "transaction_type": "transfer", "transaction_date": DAY})
    assert r.status_code == 404


def test_editor_cannot_pay_the_owners_private_loan_from_joint(sw, sw_client):
    b, joint, loan = sw["b"], sw["joint"], sw["a_loan"]
    r = _call(sw_client, b, "POST", f"/accounts/{loan}/loan-payment",
              {"from_account_id": joint, "amount": 5000, "transaction_date": DAY})
    assert r.status_code == 404
    r = _call(sw_client, b, "POST", "/transactions/", {
        "account_id": joint, "transfer_from_account_id": joint, "transfer_to_account_id": loan,
        "amount": 5000, "transaction_type": "transfer", "transaction_date": DAY})
    assert r.status_code == 404


def test_editor_materialising_the_owners_entry_makes_the_owners_transaction(sw, sw_client, sw_db):
    from app.models.transaction import Transaction

    a, b = sw["a"], sw["b"]
    category = sw_post(sw_client, a, "/categories/", {"name": "Utilities"})["id"]
    tag = sw_post(sw_client, a, "/tags/", {"name": "Bills"}, expect=(201,))["id"]
    entry = _entry(sw_client, a, sw["joint"], category_id=category, tag_ids=[tag])["id"]
    r = _call(sw_client, b, "POST", f"/budget-entries/{entry}/materialize", {})
    assert r.status_code == 201, r.text
    txn = sw_db.get(Transaction, r.json()["id"])
    assert txn.user_id == a["id"]
    assert txn.created_by_actor == b["id"]
    assert txn.category_id == category
    # The owner's tag came with it; the editor sees none of it.
    a_view = _call(sw_client, a, "GET", f"/transactions/{txn.id}").json()
    assert [t["id"] for t in a_view["tags"]] == [tag]
    assert _call(sw_client, b, "GET", f"/transactions/{txn.id}").json()["tags"] == []


def test_editor_cannot_materialise_an_entry_touching_an_account_they_cannot_edit(sw, sw_client):
    a = sw["a"]
    entry = _entry(sw_client, a, sw["joint"], overflow_account_id=sw["a_private"])["id"]
    r = _call(sw_client, sw["b"], "POST", f"/budget-entries/{entry}/materialize", {})
    assert r.status_code == 404
    transfer = _entry(sw_client, a, sw["joint"], transfer_to_account_id=sw["a_private"])["id"]
    r = _call(sw_client, sw["b"], "POST", f"/budget-entries/{transfer}/materialize", {})
    assert r.status_code == 404


def test_materialise_is_refused_once_the_creator_lost_access(sw, sw_client, sw_db):
    entry = _entry(sw_client, sw["b"], sw["joint"])["id"]
    _set_role(sw_db, sw, "b", "viewer")
    r = _call(sw_client, sw["a"], "POST", f"/budget-entries/{entry}/materialize", {})
    assert r.status_code == 404


def test_editor_cannot_move_the_owners_transaction_to_their_private_account(sw, sw_client):
    txn = _debit(sw_client, sw["a"], sw["joint"])["id"]
    r = _call(sw_client, sw["b"], "PUT", f"/transactions/{txn}", {"account_id": sw["b_private"]})
    assert r.status_code == 404
    entry = _entry(sw_client, sw["a"], sw["joint"])["id"]
    r = _call(sw_client, sw["b"], "PUT", f"/budget-entries/{entry}",
              {"account_id": sw["b_private"]})
    assert r.status_code == 404


def test_non_creator_cannot_change_attachments(sw, sw_client):
    txn = _debit(sw_client, sw["a"], sw["joint"], receipt_url="/uploads/receipts/a.png")["id"]
    r = _call(sw_client, sw["b"], "PUT", f"/transactions/{txn}", {"receipt_url": "/x.png"})
    assert r.status_code == 400
    r = _call(sw_client, sw["b"], "PUT", f"/transactions/{txn}", {"invoice_url": "/x.pdf"})
    assert r.status_code == 400
    r = sw_client.post(f"{API}/transactions/{txn}/upload-receipt", headers=sw["b"]["headers"],
                       files={"file": ("r.png", b"x", "image/png")})
    assert r.status_code == 404


def test_non_creator_cannot_set_the_creators_category(sw, sw_client):
    category = sw_post(sw_client, sw["b"], "/categories/",
                       {"name": "Bea food"})["id"]
    txn = _debit(sw_client, sw["a"], sw["joint"])["id"]
    r = _call(sw_client, sw["b"], "PUT", f"/transactions/{txn}", {"category_id": category})
    assert r.status_code == 404


# --- Accountless entries -----------------------------------------------------------------

def test_accountless_entries_are_creator_only(sw, sw_client):
    entry = sw_post(sw_client, sw["a"], "/budget-entries/", {
        "name": "Cash allowance", "entry_type": "expense", "amount": 30,
        "next_occurrence": "2026-10-05T00:00:00"})["id"]
    for who in ("b", "d", "v", "s"):
        caller = sw[who]
        assert _call(sw_client, caller, "GET", f"/budget-entries/{entry}").status_code == 404
        assert _call(sw_client, caller, "PUT", f"/budget-entries/{entry}",
                     {"amount": 1}).status_code == 404
        assert _call(sw_client, caller, "DELETE", f"/budget-entries/{entry}").status_code == 404
    # Nobody else may make a shared entry accountless either.
    shared = _entry(sw_client, sw["b"], sw["joint"])["id"]
    assert _call(sw_client, sw["a"], "PUT", f"/budget-entries/{shared}",
                 {"account_id": None}).status_code == 404
    assert _call(sw_client, sw["a"], "PUT", f"/budget-entries/{entry}",
                 {"amount": 31}).status_code == 200


# --- Demotion and stranded records -------------------------------------------------------

def test_demoted_editor_keeps_reading_but_writes_only_deletes_of_own_unposted(sw, sw_client, sw_db):
    b, joint = sw["b"], sw["joint"]
    pending = _debit(sw_client, b, joint, posted=False)["id"]
    posted = _debit(sw_client, b, joint)["id"]
    owners = _debit(sw_client, sw["a"], joint, posted=False)["id"]
    _set_role(sw_db, sw, "b", "viewer")
    assert _call(sw_client, b, "GET", f"/transactions/{posted}").status_code == 200
    assert _call(sw_client, b, "PUT", f"/transactions/{pending}", {"amount": 1}).status_code == 404
    assert _call(sw_client, b, "PUT", f"/transactions/{pending}",
                 {"is_posted": True}).status_code == 404
    assert _call(sw_client, b, "PUT", f"/transactions/{posted}",
                 {"is_posted": False}).status_code == 404
    assert _call(sw_client, b, "DELETE", f"/transactions/{posted}").status_code == 404
    assert _call(sw_client, b, "DELETE", f"/transactions/{owners}").status_code == 404
    assert _call(sw_client, b, "DELETE", f"/transactions/{pending}").status_code == 200


@pytest.mark.parametrize("change", ["revoke", "demote"])
def test_owner_resolves_a_stranded_record_on_their_own_account(sw, sw_client, sw_db, change):
    """The owner exemption: post, revert or delete, but never edit."""
    a, b, joint = sw["a"], sw["b"], sw["joint"]
    pending = _debit(sw_client, b, joint, posted=False)["id"]
    posted = _debit(sw_client, b, joint)["id"]
    _set_role(sw_db, sw, "b", None if change == "revoke" else "viewer")
    assert _call(sw_client, a, "PUT", f"/transactions/{pending}", {"amount": 1}).status_code == 404
    assert _call(sw_client, a, "PUT", f"/transactions/{pending}",
                 {"is_posted": True}).status_code == 200
    assert _call(sw_client, a, "PUT", f"/transactions/{posted}",
                 {"is_posted": False}).status_code == 200
    assert _call(sw_client, a, "DELETE", f"/transactions/{posted}").status_code == 200
    assert _call(sw_client, a, "DELETE", f"/transactions/{pending}").status_code == 200


@pytest.mark.parametrize("change", ["revoke", "demote"])
@pytest.mark.parametrize("direction", ["into_joint", "out_of_joint"])
def test_stranded_transfers_between_private_and_joint(sw, sw_client, sw_db, change, direction):
    a, b, joint, private = sw["a"], sw["b"], sw["joint"], sw["b_private"]
    frm, to = (private, joint) if direction == "into_joint" else (joint, private)
    pending_b = _transfer(sw_client, b, frm, to, posted=False)["id"]
    pending_a = _transfer(sw_client, b, frm, to, posted=False)["id"]
    posted = _transfer(sw_client, b, frm, to)["id"]
    _set_role(sw_db, sw, "b", None if change == "revoke" else "viewer")

    # Pending: deleted by the creator, and by the joint account's owner.
    assert _call(sw_client, b, "DELETE", f"/transactions/{pending_b}").status_code == 200
    assert _call(sw_client, a, "DELETE", f"/transactions/{pending_a}").status_code == 200
    # Posted: stays; neither can revert or delete it (no one edits both accounts).
    for who in (a, b, sw["d"]):
        assert _call(sw_client, who, "PUT", f"/transactions/{posted}",
                     {"is_posted": False}).status_code == 404
        assert _call(sw_client, who, "DELETE", f"/transactions/{posted}").status_code == 404
    # Someone with edit rights on both accounts can: the creator once re-granted.
    if change == "revoke":
        from app.tests.conftest import sw_share
        sw["shares"]["b"] = sw_share(sw_db, joint, b["id"], "editor", a["id"])
    else:
        _set_role(sw_db, sw, "b", "editor")
    assert _call(sw_client, b, "PUT", f"/transactions/{posted}",
                 {"is_posted": False}).status_code == 200


def test_admin_has_no_owner_exemption(sw, sw_client, sw_db):
    posted = _debit(sw_client, sw["b"], sw["joint"])["id"]
    pending = _debit(sw_client, sw["b"], sw["joint"], posted=False)["id"]
    _set_role(sw_db, sw, "b", None)
    d = sw["d"]
    assert _call(sw_client, d, "PUT", f"/transactions/{posted}",
                 {"is_posted": False}).status_code == 404
    assert _call(sw_client, d, "DELETE", f"/transactions/{posted}").status_code == 404
    assert _call(sw_client, d, "DELETE", f"/transactions/{pending}").status_code == 404


# --- Linking to and deleting another user's recurring entry ------------------------------

def test_linking_needs_the_entry_owner(sw, sw_client):
    a_entry = _entry(sw_client, sw["a"], sw["joint"])["id"]
    b = sw["b"]
    r = _call(sw_client, b, "POST", "/transactions/", {
        "account_id": sw["joint"], "amount": 40, "transaction_type": "debit",
        "transaction_date": DAY, "budget_entry_id": a_entry})
    assert r.status_code == 404
    own = _debit(sw_client, b, sw["joint"])["id"]
    assert _call(sw_client, b, "PUT", f"/transactions/{own}",
                 {"budget_entry_id": a_entry}).status_code == 404
    # The owner's own transaction on the joint account, edited by the editor: still 404,
    # since the editor doesn't own the entry.
    a_txn = _debit(sw_client, sw["a"], sw["joint"])["id"]
    assert _call(sw_client, b, "PUT", f"/transactions/{a_txn}",
                 {"budget_entry_id": a_entry}).status_code == 404
    assert _call(sw_client, sw["a"], "PUT", f"/transactions/{a_txn}",
                 {"budget_entry_id": a_entry}).status_code == 200


def test_editor_deletes_the_owners_entry_with_links_they_can_edit(sw, sw_client, sw_db):
    from app.models.transaction import Transaction

    a, joint = sw["a"], sw["joint"]
    entry = _entry(sw_client, a, joint)["id"]
    linked = _debit(sw_client, a, joint, budget_entry_id=entry)["id"]
    assert _call(sw_client, sw["b"], "DELETE", f"/budget-entries/{entry}").status_code == 204
    sw_db.expire_all()
    assert sw_db.get(Transaction, linked).budget_entry_id is None


def test_deleting_an_entry_never_changes_a_transaction_the_caller_cannot_edit(sw, sw_client, sw_db):
    from app.models.transaction import Transaction

    a, b, joint = sw["a"], sw["b"], sw["joint"]
    entry = _entry(sw_client, a, joint)["id"]
    private = _debit(sw_client, a, sw["a_private"], budget_entry_id=entry)["id"]
    r = _call(sw_client, b, "DELETE", f"/budget-entries/{entry}")
    assert r.status_code == 409
    sw_db.expire_all()
    assert sw_db.get(Transaction, private).budget_entry_id == entry
    # Its creator may: the links are their own.
    assert _call(sw_client, a, "DELETE", f"/budget-entries/{entry}").status_code == 204

    # The joint account's owner deleting the partner's entry linked from the partner's
    # private account is refused the same way.
    b_entry = _entry(sw_client, b, joint)["id"]
    _debit(sw_client, b, sw["b_private"], budget_entry_id=b_entry)
    assert _call(sw_client, a, "DELETE", f"/budget-entries/{b_entry}").status_code == 409


def test_creator_and_owner_delete_a_stranded_entry(sw, sw_client, sw_db):
    a, b, joint = sw["a"], sw["b"], sw["joint"]
    mine = _entry(sw_client, b, joint)["id"]
    theirs = _entry(sw_client, b, joint)["id"]
    _set_role(sw_db, sw, "b", None)
    assert _call(sw_client, b, "PUT", f"/budget-entries/{mine}", {"amount": 1}).status_code == 404
    assert _call(sw_client, b, "DELETE", f"/budget-entries/{mine}").status_code == 204
    assert _call(sw_client, sw["d"], "DELETE", f"/budget-entries/{theirs}").status_code == 404
    assert _call(sw_client, a, "DELETE", f"/budget-entries/{theirs}").status_code == 204

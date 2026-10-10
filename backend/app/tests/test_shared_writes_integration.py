"""Shared accounts (STU-232): who may write what.

The write rule: an edit role on every account a record touches, for the
caller and for the record's creator, before and after the change. The
account owner exemption lets the owner of every touched account post, revert
or delete a record whose creator lost access; an unposted record may always be
deleted by its creator and by an owner of any account it touches.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

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
    assert r.status_code == 400  # only the creator names its category (audit round 1, B)


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
    # The owner's own transaction on the joint account, edited by the editor: refused,
    # since only its creator names its recurring entry (400, audit round 1, B).
    a_txn = _debit(sw_client, sw["a"], sw["joint"])["id"]
    assert _call(sw_client, b, "PUT", f"/transactions/{a_txn}",
                 {"budget_entry_id": a_entry}).status_code == 400
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


# --- The creator's private references (audit round 1, B) ---------------------------------

def _owners_references(client, sw):
    """The owner's posted joint-account debit naming their category, budget and entry."""
    from app.core.time import naive_utc_now

    a, joint = sw["a"], sw["joint"]
    category = sw_post(client, a, "/categories/", {"name": "Owner food"})["id"]
    budget = sw_post(client, a, "/allocations/", {
        "account_id": joint, "name": "Owner budget", "allocation_type": "budget",
        "configuration": {"category_ids": [category]}})["id"]
    entry = _entry(client, a, joint, category_id=category, allocation_id=budget)["id"]
    txn = _debit(client, a, joint, amount=100, category_id=category, allocation_id=budget,
                 budget_entry_id=entry,
                 transaction_date=naive_utc_now().replace(microsecond=0).isoformat())["id"]
    return {"category": category, "budget": budget, "entry": entry, "txn": txn}


def _references_of(db, refs):
    from app.models.allocation import Allocation
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    db.expire_all()
    txn, entry = db.get(Transaction, refs["txn"]), db.get(BudgetEntry, refs["entry"])
    return ((txn.category_id, txn.allocation_id, txn.budget_entry_id, txn.is_recurring),
            (entry.category_id, entry.allocation_id),
            float(db.get(Allocation, refs["budget"]).current_amount or 0))


@pytest.mark.parametrize("who", ["b", "d"])
def test_non_creator_cannot_clear_or_probe_the_creators_references(sw, sw_client, sw_db, who):
    refs = _owners_references(sw_client, sw)
    before = _references_of(sw_db, refs)
    assert before[2] == 100.0  # the posted debit counts against the owner's budget
    caller = sw[who]
    for field, stored in (("category_id", refs["category"]), ("allocation_id", refs["budget"]),
                          ("budget_entry_id", refs["entry"])):
        for value in (None, stored):  # clearing, or guessing the stored id
            r = _call(sw_client, caller, "PUT", f"/transactions/{refs['txn']}", {field: value})
            assert r.status_code == 400, (field, value, r.text)
    for field, stored in (("category_id", refs["category"]), ("allocation_id", refs["budget"])):
        for value in (None, stored):
            r = _call(sw_client, caller, "PUT", f"/budget-entries/{refs['entry']}",
                      {field: value})
            assert r.status_code == 400, (field, value, r.text)
    assert _references_of(sw_db, refs) == before
    # Attachments (audit round 2, 2): refused whatever the value, so a stored URL,
    # the null of none stored and a guess all get the same answer.
    attached = _debit(sw_client, sw["a"], sw["joint"],
                      receipt_url="/uploads/receipts/r.png",
                      invoice_url="/uploads/invoices/i.pdf")["id"]
    answers = set()
    for txn, stored in ((refs["txn"], None), (attached, "stored")):
        for field in ("receipt_url", "invoice_url"):
            current = (None if stored is None else
                       "/uploads/receipts/r.png" if field == "receipt_url"
                       else "/uploads/invoices/i.pdf")
            for value in (current, None, "/uploads/guess.png"):
                r = _call(sw_client, caller, "PUT", f"/transactions/{txn}", {field: value})
                answers.add((r.status_code, r.text))
    assert answers == {(400, '{"detail":"Only the transaction\'s creator can change its '
                             'attachments"}')}, answers
    sw_db.expire_all()
    from app.models.transaction import Transaction
    stored = sw_db.get(Transaction, attached)
    assert (stored.receipt_url, stored.invoice_url) == ("/uploads/receipts/r.png",
                                                        "/uploads/invoices/i.pdf")
    # Fields the editor may change still save.
    assert _call(sw_client, caller, "PUT", f"/transactions/{refs['txn']}",
                 {"description": "Edited"}).status_code == 200
    assert _call(sw_client, caller, "PUT", f"/budget-entries/{refs['entry']}",
                 {"amount": 41}).status_code == 200
    assert _references_of(sw_db, refs) == before


def test_the_creator_still_clears_their_own_references(sw, sw_client, sw_db):
    refs = _owners_references(sw_client, sw)
    a = sw["a"]
    for field in ("category_id", "allocation_id", "budget_entry_id"):
        assert _call(sw_client, a, "PUT", f"/transactions/{refs['txn']}",
                     {field: None}).status_code == 200, field
    for field in ("category_id", "allocation_id"):
        assert _call(sw_client, a, "PUT", f"/budget-entries/{refs['entry']}",
                     {field: None}).status_code == 200, field
    txn_refs, entry_refs, spent = _references_of(sw_db, refs)
    assert txn_refs == (None, None, None, False) and entry_refs == (None, None)
    assert spent == 0.0


# --- Account settings for admins (audit round 1, D) --------------------------------------

def test_an_admin_saves_settings_with_is_active_unchanged_but_cannot_change_it(
        sw, sw_client, sw_db):
    from app.models.account import Account

    d, joint = sw["d"], sw["joint"]
    form = _call(sw_client, d, "GET", f"/accounts/{joint}").json()
    assert form["is_active"] is True
    # The settings form resends every field, is_active included and unchanged.
    r = _call(sw_client, d, "PUT", f"/accounts/{joint}",
              {"name": "Joint renamed", "is_active": True})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Joint renamed"
    assert form["permissions"]["can_delete"] is False
    r = _call(sw_client, d, "PUT", f"/accounts/{joint}", {"name": "Nope", "is_active": False})
    assert r.status_code == 404
    sw_db.expire_all()
    account = sw_db.get(Account, joint)
    assert (account.name, account.is_active) == ("Joint renamed", True)
    # The owner alone may deactivate it, and is told so.
    owner_view = _call(sw_client, sw["a"], "GET", f"/accounts/{joint}").json()
    assert owner_view["permissions"]["can_delete"] is True
    assert _call(sw_client, sw["a"], "PUT", f"/accounts/{joint}",
                 {"is_active": False}).status_code == 200
    # Reactivating is a change too.
    assert _call(sw_client, d, "PUT", f"/accounts/{joint}",
                 {"is_active": True}).status_code == 404


@pytest.mark.parametrize("kind", ["credit", "loan"])
def test_an_admin_saves_settings_with_a_hidden_payer_unchanged(sw, sw_client, sw_db, kind):
    """Audit round 2, 5: a card or loan shared with an admin, paid from the owner's
    private account (one the admin can't use). Resending that stored routing
    saves; routing to it anew, or to an account of the admin's own, is refused;
    routing to the owner's joint account, which the admin manages, saves."""
    from app.models.account import Account

    a, d, private, joint = sw["a"], sw["d"], sw["a_private"], sw["joint"]
    body = {"name": "Shared liability", "account_type": kind, "balance": 0,
            "payment_account_id": private}
    if kind == "credit":
        body.update({"billing_cycle_start": 10, "days_until_due_date": 20,
                     "payment_overflow_account_id": joint})
    else:
        body.update({"balance": -1_000, "loan_kind": "personal", "loan_annual_rate": 10,
                     "loan_term_months": 12, "loan_payment_amount": 100,
                     "loan_first_payment_date": "2026-11-01"})
    shared = sw_post(sw_client, a, "/accounts/", body)["id"]
    other = sw_post(sw_client, a, "/accounts/", {**body, "payment_account_id": joint,
                                                 "name": "Other liability"})["id"]
    for account in (shared, other):
        sw_share(sw_db, account, d["id"], "admin", a["id"])
    d_own = sw_post(sw_client, d, "/accounts/", {
        "name": "Dee bank", "account_type": "checking", "balance": 10})["id"]

    form = _call(sw_client, d, "GET", f"/accounts/{shared}").json()
    assert form["payment_account_id"] == private
    resend = {"name": "Renamed", "payment_account_id": form["payment_account_id"]}
    if kind == "credit":
        resend["payment_overflow_account_id"] = form["payment_overflow_account_id"]
    r = _call(sw_client, d, "PUT", f"/accounts/{shared}", resend)
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["payment_account_id"]) == ("Renamed", private)
    # A changed target is still checked: the hidden account, or the admin's own.
    for target in (private, d_own):
        r = _call(sw_client, d, "PUT", f"/accounts/{other}", {"payment_account_id": target})
        assert r.status_code == 404, (target, r.text)
    sw_db.expire_all()
    assert sw_db.get(Account, other).payment_account_id == joint
    r = _call(sw_client, d, "PUT", f"/accounts/{shared}", {"payment_account_id": joint})
    assert r.status_code == 200, r.text
    sw_db.expire_all()
    assert sw_db.get(Account, shared).payment_account_id == joint


@pytest.mark.parametrize("who,expected", [("a", True), ("d", False), ("b", False), ("v", False)])
def test_only_the_owner_gets_can_delete(sw, sw_client, who, expected):
    body = _call(sw_client, sw[who], "GET", f"/accounts/{sw['joint']}").json()
    assert body["permissions"]["can_delete"] is expected
    listed = {a["id"]: a for a in _call(sw_client, sw[who], "GET", "/accounts/?limit=100").json()[
        "items"]}
    assert listed[sw["joint"]]["permissions"]["can_delete"] is expected


# --- Deleting an entry with the caller's own linked transactions (audit round 1, J) ------

@pytest.mark.parametrize("change", ["revoke", "demote"])
def test_a_creator_who_lost_edit_cannot_unlink_their_own_posted_transaction(
        sw, sw_client, sw_db, change):
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    b, joint = sw["b"], sw["joint"]
    entry = _entry(sw_client, b, joint)["id"]
    posted = _debit(sw_client, b, joint, budget_entry_id=entry)["id"]
    _set_role(sw_db, sw, "b", None if change == "revoke" else "viewer")
    r = _call(sw_client, b, "DELETE", f"/budget-entries/{entry}")
    assert r.status_code == 409, r.text
    sw_db.expire_all()
    assert sw_db.get(BudgetEntry, entry) is not None
    assert sw_db.get(Transaction, posted).budget_entry_id == entry
    # The account's owner, who may edit the stranded row... may not either: its
    # creator lost access, so it is not editable (only post, revert or delete).
    assert _call(sw_client, sw["a"], "DELETE", f"/budget-entries/{entry}").status_code == 409


def test_a_creator_with_edit_rights_still_deletes_an_entry_with_own_links(sw, sw_client, sw_db):
    from app.models.transaction import Transaction

    b, joint = sw["b"], sw["joint"]
    entry = _entry(sw_client, b, joint)["id"]
    posted = _debit(sw_client, b, joint, budget_entry_id=entry)["id"]
    assert _call(sw_client, b, "DELETE", f"/budget-entries/{entry}").status_code == 204
    sw_db.expire_all()
    assert sw_db.get(Transaction, posted).budget_entry_id is None


# --- created_by_actor on every new transaction (audit round 1, L) ------------------------

def test_loan_payments_and_prepayments_record_their_actor(sw, sw_client, sw_db):
    from app.models.transaction import Transaction

    a = sw["a"]
    home = sw_post(sw_client, a, "/accounts/", {
        "name": "Home loan", "account_type": "loan", "loan_kind": "home",
        "balance": -50_000, "loan_annual_rate": 6, "loan_term_months": 120,
        "loan_payment_amount": 600, "loan_first_payment_date": "2026-10-20",
        "payment_account_id": sw["a_private"]})["id"]
    payment = sw_post(sw_client, a, f"/accounts/{home}/loan-payment", {
        "from_account_id": sw["a_private"], "amount": 600, "transaction_date": DAY})["id"]
    prepayment = sw_post(sw_client, a, f"/accounts/{home}/loan-prepayment", {
        "from_account_id": sw["a_private"], "amount": 1_000, "transaction_date": DAY})["id"]
    debit = _debit(sw_client, a, sw["a_private"])["id"]
    sw_db.expire_all()
    for txn_id in (payment, prepayment, debit):
        txn = sw_db.get(Transaction, txn_id)
        assert txn.created_by_actor == a["id"], txn_id

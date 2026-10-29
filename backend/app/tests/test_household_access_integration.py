"""Household tag shares: what a share grants (STU-233, plan §1).

``tag_viewer`` (a Household tag share, kept apart from ``viewer``) lets C see
A's Household-tagged accounts, and read A's records on A's accounts that touch
one of them (b2) or carry A's Household tag explicitly (c). Never another
user's records on A's accounts (the tag-share invariant), never a write.
Uses the ``hh`` world (``conftest.py``): A owner, B editor on A's joint
account, C holding A's and B's Household tag shares.
"""
import re

import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
B_LUNCH, B_DEPOSIT = 66.61, 311.37  # B's amounts on A's joint account: never in C's view


def _call(client, who, method, path, body=None, **kw):
    return client.request(method, f"{API}{path}", json=body, headers=who["headers"], **kw)


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _txn(client, who, account, amount, description, kind="debit", tags=(), **extra):
    body = {"account_id": account, "amount": amount, "transaction_type": kind,
            "description": description, "transaction_date": DAY, "is_posted": True,
            "tag_ids": list(tags), **extra}
    return sw_post(client, who, "/transactions/", body)["id"]


def _transfer(client, who, frm, to, amount, description, tags=()):
    return _txn(client, who, frm, amount, description, kind="transfer", tags=tags,
                transfer_from_account_id=frm, transfer_to_account_id=to)


def _entry(client, who, account, name, tags=(), **extra):
    body = {"name": name, "entry_type": "expense", "amount": 42,
            "next_occurrence": "2026-10-25T00:00:00", "account_id": account,
            "tag_ids": list(tags), **extra}
    return sw_post(client, who, "/budget-entries/", body)["id"]


@pytest.fixture
def leak(hh, sw_client, sw_db):
    """The third-party leak world's records (the ticket's three-user fixture)."""
    client, a, b = sw_client, hh["a"], hh["b"]
    rec = {
        # A's own: on the joint account (b2), on a private account with the
        # explicit Household tag (c), a loan payment from the joint account,
        # untagged private spending, and an accountless Household entry (c).
        "a_joint": _txn(client, a, hh["joint"], 120, "Household groceries"),
        "a_explicit": _txn(client, a, hh["a_private"], 55, "Shared internet",
                           tags=[hh["hh_a"]]),
        "a_loan_payment": _transfer(client, a, hh["joint"], hh["a_loan"], 500, f"{PRIVATE} car"),
        "a_private": _txn(client, a, hh["a_private"], 77, f"{PRIVATE} pharmacy"),
        "a_private_entry": _entry(client, a, hh["a_private"], f"{PRIVATE} gym"),
        "a_hh_entry": _entry(client, a, None, "Household water", tags=[hh["hh_a"]]),
        # B's, on A's joint account, every one tagged with B's Household tag.
        "b_lunch": _txn(client, b, hh["joint"], B_LUNCH, f"{PRIVATE} Bea lunch",
                        tags=[hh["hh_b"]]),
        "b_deposit": _transfer(client, b, hh["b_private"], hh["joint"], B_DEPOSIT,
                               f"{PRIVATE} Bea deposit", tags=[hh["hh_b"]]),
        "b_entry": _entry(client, b, hh["joint"], f"{PRIVATE} Bea bill", tags=[hh["hh_b"]]),
    }
    # B tags A's joint transaction, and (as an admin, then back to editor) the
    # joint account itself, with B's Household tag: neither grants C anything.
    assert _call(client, b, "PUT", f"/transactions/{rec['a_joint']}",
                 {"tag_ids": [hh["hh_b"]]}).status_code == 200
    from app.models.account_share import AccountShare

    share = sw_db.get(AccountShare, hh["b_share"])
    share.role = "admin"
    sw_db.commit()
    assert _call(client, b, "PUT", f"/accounts/{hh['joint']}",
                 {"tag_ids": [hh["hh_b"]]}).status_code == 200
    share.role = "editor"
    sw_db.commit()
    return rec


def _b_ids(rec):
    return [rec["b_lunch"], rec["b_deposit"], rec["b_entry"]]


# A row's own id in a list: ``$[0].id``, ``$.items[0].id``, ``$.balance_history[0].id``.
_OWN_ID = re.compile(r"\$(?:\.[a-z_]+)?\[\d+\]\.id")


_ACCOUNT_REF = re.compile(r".*\.(?:account\.id|counterpart\.id|[a-z_]*account_id)")


def _clean(body, rec, rows=None, accounts=()):
    """Leaks in ``body``; ``rows`` names the table its list rows come from.

    The private ids are transaction and budget-entry ids. A row's own id comes
    from its table's sequence, so one from another table can equal a private id
    by chance: that id is let through. A row of the private ids' own table
    (``rows`` "transactions" or "entries") is still checked, as is every
    reference to any other account and every other field. ``accounts`` are the
    accounts the viewer may see: a reference to one (``account.id``,
    ``account_id``) is that account's id, not a private record's, so it passes too.
    """
    own = {"transactions": [rec["b_lunch"], rec["b_deposit"], rec["a_private"]],
           "entries": [rec["b_entry"], rec["a_private_entry"]]}.get(rows, [])
    leaks = sw_leaks(body, private_ids=_b_ids(rec) + [rec["a_private"], rec["a_private_entry"]],
                     numbers=(B_LUNCH, B_DEPOSIT, 77))
    return [(where, value) for where, value in leaks
            if not (_OWN_ID.fullmatch(where) and value not in own)
            and not (_ACCOUNT_REF.fullmatch(where) and value in accounts)]


def test_the_leak_check_passes_a_rows_own_id_that_equals_a_private_id_and_still_catches_leaks(
        hh, leak, sw_client):
    """Ids from different sequences collide by chance; force it here."""
    c, joint = hh["c"], hh["joint"]
    visible_accounts = (joint, hh["c_private"])
    accounts = _get(sw_client, c, "/accounts/", limit=100)["items"]
    # A private transaction whose id equals the joint account's own id.
    assert _clean(accounts, {**leak, "a_private": joint}, "accounts") == []
    # The same id in a reference, a string or a private-table row is still a leak.
    assert _clean([{"id": 1, "account_id": joint}], {**leak, "a_private": joint}, "accounts")
    assert _clean([{"id": 1, "name": f"{PRIVATE} x"}], leak, "accounts")
    txns = _get(sw_client, c, "/transactions/", limit=100)
    visible = leak["a_joint"]
    assert _clean(txns, {**leak, "b_lunch": visible}, "transactions", visible_accounts)
    assert _clean(txns, {**leak, "b_entry": visible}, "transactions",
                  visible_accounts) == []  # an entry id
    # A visible account's reference passes; a hidden account's id there does not.
    assert _clean(txns, {**leak, "a_private": joint}, "transactions", visible_accounts) == []
    assert _clean({"account": {"id": hh["a_private"]}}, {**leak, "a_private": hh["a_private"]},
                  "transactions", visible_accounts)


# --- Accounts ---------------------------------------------------------------------------

def test_tag_viewer_sees_the_household_account_in_the_minimal_shape(hh, leak, sw_client):
    c = hh["c"]
    accounts = _get(sw_client, c, "/accounts/", limit=100)["items"]
    by_id = {a["id"]: a for a in accounts}
    assert set(by_id) == {hh["joint"], hh["c_private"]}
    joint = by_id[hh["joint"]]
    assert set(joint) == {"id", "name", "account_type", "currency", "balance", "my_role",
                          "permissions", "owner_name", "tags"}
    assert joint["my_role"] == "tag_viewer" and joint["owner_name"] == "Alice O."
    assert not any(joint["permissions"].values())
    assert _get(sw_client, c, f"/accounts/{hh['joint']}") == joint
    for hidden in ("a_private", "a_card", "a_loan", "a_wallet", "b_private"):
        assert _call(sw_client, c, "GET", f"/accounts/{hh[hidden]}").status_code == 404, hidden
    assert _clean(accounts, leak, "accounts") == []


def test_an_account_share_viewer_holding_the_tag_share_gets_the_higher_role(hh, leak, sw_client,
                                                                             sw_db):
    c = hh["c"]
    sw_share(sw_db, hh["joint"], c["id"], "viewer", hh["a"]["id"])
    joint = _get(sw_client, c, f"/accounts/{hh['joint']}")
    assert joint["my_role"] == "viewer"  # the account share's provenance
    assert "is_active" in joint and "billing_cycle_start" in joint
    # As a direct viewer C reads everyone's records on the account (rule b).
    ids = {t["id"] for t in _get(sw_client, c, "/transactions/", limit=100)["items"]}
    assert {leak["b_lunch"], leak["b_deposit"], leak["a_joint"]} <= ids


def test_a_tag_anyone_but_the_owner_put_on_the_account_grants_nothing(hh, leak, sw_client):
    """B's Household tag stays on A's joint account; A's removal ends C's role."""
    a, c = hh["a"], hh["c"]
    assert _call(sw_client, a, "PUT", f"/accounts/{hh['joint']}",
                 {"tag_ids": []}).status_code == 200
    assert _call(sw_client, c, "GET", f"/accounts/{hh['joint']}").status_code == 404
    assert _call(sw_client, c, "GET", f"/transactions/{leak['a_joint']}").status_code == 404
    # The explicitly tagged record still reads under (c).
    assert _call(sw_client, c, "GET", f"/transactions/{leak['a_explicit']}").status_code == 200


# --- Records: the tag-share invariant ----------------------------------------------------

def test_third_party_records_never_reach_the_tag_viewer(hh, leak, sw_client):
    c = hh["c"]
    txns = _get(sw_client, c, "/transactions/", limit=100)
    assert {t["id"] for t in txns["items"]} == {
        leak["a_joint"], leak["a_explicit"], leak["a_loan_payment"]}
    assert txns["total"] == 3
    entries = _get(sw_client, c, "/budget-entries/", limit=100)
    assert {e["id"] for e in entries["items"]} == {leak["a_hh_entry"]}
    for kind, key in (("transactions", "b_lunch"), ("transactions", "b_deposit"),
                      ("budget-entries", "b_entry"), ("transactions", "a_private"),
                      ("budget-entries", "a_private_entry")):
        assert _call(sw_client, c, "GET", f"/{kind}/{leak[key]}").status_code == 404, key
    assert _clean(txns, leak, "transactions", (hh["joint"], hh["c_private"])) == []
    assert _clean(entries, leak, "entries", (hh["joint"], hh["c_private"])) == []


def test_search_history_and_summary_follow_the_invariant(hh, leak, sw_client):
    c = hh["c"]
    for term in ("Bea", "lunch", "deposit", "pharmacy", PRIVATE):
        assert _get(sw_client, c, "/transactions/", search=term)["items"] == [], term
    found = _get(sw_client, c, "/transactions/", search="groceries")["items"]
    assert [t["id"] for t in found] == [leak["a_joint"]]

    history = _get(sw_client, c, f"/accounts/{hh['joint']}/balance")
    assert [round(h["amount"], 2) for h in history["balance_history"]] == [-120.0, -500.0]
    assert [round(h["balance_after"], 2) for h in history["balance_history"]] == [-120.0, -620.0]
    assert round(history["calculated_balance"], 2) == -620.0
    assert _clean(history, leak, "transactions", (hh["joint"], hh["c_private"])) == []

    summary = _get(sw_client, c, "/transactions/summary/period",
                   start_date="2026-09-01T00:00:00", end_date="2026-10-31T00:00:00")
    assert summary["summary"]["transaction_count"] == 2
    assert _clean(summary, leak, None, (hh["joint"], hh["c_private"])) == []
    # A direct reader of the account (B, the editor) still gets every row.
    b_history = _get(sw_client, hh["b"], f"/accounts/{hh['joint']}/balance")
    assert len(b_history["balance_history"]) == 4


def test_non_household_records_on_private_accounts_are_invisible(hh, leak, sw_client):
    c = hh["c"]
    assert _call(sw_client, c, "GET", f"/transactions/{leak['a_private']}").status_code == 404
    ids = {t["id"] for t in _get(sw_client, c, "/transactions/", limit=100,
                                 account_ids=[hh["a_private"]])["items"]}
    assert ids == set()  # a hidden account id filters to nothing


def test_the_loan_payment_from_the_household_account_is_a_neutral_loan_payment(hh, leak,
                                                                               sw_client):
    """Effective tags (the joint account's) never drive the description: "Loan payment"."""
    body = _get(sw_client, hh["c"], f"/transactions/{leak['a_loan_payment']}")
    assert body["view"] == "limited"
    assert body["display_description"] == "Loan payment"
    assert body["account"] == {"id": hh["joint"], "name": "Joint account"}
    assert body["counterpart"] == {"id": None, "name": "Loan payment"}
    assert body["transfer_fee"] is None
    assert sw_leaks(body) == []


def test_tagging_a_private_card_household_exposes_only_the_owners_transactions(hh, sw_client,
                                                                                sw_db):
    """Pinned (plan §5): the owner's own transactions on it, never anyone else's."""
    a, b, c = hh["a"], hh["b"], hh["c"]
    sw_share(sw_db, hh["a_card"], b["id"], "editor", a["id"])
    mine = _txn(sw_client, a, hh["a_card"], 45, "Card groceries")
    theirs = _txn(sw_client, b, hh["a_card"], B_LUNCH, f"{PRIVATE} Bea card")
    assert _call(sw_client, c, "GET", f"/transactions/{mine}").status_code == 404
    assert _call(sw_client, a, "PUT", f"/accounts/{hh['a_card']}",
                 {"tag_ids": [hh["hh_a"]]}).status_code == 200
    card = _get(sw_client, c, f"/accounts/{hh['a_card']}")
    assert card["my_role"] == "tag_viewer" and "credit_limit" not in card
    assert _get(sw_client, c, f"/transactions/{mine}")["display_description"] == "Card groceries"
    assert _call(sw_client, c, "GET", f"/transactions/{theirs}").status_code == 404
    ids = {t["id"] for t in _get(sw_client, c, "/transactions/", limit=100)["items"]}
    assert mine in ids and theirs not in ids
    # Statements and the card's settings stay closed to a tag viewer.
    assert _call(sw_client, c, "GET", f"/accounts/{hh['a_card']}/statements").status_code == 404


# --- Never a write -----------------------------------------------------------------------

def test_the_tag_share_is_read_only_on_every_write_route(hh, leak, sw_client):
    a, c = hh["a"], hh["c"]
    joint, txn = hh["joint"], leak["a_joint"]
    entry = _entry(sw_client, a, joint, "Household power")
    unposted = _txn(sw_client, a, joint, 9, "Pending", is_posted=False)
    c_tag = sw_post(sw_client, c, "/tags/", {"name": "Mine"}, expect=(201,))["id"]
    listed = {t["id"]: t for t in _get(sw_client, c, "/transactions/", limit=100)["items"]}
    for t in (txn, unposted, leak["a_explicit"], leak["a_loan_payment"]):
        assert not any(listed[t]["permissions"].values()), t
    entries = {e["id"]: e for e in _get(sw_client, c, "/budget-entries/", limit=100)["items"]}
    for e in (entry, leak["a_hh_entry"]):
        assert not any(entries[e]["permissions"].values()), e

    debit = {"account_id": joint, "amount": 5, "transaction_type": "debit",
             "transaction_date": DAY}
    calls = [
        ("POST", "/transactions/", debit),
        ("POST", "/transactions/", {**debit, "account_id": hh["c_private"],
                                    "transaction_type": "transfer",
                                    "transfer_from_account_id": hh["c_private"],
                                    "transfer_to_account_id": joint}),
        ("PUT", f"/transactions/{txn}", {"amount": 7}),
        ("PUT", f"/transactions/{txn}", {"is_posted": False}),          # revert
        ("PUT", f"/transactions/{unposted}", {"is_posted": True}),      # post
        ("PUT", f"/transactions/{txn}", {"tag_ids": [c_tag]}),          # tag
        ("PUT", f"/transactions/{leak['a_explicit']}", {"tag_ids": [c_tag]}),
        ("DELETE", f"/transactions/{unposted}", None),
        ("DELETE", f"/transactions/{txn}", None),
        ("POST", "/budget-entries/", {"name": "x", "entry_type": "expense", "amount": 1,
                                      "next_occurrence": DAY, "account_id": joint}),
        ("PUT", f"/budget-entries/{entry}", {"amount": 1}),
        ("PUT", f"/budget-entries/{leak['a_hh_entry']}", {"amount": 1}),
        ("POST", f"/budget-entries/{entry}/materialize", {}),
        ("POST", f"/budget-entries/{leak['a_hh_entry']}/materialize", {}),
        ("DELETE", f"/budget-entries/{entry}", None),
        ("DELETE", f"/budget-entries/{leak['a_hh_entry']}", None),
        ("PUT", f"/accounts/{joint}", {"name": "Renamed"}),
        ("PUT", f"/accounts/{joint}", {"tag_ids": [c_tag]}),
        ("DELETE", f"/accounts/{joint}", None),
        ("GET", f"/accounts/{joint}/shares", None),
        ("POST", f"/accounts/{joint}/shares", {"email": hh["b"]["email"], "role": "viewer"}),
        ("DELETE", f"/accounts/{joint}/shares/{hh['b_share']}", None),
    ]
    for method, path, body in calls:
        r = _call(sw_client, c, method, path, body)
        assert r.status_code == 404, (method, path, r.status_code, r.text)
    # Nothing changed.
    assert _get(sw_client, a, f"/transactions/{txn}")["amount"] == 120
    assert _get(sw_client, a, f"/transactions/{unposted}")["is_posted"] is False
    assert _get(sw_client, a, f"/accounts/{joint}")["name"] == "Joint account"
    assert _get(sw_client, a, f"/budget-entries/{entry}")["amount"] == 42


# --- Revoke and leave ----------------------------------------------------------------------

@pytest.mark.parametrize("how", ["revoke", "leave"])
def test_revoking_or_leaving_the_share_ends_access(hh, leak, sw_client, how):
    a, c = hh["a"], hh["c"]
    if how == "revoke":
        r = _call(sw_client, a, "DELETE", f"/tags/household/shares/{hh['a_to_c']}")
    else:
        r = _call(sw_client, c, "DELETE", f"/shares/received/household/{hh['a_to_c']}")
    assert r.status_code == 204
    assert _call(sw_client, c, "GET", f"/accounts/{hh['joint']}").status_code == 404
    for kind, key in (("transactions", "a_joint"), ("transactions", "a_explicit"),
                      ("budget-entries", "a_hh_entry")):
        assert _call(sw_client, c, "GET", f"/{kind}/{leak[key]}").status_code == 404, key
    assert _get(sw_client, c, "/transactions/")["items"] == []
    assert _get(sw_client, c, "/budget-entries/")["items"] == []
    assert [x["id"] for x in _get(sw_client, c, "/accounts/")["items"]] == [hh["c_private"]]

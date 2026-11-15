"""Household viewer follow-ups from the T5 audit (STU-253).

Uses the ``hh`` world (``conftest.py``): A owner, B editor on A's joint
account, C holding A's and B's Household tag shares (``tag_viewer`` on A's
Household-tagged accounts).
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _call(client, who, method, path, body=None, **kw):
    return client.request(method, f"{API}{path}", json=body, headers=who["headers"], **kw)


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


# --- Part 1: the details permission --------------------------------------------------------

def test_can_view_details_by_role(hh, sw_client, sw_db, sw_people):
    """AC1: true for owner, admin, editor and viewer; false for a tag viewer."""
    admin, viewer = sw_people("Ada", "Admin"), sw_people("Vic", "Viewer")
    sw_share(sw_db, hh["joint"], admin["id"], "admin", hh["a"]["id"])
    sw_share(sw_db, hh["joint"], viewer["id"], "viewer", hh["a"]["id"])
    for who, role in ((hh["a"], "owner"), (admin, "admin"), (hh["b"], "editor"),
                      (viewer, "viewer"), (hh["c"], "tag_viewer")):
        one = _get(sw_client, who, f"/accounts/{hh['joint']}")
        [listed] = [a for a in _get(sw_client, who, "/accounts/", limit=100)["items"]
                    if a["id"] == hh["joint"]]
        for body in (one, listed):
            assert body["my_role"] == role
            assert body["permissions"]["can_view_details"] is (role != "tag_viewer"), role


# --- Part 7: an inactive tag-viewer account is hidden everywhere the list hides it ---------

@pytest.fixture
def inactive_household(hh, sw_client, sw_db):
    """A's second Household-tagged bank account, with one of A's records, deactivated
    (written directly: the deactivation rules are tested on their own)."""
    from app.models.account import Account

    account = sw_post(sw_client, hh["a"], "/accounts/", {
        "name": "Old joint", "account_type": "checking", "balance": 0, "tag_ids": [hh["hh_a"]]})["id"]
    sw_post(sw_client, hh["a"], "/transactions/", {
        "account_id": account, "amount": 12, "transaction_type": "debit", "description": "Old",
        "transaction_date": "2026-10-01T00:00:00", "is_posted": True})
    # Active, the tag viewer reaches it everywhere.
    assert _call(sw_client, hh["c"], "GET", f"/accounts/{account}").status_code == 200
    sw_db.query(Account).filter(Account.id == account).update({"is_active": False})
    sw_db.commit()
    listed = {a["id"] for a in _get(sw_client, hh["c"], "/accounts/", limit=100)["items"]}
    assert account not in listed and hh["joint"] in listed
    return account


def test_inactive_tag_viewer_hidden_get(hh, inactive_household, sw_client):
    """AC4: ``GET /accounts/{id}`` is a 404, as the list leaves it out; the owner keeps it."""
    assert _call(sw_client, hh["c"], "GET", f"/accounts/{inactive_household}").status_code == 404
    assert _get(sw_client, hh["a"], f"/accounts/{inactive_household}")["is_active"] is False
    assert _get(sw_client, hh["c"], f"/accounts/{hh['joint']}")["my_role"] == "tag_viewer"


def test_inactive_tag_viewer_hidden_balance(hh, inactive_household, sw_client):
    """AC4: ``GET /accounts/{id}/balance`` is a 404 too."""
    path = f"/accounts/{inactive_household}/balance"
    assert _call(sw_client, hh["c"], "GET", path).status_code == 404
    assert _get(sw_client, hh["a"], path)["calculated_balance"] == -12
    assert _call(sw_client, hh["c"], "GET", f"/accounts/{hh['joint']}/balance").status_code == 200


def test_inactive_tag_viewer_hidden_export(hh, inactive_household, sw_client):
    """AC4: the export's ``shared_accounts`` leaves it out, in JSON and CSV."""
    body = _get(sw_client, hh["c"], "/data/export.json")
    ids = {a["id"] for a in body["shared_accounts"]}
    assert inactive_household not in ids and hh["joint"] in ids
    r = sw_client.get(f"{API}/data/export.csv", headers=hh["c"]["headers"],
                      params={"table": "shared_accounts"})
    assert r.status_code == 200
    assert "Old joint" not in r.text and "Joint account" in r.text


# --- Part 6: a tag viewer's account is plain cash in their projection ---------------------

def _projection(client, who):
    """Every figure the caller's available cash and projection reach."""
    snapshot = _get(client, who, "/dashboard/snapshot")
    return {
        "snapshot": {k: snapshot[k] for k in (
            "balances", "available_cash", "upcoming_this_month", "monthly_summary",
            "forecast_next_3_months", "account_closings", "payables")},
        "cashflow": _get(client, who, "/forecast/cashflow"),
        "timeline": _get(client, who, "/forecast/timeline"),
        "upcoming": _get(client, who, "/forecast/upcoming"),
        "disposable": _get(client, who, "/forecast/disposable"),
    }


def _set_wallet(db, account_id, flag):
    from app.models.account import Account

    db.query(Account).filter(Account.id == account_id).update({"is_spending_wallet": flag})
    db.commit()


def test_tag_viewer_wallet_flag_not_inferable(hh, sw_client, sw_db):
    """AC5: toggling a tag-viewer account's ``is_spending_wallet`` moves nothing C sees."""
    from datetime import date, timedelta

    a, c = hh["a"], hh["c"]
    wallet = hh["a_wallet"]  # A's spending wallet, balance 800
    r = sw_client.put(f"{API}/accounts/{wallet}", headers=a["headers"],
                      json={"tag_ids": [hh["hh_a"]]})
    assert r.status_code == 200, r.text
    soon = (date.today() + timedelta(days=5)).isoformat() + "T00:00:00"
    # A's own records, read by C through the share (b2): a top-up from the joint
    # account, spending from the wallet, and a recurring expense funded from it.
    sw_post(sw_client, a, "/transactions/", {
        "account_id": hh["joint"], "transfer_from_account_id": hh["joint"],
        "transfer_to_account_id": wallet, "amount": 300, "transaction_type": "transfer",
        "description": "Top-up", "transaction_date": soon, "is_posted": False})
    sw_post(sw_client, a, "/transactions/", {
        "account_id": wallet, "amount": 45, "transaction_type": "debit",
        "description": "Snacks", "transaction_date": soon, "is_posted": False})
    sw_post(sw_client, a, "/budget-entries/", {
        "name": "Market", "entry_type": "expense", "amount": 70, "cadence": "monthly",
        "next_occurrence": soon, "account_id": wallet})
    on = _projection(sw_client, c)
    assert any(row["id"] == wallet for row in on["snapshot"]["balances"]["by_account"])
    _set_wallet(sw_db, wallet, False)
    off = _projection(sw_client, c)
    for key in on:
        assert on[key] == off[key], key
    # Plain cash: the wallet's balance is in C's available cash.
    assert off["snapshot"]["available_cash"] == 10_000 + 800 + 2_000
    # The owner, who sees the setting, still projects it as a wallet.
    _set_wallet(sw_db, wallet, True)
    assert _get(sw_client, a, "/dashboard/snapshot")["available_cash"] == 10_000 + 5_000


def _tag(client, hh, account):
    r = client.put(f"{API}/accounts/{account}", headers=hh["a"]["headers"],
                   json={"tag_ids": [hh["hh_a"]]})
    assert r.status_code == 200, r.text


def _debit(client, who, account, amount, description, when="2026-10-01T00:00:00"):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": amount, "transaction_type": "debit",
        "description": description, "transaction_date": when, "is_posted": True})["id"]

# --- Part 4: a tag-viewer card paid from a hidden account is never "Card payment 0" -------

def test_tag_viewer_card_event_not_zero(hh, sw_client, sw_db):
    """AC3: the card's statement event, with its payment account hidden from C, shows
    the Limited statement figure (or is left out), never a face of 0."""
    from datetime import datetime

    from app.tests.projection_lists import payable_rows, upcoming_rows

    a, c = hh["a"], hh["c"]
    _tag(sw_client, hh, hh["a_card"])  # paid from A's private bank, which C can't view
    _debit(sw_client, a, hh["a_card"], 100, "Household internet", when="2026-10-12T00:00:00")
    sw_db.expire_all()
    ref = datetime(2026, 10, 10)
    rows = [r for r in [*upcoming_rows(sw_db, c["id"], days=60, reference=ref),
                        *payable_rows(sw_db, c["id"], days=60, reference=ref)]
            if r.get("kind") == "card_payment"]
    assert rows, "the statement event is listed"
    for row in rows:
        assert row["view"] == "limited" and row["cash_delta"] == 0
        assert row["face_amount"] == 100, row
    # The approved Limited statement shows the same figure for that statement.
    statements = _get(sw_client, c, f"/accounts/{hh['a_card']}/statements")["statements"]
    assert 100 in [s["amount_due"] for s in statements]


# --- Part 2: the Limited statement and loan schedule for a tag viewer ---------------------

# The approved Limited shapes (the viewer's, ``GET /accounts/{id}/statements`` and
# ``/loan-schedule``): a tag viewer gets nothing beyond them.
LIMITED_STATEMENTS = {"view", "name", "currency", "statements"}
LIMITED_STATEMENT = {"close_date", "due_date", "amount_due", "currency", "status", "lines"}
LIMITED_LINE = {"date", "display_description", "amount"}
LIMITED_SCHEDULE = {"view", "name", "currency", "owed", "next_due_date", "payments_left", "rows"}
LIMITED_ROW = {"due_date", "amount", "status"}
B_CHARGE, B_PAYMENT = 66.61, 311.37  # B's records on A's accounts: never in C's lines or rows


def _pay(client, who, frm, to, amount, description):
    return sw_post(client, who, "/transactions/", {
        "account_id": frm, "transfer_from_account_id": frm, "transfer_to_account_id": to,
        "amount": amount, "transaction_type": "transfer", "description": description,
        "transaction_date": "2026-10-01T00:00:00", "is_posted": True})["id"]


def test_tag_viewer_statements_limited_shape(hh, sw_client, sw_db, sw_people):
    a, b, c = hh["a"], hh["b"], hh["c"]
    viewer = sw_people("Vic", "Viewer")
    sw_share(sw_db, hh["a_card"], viewer["id"], "viewer", a["id"])
    sw_share(sw_db, hh["a_card"], b["id"], "editor", a["id"])
    _tag(sw_client, hh, hh["a_card"])
    _debit(sw_client, a, hh["a_card"], 45, "Card groceries")
    _debit(sw_client, b, hh["a_card"], B_CHARGE, "Bea lunch")
    path = f"/accounts/{hh['a_card']}/statements"
    body = _get(sw_client, c, path)
    approved = _get(sw_client, viewer, path)
    assert body["view"] == approved["view"] == "limited"
    assert set(body) == set(approved) == LIMITED_STATEMENTS
    assert body["statements"], body
    lines = []
    for statement in body["statements"]:
        assert set(statement) - {"incomplete"} == LIMITED_STATEMENT, statement
        for line in statement["lines"]:
            assert set(line) == LIMITED_LINE, line
            lines.append(line)
    # The sharer's own charge only (the tag-share invariant); the amount due is the
    # whole statement's, B's charge included (README, Household).
    assert [(line["amount"], line["display_description"]) for line in lines] == [
        (45, "Card groceries")]
    assert sum(s["amount_due"] for s in body["statements"]) == pytest.approx(45 + B_CHARGE)
    for statement in approved["statements"]:
        assert set(statement) - {"incomplete"} == LIMITED_STATEMENT
        assert all(set(line) == LIMITED_LINE for line in statement["lines"])


def test_tag_viewer_loan_schedule_limited_shape(hh, sw_client, sw_db, sw_people):
    a, b, c = hh["a"], hh["b"], hh["c"]
    viewer = sw_people("Vic", "Viewer")
    sw_share(sw_db, hh["a_loan"], viewer["id"], "viewer", a["id"])
    sw_share(sw_db, hh["a_loan"], b["id"], "editor", a["id"])
    _tag(sw_client, hh, hh["a_loan"])
    _pay(sw_client, a, hh["a_private"], hh["a_loan"], 1_000, "Loan payment A")
    _pay(sw_client, b, hh["b_private"], hh["a_loan"], B_PAYMENT, "Loan payment B")
    path = f"/accounts/{hh['a_loan']}/loan-schedule"
    body = _get(sw_client, c, path)
    approved = _get(sw_client, viewer, path)
    assert body["view"] == approved["view"] == "limited"
    assert set(body) == set(approved) == LIMITED_SCHEDULE
    assert all(set(row) == LIMITED_ROW for row in [*body["rows"], *approved["rows"]])
    paid = [row["amount"] for row in body["rows"] if row["status"] == "paid"]
    assert paid == [1_000]
    assert sorted(r["amount"] for r in approved["rows"] if r["status"] == "paid") == [
        B_PAYMENT, 1_000]
    assert body["owed"] == approved["owed"]
    assert [r for r in body["rows"] if r["status"] == "open"] == [
        r for r in approved["rows"] if r["status"] == "open"]
    # A card the share does not reach (untagged) stays a 404.
    assert _call(sw_client, c, "GET", f"/accounts/{hh['a_card']}/statements").status_code == 404


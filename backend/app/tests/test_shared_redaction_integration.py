"""Shared accounts (STU-232): what each caller is shown.

Full for the creator, SharedFull for another editor or admin, Limited for
everyone else, with exact allowlists. Every private value of the owner's
carries the ``PRIVATE`` sentinel, and ``sw_leaks`` walks whole response
bodies for it, for private ids and for a hidden loan's interest.
"""
import pytest

from app.tests.conftest import API, PRIVATE, sw_db_reachable, sw_leaks, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
INTEREST = 777.77  # the owner's private loan interest: never shown to anyone else

PERMISSION_KEYS = {"can_edit", "can_delete", "can_post", "can_revert", "can_tag"}
LIMITED_TRANSACTION_KEYS = {
    "view", "permissions", "tags", "created_by", "id", "date", "display_description", "amount",
    "transfer_fee", "currency", "transaction_type", "is_posted", "category_name", "account",
    "counterpart",
}
LIMITED_ENTRY_KEYS = {
    "view", "permissions", "tags", "created_by", "id", "display_name", "amount", "currency",
    "entry_type", "cadence", "next_occurrence", "end_date", "category_name", "account",
    "counterpart",
}
LIMITED_BALANCE_KEYS = {"view", "date", "amount", "balance_after", "display_description"}
LIMITED_SCHEDULE_KEYS = {"view", "name", "currency", "owed", "next_due_date", "payments_left",
                         "rows"}
LIMITED_STATEMENT_KEYS = {"close_date", "due_date", "amount_due", "currency", "status", "lines"}
OWNER_PRIVATE = {"category_id", "allocation_id", "budget_entry_id", "receipt_url", "invoice_url"}


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


def _put(client, who, path, body, expect=200):
    r = client.put(f"{API}{path}", headers=who["headers"], json=body)
    assert r.status_code == expect, (path, r.status_code, r.text)
    return r.json()


@pytest.fixture
def house(sw, sw_client, sw_db):
    """The owner's records: shared ones with plain names, private ones with sentinels."""
    c, a = sw_client, sw["a"]
    joint, private, loan = sw["joint"], sw["a_private"], sw["a_loan"]
    groceries = sw_post(c, a, "/categories/", {"name": "Groceries"})["id"]
    secret_cat = sw_post(c, a, "/categories/", {"name": f"{PRIVATE} therapy"})["id"]
    goal = sw_post(c, a, "/allocations/", {
        "account_id": private, "name": f"{PRIVATE} goal", "allocation_type": "goal",
        "target_amount": 1000})["id"]
    secret_tag = sw_post(c, a, "/tags/", {"name": f"{PRIVATE} tag"}, expect=(201,))["id"]
    joint_entry = sw_post(c, a, "/budget-entries/", {
        "name": "Electricity", "entry_type": "expense", "amount": 75,
        "next_occurrence": "2026-10-20T00:00:00", "account_id": joint,
        "category_id": groceries, "tag_ids": [secret_tag]})["id"]
    joint_txn = sw_post(c, a, "/transactions/", {
        "account_id": joint, "amount": 120, "transaction_type": "debit",
        "description": "Weekly groceries", "transaction_date": DAY,
        "category_id": groceries, "allocation_id": goal, "budget_entry_id": joint_entry,
        "receipt_url": f"/uploads/receipts/{PRIVATE}.png",
        "invoice_url": f"/uploads/invoices/{PRIVATE}.pdf", "tag_ids": [secret_tag]})["id"]
    private_txn = sw_post(c, a, "/transactions/", {
        "account_id": private, "amount": 55, "transaction_type": "debit",
        "description": f"{PRIVATE} pharmacy", "transaction_date": DAY,
        "category_id": secret_cat})["id"]
    deposit = sw_post(c, a, "/transactions/", {
        "account_id": private, "transfer_from_account_id": private,
        "transfer_to_account_id": joint, "amount": 500, "transaction_type": "transfer",
        "description": f"{PRIVATE} top-up", "transaction_date": DAY,
        "category_id": secret_cat})["id"]
    loan_payment = sw_post(c, a, "/transactions/", {
        "account_id": joint, "transfer_from_account_id": joint, "transfer_to_account_id": loan,
        "amount": 4000, "transfer_fee": INTEREST, "transaction_type": "transfer",
        "description": f"{PRIVATE} car loan", "transaction_date": DAY})["id"]
    overflow_entry = sw_post(c, a, "/budget-entries/", {
        "name": f"{PRIVATE} insurance", "entry_type": "expense", "amount": 60,
        "next_occurrence": "2026-10-21T00:00:00", "account_id": joint,
        "overflow_account_id": private, "category_id": secret_cat})["id"]
    private_entry = sw_post(c, a, "/budget-entries/", {
        "name": f"{PRIVATE} gym", "entry_type": "expense", "amount": 50,
        "next_occurrence": "2026-10-22T00:00:00", "account_id": private})["id"]
    # A shared card paid from the owner's private account, and a shared loan.
    card = sw_post(c, a, "/accounts/", {
        "name": "Shared card", "account_type": "credit", "balance": 0,
        "billing_cycle_start": 10, "days_until_due_date": 20, "payment_account_id": private,
        "credit_limit": 99_999, "description": f"{PRIVATE} card notes"})["id"]
    sw_post(c, a, "/transactions/", {
        "account_id": card, "amount": 300, "transaction_type": "debit",
        "description": "Card groceries", "transaction_date": "2026-09-05T00:00:00"})
    sw_post(c, a, "/transactions/", {
        "account_id": card, "transfer_from_account_id": card, "transfer_to_account_id": private,
        "amount": 200, "transfer_fee": 5, "transaction_type": "transfer",
        "description": f"{PRIVATE} cash advance", "transaction_date": "2026-09-06T00:00:00"})
    shared_loan = sw_post(c, a, "/accounts/", {
        "name": "Shared loan", "account_type": "loan", "loan_kind": "personal",
        "balance": -12_000, "loan_annual_rate": 9.75, "loan_term_months": 12,
        "loan_payment_amount": 1_050, "loan_first_payment_date": "2026-10-15",
        "payment_account_id": private, "description": f"{PRIVATE} loan notes"})["id"]
    sw_post(c, a, f"/accounts/{shared_loan}/loan-payment", {
        "from_account_id": private, "amount": 1_050, "transaction_date": "2026-09-15T00:00:00"})
    for who, role in (("b", "editor"), ("v", "viewer"), ("d", "admin")):
        sw_share(sw_db, card, sw[who]["id"], role, a["id"])
        sw_share(sw_db, shared_loan, sw[who]["id"], role, a["id"])
    return {
        "groceries": groceries, "secret_cat": secret_cat, "goal": goal, "secret_tag": secret_tag,
        "joint_entry": joint_entry, "joint_txn": joint_txn, "private_txn": private_txn,
        "deposit": deposit, "loan_payment": loan_payment, "overflow_entry": overflow_entry,
        "private_entry": private_entry, "card": card, "shared_loan": shared_loan,
        "private_ids": {private, loan, sw["a_card"], secret_cat, goal, secret_tag,
                        private_txn, private_entry},
    }


# --- Views and allowlists ----------------------------------------------------------------

def test_creator_gets_full_editor_shared_full_viewer_limited(sw, sw_client, house):
    path = f"/transactions/{house['joint_txn']}"
    full = _get(sw_client, sw["a"], path)
    assert full["view"] == "full"
    assert full["category_id"] == house["groceries"] and full["receipt_url"]
    assert set(full["permissions"]) == PERMISSION_KEYS
    assert full["created_by"] == "Alice O."
    for who in ("b", "d"):
        shared = _get(sw_client, sw[who], path)
        assert shared["view"] == "shared_full"
        assert not OWNER_PRIVATE & set(shared)
        assert shared["category_name"] == "Groceries"
        assert shared["description"] == "Weekly groceries"
        assert shared["created_by"] == "Alice O."
    limited = _get(sw_client, sw["v"], path)
    assert limited["view"] == "limited"
    assert set(limited) == LIMITED_TRANSACTION_KEYS
    assert limited["display_description"] == "Weekly groceries"
    assert limited["account"] == {"id": sw["joint"], "name": "Joint account"}
    assert limited["counterpart"] is None


def test_non_creator_editor_response_has_no_owner_private_ids(sw, sw_client, house):
    body = _get(sw_client, sw["b"], f"/transactions/{house['joint_txn']}")
    assert sw_leaks(body, house["private_ids"]) == []
    assert not OWNER_PRIVATE & set(body)
    entry = _get(sw_client, sw["b"], f"/budget-entries/{house['joint_entry']}")
    assert entry["view"] == "shared_full"
    assert not {"category_id", "allocation_id"} & set(entry)
    assert entry["category_name"] == "Groceries"


def test_limited_entry_allowlist(sw, sw_client, house):
    for who in ("b", "v", "d"):
        body = _get(sw_client, sw[who], f"/budget-entries/{house['overflow_entry']}")
        assert body["view"] == "limited"
        assert set(body) == LIMITED_ENTRY_KEYS
        # It touches the owner's private account (its overflow): neutral name.
        assert body["display_name"] == "Recurring expense"
        assert body["category_name"] is None
        assert body["account"] == {"id": sw["joint"], "name": "Joint account"}
        assert sw_leaks(body, house["private_ids"]) == []


def test_transfer_from_a_hidden_account_is_neutral(sw, sw_client, house):
    for who in ("b", "v", "d"):
        body = _get(sw_client, sw[who], f"/transactions/{house['deposit']}")
        assert body["view"] == "limited" and set(body) == LIMITED_TRANSACTION_KEYS
        assert body["display_description"] == "Transfer"
        assert body["account"] == {"id": None, "name": "Other account"}
        assert body["counterpart"] == {"id": sw["joint"], "name": "Joint account"}
        assert body["category_name"] is None
        assert body["amount"] == 500


def test_payment_to_a_hidden_loan_shows_no_interest(sw, sw_client, house):
    for who in ("b", "v", "d"):
        body = _get(sw_client, sw[who], f"/transactions/{house['loan_payment']}")
        assert body["view"] == "limited"
        assert body["transfer_fee"] is None
        assert body["amount"] == pytest.approx(4000 + INTEREST)
        assert body["display_description"] == "Loan payment"
        assert body["counterpart"] == {"id": None, "name": "Loan payment"}
        assert sw_leaks(body, house["private_ids"], numbers=[INTEREST]) == []


def test_balance_history_entries(sw, sw_client, house):
    body = _get(sw_client, sw["v"], f"/accounts/{sw['joint']}/balance")
    assert body["balance_history"]
    for entry in body["balance_history"]:
        assert set(entry) == LIMITED_BALANCE_KEYS
    assert sw_leaks(body, house["private_ids"], numbers=[INTEREST]) == []
    own = _get(sw_client, sw["a"], f"/accounts/{sw['joint']}/balance")
    assert {e["view"] for e in own["balance_history"]} == {"full"}
    assert all("transaction_id" in e for e in own["balance_history"])
    editor = _get(sw_client, sw["b"], f"/accounts/{sw['joint']}/balance")
    views = {e["view"] for e in editor["balance_history"]}
    assert views == {"shared_full", "limited"}
    assert sw_leaks(editor, house["private_ids"], numbers=[INTEREST]) == []


def test_viewer_gets_the_limited_loan_schedule(sw, sw_client, house):
    body = _get(sw_client, sw["v"], f"/accounts/{house['shared_loan']}/loan-schedule")
    assert set(body) == LIMITED_SCHEDULE_KEYS
    assert body["view"] == "limited"
    first = body["rows"][0]
    assert first["due_date"].startswith("2026-09-15")
    assert (first["amount"], first["status"]) == (1050.0, "paid")
    assert {r["status"] for r in body["rows"][1:]} == {"open"}
    for row in body["rows"]:
        assert set(row) == {"due_date", "amount", "status"}
    assert "9.75" not in str(body)
    for who in ("a", "d"):
        full = _get(sw_client, sw[who], f"/accounts/{house['shared_loan']}/loan-schedule")
        assert full["view"] == "full" and full["annual_rate"] == 9.75
    # An editor keeps the payment rows but not the loan's terms (audit round 1, G).
    editor = _get(sw_client, sw["b"], f"/accounts/{house['shared_loan']}/loan-schedule")
    assert editor["view"] == "full"
    for field in ("annual_rate", "payment_amount", "term_months", "first_payment_date",
                  "amortization", "proposed_split"):
        assert editor[field] is None, field
    assert "9.75" not in str(editor)
    assert [p["principal"] + p["interest"] for p in editor["payments"]] == [1050.0]
    assert editor["payments"][0]["transaction_id"]
    assert editor["upcoming"] and all(r["payment"] and r["due_date"] for r in editor["upcoming"])
    for row in editor["upcoming"]:
        assert (row["principal"], row["interest"], row["balance_after"]) == (None, None, None)


def test_viewer_gets_limited_statements(sw, sw_client, house):
    body = _get(sw_client, sw["v"], f"/accounts/{house['card']}/statements")
    assert body["view"] == "limited"
    assert set(body) == {"view", "name", "currency", "statements"}
    statement = body["statements"][0]
    assert set(statement) == LIMITED_STATEMENT_KEYS
    assert statement["close_date"].startswith("2026-09-10")
    assert statement["due_date"].startswith("2026-09-30")
    assert statement["amount_due"] == 505.0
    assert statement["status"] == "overdue"
    assert [line["display_description"] for line in statement["lines"]] == [
        "Card groceries", "Transfer"]
    for line in statement["lines"]:
        assert set(line) == {"date", "display_description", "amount"}
    assert sw_leaks(body, house["private_ids"]) == []
    full = _get(sw_client, sw["b"], f"/accounts/{house['card']}/statements")
    assert full["view"] == "full"
    assert full["statements"][0]["statement_balance"] == 505.0
    assert all("transaction_id" in line for line in full["statements"][0]["lines"])
    assert sw_leaks(full, house["private_ids"]) == []


def test_statements_need_a_role_on_the_card(sw, sw_client, house):
    r = sw_client.get(f"{API}/accounts/{house['card']}/statements", headers=sw["s"]["headers"])
    assert r.status_code == 404
    r = sw_client.get(f"{API}/accounts/{sw['a_card']}/statements", headers=sw["b"]["headers"])
    assert r.status_code == 404


# --- Accounts ----------------------------------------------------------------------------

def test_account_role_permissions_and_field_visibility(sw, sw_client, house):
    expected = {
        "a": ("owner", True, True), "d": ("admin", True, True),
        "b": ("editor", False, True), "v": ("viewer", False, False),
    }
    for who, (role, manage, add) in expected.items():
        body = _get(sw_client, sw[who], f"/accounts/{house['card']}")
        assert body["my_role"] == role
        assert body["permissions"] == {"can_edit_settings": manage, "can_manage_shares": manage,
                                       "can_add_transactions": add,
                                       "can_delete": role == "owner"}
        assert body["owner_name"] == "Alice O."
        if manage:
            assert body["credit_limit"] == 99_999 and body["payment_account_id"]
        else:
            for field in ("description", "credit_limit", "payment_account_id",
                          "payment_overflow_account_id"):
                assert body[field] is None, field
            assert sw_leaks(body, house["private_ids"]) == []
        loan = _get(sw_client, sw[who], f"/accounts/{house['shared_loan']}")
        if not manage:
            for field in ("loan_annual_rate", "loan_term_months", "loan_payment_amount",
                          "loan_first_payment_date", "loan_amortization",
                          "loan_payments_made_offset", "description"):
                assert loan[field] is None, field


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_whole_responses_carry_no_sentinel(sw, sw_client, house, who):
    caller = sw[who]
    # An admin is shown the shared accounts' descriptions and routing ids by design
    # (test_account_role_permissions_and_field_visibility); everyone else is not.
    accounts = [] if who == "d" else [("/accounts/", {"limit": 100})]
    for path, params in (*accounts, ("/transactions/", {"limit": 100}),
                         ("/budget-entries/", {"limit": 100}),
                         (f"/accounts/{sw['joint']}/balance", {}),
                         (f"/accounts/{house['card']}/statements", {}),
                         (f"/accounts/{house['shared_loan']}/loan-schedule", {}),
                         ("/transactions/summary/period",
                          {"start_date": "2026-01-01T00:00:00",
                           "end_date": "2026-12-31T00:00:00"})):
        body = _get(sw_client, caller, path, **params)
        assert sw_leaks(body, house["private_ids"], numbers=[INTEREST]) == [], path


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_search_for_a_sentinel_finds_nothing(sw, sw_client, house, who):
    body = _get(sw_client, sw[who], "/transactions/", search=PRIVATE, limit=100)
    assert body["items"] == [] and body["total"] == 0
    # The owner still finds their own.
    mine = _get(sw_client, sw["a"], "/transactions/", search=PRIVATE, limit=100)
    assert mine["total"] == 4


def test_category_filter_covers_only_the_callers_records(sw, sw_client, house):
    body = _get(sw_client, sw["b"], "/transactions/", category_ids=house["groceries"], limit=100)
    assert body["total"] == 0


# --- Tags --------------------------------------------------------------------------------

def test_tags_stay_private_in_both_directions(sw, sw_client, house):
    joint_txn = house["joint_txn"]
    b = sw["b"]
    for who in ("b", "v", "d"):
        body = _get(sw_client, sw[who], f"/transactions/{joint_txn}")
        assert body["tags"] == []
        entry = _get(sw_client, sw[who], f"/budget-entries/{house['joint_entry']}")
        assert entry["tags"] == []
    b_tag = sw_post(sw_client, b, "/tags/", {"name": "Bea secret"}, expect=(201,))["id"]
    tagged = _put(sw_client, b, f"/transactions/{joint_txn}", {"tag_ids": [b_tag]})
    assert [t["name"] for t in tagged["tags"]] == ["Bea secret"]
    owner_view = _get(sw_client, sw["a"], f"/transactions/{joint_txn}")
    assert [t["name"] for t in owner_view["tags"]] == [f"{PRIVATE} tag"]
    assert "Bea secret" not in str(_get(sw_client, sw["a"], "/transactions/", limit=100))


# --- Permissions -------------------------------------------------------------------------

def test_permission_flags(sw, sw_client, house):
    joint_txn = f"/transactions/{house['joint_txn']}"
    everything = dict.fromkeys(PERMISSION_KEYS, True)
    posted = {**everything, "can_post": False}
    assert _get(sw_client, sw["a"], joint_txn)["permissions"] == posted
    assert _get(sw_client, sw["b"], joint_txn)["permissions"] == posted
    assert _get(sw_client, sw["v"], joint_txn)["permissions"] == dict.fromkeys(
        PERMISSION_KEYS, False)
    # The owner's deposit from their private account: nobody else may touch it.
    assert _get(sw_client, sw["b"], f"/transactions/{house['deposit']}")["permissions"] == \
        dict.fromkeys(PERMISSION_KEYS, False)


def test_demoted_creator_gets_full_with_only_delete_on_unposted(sw, sw_client, sw_db):
    from app.models.account_share import AccountShare

    b, joint = sw["b"], sw["joint"]
    posted = sw_post(sw_client, b, "/transactions/", {
        "account_id": joint, "amount": 20, "transaction_type": "debit",
        "transaction_date": DAY})["id"]
    pending = sw_post(sw_client, b, "/transactions/", {
        "account_id": joint, "amount": 30, "transaction_type": "debit",
        "transaction_date": DAY, "is_posted": False})["id"]
    entry = sw_post(sw_client, b, "/budget-entries/", {
        "name": "Bea bill", "entry_type": "expense", "amount": 10,
        "next_occurrence": "2026-10-05T00:00:00", "account_id": joint})["id"]
    share = sw_db.get(AccountShare, sw["shares"]["b"])
    share.role = "viewer"
    sw_db.commit()
    none = dict.fromkeys(PERMISSION_KEYS, False)
    body = _get(sw_client, b, f"/transactions/{posted}")
    assert body["view"] == "full" and body["permissions"] == none
    body = _get(sw_client, b, f"/transactions/{pending}")
    assert body["view"] == "full" and body["permissions"] == {**none, "can_delete": True}
    body = _get(sw_client, b, f"/budget-entries/{entry}")
    assert body["view"] == "full" and body["permissions"] == {**none, "can_delete": True}


def test_revoked_creator_reads_their_record_limited(sw, sw_client, sw_db):
    from app.models.account_share import AccountShare

    b = sw["b"]
    txn = sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["joint"], "amount": 20, "transaction_type": "debit",
        "description": "Bea lunch", "transaction_date": DAY, "is_posted": False})["id"]
    sw_db.delete(sw_db.get(AccountShare, sw["shares"]["b"]))
    sw_db.commit()
    body = _get(sw_client, b, f"/transactions/{txn}")
    assert body["view"] == "limited"
    assert body["account"] == {"id": None, "name": "Other account"}
    assert body["permissions"]["can_delete"] is True


# --- List filters (audit round 1, C) -----------------------------------------------------

NOWHERE = 2_000_000_000  # an account id that doesn't exist
YEAR = {"start_date": "2026-01-01T00:00:00", "end_date": "2026-12-31T00:00:00"}


def _list(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    return r.status_code, r.json()


@pytest.mark.parametrize("who", ["b", "v", "d"])
def test_a_hidden_account_filter_answers_as_a_nonexistent_one(sw, sw_client, house, who):
    caller = sw[who]
    nowhere = _list(sw_client, caller, "/transactions/", account_ids=[NOWHERE], limit=100)
    assert nowhere == (200, {"items": [], "total": 0, "has_more": False})
    # The owner's private bank (source of the deposit), loan (destination of the
    # loan payment) and card: each answers exactly as the nonexistent id.
    for hidden in (sw["a_private"], sw["a_loan"], sw["a_card"]):
        assert _list(sw_client, caller, "/transactions/", account_ids=[hidden],
                     limit=100) == nowhere, hidden
        assert _list(sw_client, caller, "/transactions/", account_ids=[sw["joint"], hidden],
                     limit=100) == _list(sw_client, caller, "/transactions/",
                                         account_ids=[sw["joint"], NOWHERE], limit=100)
        assert _list(sw_client, caller, "/transactions/summary/period", account_id=hidden,
                     **YEAR) == _list(sw_client, caller, "/transactions/summary/period",
                                      account_id=NOWHERE, **YEAR), hidden


def test_a_revoked_account_filter_answers_as_a_nonexistent_one(sw, sw_client, sw_db):
    from app.models.account_share import AccountShare

    b, joint = sw["b"], sw["joint"]
    sw_post(sw_client, b, "/transactions/", {
        "account_id": joint, "amount": 20, "transaction_type": "debit",
        "description": "Bea lunch", "transaction_date": DAY})
    sw_post(sw_client, b, "/transactions/", {
        "account_id": sw["b_private"], "transfer_from_account_id": sw["b_private"],
        "transfer_to_account_id": joint, "amount": 50, "transaction_type": "transfer",
        "description": "Bea top-up", "transaction_date": DAY})
    sw_db.delete(sw_db.get(AccountShare, sw["shares"]["b"]))
    sw_db.commit()
    for path, params in (("/transactions/", {"account_ids": [joint], "limit": 100}),
                         ("/transactions/summary/period", {"account_id": joint, **YEAR})):
        other = dict(params)
        other["account_ids" if "account_ids" in params else "account_id"] = (
            [NOWHERE] if "account_ids" in params else NOWHERE)
        assert _list(sw_client, b, path, **params) == _list(sw_client, b, path, **other), path


def test_reconciled_and_active_filters_say_nothing_about_limited_records(
        sw, sw_client, sw_db, house):
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    # The owner reconciles the joint debit (shown limited to the viewer) and
    # deactivates the entry overflowing to their private account (limited to all).
    sw_db.get(Transaction, house["joint_txn"]).is_reconciled = True
    sw_db.get(BudgetEntry, house["overflow_entry"]).is_active = False
    sw_db.commit()
    v = sw["v"]
    seen = set()
    for flag in (True, False):
        body = _get(sw_client, v, "/transactions/", is_reconciled=flag, limit=100)
        assert {t["view"] for t in body["items"]} <= {"full", "shared_full"}
        seen |= {t["id"] for t in body["items"]}
    assert house["joint_txn"] not in seen
    for who in ("b", "v", "d"):
        listed = set()
        for flag in (True, False):
            body = _get(sw_client, sw[who], "/budget-entries/", is_active=flag, limit=100)
            assert {e["view"] for e in body["items"]} <= {"full", "shared_full"}
            listed |= {e["id"] for e in body["items"]}
        assert house["overflow_entry"] not in listed
    # The owner, who sees both in full, still filters on them.
    assert house["joint_txn"] in {t["id"] for t in _get(
        sw_client, sw["a"], "/transactions/", is_reconciled=True, limit=100)["items"]}
    assert house["overflow_entry"] in {e["id"] for e in _get(
        sw_client, sw["a"], "/budget-entries/", is_active=False, limit=100)["items"]}

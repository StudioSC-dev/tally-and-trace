"""One-bit disclosures in shared-account error responses (STU-242).

Each refusal here used to differ with something the caller is not shown: a
loan's payment account, its currency, or transactions on accounts the caller
cannot read. Every test is differential: the same request against two hidden
states must get the same status and the same body bytes.
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

DAY = "2026-10-01T00:00:00"
LOAN = {"account_type": "loan", "loan_kind": "personal", "balance": -10_000,
        "loan_annual_rate": 10, "loan_term_months": 12, "loan_payment_amount": 900,
        "loan_first_payment_date": "2026-11-01"}
NEUTRAL_CURRENCY_DETAIL = (
    "This loan's payment account must stay a funding account in the same currency; "
    "the loan's payment account has to change first")
NO_FUNDING_DETAIL = (
    "No funding account: pass from_account_id or set the loan's payment_account_id")


def _call(client, who, method, path, body=None):
    return client.request(method, f"{API}{path}", json=body, headers=who["headers"])


def _same(first, second):
    """Status and body bytes of two responses."""
    assert (first.status_code, first.content) == (second.status_code, second.content), (
        first.status_code, first.text, second.status_code, second.text)


def _loan(client, owner, name, **extra):
    return sw_post(client, owner, "/accounts/", {**LOAN, "name": name, **extra})["id"]


def _entry(client, who, account):
    return sw_post(client, who, "/budget-entries/", {
        "name": "Bill", "entry_type": "expense", "amount": 40,
        "next_occurrence": "2026-10-05T00:00:00", "account_id": account})["id"]


def _linked_debit(client, who, account, entry):
    return sw_post(client, who, "/transactions/", {
        "account_id": account, "amount": 25, "transaction_type": "debit",
        "description": "Debit", "transaction_date": DAY, "is_posted": True,
        "budget_entry_id": entry})["id"]


def _demote(db, sw, who, role):
    from app.models.account_share import AccountShare

    db.get(AccountShare, sw["shares"][who]).role = role
    db.commit()


# --- AC1: a loan payment with no funding account ----------------------------------------

def test_loan_payment_funding_same_response(sw, sw_client, sw_db):
    """An editor paying without ``from_account_id`` gets the same 404 whether the
    loan has no payment account or is paid from an account hidden from them."""
    a, b = sw["a"], sw["b"]
    unrouted = _loan(sw_client, a, "Unrouted loan")
    hidden = _loan(sw_client, a, "Hidden payer loan", payment_account_id=sw["a_private"])
    for loan in (unrouted, hidden):
        sw_share(sw_db, loan, b["id"], "editor", a["id"])
    for route, body in (("loan-payment", {"amount": 900, "transaction_date": DAY}),
                        ("loan-prepayment", {"amount": 500, "transaction_date": DAY})):
        got = [_call(sw_client, b, "POST", f"/accounts/{loan}/{route}", body)
               for loan in (unrouted, hidden)]
        assert got[0].status_code == 404, (route, got[0].text)
        _same(*got)


# --- AC2: changing a loan's currency ------------------------------------------------------

def test_loan_currency_message_neutral(sw, sw_client, sw_db):
    """An admin moving a loan to USD gets the same refusal whatever the currency of
    the owner's payment account they cannot see, and it names neither."""
    a, d = sw["a"], sw["d"]
    euro_bank = sw_post(sw_client, a, "/accounts/", {
        "name": "Euro bank", "account_type": "checking", "balance": 100,
        "currency": "EUR"})["id"]
    peso_paid = _loan(sw_client, a, "Peso loan", payment_account_id=sw["a_private"])
    euro_paid = _loan(sw_client, a, "Euro loan", currency="EUR", payment_account_id=euro_bank)
    for loan in (peso_paid, euro_paid):
        sw_share(sw_db, loan, d["id"], "admin", a["id"])
    got = [_call(sw_client, d, "PUT", f"/accounts/{loan}", {"currency": "USD"})
           for loan in (peso_paid, euro_paid)]
    assert got[0].status_code == 400, got[0].text
    _same(*got)
    assert got[0].json() == {"detail": NEUTRAL_CURRENCY_DETAIL}
    for code in ("PHP", "EUR", "USD"):
        assert code not in got[0].text


# --- AC3: deleting a recurring entry with linked rows the caller cannot read ------------

def test_recurring_delete_409_counts_only_readable(sw, sw_client, sw_db):
    """The joint account's owner deletes the partner's entries: one with no linked
    rows, one linked only from the partner's private account. Both succeed alike,
    and the hidden row is unlinked as any other."""
    from app.models.transaction import Transaction

    a, b, joint = sw["a"], sw["b"], sw["joint"]
    bare = _entry(sw_client, b, joint)
    hidden_linked = _entry(sw_client, b, joint)
    hidden = _linked_debit(sw_client, b, sw["b_private"], hidden_linked)
    got = [_call(sw_client, a, "DELETE", f"/budget-entries/{entry}")
           for entry in (bare, hidden_linked)]
    assert got[0].status_code == 204, got[0].text
    _same(*got)
    sw_db.expire_all()
    row = sw_db.get(Transaction, hidden)
    assert (row.budget_entry_id, row.is_recurring, row.recurrence_frequency) == (
        None, False, None)

    # The partner deleting the owner's entry linked from the owner's private account.
    a_bare = _entry(sw_client, a, joint)
    a_hidden_linked = _entry(sw_client, a, joint)
    _linked_debit(sw_client, a, sw["a_private"], a_hidden_linked)
    got = [_call(sw_client, b, "DELETE", f"/budget-entries/{entry}")
           for entry in (a_bare, a_hidden_linked)]
    assert got[0].status_code == 204, got[0].text
    _same(*got)


def test_recurring_delete_readable_rows_still_block(sw, sw_client, sw_db):
    """A readable linked row the caller may not edit still refuses the delete, with
    the same 409 whether more hidden linked rows exist or not; nothing is unlinked."""
    from app.models.budget_entry import BudgetEntry
    from app.models.transaction import Transaction

    a, b, joint = sw["a"], sw["b"], sw["joint"]
    readable_only = _entry(sw_client, b, joint)
    with_hidden = _entry(sw_client, b, joint)
    rows = [_linked_debit(sw_client, b, joint, readable_only),
            _linked_debit(sw_client, b, joint, with_hidden),
            _linked_debit(sw_client, b, sw["b_private"], with_hidden)]
    # The partner loses edit: the owner reads their joint rows but may not edit them.
    _demote(sw_db, sw, "b", "viewer")
    got = [_call(sw_client, a, "DELETE", f"/budget-entries/{entry}")
           for entry in (readable_only, with_hidden)]
    assert got[0].status_code == 409, got[0].text
    _same(*got)
    sw_db.expire_all()
    for entry in (readable_only, with_hidden):
        assert sw_db.get(BudgetEntry, entry) is not None
    for txn in rows:
        assert sw_db.get(Transaction, txn).budget_entry_id is not None


# --- AC4: callers with full visibility, and what the ticket leaves alone ----------------

def test_owner_messages_unchanged(sw, sw_client, sw_db):
    a, b, d, v = sw["a"], sw["b"], sw["d"], sw["v"]
    unrouted = _loan(sw_client, a, "Unrouted loan")
    sw_share(sw_db, unrouted, d["id"], "admin", a["id"])
    sw_share(sw_db, unrouted, b["id"], "editor", a["id"])
    body = {"amount": 900, "transaction_date": DAY}
    # Owner and admin see the loan's routing, so they keep the 400 that says why.
    for who in (a, d):
        r = _call(sw_client, who, "POST", f"/accounts/{unrouted}/loan-payment", body)
        assert (r.status_code, r.json()) == (400, {"detail": NO_FUNDING_DETAIL}), r.text
    # A caller with no role on the loan still gets the loan's own 404.
    r = _call(sw_client, sw["s"], "POST", f"/accounts/{unrouted}/loan-payment", body)
    assert (r.status_code, r.json()) == (404, {"detail": "Account not found"})
    # An editor naming a funding account they may use still pays.
    r = _call(sw_client, b, "POST", f"/accounts/{unrouted}/loan-payment",
              {**body, "from_account_id": sw["joint"]})
    assert r.status_code == 200, r.text

    # The owner's currency mismatch gets the neutral wording too (the one change).
    routed = _loan(sw_client, a, "Routed loan", payment_account_id=sw["a_private"])
    r = _call(sw_client, a, "PUT", f"/accounts/{routed}", {"currency": "USD"})
    assert (r.status_code, r.json()) == (400, {"detail": NEUTRAL_CURRENCY_DETAIL})
    r = sw_client.post(f"{API}/accounts/", headers=a["headers"], json={
        **LOAN, "name": "Dollar loan", "currency": "USD", "payment_account_id": sw["a_private"]})
    assert (r.status_code, r.json()) == (400, {"detail": NEUTRAL_CURRENCY_DETAIL})

    # The admin's is_active change keeps its 404 (part 4 of the ticket is not taken).
    r = _call(sw_client, d, "PUT", f"/accounts/{sw['joint']}", {"is_active": False})
    assert (r.status_code, r.json()) == (404, {"detail": "Account not found"})

    # Deleting an entry: authorization is unchanged (a viewer is refused with 404),
    # and the creator still deletes their own entry with their own linked rows.
    entry = _entry(sw_client, a, sw["joint"])
    r = _call(sw_client, v, "DELETE", f"/budget-entries/{entry}")
    assert (r.status_code, r.json()) == (404, {"detail": "Budget entry not found"})
    _linked_debit(sw_client, a, sw["a_private"], entry)
    assert _call(sw_client, a, "DELETE", f"/budget-entries/{entry}").status_code == 204

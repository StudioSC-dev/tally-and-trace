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

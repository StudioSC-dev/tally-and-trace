"""Transaction dates are bounded (STU-404).

A date saved on a transaction runs from 2000-01-01 to Manila's today plus five
years, both inclusive. The rule guards every write path that takes a
transaction date; a row already stored outside it stays readable and fixable.
This module does not import ``app.core.record_dates`` at module level, so it
collects (and the labelled guards run) where that module does not exist.
Skips without a database.
"""
import sys
from datetime import date, datetime, timedelta

import pytest

from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

BAD_YEAR_6 = "0006-05-10T00:00:00.000Z"
BEFORE_MIN = "1999-12-31T00:00:00"


def pin_clock(monkeypatch, when: datetime) -> None:
    """Freeze ``naive_utc_now`` in every loaded app module (Manila's today included)."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "naive_utc_now"):
            monkeypatch.setattr(module, "naive_utc_now", lambda: when)


def _today() -> date:
    from app.core.time import manila_today

    return manila_today()


def _max(today: date) -> date:
    """Today plus five calendar years; Feb 29 becomes Feb 28."""
    try:
        return today.replace(year=today.year + 5)
    except ValueError:
        return today.replace(year=today.year + 5, day=28)


def _message() -> str:
    return f"Choose a date from 2000-01-01 to {_max(_today()).isoformat()}"


def _after_max() -> str:
    return f"{(_max(_today()) + timedelta(days=1)).isoformat()}T00:00:00"


def _at(day: date) -> str:
    return f"{day.isoformat()}T00:00:00"


def _account(client, who, name="Checking", account_type="checking", balance=50_000, **extra):
    return sw_post(client, who, "/accounts/", {
        "name": name, "account_type": account_type, "balance": balance, **extra})["id"]


def _txn_body(account_id, **over):
    body = {"account_id": account_id, "transaction_type": "debit", "amount": 10,
            "description": "Probe", "transaction_date": _at(_today()), "is_posted": True}
    body.update(over)
    return body


def _post_txn(client, who, body):
    return client.post(f"{API}/transactions/", json=body, headers=who["headers"])


def _put_txn(client, who, txn_id, **body):
    return client.put(f"{API}/transactions/{txn_id}", json=body, headers=who["headers"])


def _assert_refused(r):
    assert r.status_code == 422, r.text
    assert r.json()["detail"][0]["msg"] == _message()


def _entry(client, who, account_id, next_day, name="Gym"):
    return sw_post(client, who, "/budget-entries/", {
        "name": name, "entry_type": "expense", "amount": 100, "cadence": "monthly",
        "next_occurrence": f"{next_day}T00:00:00", "account_id": account_id})["id"]


def _txn_count(db, account_id) -> int:
    from app.models.transaction import Transaction

    db.rollback()
    return db.query(Transaction).filter(Transaction.account_id == account_id).count()


# --- create / update -------------------------------------------------------------------------

def test_create_refuses_dates_outside_the_range(sw_client, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    for bad in (BAD_YEAR_6, BEFORE_MIN, _after_max()):
        _assert_refused(_post_txn(sw_client, me, _txn_body(acct, transaction_date=bad)))


def test_create_accepts_the_bounds_and_today(sw_client, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    for ok in ("2000-01-01T00:00:00", _at(_today()), _at(_max(_today()))):
        r = _post_txn(sw_client, me, _txn_body(acct, transaction_date=ok))
        assert r.status_code in (200, 201), (ok, r.text)


def test_create_refuses_a_posting_date_outside_the_range(sw_client, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    for bad in (BAD_YEAR_6, _after_max()):
        _assert_refused(_post_txn(sw_client, me, _txn_body(acct, posting_date=bad)))


def test_update_refuses_a_date_outside_the_range(sw_client, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    txn = _post_txn(sw_client, me, _txn_body(acct)).json()["id"]
    for bad in (BAD_YEAR_6, BEFORE_MIN, _after_max()):
        _assert_refused(_put_txn(sw_client, me, txn, transaction_date=bad))
    _assert_refused(_put_txn(sw_client, me, txn, posting_date=BAD_YEAR_6))


def test_an_existing_out_of_range_row_stays_readable_and_fixable(sw_client, sw_db, sw_people):
    """Labelled guard: passes before the change. It keeps the validators off
    ``TransactionBase``, the response model's parent."""
    from app.models.transaction import Transaction, TransactionType

    me = sw_people()
    acct = _account(sw_client, me)
    row = Transaction(user_id=me["id"], account_id=acct, amount=10,
                      transaction_type=TransactionType.DEBIT, is_posted=True,
                      description="Typo", transaction_date=datetime(6, 5, 10))
    sw_db.add(row)
    sw_db.commit()
    txn_id = row.id

    r = sw_client.get(f"{API}/transactions/", headers=me["headers"], params={"ids": [txn_id]})
    assert r.status_code == 200, r.text
    assert [t["id"] for t in r.json()["items"]] == [txn_id]

    r = _put_txn(sw_client, me, txn_id, description="Fixed later")
    assert r.status_code == 200, r.text
    r = _put_txn(sw_client, me, txn_id, transaction_date=_at(_today()))
    assert r.status_code == 200, r.text


# --- materialize, Mark paid, Charged ---------------------------------------------------------

def test_materialize_refuses_a_transaction_date_outside_the_range(sw_client, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    entry = _entry(sw_client, me, acct, _today().isoformat())
    for bad in (BAD_YEAR_6, _after_max()):
        r = sw_client.post(f"{API}/budget-entries/{entry}/materialize",
                           json={"transaction_date": bad}, headers=me["headers"])
        _assert_refused(r)


def test_post_n_due_on_a_legacy_schedule_is_refused_and_writes_nothing(
        sw_client, sw_db, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    entry = _entry(sw_client, me, acct, "1999-12-01")
    r = sw_client.post(f"{API}/budget-entries/{entry}/materialize-due", headers=me["headers"])
    assert r.status_code == 422, r.text
    assert _message() in r.text
    assert _txn_count(sw_db, acct) == 0
    state = sw_client.get(f"{API}/budget-entries/{entry}", headers=me["headers"]).json()
    assert state["next_occurrence"].startswith("1999-12-01")


def test_mark_paid_on_a_legacy_occurrence_needs_an_in_range_date(sw_client, sw_db, sw_people):
    me = sw_people()
    acct = _account(sw_client, me)
    entry = _entry(sw_client, me, acct, "1999-12-01")
    url = f"{API}/budget-entries/{entry}/materialize"

    r = sw_client.post(url, json={"occurrence_date": "1999-12-01T00:00:00"},
                       headers=me["headers"])
    assert r.status_code == 422, r.text
    assert _message() in r.text
    assert _txn_count(sw_db, acct) == 0


def test_mark_paid_on_a_legacy_occurrence_with_an_in_range_date_succeeds(
        sw_client, sw_db, sw_people):
    """Labelled guard: passes before the change. It keeps the ``_create``
    check conditional on a missing ``transaction_date``."""
    me = sw_people()
    acct = _account(sw_client, me)
    entry = _entry(sw_client, me, acct, "1999-12-01")
    url = f"{API}/budget-entries/{entry}/materialize"
    r = sw_client.post(url, json={"occurrence_date": "1999-12-01T00:00:00",
                                  "transaction_date": _at(_today())},
                       headers=me["headers"])
    assert r.status_code == 201, r.text
    assert r.json()["transaction_date"].startswith(_today().isoformat())
    assert _txn_count(sw_db, acct) == 1


# --- card Pay, loans -------------------------------------------------------------------------

def test_card_payment_refuses_a_date_outside_the_range(sw_client, sw_people):
    me = sw_people()
    bank = _account(sw_client, me, "Savings", "savings", 100_000)
    card = _account(sw_client, me, "Card", "credit", 0, billing_cycle_start=24,
                    days_until_due_date=21, payment_account_id=bank)
    for bad in ("0006-05-10", (_max(_today()) + timedelta(days=1)).isoformat()):
        r = sw_client.post(f"{API}/cards/{card}/payments", headers=me["headers"], json={
            "amount": 100, "from_account_id": bank, "payment_date": bad})
        _assert_refused(r)


@pytest.mark.parametrize("path,body", [
    ("loan-payment", {"principal": 1000, "interest": 100}),
    ("loan-prepayment", {"amount": 1000}),
])
def test_loan_endpoints_refuse_a_date_outside_the_range(sw_client, sw_people, path, body):
    me = sw_people()
    bank = _account(sw_client, me, "Bank", "savings", 500_000)
    loan = _account(sw_client, me, "Loan", "loan", -1_000_000, loan_kind="auto",
                    loan_annual_rate=10, loan_term_months=60, loan_payment_amount=28_239,
                    loan_first_payment_date="2026-03-04", payment_account_id=bank,
                    loan_amortization="reduce_term")
    for bad in (BAD_YEAR_6, _after_max()):
        r = sw_client.post(f"{API}/accounts/{loan}/{path}", headers=me["headers"],
                           json={**body, "transaction_date": bad})
        _assert_refused(r)


# --- the clock -------------------------------------------------------------------------------

def test_the_upper_bound_moves_with_the_clock(sw_client, sw_people, monkeypatch):
    me = sw_people()
    acct = _account(sw_client, me)
    pin_clock(monkeypatch, datetime(2027, 3, 18, 2, 0))
    r = _post_txn(sw_client, me, _txn_body(acct, transaction_date="2032-03-18T00:00:00"))
    assert r.status_code in (200, 201), r.text
    r = _post_txn(sw_client, me, _txn_body(acct, transaction_date="2032-03-19T00:00:00"))
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == (
        "Choose a date from 2000-01-01 to 2032-03-18"), r.text


def test_feb_29_plus_five_years_is_feb_28(sw_client, sw_people, monkeypatch):
    me = sw_people()
    acct = _account(sw_client, me)
    pin_clock(monkeypatch, datetime(2028, 2, 29, 2, 0))
    r = _post_txn(sw_client, me, _txn_body(acct, transaction_date="2033-02-28T00:00:00"))
    assert r.status_code in (200, 201), r.text
    r = _post_txn(sw_client, me, _txn_body(acct, transaction_date="2033-03-01T00:00:00"))
    assert r.status_code == 422 and r.json()["detail"][0]["msg"] == (
        "Choose a date from 2000-01-01 to 2033-02-28"), r.text

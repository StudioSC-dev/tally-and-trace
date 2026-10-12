"""Deactivating an account with obligations on it (STU-234).

A card that funds a pending payment into a loan, that the projection still
bills a recurring entry on, or that still owes on a statement, and a loan with
a pending or recurring payment, cannot be deactivated (``PUT`` with
``is_active`` false, or the soft ``DELETE``) until the obligation is cleared.

"Today" is frozen at ``TODAY`` for the guard, so nothing here depends on the
run date. The fixture card (``sw["a_card"]``) closes on the 15th and is due 21
days later: on ``TODAY`` (Oct 12) the open cycle closes Oct 15 and is due Nov 5.
"""
from datetime import datetime, timedelta
from decimal import Decimal

import pytest

import app.routers.accounts as accounts_router
from app.routers.accounts import (
    CARD_OPEN_STATEMENT_DETAIL,
    CARD_PENDING_PAYMENT_DETAIL,
    CARD_RECURRING_ENTRY_DETAIL,
    LOAN_PENDING_PAYMENT_DETAIL,
)
from app.tests.conftest import API, sw_db_reachable, sw_post

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")

TODAY = datetime(2026, 10, 12, 9, 30)
DAY = "2026-10-01T00:00:00"
DEACTIVATIONS = ["put", "delete"]


@pytest.fixture(autouse=True)
def _frozen_today(monkeypatch):
    monkeypatch.setattr(accounts_router, "naive_utc_now", lambda: TODAY)


def _call(client, who, method, path, body=None):
    return client.request(method, f"{API}{path}", json=body, headers=who["headers"])


def _deactivate(client, who, account_id, how):
    if how == "put":
        return _call(client, who, "PUT", f"/accounts/{account_id}", {"is_active": False})
    return _call(client, who, "DELETE", f"/accounts/{account_id}")


def _is_active(client, who, account_id):
    return _call(client, who, "GET", f"/accounts/{account_id}").json()["is_active"]


def _refused(r, detail):
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == detail


def _transfer(client, who, frm, to, amount, posted):
    return sw_post(client, who, "/transactions/", {
        "account_id": frm, "transfer_from_account_id": frm, "transfer_to_account_id": to,
        "amount": amount, "transaction_type": "transfer", "description": "Move",
        "transaction_date": DAY, "is_posted": posted})


def _charge(client, who, card, amount, posted=True):
    return sw_post(client, who, "/transactions/", {
        "account_id": card, "amount": amount, "transaction_type": "debit",
        "description": "Charge", "transaction_date": DAY, "is_posted": posted})


def _days_from_today(days):
    today = TODAY.replace(hour=0, minute=0, second=0, microsecond=0)
    return (today + timedelta(days=days)).isoformat()


def _entry(client, who, account_id, **fields):
    return sw_post(client, who, "/budget-entries/", {
        "name": "Subscription", "entry_type": "expense", "amount": 500,
        "next_occurrence": _days_from_today(8), "account_id": account_id,
        **fields}, expect=(201,))["id"]


def _pay_card(client, who, bank, card, charged):
    _transfer(client, who, bank, card, charged, posted=True)


# --- Card: a pending payment into a loan ------------------------------------------------

@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_card_funding_a_pending_loan_payment_is_refused_until_it_is_removed(
        sw, sw_client, how):
    a, card, loan = sw["a"], sw["a_card"], sw["a_loan"]
    txn = _transfer(sw_client, a, card, loan, 1_000, posted=False)["id"]

    _refused(_deactivate(sw_client, a, card, how), CARD_PENDING_PAYMENT_DETAIL)
    assert _is_active(sw_client, a, card) is True

    assert _call(sw_client, a, "DELETE", f"/transactions/{txn}").status_code == 200
    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


def test_a_card_funding_a_loan_payment_is_freed_once_it_is_posted_and_billed_paid(
        sw, sw_client):
    a, card, loan = sw["a"], sw["a_card"], sw["a_loan"]
    txn = _transfer(sw_client, a, card, loan, 1_000, posted=False)
    _refused(_deactivate(sw_client, a, card, "put"), CARD_PENDING_PAYMENT_DETAIL)

    posted = _call(sw_client, a, "PUT", f"/transactions/{txn['id']}", {"is_posted": True})
    assert posted.status_code == 200, posted.text
    # Posted, the payment is a charge on the card's statement until that is paid.
    _refused(_deactivate(sw_client, a, card, "put"), CARD_OPEN_STATEMENT_DETAIL)

    body = posted.json()
    charged = Decimal(str(body["amount"])) + Decimal(str(body.get("transfer_fee") or 0))
    _pay_card(sw_client, a, sw["a_private"], card, float(charged))
    r = _deactivate(sw_client, a, card, "put")
    assert r.status_code == 200, r.text


# --- Card: an active recurring entry ---------------------------------------------------

@pytest.mark.parametrize("how", DEACTIVATIONS)
@pytest.mark.parametrize("clear", ["end", "delete"])
def test_a_card_with_an_active_recurring_charge_is_refused_until_it_is_cleared(
        sw, sw_client, how, clear):
    a, card = sw["a"], sw["a_card"]
    entry = _entry(sw_client, a, card)

    _refused(_deactivate(sw_client, a, card, how), CARD_RECURRING_ENTRY_DETAIL)
    assert _is_active(sw_client, a, card) is True

    if clear == "end":
        r = _call(sw_client, a, "PUT", f"/budget-entries/{entry}", {"is_active": False})
    else:
        r = _call(sw_client, a, "DELETE", f"/budget-entries/{entry}")
    assert r.status_code in (200, 204), r.text
    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_card_with_a_recurring_income_entry_is_refused(sw, sw_client, how):
    a, card = sw["a"], sw["a_card"]
    _entry(sw_client, a, card, name="Cashback", entry_type="income")

    _refused(_deactivate(sw_client, a, card, how), CARD_RECURRING_ENTRY_DETAIL)
    assert _is_active(sw_client, a, card) is True


@pytest.mark.parametrize("how", DEACTIVATIONS)
@pytest.mark.parametrize("clear", ["delete", "record_and_pay"])
def test_a_recently_ended_charge_still_billed_on_an_unpaid_statement_is_refused(
        sw, sw_client, how, clear):
    # Its last occurrence (Oct 7) is before today but on the cycle due Nov 5,
    # so the projection still bills it although nothing occurs from today on.
    a, card = sw["a"], sw["a_card"]
    entry = _entry(sw_client, a, card, next_occurrence="2026-10-07T00:00:00",
                   end_mode="on_date", end_date="2026-10-07T00:00:00")

    _refused(_deactivate(sw_client, a, card, how), CARD_RECURRING_ENTRY_DETAIL)
    assert _is_active(sw_client, a, card) is True

    if clear == "delete":
        r = _call(sw_client, a, "DELETE", f"/budget-entries/{entry}")
        assert r.status_code in (200, 204), r.text
    else:
        # Recorded (the entry runs out and goes inactive), it is a charge on the
        # statement, owed until that is paid.
        r = _call(sw_client, a, "POST", f"/budget-entries/{entry}/materialize", {})
        assert r.status_code == 201, r.text
        _refused(_deactivate(sw_client, a, card, how), CARD_OPEN_STATEMENT_DETAIL)
        _pay_card(sw_client, a, sw["a_private"], card, 500)
    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_charge_whose_statement_fell_due_before_today_deactivates(sw, sw_client, how):
    # Its last occurrence (Sep 7) was billed on the cycle due Oct 6: the
    # projection drops it as lapsed, so nothing is owed for it.
    a, card = sw["a"], sw["a_card"]
    _entry(sw_client, a, card, next_occurrence="2026-08-07T00:00:00",
           end_mode="on_date", end_date="2026-09-07T00:00:00")

    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_final_occurrence_recorded_without_advancing_and_paid_deactivates(
        sw, sw_client, how):
    # The entry stays active on its last occurrence (today), but the recorded
    # transaction stands for it, so the projection bills nothing more.
    a, card = sw["a"], sw["a_card"]
    entry = _entry(sw_client, a, card, next_occurrence="2026-10-12T00:00:00",
                   end_mode="on_date", end_date="2026-10-12T00:00:00")
    r = _call(sw_client, a, "POST", f"/budget-entries/{entry}/materialize",
              {"advance": False})
    assert r.status_code == 201, r.text
    _refused(_deactivate(sw_client, a, card, how), CARD_OPEN_STATEMENT_DETAIL)

    _pay_card(sw_client, a, sw["a_private"], card, 500)
    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_card_without_a_cycle_is_refused_until_its_recurring_charge_ends(
        sw, sw_client, how):
    a = sw["a"]
    card = sw_post(sw_client, a, "/accounts/", {
        "name": "Store card", "account_type": "credit", "balance": 0})["id"]
    entry = _entry(sw_client, a, card, next_occurrence="2026-09-20T00:00:00",
                   end_mode="on_date", end_date="2026-12-31T00:00:00")

    _refused(_deactivate(sw_client, a, card, how), CARD_RECURRING_ENTRY_DETAIL)
    assert _is_active(sw_client, a, card) is True

    # Ended yesterday: it occurred before today, but a card without a cycle
    # has no statement to bill that on.
    r = _call(sw_client, a, "PUT", f"/budget-entries/{entry}",
              {"end_date": "2026-10-11T00:00:00"})
    assert r.status_code == 200, r.text
    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


# --- Card: an open statement ------------------------------------------------------------

@pytest.mark.parametrize("how", DEACTIVATIONS)
@pytest.mark.parametrize("posted", [True, False])
def test_a_card_with_an_unpaid_statement_is_refused_until_it_is_paid(
        sw, sw_client, how, posted):
    a, card = sw["a"], sw["a_card"]
    _charge(sw_client, a, card, 2_500, posted=posted)

    _refused(_deactivate(sw_client, a, card, how), CARD_OPEN_STATEMENT_DETAIL)
    assert _is_active(sw_client, a, card) is True

    # A part payment still leaves the statement open.
    _pay_card(sw_client, a, sw["a_private"], card, 1_000)
    _refused(_deactivate(sw_client, a, card, how), CARD_OPEN_STATEMENT_DETAIL)

    _pay_card(sw_client, a, sw["a_private"], card, 1_500)
    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_an_unposted_payment_covering_the_statement_counts_as_paying_it(sw, sw_client, how):
    a, card = sw["a"], sw["a_card"]
    _charge(sw_client, a, card, 2_500)
    _transfer(sw_client, a, sw["a_private"], card, 2_500, posted=False)

    r = _deactivate(sw_client, a, card, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, card) is False


def test_a_card_whose_only_charge_is_deleted_deactivates(sw, sw_client):
    a, card = sw["a"], sw["a_card"]
    txn = _charge(sw_client, a, card, 2_500, posted=False)["id"]
    _refused(_deactivate(sw_client, a, card, "delete"), CARD_OPEN_STATEMENT_DETAIL)
    assert _call(sw_client, a, "DELETE", f"/transactions/{txn}").status_code == 200
    assert _deactivate(sw_client, a, card, "delete").status_code == 200


# --- Loan: a pending payment ------------------------------------------------------------

@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_loan_with_a_planned_payment_is_refused_until_it_is_posted(sw, sw_client, how):
    a, loan = sw["a"], sw["a_loan"]
    txn = sw_post(sw_client, a, f"/accounts/{loan}/loan-payment",
                  {"amount": 5_000, "is_posted": False, "transaction_date": DAY})["id"]

    _refused(_deactivate(sw_client, a, loan, how), LOAN_PENDING_PAYMENT_DETAIL)
    assert _is_active(sw_client, a, loan) is True

    r = _call(sw_client, a, "PUT", f"/transactions/{txn}", {"is_posted": True})
    assert r.status_code == 200, r.text
    r = _deactivate(sw_client, a, loan, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, loan) is False


def test_a_loan_with_a_planned_payment_deactivates_once_the_payment_is_deleted(sw, sw_client):
    a, loan = sw["a"], sw["a_loan"]
    txn = _transfer(sw_client, a, sw["a_private"], loan, 1_000, posted=False)["id"]
    _refused(_deactivate(sw_client, a, loan, "put"), LOAN_PENDING_PAYMENT_DETAIL)
    assert _call(sw_client, a, "DELETE", f"/transactions/{txn}").status_code == 200
    assert _deactivate(sw_client, a, loan, "put").status_code == 200


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_loan_with_an_active_recurring_payment_is_refused_until_it_is_ended(
        sw, sw_client, how):
    a, loan = sw["a"], sw["a_loan"]
    entry = sw_post(sw_client, a, "/budget-entries/", {
        "name": "Loan payment", "entry_type": "expense", "amount": 5_000,
        "next_occurrence": "2026-10-20T00:00:00", "account_id": sw["a_private"],
        "transfer_to_account_id": loan}, expect=(201,))["id"]

    _refused(_deactivate(sw_client, a, loan, how), LOAN_PENDING_PAYMENT_DETAIL)

    r = _call(sw_client, a, "PUT", f"/budget-entries/{entry}", {"is_active": False})
    assert r.status_code == 200, r.text
    r = _deactivate(sw_client, a, loan, how)
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_loan_whose_recurring_payment_ended_by_date_deactivates(sw, sw_client, how):
    a, loan = sw["a"], sw["a_loan"]
    _entry(sw_client, a, sw["a_private"], name="Loan payment", amount=5_000,
           transfer_to_account_id=loan, next_occurrence=_days_from_today(-60),
           end_mode="on_date", end_date=_days_from_today(-5))

    r = _deactivate(sw_client, a, loan, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, loan) is False


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_loan_whose_recurring_payment_runs_on_is_still_refused(sw, sw_client, how):
    a, loan = sw["a"], sw["a_loan"]
    _entry(sw_client, a, sw["a_private"], name="Loan payment", amount=5_000,
           transfer_to_account_id=loan, next_occurrence=_days_from_today(-60),
           end_mode="on_date", end_date=_days_from_today(40))

    _refused(_deactivate(sw_client, a, loan, how), LOAN_PENDING_PAYMENT_DETAIL)
    assert _is_active(sw_client, a, loan) is True


@pytest.mark.parametrize("how", DEACTIVATIONS)
def test_a_loan_whose_final_payment_was_recorded_without_advancing_deactivates(
        sw, sw_client, how):
    # The entry stays active on its last occurrence (today), but the posted
    # payment stands for it, so the loan-cover walk projects nothing more.
    a, loan = sw["a"], sw["a_loan"]
    entry = _entry(sw_client, a, sw["a_private"], name="Loan payment", amount=5_000,
                   transfer_to_account_id=loan, next_occurrence="2026-10-12T00:00:00",
                   end_mode="on_date", end_date="2026-10-12T00:00:00")
    _refused(_deactivate(sw_client, a, loan, how), LOAN_PENDING_PAYMENT_DETAIL)

    r = _call(sw_client, a, "POST", f"/budget-entries/{entry}/materialize",
              {"advance": False})
    assert r.status_code == 201, r.text
    r = _deactivate(sw_client, a, loan, how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, a, loan) is False


# --- No obligations ---------------------------------------------------------------------

@pytest.mark.parametrize("how", DEACTIVATIONS)
@pytest.mark.parametrize("which", ["a_card", "a_loan", "joint"])
def test_an_account_with_no_obligations_still_deactivates(sw, sw_client, how, which):
    r = _deactivate(sw_client, sw["a"], sw[which], how)
    assert r.status_code == 200, r.text
    assert _is_active(sw_client, sw["a"], sw[which]) is False


def test_a_null_is_active_is_rejected_and_omitting_it_still_works(sw, sw_client):
    a, card = sw["a"], sw["a_card"]
    _charge(sw_client, a, card, 2_500)

    r = _call(sw_client, a, "PUT", f"/accounts/{card}", {"is_active": None})
    assert r.status_code == 422, r.text
    detail = _call(sw_client, a, "GET", f"/accounts/{card}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["is_active"] is True

    r = _call(sw_client, a, "PUT", f"/accounts/{card}", {"name": "Renamed card"})
    assert r.status_code == 200, r.text
    assert r.json()["is_active"] is True
    assert r.json()["name"] == "Renamed card"


def test_reactivating_and_resending_an_inactive_value_skip_the_guards(sw, sw_client):
    a, card = sw["a"], sw["a_card"]
    assert _deactivate(sw_client, a, card, "put").status_code == 200
    _charge(sw_client, a, card, 2_500)
    # Already inactive: resending False changes nothing, so nothing is refused.
    r = _call(sw_client, a, "PUT", f"/accounts/{card}", {"name": "Card", "is_active": False})
    assert r.status_code == 200, r.text
    assert _call(sw_client, a, "PUT", f"/accounts/{card}",
                 {"is_active": True}).status_code == 200
    _refused(_deactivate(sw_client, a, card, "put"), CARD_OPEN_STATEMENT_DETAIL)

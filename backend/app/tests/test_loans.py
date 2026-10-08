"""Pure tests for loan maths (``services/loans.py``) and loan interest in the summary."""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.models.transaction import TransactionType
from app.routers.transactions import summarize_period
from app.services.loans import (
    LoanError, amortize, cents, default_amortization, due_date, propose_split, scheduled_dues,
)

BANK, GCASH, LOAN = 1, 2, 3


def _transfer(src, dst, amount, fee="0"):
    return SimpleNamespace(transaction_type=TransactionType.TRANSFER, account_id=src,
                           amount=Decimal(amount), category_id=None, transfer_fee=Decimal(fee),
                           transfer_from_account_id=src, transfer_to_account_id=dst)


def _assert_invariant(result):
    total = sum((v["expenses"] for v in result["category_breakdown"].values()), Decimal("0"))
    assert total == result["total_expenses"]


def test_loan_interest_gets_its_own_row_and_principal_is_not_an_expense():
    result = summarize_period(
        [_transfer(BANK, LOAN, "20000", "8239"), _transfer(BANK, GCASH, "1000", "15")],
        {GCASH}, {}, {BANK, GCASH, LOAN}, loan_names={LOAN: "BDO Auto"},
    )
    rows = {name: v["expenses"] for name, v in result["category_breakdown"].items()}
    assert rows["Interest: BDO Auto"] == Decimal("8239")
    assert rows["Transfer fees"] == Decimal("15")
    assert result["total_expenses"] == Decimal("8239") + Decimal("1015")
    _assert_invariant(result)


def test_interest_on_a_wallet_funded_loan_payment_keeps_the_invariant():
    result = summarize_period(
        [_transfer(BANK, GCASH, "30000"), _transfer(GCASH, LOAN, "20000", "8000")],
        {GCASH}, {}, {BANK, GCASH, LOAN}, loan_names={LOAN: "Car"},
    )
    assert result["category_breakdown"]["Interest: Car"]["expenses"] == Decimal("8000")
    _assert_invariant(result)


def test_default_amortization_by_kind():
    assert default_amortization("home") == "reduce_term"
    assert default_amortization("auto") == "fixed"
    assert default_amortization("personal") == "fixed"


def test_due_dates_step_monthly_from_the_first_payment_and_clamp():
    assert due_date(date(2026, 3, 4), 8) == date(2026, 11, 4)
    assert due_date(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert due_date(date(2026, 1, 31), 2) == date(2026, 3, 31)


def test_propose_split_from_the_rate_and_bank_overrides():
    loan = SimpleNamespace(balance=Decimal("-100000"), loan_annual_rate=Decimal("12"),
                           loan_payment_amount=Decimal("5000"))
    assert propose_split(loan) == (Decimal("4000.00"), Decimal("1000.00"))
    assert propose_split(loan, principal=Decimal("4100"), interest=Decimal("900")) == (
        Decimal("4100.00"), Decimal("900.00"))
    assert propose_split(loan, total=Decimal("6000"), interest=Decimal("850")) == (
        Decimal("5150.00"), Decimal("850.00"))
    assert propose_split(loan, principal=Decimal("4500")) == (
        Decimal("4500.00"), Decimal("500.00"))
    # The final payment never takes more principal than is owed.
    small = SimpleNamespace(balance=Decimal("-1000"), loan_annual_rate=Decimal("12"),
                            loan_payment_amount=Decimal("5000"))
    assert propose_split(small) == (Decimal("1000.00"), Decimal("10.00"))


def test_amortize_pays_off_the_balance_and_a_prepayment_shortens_it():
    rows = amortize(Decimal("100000"), Decimal("6"), Decimal("2000"), date(2026, 11, 4))
    assert rows[0]["interest"] == Decimal("500.00")
    assert rows[0]["principal"] == Decimal("1500.00")
    assert sum(r["principal"] for r in rows) == Decimal("100000.00")
    assert rows[-1]["balance_after"] == Decimal("0.00")
    assert rows[1]["due_date"] == date(2026, 12, 4)

    shorter = amortize(Decimal("80000"), Decimal("6"), Decimal("2000"), date(2026, 11, 4))
    assert len(shorter) < len(rows)

    # A payment that never covers the interest never repays the loan.
    assert amortize(Decimal("100000"), Decimal("36"), Decimal("1000"), date(2026, 11, 4)) is None


def test_cents_normalises_whole_cents_and_refuses_finer_or_non_finite_values():
    assert cents(None) is None
    assert cents(Decimal("100.1")) == Decimal("100.10")
    assert cents(28239.05) == Decimal("28239.05")
    for bad in (Decimal("0.005"), 0.005, Decimal("NaN"), Decimal("Infinity")):
        with pytest.raises(LoanError):
            cents(bad)


def _reduce_term_loan(owed, rate="0"):
    return SimpleNamespace(loan_first_payment_date=date(2026, 10, 4), loan_kind="home",
                           loan_amortization="reduce_term", loan_payment_amount=Decimal("8000"),
                           loan_annual_rate=Decimal(rate), loan_term_months=None,
                           balance=-Decimal(owed))


def test_reduce_term_rows_keep_what_each_open_due_date_still_owes():
    # Oct 4 is unpaid, Nov 4 half paid, Dec 4 a quarter paid; 74,000 is owed at 0%.
    loan = _reduce_term_loan("74000")
    state = {"open": [(0, Decimal("8000.00")), (1, Decimal("4000.00")), (2, Decimal("6000.00")),
                      *((step, Decimal("8000.00")) for step in range(3, 40))]}

    rows = scheduled_dues(loan, state)
    assert [r["payment"] for r in rows[:4]] == [Decimal("8000.00"), Decimal("4000.00"),
                                                 Decimal("6000.00"), Decimal("8000.00")]
    assert [r["due_date"] for r in rows[:3]] == [date(2026, 10, 4), date(2026, 11, 4),
                                                  date(2026, 12, 4)]
    assert sum(r["principal"] for r in rows) == Decimal("74000.00")
    assert rows[-1]["balance_after"] == Decimal("0.00")


def test_reduce_term_rows_split_a_part_paid_due_date_interest_first():
    # 6% on 50,000 is 250 a month; 300 already paid on Nov 4 covers its interest.
    loan = _reduce_term_loan("50000", rate="6")
    state = {"open": [(0, Decimal("8000.00")), (1, Decimal("7700.00")),
                      *((step, Decimal("8000.00")) for step in range(2, 40))]}

    rows = scheduled_dues(loan, state)
    assert (rows[0]["interest"], rows[0]["principal"]) == (Decimal("250.00"), Decimal("7750.00"))
    assert rows[1]["payment"] == Decimal("7700.00")
    assert rows[1]["interest"] == Decimal("0.00")  # 211.25 due, already paid
    assert sum(r["principal"] for r in rows) == Decimal("50000.00")

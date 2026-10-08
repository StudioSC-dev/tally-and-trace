"""Pure tests for loan maths (``services/loans.py``) and loan interest in the summary."""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from app.models.transaction import TransactionType
from app.routers.transactions import summarize_period
from app.services.loans import amortize, default_amortization, due_date, propose_split

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

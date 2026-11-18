"""The bank statement contract an extractor sends (STU-746). Every figure is made up."""
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.schemas.statement_reconcile import BankStatement


def line(no, when, amount, kind="charge"):
    return {"line_no": no, "transaction_date": when, "description": f"Line {no}",
            "amount": amount, "kind": kind}


def statement(lines, **header):
    return BankStatement.model_validate(
        {"header": {"close_date": "2026-07-24", **header}, "lines": lines})


# --- AC7 --------------------------------------------------------------------------------


def test_header_that_does_not_add_up_states_the_gap():
    lines = [line(1, "2026-07-01", "400.00"), line(2, "2026-07-04", "35.00", "credit"),
             line(3, "2026-07-05", "1000.00", "payment")]
    ok = statement(lines, previous_balance="2000.00", payments_and_credits="1035.00",
                   total_due="1365.00")
    assert ok.header.total_due == Decimal("1365.00")
    with pytest.raises(ValidationError) as caught:
        statement(lines, previous_balance="2000.00", payments_and_credits="1035.00",
                  total_due="1400.00")
    assert ("previous_balance + charges - credits - payments = 1365.00, total_due = 1400.00,"
            " gap 35.00") in str(caught.value)


@pytest.mark.parametrize("bad, message", [
    ([line(1, "2026-07-01", "10.00"), line(1, "2026-07-02", "20.00")], "line_no must be unique"),
    ([line(1, "2026-07-01", "-10.00")], "greater than 0"),
    ([line(1, "2026-07-01", "10.005")], "no more than 2 decimal places"),
])
def test_bad_lines_are_rejected(bad, message):
    with pytest.raises(ValidationError) as caught:
        statement(bad, total_due="0.00")
    assert message in str(caught.value)


def test_a_third_decimal_place_in_the_header_is_rejected():
    with pytest.raises(ValidationError) as caught:
        statement([], total_due="1.001")
    assert "no more than 2 decimal places" in str(caught.value)

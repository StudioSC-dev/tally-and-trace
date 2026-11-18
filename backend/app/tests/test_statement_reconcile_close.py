"""Which of the card's closes a bank statement is compared with (STU-749,
``statement_reconcile_apply.app_close``). Pure: no database."""
from datetime import date

import pytest
from fastapi import HTTPException

from app.models.account import Account
from app.services.statement_reconcile_apply import NEAR_CLOSE_DAYS, app_close

TODAY = date(2026, 11, 18)


def _card(close_day):
    return Account(billing_cycle_start=close_day, days_until_due_date=21)


@pytest.mark.parametrize("close_day, stated, expected", [
    (14, date(2026, 11, 14), date(2026, 11, 14)),  # a close of the card
    (14, date(2026, 11, 15), date(2026, 11, 14)),  # a day after it, inside the open cycle
    (14, date(2026, 11, 13), date(2026, 11, 14)),  # a day before it
    (16, date(2026, 11, 13), date(2026, 11, 16)),  # before a close that is still open
    (24, date(2026, 10, 30), date(2026, 10, 24)),  # nearer the earlier of two closes
    (31, date(2026, 3, 3), date(2026, 2, 28)),     # a clamped close
])
def test_nearest_close(close_day, stated, expected):
    assert app_close(_card(close_day), stated, TODAY) == expected


def test_a_tie_is_always_beyond_the_bound():
    # Closes are at least 28 days apart, so a day equally far from two is 14 or more
    # days from each: refused, never resolved to either.
    assert NEAR_CLOSE_DAYS < 14
    with pytest.raises(HTTPException):  # 2027-02-01 and 2027-03-01, 14 days either side
        app_close(_card(1), date(2027, 2, 15), date(2027, 3, 18))


@pytest.mark.parametrize("close_day, stated", [
    (14, date(2026, 11, 18)),  # today has not closed
    (14, date(2026, 11, 20)),  # the future, whatever the card's day
    (20, date(2026, 11, 19)),  # the future, a day before the card's close
    (14, date(2026, 10, 30)),  # 16 days from every close
])
def test_not_a_closed_statement(close_day, stated):
    with pytest.raises(HTTPException) as caught:
        app_close(_card(close_day), stated, TODAY)
    assert (caught.value.status_code, caught.value.detail) == (
        422, "Not a closed statement of this card")

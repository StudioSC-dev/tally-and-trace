"""Unit tests for the budget-period helper behind allocation spending totals. No database."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

import app.routers.transactions as transactions_module
from app.models.allocation import Allocation, AllocationType, BudgetPeriodFrequency
from app.routers.transactions import _ensure_budget_period

SPENT = Decimal("500.00")


@pytest.fixture
def now_is(monkeypatch):
    def _set(value):
        monkeypatch.setattr(transactions_module, "naive_utc_now", lambda: value)

    return _set


def _allocation(start, end, frequency=BudgetPeriodFrequency.MONTHLY):
    return Allocation(
        allocation_type=AllocationType.BUDGET,
        current_amount=SPENT,
        period_frequency=frequency,
        period_start=start,
        period_end=end,
    )


def _snapshot(allocation):
    return (allocation.period_start, allocation.period_end, allocation.current_amount)


# (frequency, active start, active end, next end, a reference inside the next period)
FREQUENCIES = [
    (BudgetPeriodFrequency.DAILY, datetime(2026, 10, 6), datetime(2026, 10, 7), datetime(2026, 10, 8),
     datetime(2026, 10, 7, 15, 0)),
    (BudgetPeriodFrequency.WEEKLY, datetime(2026, 9, 28), datetime(2026, 10, 5), datetime(2026, 10, 12),
     datetime(2026, 10, 7, 15, 0)),
    (BudgetPeriodFrequency.MONTHLY, datetime(2026, 9, 1), datetime(2026, 10, 1), datetime(2026, 11, 1),
     datetime(2026, 10, 7, 15, 0)),
    (BudgetPeriodFrequency.QUARTERLY, datetime(2026, 7, 1), datetime(2026, 10, 1), datetime(2027, 1, 1),
     datetime(2026, 10, 7, 15, 0)),
]
NOW = datetime(2026, 10, 7, 18, 0)


@pytest.mark.parametrize("frequency,start,end,next_end,reference", FREQUENCIES)
def test_a_reference_inside_the_active_period_counts_without_reset(now_is, frequency, start, end, next_end, reference):
    now_is(NOW)
    allocation = _allocation(end, next_end, frequency)
    assert _ensure_budget_period(allocation, reference) is True
    assert _snapshot(allocation) == (end, next_end, SPENT)


@pytest.mark.parametrize("frequency,start,end,next_end,reference", FREQUENCIES)
def test_a_reference_in_the_current_period_rolls_forward_and_resets(now_is, frequency, start, end, next_end, reference):
    now_is(NOW)
    allocation = _allocation(start, end, frequency)
    assert _ensure_budget_period(allocation, reference) is True
    assert _snapshot(allocation) == (end, next_end, Decimal("0"))


@pytest.mark.parametrize("frequency,start,end,next_end,reference", FREQUENCIES)
def test_a_reference_before_the_period_is_historical(now_is, frequency, start, end, next_end, reference):
    now_is(NOW)
    allocation = _allocation(end, next_end, frequency)
    assert _ensure_budget_period(allocation, start) is False
    assert _snapshot(allocation) == (end, next_end, SPENT)


@pytest.mark.parametrize("frequency,start,end,next_end,reference", FREQUENCIES)
def test_a_reference_beyond_the_current_period_is_future(now_is, frequency, start, end, next_end, reference):
    now_is(NOW)
    allocation = _allocation(end, next_end, frequency)
    assert _ensure_budget_period(allocation, next_end + timedelta(hours=1)) is False
    assert _snapshot(allocation) == (end, next_end, SPENT)


@pytest.mark.parametrize(
    "frequency,expected_start,expected_end",
    [
        (BudgetPeriodFrequency.DAILY, datetime(2026, 10, 7), datetime(2026, 10, 8)),
        (BudgetPeriodFrequency.WEEKLY, datetime(2026, 10, 5), datetime(2026, 10, 12)),
        (BudgetPeriodFrequency.MONTHLY, datetime(2026, 10, 1), datetime(2026, 11, 1)),
        (BudgetPeriodFrequency.QUARTERLY, datetime(2026, 10, 1), datetime(2027, 1, 1)),
    ],
)
def test_a_missing_period_start_initialises_from_the_reference(now_is, frequency, expected_start, expected_end):
    now_is(NOW)
    allocation = _allocation(None, None, frequency)
    assert _ensure_budget_period(allocation, datetime(2026, 10, 7, 9, 0)) is True
    assert _snapshot(allocation) == (expected_start, expected_end, Decimal("0"))


def test_a_missing_period_start_with_a_future_reference_is_left_alone(now_is):
    now_is(NOW)
    allocation = _allocation(None, None)
    assert _ensure_budget_period(allocation, datetime(2026, 11, 10)) is False
    assert _snapshot(allocation) == (None, None, SPENT)


def test_a_missing_period_end_is_derived_from_period_start(now_is):
    now_is(NOW)
    allocation = _allocation(datetime(2026, 10, 1), None)
    assert _ensure_budget_period(allocation, datetime(2026, 10, 7, 9, 0)) is True
    assert _snapshot(allocation) == (datetime(2026, 10, 1), datetime(2026, 11, 1), SPENT)


def test_a_missing_period_end_does_not_re_anchor_on_a_historical_reference(now_is):
    now_is(NOW)
    allocation = _allocation(datetime(2026, 10, 1), None)
    assert _ensure_budget_period(allocation, datetime(2026, 9, 15)) is False
    assert _snapshot(allocation) == (datetime(2026, 10, 1), None, SPENT)


def test_a_stale_period_rolls_through_several_periods_to_the_current_one(now_is):
    now_is(NOW)
    allocation = _allocation(datetime(2026, 7, 1), datetime(2026, 8, 1))
    assert _ensure_budget_period(allocation, datetime(2026, 10, 2)) is True
    assert _snapshot(allocation) == (datetime(2026, 10, 1), datetime(2026, 11, 1), Decimal("0"))


def test_a_stale_period_rolls_only_as_far_as_the_reference(now_is):
    now_is(NOW)
    allocation = _allocation(datetime(2026, 7, 1), datetime(2026, 8, 1))
    assert _ensure_budget_period(allocation, datetime(2026, 8, 20)) is True
    assert _snapshot(allocation) == (datetime(2026, 8, 1), datetime(2026, 9, 1), Decimal("0"))


def test_a_period_that_has_not_started_yet_is_future(now_is):
    now_is(NOW)
    allocation = _allocation(datetime(2026, 11, 1), datetime(2026, 12, 1))
    assert _ensure_budget_period(allocation, datetime(2026, 11, 10)) is False
    assert _snapshot(allocation) == (datetime(2026, 11, 1), datetime(2026, 12, 1), SPENT)


@pytest.mark.parametrize(
    "reference,inside",
    [
        (datetime(2026, 10, 1, 0, 30, tzinfo=timezone(timedelta(hours=8))), False),
        (datetime(2026, 9, 30, 23, 30, tzinfo=timezone(timedelta(hours=-4))), True),
    ],
)
def test_offset_references_are_classified_in_utc(now_is, reference, inside):
    now_is(NOW)
    allocation = _allocation(datetime(2026, 10, 1), datetime(2026, 11, 1))
    assert _ensure_budget_period(allocation, reference) is inside
    assert _snapshot(allocation) == (datetime(2026, 10, 1), datetime(2026, 11, 1), SPENT)

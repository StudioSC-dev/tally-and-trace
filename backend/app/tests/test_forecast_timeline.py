"""
Unit tests for the dated running-balance timeline engine (pre-due-date solvency).

These are pure — no database — so they run anywhere. The headline test is the
worked example from the portfolio blog post: a month that closes positive but goes
insolvent mid-month before payday. If the engine ever stops flagging that, the
"month-end total lied" bug is back.
"""
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from app.models.transaction import RecurrenceFrequency
from app.services.forecast import (
    build_timeline,
    iter_occurrences,
    _monthly_equivalent,
)


def _entry(cadence, next_occurrence, **kw):
    """A minimal stand-in for a BudgetEntry ORM row."""
    defaults = dict(
        cadence=cadence,
        next_occurrence=next_occurrence,
        end_mode="indefinite",
        end_date=None,
        max_occurrences=None,
        semi_monthly_day_1=1,
        semi_monthly_day_2=15,
    )
    defaults.update(kw)
    return SimpleNamespace(**defaults)


# ---------------------------------------------------------------------------
# build_timeline — the solvency core
# ---------------------------------------------------------------------------

def test_worked_example_month_closes_positive_but_dips_negative():
    """The blog fixture: +175k close, but -35k on Aug 24 before payday."""
    opening = Decimal("120000")
    events = [
        {"date": datetime(2026, 8, 5), "name": "Rent", "amount": Decimal("-40000")},
        {"date": datetime(2026, 8, 14), "name": "Payroll #1", "amount": Decimal("60000")},
        {"date": datetime(2026, 8, 22), "name": "Card A", "amount": Decimal("-80000")},
        {"date": datetime(2026, 8, 24), "name": "Card B", "amount": Decimal("-95000")},
        {"date": datetime(2026, 8, 28), "name": "Payroll #2", "amount": Decimal("60000")},
        {"date": datetime(2026, 8, 30), "name": "Salary", "amount": Decimal("150000")},
    ]

    r = build_timeline(opening, events)

    assert r["closing_balance"] == Decimal("175000.00")   # month nets out fine...
    assert r["lowest_balance"] == Decimal("-35000.00")    # ...but you're underwater
    assert r["trough_date"] == datetime(2026, 8, 24).date()
    assert r["shortfall"] is True
    assert len(r["shortfalls"]) == 1
    assert r["shortfalls"][0]["date"] == datetime(2026, 8, 24).date()
    assert r["shortfalls"][0]["balance_after"] == Decimal("-35000.00")


def test_no_shortfall_when_income_arrives_first():
    """Same totals, but payday precedes the bills -> never negative."""
    opening = Decimal("120000")
    events = [
        {"date": datetime(2026, 8, 2), "name": "Salary", "amount": Decimal("150000")},
        {"date": datetime(2026, 8, 22), "name": "Card A", "amount": Decimal("-80000")},
        {"date": datetime(2026, 8, 24), "name": "Card B", "amount": Decimal("-95000")},
    ]
    r = build_timeline(opening, events)
    assert r["shortfall"] is False
    assert r["lowest_balance"] == Decimal("95000.00")
    assert r["closing_balance"] == Decimal("95000.00")


def test_same_day_tiebreak_processes_outflow_first():
    """A bill and income on the same day: the conservative order dips first."""
    opening = Decimal("100")
    events = [
        {"date": datetime(2026, 8, 10), "name": "Income", "amount": Decimal("50")},
        {"date": datetime(2026, 8, 10), "name": "Bill", "amount": Decimal("-120")},
    ]
    r = build_timeline(opening, events)
    # Outflow first: 100 - 120 = -20 (shortfall), then +50 = 30.
    assert r["shortfall"] is True
    assert r["lowest_balance"] == Decimal("-20.00")
    assert r["closing_balance"] == Decimal("30.00")


def test_decimal_precision_no_float_drift():
    opening = Decimal("0.10")
    events = [{"date": datetime(2026, 8, 1), "name": "x", "amount": Decimal("0.20")}]
    r = build_timeline(opening, events)
    assert r["closing_balance"] == Decimal("0.30")  # not 0.30000000000000004


def test_empty_events_trough_is_opening():
    r = build_timeline(Decimal("500"), [])
    assert r["closing_balance"] == Decimal("500.00")
    assert r["lowest_balance"] == Decimal("500.00")
    assert r["trough_date"] is None
    assert r["shortfall"] is False


# ---------------------------------------------------------------------------
# iter_occurrences — cadence expansion
# ---------------------------------------------------------------------------

def _dates(entry, start, end):
    return [o.date() for o in iter_occurrences(entry, start, end)]


def test_weekly_occurrences():
    e = _entry(RecurrenceFrequency.WEEKLY, datetime(2026, 8, 1))
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 8, 31))
    assert got == [
        datetime(2026, 8, d).date() for d in (1, 8, 15, 22, 29)
    ]


def test_biweekly_occurrences():
    e = _entry(RecurrenceFrequency.BIWEEKLY, datetime(2026, 8, 1))
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 8, 31))
    assert got == [datetime(2026, 8, d).date() for d in (1, 15, 29)]


def test_semi_monthly_default_days():
    e = _entry(RecurrenceFrequency.SEMI_MONTHLY, datetime(2026, 8, 1))
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 10, 1))
    assert got == [
        datetime(2026, 8, 1).date(), datetime(2026, 8, 15).date(),
        datetime(2026, 9, 1).date(), datetime(2026, 9, 15).date(),
    ]


def test_semi_monthly_custom_days():
    e = _entry(RecurrenceFrequency.SEMI_MONTHLY, datetime(2026, 8, 5),
               semi_monthly_day_1=5, semi_monthly_day_2=20)
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 9, 1))
    assert got == [datetime(2026, 8, 5).date(), datetime(2026, 8, 20).date()]


def test_semi_monthly_clamps_to_month_length():
    # Feb 2026 has 28 days; day 31 clamps to the 28th.
    e = _entry(RecurrenceFrequency.SEMI_MONTHLY, datetime(2026, 2, 1),
               semi_monthly_day_1=15, semi_monthly_day_2=31)
    got = _dates(e, datetime(2026, 2, 1), datetime(2026, 3, 1))
    assert got == [datetime(2026, 2, 15).date(), datetime(2026, 2, 28).date()]


def test_end_date_stops_occurrences():
    e = _entry(RecurrenceFrequency.MONTHLY, datetime(2026, 8, 1),
               end_mode="on_date", end_date=datetime(2026, 9, 15))
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 12, 1))
    assert got == [datetime(2026, 8, 1).date(), datetime(2026, 9, 1).date()]


def test_max_occurrences_caps_count():
    e = _entry(RecurrenceFrequency.MONTHLY, datetime(2026, 8, 1),
               end_mode="after_occurrences", max_occurrences=2)
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 12, 1))
    assert got == [datetime(2026, 8, 1).date(), datetime(2026, 9, 1).date()]


def test_occurrences_respect_window_start():
    # Anchor in the past; only occurrences inside the window are yielded.
    e = _entry(RecurrenceFrequency.MONTHLY, datetime(2026, 6, 1))
    got = _dates(e, datetime(2026, 8, 1), datetime(2026, 10, 1))
    assert got == [datetime(2026, 8, 1).date(), datetime(2026, 9, 1).date()]


# ---------------------------------------------------------------------------
# _monthly_equivalent — normalization for the new cadences
# ---------------------------------------------------------------------------

def test_monthly_equivalent_new_cadences():
    assert _monthly_equivalent(120.0, RecurrenceFrequency.SEMI_MONTHLY) == 240.0
    assert round(_monthly_equivalent(100.0, RecurrenceFrequency.WEEKLY), 2) == round(100 * 52 / 12, 2)
    assert round(_monthly_equivalent(100.0, RecurrenceFrequency.BIWEEKLY), 2) == round(100 * 26 / 12, 2)
    assert _monthly_equivalent(300.0, RecurrenceFrequency.MONTHLY) == 300.0

"""Unit tests for UC1 account-aware payment routing (pure, no database)."""
from datetime import datetime
from decimal import Decimal

from app.services.forecast import route_accounts

NAMES = {1: "Payroll", 2: "Checking"}


def _ev(day, amount, funding, overflow=None, name="bill"):
    return {
        "date": datetime(2026, 8, day),
        "name": name,
        "amount": Decimal(str(amount)),
        "funding_account_id": funding,
        "overflow_account_id": overflow,
    }


def test_primary_covers_no_shortfall():
    assert route_accounts({1: Decimal("100"), 2: Decimal("0")}, [_ev(5, -50, 1)], NAMES) == []


def test_overflow_fully_covers_no_shortfall():
    # Primary short 20, overflow has 100 -> covered, no shortfall.
    assert route_accounts({1: Decimal("30"), 2: Decimal("100")}, [_ev(5, -50, 1, 2)], NAMES) == []


def test_overflow_partial_records_shortfall():
    sf = route_accounts({1: Decimal("30"), 2: Decimal("10")}, [_ev(5, -50, 1, 2, name="Metrobank CC")], NAMES)
    assert len(sf) == 1
    assert sf[0]["account_id"] == 1
    assert sf[0]["account_name"] == "Payroll"
    assert sf[0]["short_amount"] == Decimal("10.00")   # 50 needed, 30+10 available
    assert sf[0]["overflow_used"] == Decimal("10.00")


def test_no_overflow_records_full_shortfall():
    sf = route_accounts({1: Decimal("30")}, [_ev(5, -50, 1)], NAMES)
    assert len(sf) == 1
    assert sf[0]["short_amount"] == Decimal("20.00")
    assert sf[0]["overflow_used"] == Decimal("0.00")


def test_income_into_account_then_payable_no_shortfall():
    sf = route_accounts({1: Decimal("0")}, [_ev(1, 100, 1), _ev(5, -50, 1)], NAMES)
    assert sf == []


def test_events_without_funding_account_are_ignored():
    assert route_accounts({1: Decimal("0")}, [_ev(5, -50, None)], NAMES) == []

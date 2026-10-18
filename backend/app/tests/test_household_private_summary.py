"""Pure tests for the period summary's Household line (``summarize_household_private``, STU-336).

Posted Household debits that rule (c) reads on a sharer's accounts outside the
caller's scope: grouped by record currency, by category name under the
creator-owns rule, never added into the caller's totals.
"""
from decimal import Decimal
from types import SimpleNamespace

from app.models.transaction import TransactionType
from app.models.user import CurrencyType
from app.routers.transactions import category_label, summarize_household_private

SHARER, OTHER = 1, 2
UTILITIES, GROCERIES, STALE = 10, 11, 12
NAMES = {UTILITIES: "Utilities", GROCERIES: "Groceries", STALE: "Someone else's"}
OWNERS = {UTILITIES: SHARER, GROCERIES: SHARER, STALE: OTHER}


def _row(amount, currency="PHP", category=None, kind=TransactionType.DEBIT, user=SHARER):
    return SimpleNamespace(transaction_type=kind, amount=Decimal(amount), currency=currency,
                           category_id=category, user_id=user)


def _summary(rows, default="PHP"):
    return summarize_household_private(rows, NAMES, OWNERS, default)


def test_h1_debits_grouped_by_record_currency_enum_or_string():
    result = _summary([
        _row("55.55", CurrencyType.PHP, UTILITIES),
        _row("10.00", "PHP", GROCERIES),
        _row("4.45", CurrencyType.PHP, UTILITIES),
        _row("20.00", CurrencyType.USD, UTILITIES),
        _row("1.50", "USD"),
    ])
    assert result == [
        {"currency": "PHP", "total_expenses": Decimal("70.00"), "transaction_count": 3,
         "category_breakdown": {"Utilities": Decimal("60.00"), "Groceries": Decimal("10.00")}},
        {"currency": "USD", "total_expenses": Decimal("21.50"), "transaction_count": 2,
         "category_breakdown": {"Utilities": Decimal("20.00"), "Uncategorized": Decimal("1.50")}},
    ]
    for part in result:
        assert sum(part["category_breakdown"].values(), Decimal("0")) == part["total_expenses"]


def test_h2_default_first_only_when_present_then_alphabetical():
    rows = [_row("1", "USD"), _row("2", "EUR"), _row("3", "PHP")]
    assert [p["currency"] for p in _summary(rows)] == ["PHP", "EUR", "USD"]
    assert [p["currency"] for p in _summary(rows, default="JPY")] == ["EUR", "PHP", "USD"]
    assert [p["currency"] for p in _summary(rows[:2])] == ["EUR", "USD"]
    assert _summary([]) == []


def test_h3_a_row_with_no_currency_is_skipped():
    result = _summary([_row("9", None, UTILITIES), _row("5", "PHP", UTILITIES)])
    assert result == [{"currency": "PHP", "total_expenses": Decimal("5"),
                       "transaction_count": 1, "category_breakdown": {"Utilities": Decimal("5")}}]
    assert _summary([_row("9", None)]) == []


def test_h4_credits_and_transfers_are_ignored():
    rows = [_row("444.41", kind=TransactionType.CREDIT, category=UTILITIES),
            _row("300", kind=TransactionType.TRANSFER, category=UTILITIES)]
    assert _summary(rows) == []
    assert _summary([*rows, _row("7")]) == [
        {"currency": "PHP", "total_expenses": Decimal("7"), "transaction_count": 1,
         "category_breakdown": {"Uncategorized": Decimal("7")}}]


def test_h5_stale_missing_and_deleted_categories_are_uncategorized():
    # STALE is owned by another user; 99 is not in the active names (deleted).
    result = _summary([_row("3", category=STALE), _row("4"), _row("5", category=99)])
    assert result[0]["category_breakdown"] == {"Uncategorized": Decimal("12")}
    assert "Someone else's" not in str(result)


def test_h6_category_label_is_the_summarys_rule():
    assert category_label(_row("1", category=UTILITIES), NAMES, OWNERS) == "Utilities"
    assert category_label(_row("1", category=STALE), NAMES, OWNERS) == "Uncategorized"
    assert category_label(_row("1", category=STALE), NAMES) == "Someone else's"
    assert category_label(_row("1"), NAMES, OWNERS) == "Uncategorized"
    assert category_label(_row("1", category=99), NAMES, OWNERS) == "Uncategorized"

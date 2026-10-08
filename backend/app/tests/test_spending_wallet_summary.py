"""Pure tests for the wallet-aware period summary (``summarize_period``)."""
from decimal import Decimal
from types import SimpleNamespace

from app.models.transaction import TransactionType
from app.routers.transactions import summarize_period

BANK, GCASH, CASH, CHECKING = 1, 2, 3, 4
WALLETS = {GCASH, CASH}
PARKING = 10
CATEGORIES = {PARKING: "Parking"}


def _debit(account, amount, category=None):
    return SimpleNamespace(transaction_type=TransactionType.DEBIT, account_id=account,
                           amount=Decimal(amount), category_id=category, transfer_fee=Decimal("0"),
                           transfer_from_account_id=None, transfer_to_account_id=None)


def _transfer(src, dst, amount, fee="0", category=None):
    return SimpleNamespace(transaction_type=TransactionType.TRANSFER, account_id=src,
                           amount=Decimal(amount), category_id=category, transfer_fee=Decimal(fee),
                           transfer_from_account_id=src, transfer_to_account_id=dst)


def _expenses_by_row(result):
    return {name: v["expenses"] for name, v in result["category_breakdown"].items()}


def _assert_invariant(result):
    total = sum((v["expenses"] for v in result["category_breakdown"].values()), Decimal("0"))
    assert total == result["total_expenses"]


def test_top_up_with_fee_plus_wallet_parking_expenses_2010():
    result = summarize_period(
        [_transfer(BANK, GCASH, "2000", "10"), _debit(GCASH, "500", PARKING)],
        WALLETS, CATEGORIES,
    )
    assert result["total_expenses"] == Decimal("2010")
    assert _expenses_by_row(result) == {
        "Transfer fees": Decimal("10"),
        "Parking": Decimal("500"),
        "Unallocated wallet spend": Decimal("1500"),
    }
    _assert_invariant(result)


def test_fee_on_a_wallet_to_wallet_transfer_is_not_expensed_again():
    result = summarize_period(
        [_transfer(BANK, GCASH, "1000", "5"), _transfer(GCASH, CASH, "300", "15")],
        WALLETS, CATEGORIES,
    )
    # Only the top-up (plus its fee) is the expense; the GCash fee is detail.
    assert result["total_expenses"] == Decimal("1005")
    assert _expenses_by_row(result) == {
        "Transfer fees": Decimal("20"),
        "Unallocated wallet spend": Decimal("985"),
    }
    _assert_invariant(result)


def test_fees_on_other_transfers_count_once_and_amounts_do_not():
    result = summarize_period(
        [_transfer(BANK, CHECKING, "5000", "25"), _debit(BANK, "120"), _debit(CHECKING, "80", PARKING)],
        WALLETS, CATEGORIES,
    )
    assert result["total_expenses"] == Decimal("225")
    assert _expenses_by_row(result) == {
        "Transfer fees": Decimal("25"),
        "Uncategorized": Decimal("120"),
        "Parking": Decimal("80"),
    }
    _assert_invariant(result)


def test_a_categorised_transfer_still_shows_its_fee_as_a_transfer_fee():
    result = summarize_period([_transfer(BANK, GCASH, "100", "2", PARKING)], WALLETS, CATEGORIES)
    assert _expenses_by_row(result) == {
        "Transfer fees": Decimal("2"), "Unallocated wallet spend": Decimal("100")}
    _assert_invariant(result)


def test_wallet_spending_without_a_top_up_shows_a_negative_unallocated_row():
    result = summarize_period([_debit(CASH, "300", PARKING)], WALLETS, CATEGORIES)
    assert result["total_expenses"] == Decimal("0")
    assert _expenses_by_row(result) == {
        "Parking": Decimal("300"), "Unallocated wallet spend": Decimal("-300")}
    _assert_invariant(result)

"""The backend installment split matches the shared one (STU-779).

Every case here is one of ``packages/shared/src/utils/installmentSplit.test.ts``
(``installment_split``), in money instead of centavos: the same totals, counts and
payments, so a wishlist installment bills what the Record card purchase form would.
"""
from decimal import Decimal

import pytest

from app.services.installment_split import installment_split, try_installment_split


def _c(centavos: int) -> Decimal:
    return Decimal(centavos) / 100


def _payments(split, months):
    return [split.amount] * (months - 1) + [split.final_amount]


def test_even_split():
    split = installment_split(Decimal("12000.00"), 12)
    assert split == (Decimal("1000.00"), Decimal("1000.00"))
    assert sum(_payments(split, 12)) == Decimal("12000.00")


def test_last_higher():
    split = installment_split(Decimal("10000.00"), 3)
    assert _payments(split, 3) == [Decimal("3333.33"), Decimal("3333.33"), Decimal("3333.34")]


def test_last_lower():
    split = installment_split(Decimal("20000.00"), 3)
    assert _payments(split, 3) == [Decimal("6666.67"), Decimal("6666.67"), Decimal("6666.66")]


@pytest.mark.parametrize("total", [7, 99, 100, 101, 150, 999_999, 1_000_000, 2_000_000,
                                   123_456_789])
@pytest.mark.parametrize("months", [1, 2, 3, 6, 7, 12, 24, 36, 360])
def test_rounds_half_up_with_the_difference_on_the_last(total, months):
    # The shared test's own oracle, on whole centavos.
    floor = total // months
    monthly = floor + 1 if (total - floor * months) * 2 >= months else floor
    last = total - monthly * (months - 1)
    split = try_installment_split(_c(total), months)
    if monthly <= 0 or last <= 0:
        assert split is None
        return
    assert split == (_c(monthly), _c(last))
    assert sum(_payments(split, months)) == _c(total)


def test_one_month():
    assert installment_split(Decimal("10000.00"), 1) == (Decimal("10000.00"), Decimal("10000.00"))
    assert installment_split(Decimal("0.01"), 1) == (Decimal("0.01"), Decimal("0.01"))


def test_two_months():
    assert installment_split(Decimal("10000.01"), 2) == (Decimal("5000.01"), Decimal("5000.00"))
    assert installment_split(Decimal("10000.00"), 2) == (Decimal("5000.00"), Decimal("5000.00"))


@pytest.mark.parametrize("total,months", [
    ("0.01", 2),  # last zero
    ("0.01", 3),  # monthly zero
    ("0.05", 8),  # last negative
    ("0.06", 4),  # last zero with a total above the count
])
def test_nonpositive_payment_rejected(total, months):
    assert try_installment_split(Decimal(total), months) is None
    with pytest.raises(ValueError, match=f"too small to split into {months} payments"):
        installment_split(Decimal(total), months)


@pytest.mark.parametrize("total,months", [
    (0, 3), (Decimal("1.005"), 3), (-1, 3), (100, 0), (100, 1.5), (100, True),
])
def test_refuses_a_total_or_count_that_is_not_positive_and_whole(total, months):
    with pytest.raises(ValueError):
        try_installment_split(total, months)


def test_accepts_floats_as_their_shortest_repr():
    # The API stores ``estimated_cost`` as Numeric(15, 2) but reads it as float.
    assert installment_split(1234.5, 3) == (Decimal("411.50"), Decimal("411.50"))

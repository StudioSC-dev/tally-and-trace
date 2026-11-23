"""A purchase total split into monthly installment payments (STU-779).

The server's copy of the shared split (``packages/shared/src/utils/installmentSplit.ts``,
STU-631, STU-658), so a wishlist installment bills exactly what the Record card purchase
form would. Money is counted in whole centavos: each payment but the last is the total
divided by the months, rounded half-up to the centavo, and the last payment is what that
leaves (higher or lower). ``app/tests/test_installment_split.py`` holds the parity cases.
"""
from decimal import Decimal
from typing import NamedTuple, Optional

_CENTS = Decimal("0.01")

TOO_SMALL_MESSAGE = "The price is too small to split into {months} payments"


class InstallmentSplit(NamedTuple):
    """Each payment but the last (``amount``) and the last (``final_amount``), in money."""
    amount: Decimal
    final_amount: Decimal


def _centavos(total) -> int:
    value = Decimal(str(total))
    centavos = value / _CENTS
    if value <= 0 or centavos != centavos.to_integral_value():
        raise ValueError("The total must be a positive amount with at most two decimal places")
    return int(centavos)


def try_installment_split(total, months: int) -> Optional[InstallmentSplit]:
    """``total`` split into ``months`` payments, or None when a payment would not be
    positive (a total too small for that many months, e.g. 0.01 over 2).

    ``total`` must be positive with at most two decimal places and ``months`` a
    positive whole number (a ValueError otherwise), as ``trySplitInstallment`` requires.
    """
    if isinstance(months, bool) or not isinstance(months, int) or months <= 0:
        raise ValueError("The months must be a positive whole number")
    cents = _centavos(total)
    floor = cents // months
    # Half-up on exact integers: the remainder is at least half of ``months``.
    monthly = floor + 1 if 2 * (cents - floor * months) >= months else floor
    last = cents - monthly * (months - 1)
    if monthly <= 0 or last <= 0:
        return None
    return InstallmentSplit(Decimal(monthly) * _CENTS, Decimal(last) * _CENTS)


def installment_split(total, months: int) -> InstallmentSplit:
    """``try_installment_split``, raising ValueError when the total is too small."""
    split = try_installment_split(total, months)
    if split is None:
        raise ValueError(TOO_SMALL_MESSAGE.format(months=months))
    return split

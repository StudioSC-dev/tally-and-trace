from datetime import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


class LoanPaymentCreate(BaseModel):
    """A scheduled loan payment. Money values are finite, with at most 2 decimals.

    Give the bank's figures (``principal`` and ``interest``) when you have them;
    otherwise the split is proposed from the loan's rate and the payment amount
    (``amount``, else the loan's ``loan_payment_amount``). With one figure and
    the total, the other is the difference.
    """
    from_account_id: Optional[int] = Field(None, gt=0)  # default: the loan's payment_account_id
    amount: Optional[Decimal] = Field(None, gt=0, decimal_places=2)
    principal: Optional[Decimal] = Field(None, ge=0, decimal_places=2)
    interest: Optional[Decimal] = Field(None, ge=0, decimal_places=2)
    transaction_date: Optional[datetime] = None  # default: now
    is_posted: bool = True
    description: Optional[str] = None


class LoanPrepaymentCreate(BaseModel):
    """Extra principal on a ``reduce_term`` loan (finite, at most 2 decimals)."""
    from_account_id: Optional[int] = Field(None, gt=0)  # default: the loan's payment_account_id
    amount: Decimal = Field(..., gt=0, decimal_places=2)
    transaction_date: Optional[datetime] = None  # default: now
    is_posted: bool = True
    description: Optional[str] = None

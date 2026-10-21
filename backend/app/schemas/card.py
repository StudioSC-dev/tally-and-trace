"""Credit-card request bodies (STU-343 Plan C, sections 2.5 and 2.6)."""
from datetime import date
from decimal import Decimal
from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.record_dates import check_record_date

Money = Annotated[Decimal, Field(ge=0, max_digits=15, decimal_places=2, allow_inf_nan=False)]


class StatementMinimumSet(BaseModel):
    """``PUT /cards/{account_id}/statements/{close_date}/minimum-due``: the
    minimum amount due printed on that statement."""
    model_config = ConfigDict(extra="forbid")

    amount: Money


class CardPaymentCreate(BaseModel):
    """``POST /cards/{account_id}/payments``: one transfer into the card.

    ``payment_date`` after Manila's today records a planned (pending) payment.
    """
    model_config = ConfigDict(extra="forbid")

    amount: Annotated[Decimal, Field(gt=0, max_digits=15, decimal_places=2,
                                     allow_inf_nan=False)]
    from_account_id: int = Field(..., gt=0)
    payment_date: date
    description: Optional[str] = Field(None, max_length=255)

    @field_validator("payment_date")
    @classmethod
    def _payment_date_in_range(cls, v):
        return check_record_date(v)

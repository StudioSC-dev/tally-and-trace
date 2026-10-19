"""Credit-card request bodies (STU-343 Plan C, sections 2.5 and 2.6)."""
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

Money = Annotated[Decimal, Field(ge=0, max_digits=15, decimal_places=2, allow_inf_nan=False)]


class StatementMinimumSet(BaseModel):
    """``PUT /cards/{account_id}/statements/{close_date}/minimum-due``: the
    minimum amount due printed on that statement."""
    model_config = ConfigDict(extra="forbid")

    amount: Money

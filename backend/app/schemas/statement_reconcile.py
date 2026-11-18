"""A card statement as an extractor sends it (STU-746).

The server never receives the statement file: an extractor reads it and sends the
header and the lines as JSON, in the card's currency. ``app.services.statement_reconcile``
compares it with the app's rows for that statement.

- A ``charge`` adds to the statement's line balance and a ``credit`` (a refund)
  takes from it. A ``payment`` is a card payment: a transfer into the card, never
  a line item, so it never changes the line balance.
- Every line amount is positive; ``kind`` gives its sign.
- When ``previous_balance`` and ``payments_and_credits`` are both given, the header
  must add up: ``previous_balance + charges - credits - payments == total_due``.
  A ``total_due`` or ``previous_balance`` may be zero or negative (a credit balance).
"""
from datetime import date
from decimal import Decimal
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

# At most two decimal places, finite.
Money = Annotated[Decimal, Field(decimal_places=2, allow_inf_nan=False)]
PositiveMoney = Annotated[Decimal, Field(gt=0, decimal_places=2, allow_inf_nan=False)]
NonNegativeMoney = Annotated[Decimal, Field(ge=0, decimal_places=2, allow_inf_nan=False)]

LineKind = Literal["charge", "credit", "payment"]


class StatementHeader(BaseModel):
    model_config = ConfigDict(extra="forbid")

    close_date: date
    total_due: Money
    due_date: Optional[date] = None
    minimum_due: Optional[NonNegativeMoney] = None
    previous_balance: Optional[Money] = None
    payments_and_credits: Optional[NonNegativeMoney] = None


class StatementLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line_no: Annotated[int, Field(ge=1)]
    transaction_date: date
    posting_date: Optional[date] = None
    description: str
    amount: PositiveMoney
    kind: LineKind
    original_amount: Optional[PositiveMoney] = None
    original_currency: Optional[Annotated[str, Field(pattern=r"^[A-Z]{3}$")]] = None

    @model_validator(mode="after")
    def _original_pair(self):
        if (self.original_amount is None) != (self.original_currency is None):
            raise ValueError("original_amount and original_currency go together")
        return self


class BankStatement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    header: StatementHeader
    lines: List[StatementLine]

    def total(self, kind: LineKind) -> Decimal:
        return sum((line.amount for line in self.lines if line.kind == kind), Decimal("0"))

    @property
    def line_balance(self) -> Decimal:
        """Charges less credits: the statement's line-item balance (payments excluded)."""
        return self.total("charge") - self.total("credit")

    @model_validator(mode="after")
    def _check(self):
        numbers = [line.line_no for line in self.lines]
        repeated = sorted({n for n in numbers if numbers.count(n) > 1})
        if repeated:
            raise ValueError(f"line_no must be unique; repeated: {repeated}")
        header = self.header
        if header.previous_balance is not None and header.payments_and_credits is not None:
            computed = (header.previous_balance + self.total("charge")
                        - self.total("credit") - self.total("payment"))
            if computed != header.total_due:
                raise ValueError(
                    "header does not add up: previous_balance + charges - credits - payments"
                    f" = {computed}, total_due = {header.total_due},"
                    f" gap {header.total_due - computed}")
        return self

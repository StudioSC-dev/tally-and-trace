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
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, List, Literal, Optional, Union

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


# --- A savings, checking or e-wallet statement (STU-753) ---------------------------------
#
# The same line fields as a card's, in the account's currency, with the kinds a bank
# prints: a ``debit`` takes money out of the account and a ``credit`` puts money in.
# A transfer between two of the user's accounts is a ``debit`` on the statement of the
# account it left and a ``credit`` on the one it reached. The header is the period
# (``period_start`` through ``period_end``, both included) and its balances; when
# ``opening_balance`` is given it must add up:
# ``opening_balance + credits - debits == closing_balance``.

AccountLineKind = Literal["debit", "credit"]


class AccountStatementHeader(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period_start: date
    period_end: date
    closing_balance: Money
    opening_balance: Optional[Money] = None

    @model_validator(mode="after")
    def _period(self):
        if self.period_end < self.period_start:
            raise ValueError("period_end is before period_start")
        return self


class AccountStatementLine(StatementLine):
    kind: AccountLineKind


class AccountStatement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    header: AccountStatementHeader
    lines: List[AccountStatementLine]

    def total(self, kind: AccountLineKind) -> Decimal:
        return sum((line.amount for line in self.lines if line.kind == kind), Decimal("0"))

    @property
    def line_balance(self) -> Decimal:
        """Debits less credits: what the period took from the account (the diff's
        ``line_balance`` counts a debit as it counts a card's charge)."""
        return self.total("debit") - self.total("credit")

    @property
    def change(self) -> Decimal:
        """Credits less debits: what the period added to the account's balance."""
        return -self.line_balance

    @model_validator(mode="after")
    def _check(self):
        numbers = [line.line_no for line in self.lines]
        repeated = sorted({n for n in numbers if numbers.count(n) > 1})
        if repeated:
            raise ValueError(f"line_no must be unique; repeated: {repeated}")
        header = self.header
        if header.opening_balance is not None:
            computed = header.opening_balance + self.change
            if computed != header.closing_balance:
                raise ValueError(
                    "header does not add up: opening_balance + credits - debits"
                    f" = {computed}, closing_balance = {header.closing_balance},"
                    f" gap {header.closing_balance - computed}")
        return self


# --- POST /cards/{account_id}/statements/reconcile (STU-749) ----------------------------

Fingerprint = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Value = Union[bool, date, Decimal, None]


class ReconcileRequest(BaseModel):
    """A dry run (``dry_run`` true) or an apply, which sends the dry run's
    ``fingerprint`` back."""
    model_config = ConfigDict(extra="forbid")

    statement: BankStatement
    dry_run: bool
    fingerprint: Optional[Fingerprint] = None

    @model_validator(mode="after")
    def _apply_needs_fingerprint(self):
        if not self.dry_run and self.fingerprint is None:
            raise ValueError("an apply needs the fingerprint of its dry run")
        return self


class HeaderDiffOut(BaseModel):
    field: Literal["close", "due", "minimum_due"]
    statement: Value
    app: Value


class FieldChangeOut(BaseModel):
    field: Literal["amount", "transaction_date", "posting_date", "is_posted"]
    before: Value
    after: Value


class NewRowOut(BaseModel):
    kind: LineKind
    amount: Decimal
    transaction_date: date
    posting_date: Optional[date] = None
    description: str


class ActionOut(BaseModel):
    kind: Literal["matched", "update", "move", "create", "unpost", "missing"]
    line_no: Optional[int] = None
    row_id: Optional[int] = None
    changes: List[FieldChangeOut] = []
    new_row: Optional[NewRowOut] = None
    possible_duplicate_of: Optional[int] = None
    # An apply's ``create``: the id of the row it added.
    created_row_id: Optional[int] = None


class DiffWarningOut(BaseModel):
    line_no: int
    reason: str


class ReconciliationOut(BaseModel):
    close_date: date
    total_due: Decimal
    line_balance: Decimal
    line_count: int
    reconciled_at: datetime
    reconciled_by_actor: Optional[int] = None


class ReconcileOut(BaseModel):
    """A dry run's diff, or an apply's applied actions and its reconciliation.

    ``notes`` are an apply's remarks that did not block it: each ``create`` whose
    line may duplicate a recurring row (``possible_duplicate_of``), and a line's
    original currency that no row can hold."""
    dry_run: bool
    fingerprint: str
    balanced: bool
    header: List[HeaderDiffOut]
    actions: List[ActionOut]
    warnings: List[DiffWarningOut]
    notes: List[str] = []
    reconciliation: Optional[ReconciliationOut] = None


# --- POST /accounts/{account_id}/statements/reconcile (STU-753) -------------------------


class AccountReconcileRequest(ReconcileRequest):
    """A savings, checking or e-wallet statement's dry run or apply."""
    statement: AccountStatement


class AccountNewRowOut(NewRowOut):
    kind: AccountLineKind


class AccountActionOut(ActionOut):
    kind: Literal["matched", "update", "move", "create", "unpost"]
    new_row: Optional[AccountNewRowOut] = None


class AccountReconciliationOut(BaseModel):
    period_start: date
    period_end: date
    opening_balance: Optional[Decimal] = None
    closing_balance: Decimal
    change: Decimal
    line_count: int
    reconciled_at: datetime
    reconciled_by_actor: Optional[int] = None


class AccountReconcileOut(ReconcileOut):
    """As ``ReconcileOut``; ``header`` is always empty (a bank account's header has
    nothing the app stores)."""
    actions: List[AccountActionOut]
    reconciliation: Optional[AccountReconciliationOut] = None

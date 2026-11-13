"""Credit-card request bodies (STU-343 Plan C, sections 2.5 and 2.6)."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.record_dates import check_record_date

Money = Annotated[Decimal, Field(ge=0, max_digits=15, decimal_places=2, allow_inf_nan=False)]


class StatementMinimumSet(BaseModel):
    """``PUT /cards/{account_id}/statements/{close_date}/minimum-due``: the
    minimum amount due printed on that statement."""
    model_config = ConfigDict(extra="forbid")

    amount: Money


class StatementDueSet(BaseModel):
    """``PUT /cards/{account_id}/statements/{close_date}/due-date``: the due
    date printed on that statement."""
    model_config = ConfigDict(extra="forbid")

    due_date: date


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


# --- Stored statements read API (STU-601, PERF-6; docs/statements-store.md) --------------------
# Shaped for later Hermes/MCP reads (STU-192): a statement's stable key is its
# card and close date. Fields absent from a limited (viewer) response are None
# and left out of the JSON.

class CardStatementSummaryOut(BaseModel):
    """One statement: every closed one and the cycle open on Manila's today."""
    close_date: date
    window_start: date
    due_date: date
    computed_due_date: date
    due_overridden: bool
    is_closed: bool
    status: str
    owed: float
    line_count: int
    incomplete: bool
    # Full view only (owner, admin, editor).
    balance: Optional[float] = None
    clear_through: Optional[float] = None
    outstanding: Optional[float] = None
    paid_since_close: Optional[float] = None


class CardStatementLineOut(BaseModel):
    date: datetime
    amount: float
    display_description: Optional[str] = None
    # Full view only.
    transaction_id: Optional[int] = None
    posted_date: Optional[date] = None


class CardStatementUnconvertedOut(BaseModel):
    """A line left out of the totals for want of a rate (full view only)."""
    date: datetime
    original_amount: float
    original_currency: str
    display_description: Optional[str] = None
    transaction_id: int


class CardStatementListOut(BaseModel):
    """``GET /cards/{account_id}/statements``."""
    view: str
    name: str
    currency: str
    card_id: Optional[int] = None
    statements: List[CardStatementSummaryOut]


class CardStatementDetailOut(BaseModel):
    """``GET /cards/{account_id}/statements/{close_date}``."""
    view: str
    name: str
    currency: str
    card_id: Optional[int] = None
    statement: CardStatementSummaryOut
    lines: List[CardStatementLineOut]
    unconverted_lines: Optional[List[CardStatementUnconvertedOut]] = None

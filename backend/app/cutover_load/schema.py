"""The ``cutover-input`` v1 schema (JSON, produced by C1).

Every model forbids unknown keys. Money is a decimal string with at most 2
places, a date is a ``YYYY-MM-DD`` local date, and an unknown
``schema_version`` is refused. Cross-row rules (references, the cutover
boundary, card statements, currencies, recurring entries) live in
``app.cutover_load.validate``.
"""

import re
from datetime import date
from decimal import Decimal
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool

from app.models.account import AccountType
from app.models.budget_entry import BudgetEntryType
from app.models.category import CategoryKind
from app.models.transaction import RecurrenceFrequency, TransactionType
from app.models.user import CurrencyType

SCHEMA_VERSION = 1

_MONEY = re.compile(r"^-?\d{1,13}(\.\d{1,2})?$")
_RATE = re.compile(r"^\d{1,3}(\.\d{1,4})?$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _money(value) -> Decimal:
    if not isinstance(value, str) or not _MONEY.match(value):
        raise ValueError("money must be a decimal string with at most 2 decimal places")
    return Decimal(value)


def _rate(value) -> Decimal:
    if not isinstance(value, str) or not _RATE.match(value):
        raise ValueError("a rate must be a decimal string with at most 4 decimal places")
    return Decimal(value)


def _date(value) -> date:
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not _DATE.match(value):
        raise ValueError("a date must be YYYY-MM-DD")
    return date.fromisoformat(value)


Money = Annotated[Decimal, BeforeValidator(_money)]
Rate = Annotated[Decimal, BeforeValidator(_rate)]
Day = Annotated[date, BeforeValidator(_date)]
Key = Annotated[str, Field(min_length=1, max_length=100)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class StatementAtCutover(_Model):
    close: Day
    owed: Money


class CardTerms(_Model):
    billing_cycle_start: int = Field(..., ge=1, le=31)
    days_until_due_date: Optional[int] = Field(None, ge=1, le=90)
    credit_limit: Optional[Money] = None
    payment_account_key: Optional[Key] = None
    payment_overflow_account_key: Optional[Key] = None
    statements_at_cutover: List[StatementAtCutover] = Field(default_factory=list)


class LoanTerms(_Model):
    loan_kind: Literal["personal", "auto", "home"]
    annual_rate: Rate
    term_months: int = Field(..., ge=1, le=600)
    payment_amount: Money
    first_payment_date: Day
    amortization: Optional[Literal["fixed", "reduce_term"]] = None
    payments_made_offset: int = Field(0, ge=0)
    payment_account_key: Optional[Key] = None
    # Decision 16: no due date of this loan is partly paid at the cutover. The
    # other fields cannot show it, so C1 sets it from the owner's confirmation;
    # validation refuses the load unless it is true.
    no_partial_due_at_cutover: Optional[StrictBool] = None


class AccountIn(_Model):
    key: Key
    name: str = Field(..., min_length=1, max_length=100)
    account_type: AccountType
    currency: CurrencyType
    is_spending_wallet: bool = False
    # App sign: cards and loans are negative while money is owed.
    balance_at_cutover: Money
    card: Optional[CardTerms] = None
    loan: Optional[LoanTerms] = None
    tags: List[str] = Field(default_factory=list)


class CategoryIn(_Model):
    key: Key
    name: str = Field(..., min_length=1, max_length=100)
    kind: CategoryKind


class TagIn(_Model):
    """A custom tag (the Household system tag is the owner's own, never listed here)."""
    name: str = Field(..., min_length=1, max_length=50)
    color: Optional[str] = Field(None, pattern=r"^#[0-9A-Fa-f]{6}$")


class TransactionIn(_Model):
    key: Key
    date: Day
    type: TransactionType
    account_key: Key
    to_account_key: Optional[Key] = None
    # Required except on an unposted foreign row, which carries only its face.
    amount: Optional[Money] = None
    # Transfers only. Into a loan: amount is the principal, transfer_fee the interest.
    transfer_fee: Optional[Money] = None
    received_amount: Optional[Money] = None
    face_amount: Optional[Money] = None
    face_currency: Optional[CurrencyType] = None
    is_posted: bool
    description: Optional[str] = None
    category_key: Optional[Key] = None
    tags: List[str] = Field(default_factory=list)


class Installment(_Model):
    total: int = Field(..., ge=1, le=720)
    paid_count: int = Field(..., ge=0, le=360)


class BudgetEntryIn(_Model):
    key: Key
    name: str = Field(..., min_length=1, max_length=150)
    entry_type: BudgetEntryType
    amount: Money
    currency: CurrencyType
    cadence: RecurrenceFrequency
    next_occurrence: Day
    semi_monthly_day_1: Optional[int] = Field(None, ge=1, le=31)
    semi_monthly_day_2: Optional[int] = Field(None, ge=1, le=31)
    end_mode: Literal["indefinite", "on_date", "after_occurrences"] = "indefinite"
    end_date: Optional[Day] = None
    account_key: Optional[Key] = None
    transfer_to_account_key: Optional[Key] = None
    overflow_account_key: Optional[Key] = None
    category_key: Optional[Key] = None
    is_autopay: bool = False
    is_active: bool = True
    tags: List[str] = Field(default_factory=list)
    last_imported_line_key: Optional[Key] = None
    description_contains: Optional[str] = Field(None, min_length=1)
    installment: Optional[Installment] = None


class CutoverInput(_Model):
    schema_version: Literal[1]
    owner_email: str = Field(..., min_length=3, max_length=255)
    cutover_date: Day
    load_date: Day
    timezone: Literal["Asia/Manila"]
    accounts: List[AccountIn] = Field(default_factory=list)
    categories: List[CategoryIn] = Field(default_factory=list)
    tags: List[TagIn] = Field(default_factory=list)
    transactions: List[TransactionIn] = Field(default_factory=list)
    budget_entries: List[BudgetEntryIn] = Field(default_factory=list)


def parse_input(raw: bytes) -> CutoverInput:
    """Parse the JSON bytes of a ``cutover-input`` file (``pydantic.ValidationError`` on failure)."""
    return CutoverInput.model_validate_json(raw)

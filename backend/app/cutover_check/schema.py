"""The ``cutover-frozen`` v1 file: the figures the check compares the database with.

JSON, validated by Pydantic with unknown keys refused. Money is a decimal string
with at most 2 places; dates are ``YYYY-MM-DD`` local dates and months ``YYYY-MM``.
An account is named by a selector ``{name, account_type, currency}``, which must
be unique among the owner's accounts (checked against the database by ``check``).

It never references the cutover input file.
"""

from __future__ import annotations

import json
import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Annotated, Dict, List, Literal, Optional, Tuple

from pydantic import (
    BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator,
)
from pydantic.functional_validators import BeforeValidator
from pydantic_core import PydanticCustomError

# ASCII digits only, matched in full (``$`` would accept a trailing newline).
_MONEY = re.compile(r"-?[0-9]+(\.[0-9]{1,2})?", re.ASCII)
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", re.ASCII)
_MONTH = re.compile(r"[0-9]{4}-(0[1-9]|1[0-2])", re.ASCII)

# Every message the file's validators raise, by error type. ``describe`` prints only
# these and the fixed texts for pydantic's own types: never an error's ``msg``, which
# for a parser or validator can carry the input.
_MESSAGES = {
    "cutover_as_of": "as_of cannot be before cutover_date",
    "cutover_card_routing_duplicate": "card_routing lists an account twice",
    "cutover_checkpoint_duplicate": "a checkpoint lists an account twice",
    "cutover_date": "dates are YYYY-MM-DD strings",
    "cutover_day_fields": "anchor_day and day_rule are exclusive and go with a monthly, "
                          "quarterly, semi_annual or annual cadence",
    "cutover_dated_late": "sheet.dated_items must be dated before as_of",
    "cutover_dated_zero": "dated item amount cannot be zero",
    "cutover_description_empty": "description_contains is empty",
    "cutover_expected_empty": "expected lists no month",
    "cutover_expected_gap": "expected months must be contiguous",
    "cutover_expected_negative": "expected counts cannot be negative",
    "cutover_first_month": "sheet.first_month must start on or after cutover_date",
    "cutover_installment": "installment goes with end_mode after_occurrences",
    "cutover_loans_duplicate": "loans lists an account twice",
    "cutover_money": "money must be a decimal string with at most 2 places",
    "cutover_month": "months are YYYY-MM strings",
    "cutover_next_dates": "next_dates holds 12 dates at most",
    "cutover_next_rows": "next_rows holds the first 3 upcoming rows at most",
    "cutover_recurring_duplicate": "recurring entries must be unique by (name, account, destination)",
    "cutover_semi_monthly": "semi_monthly_days goes with a semi_monthly cadence",
    "cutover_sheet_currency": "sheet.currency must be the sheet account's currency",
    "cutover_sheet_difference": "an approved difference falls outside sheet.months",
    "cutover_sheet_gap": "sheet.months must be contiguous",
    "cutover_sheet_month_end": "sheet.month_end must hold exactly the months in sheet.months",
    "cutover_sheet_start": "sheet.months must start at sheet.first_month",
    "cutover_statement_duplicate": "a card statement is listed twice (same card and close)",
}

_BUILTIN = {
    "extra_forbidden": "Extra inputs are not permitted",
    "missing": "Field required",
    "literal_error": "not one of the allowed values",
    "string_type": "must be a string",
    "int_type": "must be an integer",
    "int_parsing": "must be an integer",
    "int_from_float": "must be an integer",
    "bool_type": "must be true or false",
    "bool_parsing": "must be true or false",
    "list_type": "must be a list",
    "tuple_type": "must be a list",
    "dict_type": "must be an object",
    "model_type": "must be an object",
    "model_attributes_type": "must be an object",
    "too_short": "has too few items",
    "too_long": "has too many items",
    "greater_than": "is too small",
    "greater_than_equal": "is too small",
    "less_than": "is too large",
    "less_than_equal": "is too large",
}


def _fail(code: str) -> PydanticCustomError:
    return PydanticCustomError(code, _MESSAGES[code])


def _money(value) -> Decimal:
    if not isinstance(value, str) or not _MONEY.fullmatch(value):
        raise _fail("cutover_money")
    try:
        return Decimal(value)
    except InvalidOperation:  # pragma: no cover - the pattern already rules it out
        raise _fail("cutover_money") from None


def _date(value) -> date:
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise _fail("cutover_date")
    try:
        return date.fromisoformat(value)
    except ValueError:  # e.g. day 30 of February; the parser's message echoes the input
        raise _fail("cutover_date") from None


def _month(value) -> str:
    if not isinstance(value, str) or not _MONTH.fullmatch(value):
        raise _fail("cutover_month")
    return value


Money = Annotated[Decimal, BeforeValidator(_money)]
Day = Annotated[date, BeforeValidator(_date)]
Month = Annotated[str, BeforeValidator(_month)]


def month_start(month: str) -> date:
    year, mon = month.split("-")
    return date(int(year), int(mon), 1)


def month_of(day: date) -> str:
    return f"{day.year:04d}-{day.month:02d}"


def add_months(month: str, n: int) -> str:
    year, mon = (int(p) for p in month.split("-"))
    index = year * 12 + (mon - 1) + n
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def months_between(first: str, last: str) -> int:
    """How many months ``last`` is after ``first``."""
    fy, fm = (int(p) for p in first.split("-"))
    ly, lm = (int(p) for p in last.split("-"))
    return (ly * 12 + lm) - (fy * 12 + fm)


def _contiguous(months: List[str]) -> bool:
    return all(months_between(a, b) == 1 for a, b in zip(months, months[1:]))


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Selector(_Strict):
    name: str
    account_type: Literal["cash", "e_wallet", "savings", "checking", "credit", "loan"]
    currency: Literal["PHP", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF"]

    def key(self) -> Tuple[str, str, str]:
        return (self.name, self.account_type, self.currency)

    def label(self) -> str:
        return f"{self.name} ({self.account_type}, {self.currency})"


class Balance(_Strict):
    account: Selector
    amount: Money


class Checkpoint(_Strict):
    date: Day
    point: Literal["start_of_day", "end_of_day"]
    balances: List[Balance]

    @model_validator(mode="after")
    def _unique_accounts(self):
        keys = [b.account.key() for b in self.balances]
        if len(keys) != len(set(keys)):
            raise _fail("cutover_checkpoint_duplicate")
        return self


class CardStatement(_Strict):
    card: Selector
    close: Day
    due: Day
    balance: Money
    owed: Money


class CardRouting(_Strict):
    card: Selector
    payment_account: Optional[Selector]
    overflow_account: Optional[Selector]


class LoanRow(_Strict):
    due_date: Day
    payment: Money
    principal: Optional[Money] = None
    interest: Optional[Money] = None


class Loan(_Strict):
    loan: Selector
    payment_account: Optional[Selector]
    owed: Money
    payments_made: int
    payments_left: Optional[int]
    next_due: Optional[Day]
    next_rows: List[LoanRow]

    @field_validator("next_rows")
    @classmethod
    def _first_three(cls, rows):
        if len(rows) > 3:
            raise _fail("cutover_next_rows")
        return rows


_MONTH_FAMILY = frozenset({"monthly", "quarterly", "semi_annual", "annual"})
MAX_NEXT_DATES = 12


class Installment(_Strict):
    n: int
    m: int


class Recurring(_Strict):
    name: str
    account: Selector
    destination: Optional[Selector]
    overflow_account: Optional[Selector]
    entry_type: Literal["income", "expense"]
    amount: Money
    currency: Literal["PHP", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF"]
    cadence: Literal["weekly", "biweekly", "semi_monthly", "monthly", "quarterly",
                     "semi_annual", "annual"]
    semi_monthly_days: Optional[Tuple[int, int]] = None
    next_occurrence: Day
    end_mode: Literal["indefinite", "on_date", "after_occurrences"]
    end_date: Optional[Day] = None
    max_occurrences: Optional[int] = None
    is_autopay: bool
    is_active: bool
    description_contains: Optional[str] = None
    installment: Optional[Installment] = None
    # Occurrence multiplicity per month; absent only on a wallet-funded
    # non-transfer entry, which the projection never lists (checked by definition).
    expected: Optional[Dict[Month, int]] = None
    # STU-315. day_rule is always compared (absent means none, so an unexpected
    # rule fails); anchor_day and next_dates only when frozen. next_dates are the
    # entry's first occurrences from next_occurrence on, caps and end_date applied.
    day_rule: Optional[Literal["last_weekday"]] = None
    anchor_day: Optional[Annotated[int, Field(ge=1, le=31)]] = None
    next_dates: Optional[List[Day]] = None

    def key(self) -> tuple:
        return (self.name, self.account.key(),
                self.destination.key() if self.destination else None)

    def label(self) -> str:
        to = f" -> {self.destination.label()}" if self.destination else ""
        return f"{self.name} on {self.account.label()}{to}"

    @model_validator(mode="after")
    def _shape(self):
        if (self.cadence == "semi_monthly") != (self.semi_monthly_days is not None):
            raise _fail("cutover_semi_monthly")
        if (self.end_mode == "after_occurrences") != (self.installment is not None):
            raise _fail("cutover_installment")
        if self.description_contains is not None and not self.description_contains.strip():
            raise _fail("cutover_description_empty")
        if (self.anchor_day is not None or self.day_rule is not None) and (
                (self.anchor_day is not None and self.day_rule is not None)
                or self.cadence not in _MONTH_FAMILY):
            raise _fail("cutover_day_fields")
        if self.next_dates is not None and len(self.next_dates) > MAX_NEXT_DATES:
            raise _fail("cutover_next_dates")
        if self.expected is not None:
            months = sorted(self.expected)
            if not months:
                raise _fail("cutover_expected_empty")
            if not _contiguous(months):
                raise _fail("cutover_expected_gap")
            if any(count < 0 for count in self.expected.values()):
                raise _fail("cutover_expected_negative")
        return self


class ApprovedDifference(_Strict):
    month: Month
    amount: Money
    reason: str


class DatedItem(_Strict):
    date: Day
    amount: Money
    description_contains: str

    @model_validator(mode="after")
    def _non_zero(self):
        if self.amount == 0:
            raise _fail("cutover_dated_zero")
        return self


class Sheet(_Strict):
    account: Selector
    currency: Literal["PHP", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF"]
    first_month: Month
    months: List[Month]
    sheet_opening: Money
    month_end: Dict[Month, Money]
    opening_offset: Money
    overflow_policy: Literal["excluded", "included"]
    approved_differences: List[ApprovedDifference]
    dated_items: List[DatedItem]

    @model_validator(mode="after")
    def _shape(self):
        if self.currency != self.account.currency:
            raise _fail("cutover_sheet_currency")
        if not self.months or self.months[0] != self.first_month:
            raise _fail("cutover_sheet_start")
        if not _contiguous(self.months):
            raise _fail("cutover_sheet_gap")
        if set(self.month_end) != set(self.months):
            raise _fail("cutover_sheet_month_end")
        stray = {d.month for d in self.approved_differences} - set(self.months)
        if stray:
            raise _fail("cutover_sheet_difference")
        return self


class Frozen(_Strict):
    schema_version: Literal[1]
    owner_email: str
    cutover_date: Day
    as_of: Day
    timezone: Literal["Asia/Manila"]
    checkpoints: List[Checkpoint]
    card_statements: List[CardStatement]
    card_routing: List[CardRouting]
    loans: List[Loan]
    recurring: List[Recurring]
    sheet: Sheet

    @model_validator(mode="after")
    def _shape(self):
        if self.as_of < self.cutover_date:
            raise _fail("cutover_as_of")
        if month_start(self.sheet.first_month) < self.cutover_date:
            raise _fail("cutover_first_month")
        late = [d for d in self.sheet.dated_items if d.date >= self.as_of]
        if late:
            raise _fail("cutover_dated_late")
        seen = set()
        for s in self.card_statements:
            key = (s.card.key(), s.close)
            if key in seen:
                raise _fail("cutover_statement_duplicate")
            seen.add(key)
        for name, items in (("card_routing", [r.card for r in self.card_routing]),
                            ("loans", [x.loan for x in self.loans])):
            keys = [s.key() for s in items]
            if len(keys) != len(set(keys)):
                raise _fail(f"cutover_{name}_duplicate")
        keys = [r.key() for r in self.recurring]
        if len(keys) != len(set(keys)):
            raise _fail("cutover_recurring_duplicate")
        return self


class FrozenError(ValueError):
    """The frozen file is unreadable or invalid."""


def load_frozen(path: str) -> Frozen:
    """Read and validate a frozen file; an unknown ``schema_version`` is refused."""
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        raise FrozenError(f"frozen file could not be read ({type(exc).__name__})") from None
    return parse_frozen(raw)


def parse_frozen(raw) -> Frozen:
    if not isinstance(raw, dict):
        raise FrozenError("frozen file must be a JSON object")
    if raw.get("schema_version") != 1:
        raise FrozenError("unknown schema_version (only 1 is supported)")
    try:
        return Frozen.model_validate(raw)
    except ValidationError as exc:
        raise FrozenError("frozen file is invalid: " + describe(exc)) from None


def _field_names() -> set:
    names, todo = set(), [_Strict]
    while todo:
        model = todo.pop()
        names.update(getattr(model, "model_fields", {}))
        todo.extend(model.__subclasses__())
    return names


def describe(exc: ValidationError) -> str:
    """Each error as its location and message, never its input: field names and list
    positions are shown, any other key (a month, an unknown key) as ``<key>``, and
    the text is looked up by error type (``_MESSAGES``, ``_BUILTIN``), never taken
    from the error, so no input reaches it."""
    known = _field_names()
    parts = []
    for err in exc.errors(include_input=False, include_url=False, include_context=False):
        loc = ".".join(str(p) if isinstance(p, int) or p in known else "<key>"
                       for p in err["loc"])
        kind = err["type"]
        text = _MESSAGES.get(kind) or _BUILTIN.get(kind) or "invalid value"
        parts.append(f"{loc or '<file>'}: {text} [{kind}]")
    return f"{len(parts)} error(s): " + "; ".join(parts)

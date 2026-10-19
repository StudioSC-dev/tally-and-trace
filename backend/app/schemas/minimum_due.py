"""A credit card's minimum amount due rule (STU-343 Plan C, section 2.4).

How the card's bank works out the minimum amount due at a statement close. It is
stored on ``accounts.minimum_due_rule`` as ``rule.model_dump(mode="json")``, so
every Decimal is a string and loses no precision, and parsed back through
``MinimumDueRule`` on read. ``app.services.minimum_due.minimum_due`` applies it.

Inputs at a close: T (outstanding), I (installment amortizations billed in the
cycle), N (new non-installment debits and advances), O (overdue), L (overlimit).

- ``base_excludes``: inputs subtracted from T before ``base_percent`` applies.
- ``floored_terms``: terms added to the percentage before the floor is compared.
- ``added_terms``: terms added after the floor.
- ``floor``: the minimum per card currency; a currency it lacks counts as 0.

Terms: ``installments`` = I x installment_percent/100, ``overdue`` = O,
``overlimit`` = L, ``annual_fee_twelfth`` = annual_fee/12 (0 when unset),
``max_overdue_overlimit`` = max(O, L).
"""
from decimal import Decimal
from typing import Annotated, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.user import CurrencyType

Term = Literal["installments", "overdue", "overlimit", "annual_fee_twelfth",
               "max_overdue_overlimit"]
BaseExclusion = Literal["installments", "overlimit", "overdue", "new_transactions"]
PresetKey = Literal["bdo", "bdo_installment", "metrobank", "security_bank", "hsbc", "custom"]
Rounding = Literal["half_up", "down", "up"]

NonNegative = Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]


def _unique(values: list, name: str) -> list:
    if len(set(values)) != len(values):
        raise ValueError(f"{name} must not repeat a value")
    return values


class MinimumDueRule(BaseModel):
    """A card's minimum due rule. Every Decimal is finite; serialised as strings."""
    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    preset: PresetKey
    base_percent: Annotated[Decimal, Field(gt=0, le=100, allow_inf_nan=False)]
    base_excludes: List[BaseExclusion] = Field(default_factory=list)
    installment_percent: Optional[
        Annotated[Decimal, Field(ge=0, le=100, allow_inf_nan=False)]] = None
    floor: Dict[CurrencyType, NonNegative] = Field(default_factory=dict)
    floored_terms: List[Term] = Field(default_factory=list)
    added_terms: List[Term] = Field(default_factory=list)
    annual_fee: Optional[NonNegative] = None
    rounding: Rounding

    @field_validator("base_excludes")
    @classmethod
    def _unique_excludes(cls, v):
        return _unique(v, "base_excludes")

    @field_validator("floored_terms")
    @classmethod
    def _unique_floored(cls, v):
        return _unique(v, "floored_terms")

    @field_validator("added_terms")
    @classmethod
    def _unique_added(cls, v):
        return _unique(v, "added_terms")

    @model_validator(mode="after")
    def _terms_consistent(self):
        both = set(self.floored_terms) & set(self.added_terms)
        if both:
            raise ValueError(
                f"A term is either floored or added, not both: {', '.join(sorted(both))}")
        terms = set(self.floored_terms) | set(self.added_terms)
        if "installments" in terms and self.installment_percent is None:
            raise ValueError("The installments term needs installment_percent")
        if "max_overdue_overlimit" in terms and terms & {"overdue", "overlimit"}:
            raise ValueError(
                "max_overdue_overlimit replaces the overdue and overlimit terms; use one or the other")
        return self


class MinimumDuePresetOut(BaseModel):
    """A bank preset (``GET /accounts/minimum-due-presets``)."""
    key: Literal["bdo", "bdo_installment", "metrobank", "security_bank", "hsbc"]
    label: str
    effective_from: str
    rule: MinimumDueRule

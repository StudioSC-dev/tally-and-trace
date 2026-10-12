"""Household views (STU-233): one sharer's Household view at a time."""
from typing import List, Literal

from pydantic import BaseModel, ConfigDict, Field


class HouseholdViewOut(BaseModel):
    """One Household view the caller can open: their own, or a sharer's."""

    sharer_id: int
    sharer_name: str
    is_self: bool


class HouseholdSharer(BaseModel):
    id: int
    name: str


class MonthlyCurrencyLine(BaseModel):
    """One currency's totals for one month (no conversion, never two currencies)."""

    currency: str
    income: float
    expense: float
    fees: float
    moved_in: float
    moved_out: float
    paid_from_other_accounts: float


class MonthlyRow(BaseModel):
    month: str  # YYYY-MM
    kind: Literal["recorded", "current", "projected"]
    currencies: List[MonthlyCurrencyLine]


class HouseholdMonthlyResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    sharer: HouseholdSharer
    from_: str = Field(alias="from")
    to: str
    months: List[MonthlyRow]

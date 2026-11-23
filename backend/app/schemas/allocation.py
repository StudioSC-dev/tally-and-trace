from pydantic import BaseModel, Field, model_validator
from typing import Optional, List, Dict, Any
from datetime import datetime
from app.models.allocation import AllocationType, BudgetPeriodFrequency

# How a savings allocation tracks its progress (``configuration.goal_mode``, STU-777).
TARGET_BALANCE = "target_balance"
MULTI_ACCOUNT = "multi_account"
TRANSACTION_TOTAL = "transaction_total"
GOAL_MODES = (TARGET_BALANCE, MULTI_ACCOUNT, TRANSACTION_TOTAL)


def goal_mode(configuration) -> str:
    """A stored savings allocation's tracking mode; missing or unknown is ``target_balance``."""
    mode = configuration.get("goal_mode") if isinstance(configuration, dict) else None
    return mode if mode in GOAL_MODES else TARGET_BALANCE


def account_rule_error(allocation_type, configuration, account_id) -> Optional[str]:
    """Why an allocation's account (or tracking mode) is invalid, or None (STU-777).

    Budgets, goals and ``target_balance`` savings need an account.
    ``multi_account`` savings need at least one id in ``configuration.account_ids``
    (the first is stored as the account). ``transaction_total`` savings need none.
    A savings ``goal_mode`` must be one of ``GOAL_MODES``; a missing one is
    ``target_balance``.
    """
    if allocation_type == AllocationType.SAVINGS:
        raw = configuration.get("goal_mode") if isinstance(configuration, dict) else None
        if raw is not None and raw not in GOAL_MODES:
            return f"configuration.goal_mode must be one of {', '.join(GOAL_MODES)}"
        mode = raw or TARGET_BALANCE
        if mode == MULTI_ACCOUNT:
            ids = configuration.get("account_ids")
            if not isinstance(ids, list) or not ids:
                return ("A multi_account savings allocation needs at least one account "
                        "in configuration.account_ids")
            return None
        if mode == TRANSACTION_TOTAL:
            return None
    if account_id is None:
        return "account_id is required for this allocation"
    return None


class AllocationBase(BaseModel):
    account_id: Optional[int] = Field(None, gt=0)
    name: str = Field(..., min_length=1, max_length=100)
    allocation_type: AllocationType
    description: Optional[str] = None

    # Financial details
    target_amount: Optional[float] = Field(None, ge=0)
    current_amount: float = Field(default=0.0, ge=0)
    monthly_target: Optional[float] = Field(None, ge=0)
    target_date: Optional[datetime] = None
    period_frequency: Optional[BudgetPeriodFrequency] = None
    period_start: Optional[datetime] = None
    period_end: Optional[datetime] = None
    is_active: bool = True
    configuration: Optional[Dict[str, Any]] = None


class AllocationCreate(AllocationBase):
    @model_validator(mode="after")
    def _account_per_mode(self):
        problem = account_rule_error(self.allocation_type, self.configuration, self.account_id)
        if problem:
            raise ValueError(problem)
        return self


class AllocationUpdate(BaseModel):
    account_id: Optional[int] = Field(None, gt=0)
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    allocation_type: Optional[AllocationType] = None
    description: Optional[str] = None
    target_amount: Optional[float] = Field(None, ge=0)
    current_amount: Optional[float] = Field(None, ge=0)
    monthly_target: Optional[float] = Field(None, ge=0)
    target_date: Optional[datetime] = None
    period_frequency: Optional[BudgetPeriodFrequency] = None
    period_start: Optional[datetime] = None
    period_end: Optional[datetime] = None
    is_active: Optional[bool] = None
    configuration: Optional[Dict[str, Any]] = None


class AllocationResponse(AllocationBase):
    id: int
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class AllocationListResponse(BaseModel):
    items: List[AllocationResponse]
    total: int
    has_more: bool

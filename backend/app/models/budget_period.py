from sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer, Numeric, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base
from app.models.user import CurrencyType


class BudgetPeriod(Base):
    """A budget's closed window, stored when the budget rolls past it (STU-795).

    ``start`` and ``end`` are naive UTC, like ``allocations.period_start`` and
    ``period_end``. ``limit`` and ``currency`` are the budget's at the roll (its
    ``target_amount``, else ``monthly_target``; null without either).
    ``carry_from`` is the budget's ``carry_over_from`` while the window was
    current, null when carry was off: rows sharing a ``carry_from`` form one
    carry chain. Only ``services.budget_periods`` writes these rows.
    """
    __tablename__ = "budget_periods"
    __table_args__ = (
        UniqueConstraint("allocation_id", "start", name="uq_budget_periods_allocation_start"),
    )

    id = Column(Integer, primary_key=True)
    allocation_id = Column(
        Integer, ForeignKey("allocations.id", ondelete="CASCADE"), nullable=False)
    start = Column(DateTime, nullable=False)
    end = Column(DateTime, nullable=False)
    limit = Column(Numeric(15, 2), nullable=True)
    currency = Column(Enum(CurrencyType), nullable=False)
    carry_from = Column(DateTime, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

from sqlalchemy import Column, Integer, String, Float, DateTime, Text, ForeignKey, Enum, Boolean, JSON
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.models.user import CurrencyType
import enum


class AllocationType(str, enum.Enum):
    SAVINGS = "savings"
    BUDGET = "budget"
    GOAL = "goal"


class BudgetPeriodFrequency(str, enum.Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Allocation(Base):
    __tablename__ = "allocations"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)

    name = Column(String(100), nullable=False, index=True)
    allocation_type = Column(
        Enum(AllocationType, values_callable=_enum_values, name="allocationtype"),
        nullable=False,
    )
    description = Column(Text, nullable=True)

    # Financial details
    target_amount = Column(Float, nullable=True)
    current_amount = Column(Float, default=0.0, nullable=False)
    monthly_target = Column(Float, nullable=True)
    currency = Column(Enum(CurrencyType), default=CurrencyType.PHP)
    configuration = Column(JSON, nullable=True)
    period_frequency = Column(
        Enum(
            BudgetPeriodFrequency,
            values_callable=_enum_values,
            name="allocationperiodfrequency",
        ),
        nullable=True,
    )
    period_start = Column(DateTime, nullable=True)
    period_end = Column(DateTime, nullable=True)

    # Goal settings
    target_date = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="allocations")
    entity = relationship("Entity", back_populates="allocations", foreign_keys="Allocation.entity_id")
    account = relationship("Account", back_populates="allocations")
    transactions = relationship("Transaction", back_populates="allocation")
    budget_entries = relationship("BudgetEntry", back_populates="allocation")

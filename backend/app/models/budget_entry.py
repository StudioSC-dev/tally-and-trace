from sqlalchemy import (
    Column,
    Integer,
    String,
    Text,
    Float,
    Enum,
    DateTime,
    Boolean,
    ForeignKey,
)
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.models.user import CurrencyType
from app.models.transaction import RecurrenceFrequency
import enum


class BudgetEntryType(str, enum.Enum):
    INCOME = "income"
    EXPENSE = "expense"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class BudgetEntry(Base):
    __tablename__ = "budget_entries"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)
    entry_type = Column(
        Enum(BudgetEntryType, values_callable=_enum_values, name="budgetentrytype"),
        nullable=False,
    )
    name = Column(String(150), nullable=False, index=True)
    description = Column(Text, nullable=True)

    amount = Column(Float, nullable=False)
    currency = Column(Enum(CurrencyType), nullable=False, default=CurrencyType.PHP)
    cadence = Column(
        Enum(RecurrenceFrequency, values_callable=_enum_values, name="recurrencefrequency"),
        nullable=False,
        default=RecurrenceFrequency.MONTHLY,
    )
    next_occurrence = Column(DateTime, nullable=False)
    lead_time_days = Column(Integer, nullable=False, default=0)
    end_mode = Column(String(20), nullable=False, default="indefinite")
    end_date = Column(DateTime, nullable=True)
    max_occurrences = Column(Integer, nullable=True)

    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    allocation_id = Column(Integer, ForeignKey("allocations.id"), nullable=True)

    is_autopay = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    user = relationship("User", back_populates="budget_entries")
    entity = relationship("Entity", back_populates="budget_entries", foreign_keys="BudgetEntry.entity_id")
    account = relationship("Account", back_populates="budget_entries")
    category = relationship("Category", back_populates="budget_entries")
    allocation = relationship("Allocation", back_populates="budget_entries")
    transactions = relationship(
        "Transaction",
        back_populates="budget_entry",
        foreign_keys="Transaction.budget_entry_id",
    )


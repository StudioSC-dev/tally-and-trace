from sqlalchemy import (
    Column,
    Integer,
    String,
    Text,
    Numeric,
    Enum,
    DateTime,
    Boolean,
    ForeignKey,
    text,
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

    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(Enum(CurrencyType), nullable=False, default=CurrencyType.PHP)
    cadence = Column(
        Enum(RecurrenceFrequency, values_callable=_enum_values, name="recurrencefrequency"),
        nullable=False,
        default=RecurrenceFrequency.MONTHLY,
    )
    next_occurrence = Column(DateTime, nullable=False)
    lead_time_days = Column(Integer, nullable=False, default=0)
    # Only used when cadence == SEMI_MONTHLY: the two days-of-month it fires on.
    # Stored so the pair can be changed per entry; defaults to the 1st and 15th.
    semi_monthly_day_1 = Column(Integer, nullable=False, default=1)
    semi_monthly_day_2 = Column(Integer, nullable=False, default=15)
    end_mode = Column(String(20), nullable=False, default="indefinite")
    end_date = Column(DateTime, nullable=True)
    max_occurrences = Column(Integer, nullable=True)
    # Installments only: charges already paid before this entry existed (e.g. imported
    # from a spreadsheet) that have no linked transaction. Added to the linked-transaction
    # count so "n of m" reads the real paid count without fabricating historical rows.
    occurrences_paid_offset = Column(
        Integer, nullable=False, default=0, server_default=text("0")
    )

    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    # UC1: secondary funding source — payments draw from account_id first, overflow here.
    overflow_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    # Recurring transfer: when set, occurrences move money from account_id to this
    # (non-credit) account and materialise as transfer transactions.
    transfer_to_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    allocation_id = Column(Integer, ForeignKey("allocations.id"), nullable=True)

    is_autopay = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    user = relationship("User", back_populates="budget_entries")
    entity = relationship("Entity", back_populates="budget_entries", foreign_keys="BudgetEntry.entity_id")
    account = relationship("Account", back_populates="budget_entries", foreign_keys=[account_id])
    overflow_account = relationship("Account", foreign_keys=[overflow_account_id])
    transfer_to_account = relationship("Account", foreign_keys=[transfer_to_account_id])
    category = relationship("Category", back_populates="budget_entries")
    allocation = relationship("Allocation", back_populates="budget_entries")
    transactions = relationship(
        "Transaction",
        back_populates="budget_entry",
        foreign_keys="Transaction.budget_entry_id",
    )


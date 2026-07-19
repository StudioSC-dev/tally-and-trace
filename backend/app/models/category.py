from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey, Boolean, Enum
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
import enum


class CategoryKind(str, enum.Enum):
    """Directional role of a category.

    - INCOME / EXPENSE: true money in / out — changes net worth.
    - TRANSFER: a movement of the user's own money (savings contributions,
      investment funding, card payments). Net worth is unchanged; the two legs
      have opposite signs. These are the "context-aware" categories — a savings
      contribution is an expense from checking but income to savings.
    """

    INCOME = "income"
    EXPENSE = "expense"
    TRANSFER = "transfer"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)
    name = Column(String(100), nullable=False, index=True)
    description = Column(Text, nullable=True)
    color = Column(String(7), nullable=True)  # Hex color code

    # Category settings
    # is_expense is retained for backwards compatibility; `kind` is the richer
    # source of truth and the two are kept in sync by the categories router
    # (expense -> True, income/transfer -> False).
    is_expense = Column(Boolean, default=True)  # True for expense, False for income
    kind = Column(
        Enum(CategoryKind, values_callable=_enum_values, name="categorykind"),
        nullable=False,
        server_default=CategoryKind.EXPENSE.value,
    )
    is_active = Column(Boolean, default=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="categories")
    entity = relationship("Entity", back_populates="categories", foreign_keys="Category.entity_id")
    transactions = relationship("Transaction", back_populates="category")
    budget_entries = relationship("BudgetEntry", back_populates="category")

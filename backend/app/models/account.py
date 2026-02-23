from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, ForeignKey, Enum
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
import enum
from app.models.user import CurrencyType

class AccountType(str, enum.Enum):
    CASH = "cash"
    E_WALLET = "e_wallet"
    SAVINGS = "savings"
    CHECKING = "checking"
    CREDIT = "credit"

def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Account(Base):
    __tablename__ = "accounts"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False, index=True)
    account_type = Column(
        Enum(AccountType, values_callable=_enum_values, name="accounttype"),
        nullable=False,
    )
    balance = Column(Float, default=0.0, nullable=False)
    currency = Column(Enum(CurrencyType), nullable=False, default=CurrencyType.PHP)
    description = Column(Text, nullable=True)
    
    # Credit card specific fields
    credit_limit = Column(Float, nullable=True)
    due_date = Column(Integer, nullable=True)  # Day of month for due date (legacy support)
    billing_cycle_start = Column(Integer, nullable=True)  # Day of month for billing cycle start / statement day
    days_until_due_date = Column(Integer, nullable=True, default=21)
    
    # Entity scoping (nullable – existing data retains null until backfilled)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)

    # Account status
    is_active = Column(Boolean, default=True)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="accounts")
    entity = relationship("Entity", back_populates="accounts", foreign_keys="Account.entity_id")
    transactions = relationship(
        "Transaction",
        back_populates="account",
        foreign_keys="Transaction.account_id",
        lazy="selectin",
    )
    allocations = relationship("Allocation", back_populates="account")
    budget_entries = relationship("BudgetEntry", back_populates="account")

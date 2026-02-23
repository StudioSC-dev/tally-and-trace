from sqlalchemy import Column, Integer, String, Float, DateTime, Text, ForeignKey, Enum, Boolean
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.models.user import CurrencyType
import enum

class TransactionType(str, enum.Enum):
    DEBIT = "debit"
    CREDIT = "credit"
    TRANSFER = "transfer"


class RecurrenceFrequency(str, enum.Enum):
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    SEMI_ANNUAL = "semi_annual"
    ANNUAL = "annual"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Transaction(Base):
    __tablename__ = "transactions"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    allocation_id = Column(Integer, ForeignKey("allocations.id"), nullable=True)
    budget_entry_id = Column(Integer, ForeignKey("budget_entries.id"), nullable=True)
    
    amount = Column(Float, nullable=False)
    currency = Column(Enum(CurrencyType), default=CurrencyType.PHP)
    projected_amount = Column(Float, nullable=True)
    projected_currency = Column(Enum(CurrencyType), nullable=True)
    original_amount = Column(Float, nullable=True)
    original_currency = Column(Enum(CurrencyType), nullable=True)
    exchange_rate = Column(Float, nullable=True)
    transfer_fee = Column(Float, nullable=False, default=0.0)
    description = Column(Text, nullable=True)
    transaction_type = Column(
        Enum(TransactionType, values_callable=_enum_values, name="transactiontype"),
        nullable=False,
    )
    is_posted = Column(Boolean, default=True)
    transfer_from_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    transfer_to_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    
    # Transaction dates
    transaction_date = Column(DateTime, nullable=False)
    posting_date = Column(DateTime, nullable=True)  # For credit card transactions
    
    # File attachments
    receipt_url = Column(String(500), nullable=True)
    invoice_url = Column(String(500), nullable=True)
    
    # Transaction status
    is_reconciled = Column(Boolean, default=False)
    is_recurring = Column(Boolean, default=False)
    recurrence_frequency = Column(
        Enum(RecurrenceFrequency, values_callable=_enum_values, name="recurrencefrequency"),
        nullable=True,
    )
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="transactions")
    entity = relationship("Entity", back_populates="transactions", foreign_keys="Transaction.entity_id")
    account = relationship(
        "Account",
        back_populates="transactions",
        foreign_keys=[account_id],
    )
    transfer_from_account = relationship("Account", foreign_keys=[transfer_from_account_id], backref="transfer_out_transactions")
    transfer_to_account = relationship("Account", foreign_keys=[transfer_to_account_id], backref="transfer_in_transactions")
    category = relationship("Category", back_populates="transactions")
    allocation = relationship("Allocation", back_populates="transactions")
    budget_entry = relationship("BudgetEntry", back_populates="transactions")

from sqlalchemy import CheckConstraint, Column, Integer, String, Numeric, DateTime, Text, ForeignKey, Enum, Boolean
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
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    SEMI_MONTHLY = "semi_monthly"  # twice a month, on two configurable days (default 1 & 15)
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    SEMI_ANNUAL = "semi_annual"
    ANNUAL = "annual"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint(
            "loan_payment_kind IS NULL OR loan_payment_kind IN ('scheduled', 'prepayment')",
            name="ck_transactions_loan_payment_kind",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    allocation_id = Column(Integer, ForeignKey("allocations.id"), nullable=True)
    budget_entry_id = Column(Integer, ForeignKey("budget_entries.id"), nullable=True)
    
    amount = Column(Numeric(15, 2), nullable=False)
    currency = Column(Enum(CurrencyType), default=CurrencyType.PHP)
    projected_amount = Column(Numeric(15, 2), nullable=True)
    projected_currency = Column(Enum(CurrencyType), nullable=True)
    original_amount = Column(Numeric(15, 2), nullable=True)
    original_currency = Column(Enum(CurrencyType), nullable=True)
    exchange_rate = Column(Numeric(15, 6), nullable=True)
    transfer_fee = Column(Numeric(15, 2), nullable=False, default=0)
    description = Column(Text, nullable=True)
    transaction_type = Column(
        Enum(TransactionType, values_callable=_enum_values, name="transactiontype"),
        nullable=False,
    )
    is_posted = Column(Boolean, default=True)
    transfer_from_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    transfer_to_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    # Loan payments only (a transfer into a loan): "scheduled" or "prepayment".
    # Set on every transfer into a loan recorded through the API: the loan
    # payment and prepayment endpoints, a generic create, a materialised
    # recurring entry, an edit that retargets a row into a loan, and posting a
    # legacy planned row. Null on every other row and on legacy rows, which an
    # otherwise unchanged edit leaves null (unposting a posted one is refused).
    loan_payment_kind = Column(String(16), nullable=True)
    # Who created the row: the caller, set on every new transaction. It differs
    # from the owner (user_id) when an editor materialises another user's
    # recurring entry. Null only on rows created before STU-232, or once that
    # user is deleted.
    created_by_actor = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL", name="fk_transactions_created_by_actor_users"),
        nullable=True,
    )
    
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
    user = relationship("User", back_populates="transactions", foreign_keys=[user_id])
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

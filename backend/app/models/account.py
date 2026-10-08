from sqlalchemy import (
    CheckConstraint, Column, Integer, String, Numeric, Date, DateTime, Text, Boolean,
    ForeignKey, Enum, text,
)
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
    LOAN = "loan"


LOAN_KINDS = ("personal", "auto", "home")
LOAN_AMORTIZATIONS = ("fixed", "reduce_term")

def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(
            "loan_kind IS NULL OR loan_kind IN ('personal', 'auto', 'home')",
            name="ck_accounts_loan_kind",
        ),
        CheckConstraint(
            "loan_amortization IS NULL OR loan_amortization IN ('fixed', 'reduce_term')",
            name="ck_accounts_loan_amortization",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False, index=True)
    account_type = Column(
        Enum(AccountType, values_callable=_enum_values, name="accounttype"),
        nullable=False,
    )
    balance = Column(Numeric(15, 2), default=0, nullable=False)
    currency = Column(Enum(CurrencyType), nullable=False, default=CurrencyType.PHP)
    description = Column(Text, nullable=True)
    
    # Credit card specific fields
    credit_limit = Column(Numeric(15, 2), nullable=True)
    due_date = Column(Integer, nullable=True)  # Day of month for due date (legacy support)
    billing_cycle_start = Column(Integer, nullable=True)  # Day of month the statement closes
    days_until_due_date = Column(Integer, nullable=True, default=21)

    # Where this card's statement payment is funded from. Mirrors the UC1
    # primary -> overflow routing on budget_entries: the statement draws on
    # payment_account_id first, and anything it can't cover spills to
    # payment_overflow_account_id. A loan reuses payment_account_id as the account
    # its payments are funded from. Null on other account types.
    payment_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    payment_overflow_account_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    
    # Entity scoping (nullable – existing data retains null until backfilled)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)

    # Spending wallet (cash on hand, e-wallets): the balance is shown but is not
    # projection cash. Topping one up is the expense; spending from it is
    # categorised without being counted again.
    is_spending_wallet = Column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    # Loan terms (loan accounts only; null elsewhere). A loan's balance is
    # negative while money is owed. Payments are transfers into the loan:
    # principal as the amount, interest as the transfer fee. The loan's
    # payment_account_id is where its payments are funded from by default.
    loan_kind = Column(String(16), nullable=True)  # personal / auto / home
    loan_annual_rate = Column(Numeric(7, 4), nullable=True)  # percent, e.g. 6.5
    loan_term_months = Column(Integer, nullable=True)
    loan_payment_amount = Column(Numeric(15, 2), nullable=True)
    loan_first_payment_date = Column(Date, nullable=True)
    # fixed: the bank's schedule (payments left are counted); reduce_term: a
    # prepayment shortens the term.
    loan_amortization = Column(String(16), nullable=True)
    # Scheduled payments made before the loan was tracked here. Every posted
    # transaction with a loan_payment_kind of "scheduled" is counted on top, so
    # back-filled history must either reduce this offset or be recorded without
    # a loan_payment_kind; otherwise it is counted twice.
    loan_payments_made_offset = Column(Integer, nullable=True)

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

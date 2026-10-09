# Database models
from sqlalchemy.orm import relationship
from app.models.user import User as User, CurrencyType as CurrencyType
from app.models.account import Account as Account, AccountType as AccountType
from app.models.transaction import Transaction as Transaction, TransactionType as TransactionType
from app.models.category import Category as Category
from app.models.allocation import Allocation as Allocation, AllocationType as AllocationType
from app.models.budget_entry import BudgetEntry as BudgetEntry, BudgetEntryType as BudgetEntryType
from app.models.email_token import EmailToken as EmailToken, EmailTokenType as EmailTokenType
from app.models.refresh_token import RefreshToken as RefreshToken
from app.models.wishlist_item import WishlistItem as WishlistItem, WishlistPriority as WishlistPriority
from app.models.demo_state import DemoState as DemoState
from app.models.tag import (
    Tag as Tag,
    account_tags,
    budget_entry_tags,
    transaction_tags,
)

# ---------------------------------------------------------------------------
# User relationships
# ---------------------------------------------------------------------------
User.wishlist_items = relationship("WishlistItem", back_populates="user")

# ---------------------------------------------------------------------------
# Account relationships
# ---------------------------------------------------------------------------
Account.transactions = relationship(
    "Transaction",
    back_populates="account",
    foreign_keys="Transaction.account_id",
)
Account.allocations = relationship(
    "Allocation",
    back_populates="account",
    foreign_keys="Allocation.account_id",
)

# ---------------------------------------------------------------------------
# Transaction relationships
# ---------------------------------------------------------------------------
Transaction.account = relationship(
    "Account",
    back_populates="transactions",
    foreign_keys="Transaction.account_id",
)
Transaction.category = relationship("Category", back_populates="transactions")
Transaction.allocation = relationship("Allocation", back_populates="transactions")
# Transfer relationships
Transaction.transfer_from_account = relationship(
    "Account",
    foreign_keys="Transaction.transfer_from_account_id",
    backref="transfer_out_transactions",
)
Transaction.transfer_to_account = relationship(
    "Account",
    foreign_keys="Transaction.transfer_to_account_id",
    backref="transfer_in_transactions",
)

# ---------------------------------------------------------------------------
# Category relationships
# ---------------------------------------------------------------------------
Category.transactions = relationship("Transaction", back_populates="category")
Category.budget_entries = relationship("BudgetEntry", back_populates="category")

# ---------------------------------------------------------------------------
# Allocation relationships
# ---------------------------------------------------------------------------
Allocation.account = relationship("Account", back_populates="allocations")
Allocation.transactions = relationship("Transaction", back_populates="allocation")
Allocation.budget_entries = relationship("BudgetEntry", back_populates="allocation")

# ---------------------------------------------------------------------------
# BudgetEntry relationships
# ---------------------------------------------------------------------------
BudgetEntry.transactions = relationship(
    "Transaction",
    back_populates="budget_entry",
    foreign_keys="Transaction.budget_entry_id",
)

User.budget_entries = relationship("BudgetEntry", back_populates="user")
User.email_tokens = relationship("EmailToken", back_populates="user", cascade="all, delete-orphan")
Account.budget_entries = relationship("BudgetEntry", back_populates="account", foreign_keys="BudgetEntry.account_id")

Transaction.budget_entry = relationship(
    "BudgetEntry",
    back_populates="transactions",
    foreign_keys="Transaction.budget_entry_id",
)

EmailToken.user = relationship("User", back_populates="email_tokens")

# ---------------------------------------------------------------------------
# Tag links (read-only here: app/core/tags.py writes the link rows, and only
# the caller's own tags are ever shown, so routers never serialise these)
# ---------------------------------------------------------------------------
Account.explicit_tags = relationship("Tag", secondary=account_tags, viewonly=True)
Transaction.explicit_tags = relationship("Tag", secondary=transaction_tags, viewonly=True)
BudgetEntry.explicit_tags = relationship("Tag", secondary=budget_entry_tags, viewonly=True)

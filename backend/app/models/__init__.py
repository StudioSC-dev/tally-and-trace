# Database models
from sqlalchemy.orm import relationship
from app.models.user import User as User, CurrencyType as CurrencyType
from app.models.entity import Entity as Entity, EntityMembership as EntityMembership, EntityType as EntityType, MemberRole as MemberRole
from app.models.account import Account as Account, AccountType as AccountType
from app.models.transaction import Transaction as Transaction, TransactionType as TransactionType
from app.models.category import Category as Category
from app.models.allocation import Allocation as Allocation, AllocationType as AllocationType
from app.models.budget_entry import BudgetEntry as BudgetEntry, BudgetEntryType as BudgetEntryType
from app.models.email_token import EmailToken as EmailToken, EmailTokenType as EmailTokenType
from app.models.wishlist_item import WishlistItem as WishlistItem, WishlistPriority as WishlistPriority

# ---------------------------------------------------------------------------
# User relationships
# ---------------------------------------------------------------------------
User.entity_memberships = relationship(
    "EntityMembership",
    back_populates="user",
    cascade="all, delete-orphan",
)
User.wishlist_items = relationship("WishlistItem", back_populates="user")

# ---------------------------------------------------------------------------
# Entity relationships
# ---------------------------------------------------------------------------
Entity.accounts = relationship(
    "Account",
    foreign_keys="Account.entity_id",
    back_populates="entity",
)
Entity.transactions = relationship(
    "Transaction",
    foreign_keys="Transaction.entity_id",
    back_populates="entity",
)
Entity.categories = relationship(
    "Category",
    foreign_keys="Category.entity_id",
    back_populates="entity",
)
Entity.allocations = relationship(
    "Allocation",
    foreign_keys="Allocation.entity_id",
    back_populates="entity",
)
Entity.budget_entries = relationship(
    "BudgetEntry",
    foreign_keys="BudgetEntry.entity_id",
    back_populates="entity",
)

# ---------------------------------------------------------------------------
# Account relationships
# ---------------------------------------------------------------------------
Account.entity = relationship("Entity", back_populates="accounts", foreign_keys="Account.entity_id")
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
Transaction.entity = relationship("Entity", back_populates="transactions", foreign_keys="Transaction.entity_id")
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
Category.entity = relationship("Entity", back_populates="categories", foreign_keys="Category.entity_id")
Category.transactions = relationship("Transaction", back_populates="category")
Category.budget_entries = relationship("BudgetEntry", back_populates="category")

# ---------------------------------------------------------------------------
# Allocation relationships
# ---------------------------------------------------------------------------
Allocation.entity = relationship("Entity", back_populates="allocations", foreign_keys="Allocation.entity_id")
Allocation.account = relationship("Account", back_populates="allocations")
Allocation.transactions = relationship("Transaction", back_populates="allocation")
Allocation.budget_entries = relationship("BudgetEntry", back_populates="allocation")

# ---------------------------------------------------------------------------
# BudgetEntry relationships
# ---------------------------------------------------------------------------
BudgetEntry.entity = relationship("Entity", back_populates="budget_entries", foreign_keys="BudgetEntry.entity_id")
BudgetEntry.transactions = relationship(
    "Transaction",
    back_populates="budget_entry",
    foreign_keys="Transaction.budget_entry_id",
)

User.budget_entries = relationship("BudgetEntry", back_populates="user")
User.email_tokens = relationship("EmailToken", back_populates="user", cascade="all, delete-orphan")
Account.budget_entries = relationship("BudgetEntry", back_populates="account")

Transaction.budget_entry = relationship(
    "BudgetEntry",
    back_populates="transactions",
    foreign_keys="Transaction.budget_entry_id",
)

EmailToken.user = relationship("User", back_populates="email_tokens")

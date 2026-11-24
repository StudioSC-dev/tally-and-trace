import enum
from sqlalchemy import (
    CheckConstraint, Column, Integer, String, Numeric, DateTime, Text, Boolean, ForeignKey, Enum,
)
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.models.user import CurrencyType


class WishlistPriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class WishlistPaymentPlan(str, enum.Enum):
    """How the purchase is paid (STU-779): at once, or as a card installment."""
    FULL = "full"
    INSTALLMENT = "installment"


INSTALLMENT_MIN_MONTHS = 2
INSTALLMENT_MAX_MONTHS = 60


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class WishlistItem(Base):
    __tablename__ = "wishlist_items"
    __table_args__ = (
        CheckConstraint(
            "(payment_plan = 'full' AND installment_months IS NULL) OR "
            "(payment_plan = 'installment' AND installment_months IS NOT NULL AND "
            "installment_months BETWEEN "
            f"{INSTALLMENT_MIN_MONTHS} AND {INSTALLMENT_MAX_MONTHS})",
            name="ck_wishlist_items_installment_months",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(200), nullable=False)
    estimated_cost = Column(Numeric(15, 2), nullable=False)
    currency = Column(
        Enum(CurrencyType),
        nullable=False,
        default=CurrencyType.PHP,
    )
    priority = Column(
        Enum(WishlistPriority, values_callable=_enum_values, name="wishlistpriority"),
        nullable=False,
        default=WishlistPriority.MEDIUM,
    )
    category_id = Column(Integer, ForeignKey("categories.id"), nullable=True)
    url = Column(String(500), nullable=True)
    notes = Column(Text, nullable=True)
    target_date = Column(DateTime(timezone=True), nullable=True)
    # STU-779: the account the purchase is paid from, and how. An installment is a
    # card installment: ``installment_entry_id`` is the recurring entry marking the
    # item purchased created (unique, so one item never gets two).
    account_id = Column(Integer, ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True,
                        index=True)
    payment_plan = Column(
        Enum(WishlistPaymentPlan, values_callable=_enum_values, name="wishlistpaymentplan"),
        nullable=False,
        default=WishlistPaymentPlan.FULL,
        server_default=WishlistPaymentPlan.FULL.value,
    )
    installment_months = Column(Integer, nullable=True)
    installment_entry_id = Column(
        Integer, ForeignKey("budget_entries.id", ondelete="SET NULL"), nullable=True, unique=True)
    is_purchased = Column(Boolean, default=False, nullable=False)
    purchased_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="wishlist_items")
    category = relationship("Category", foreign_keys=[category_id])
    account = relationship("Account", foreign_keys=[account_id])
    installment_entry = relationship("BudgetEntry", foreign_keys=[installment_entry_id])

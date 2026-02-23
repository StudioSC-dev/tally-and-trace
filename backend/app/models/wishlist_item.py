import enum
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, Boolean, ForeignKey, Enum
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.models.user import CurrencyType


class WishlistPriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class WishlistItem(Base):
    __tablename__ = "wishlist_items"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    entity_id = Column(Integer, ForeignKey("entities.id"), nullable=True, index=True)
    name = Column(String(200), nullable=False)
    estimated_cost = Column(Float, nullable=False)
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
    is_purchased = Column(Boolean, default=False, nullable=False)
    purchased_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="wishlist_items")
    entity = relationship("Entity", foreign_keys=[entity_id])
    category = relationship("Category", foreign_keys=[category_id])

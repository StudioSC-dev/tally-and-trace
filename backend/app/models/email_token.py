# -*- coding: utf-8 -*-
"""Email token model for verification and password reset flows."""
from typing import TYPE_CHECKING

from sqlalchemy import Column, Integer, String, DateTime, Enum, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base
import enum


class EmailTokenType(str, enum.Enum):
    VERIFY_EMAIL = "verify_email"
    RESET_PASSWORD = "reset_password"


def _enum_values(enum_cls):
    return [member.value for member in enum_cls]


class EmailToken(Base):
    __tablename__ = "email_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token = Column(String(128), unique=True, nullable=False, index=True)
    token_type = Column(
        Enum(EmailTokenType, values_callable=_enum_values, name="emailtokentype"),
        nullable=False,
        index=True
    )
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    if TYPE_CHECKING:  # pragma: no cover - for type checkers only
        from app.models.user import User

        user: "User"

    user = relationship("User", back_populates="email_tokens")

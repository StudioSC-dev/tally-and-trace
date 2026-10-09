"""Account shares: an account the owner shares with another user (STU-232).

A share gives one user (``user_id``) a role on one account (``account_id``):
``viewer``, ``editor`` or ``admin``. The account's owner (``accounts.user_id``)
is never a share row; they always keep full control. A user holds at most one
share per account (``uq_account_shares_account_id_user_id``). Deleting the
account or the user deletes the share. See ``app/core/access.py`` for what each
role allows.
"""

from sqlalchemy import (
    CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, PrimaryKeyConstraint,
    String, UniqueConstraint, func,
)
from sqlalchemy.orm import relationship

from app.core.database import Base

SHARE_ROLES = ("viewer", "editor", "admin")


class AccountShare(Base):
    __tablename__ = "account_shares"

    id = Column(Integer, nullable=False)
    account_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE", name="fk_account_shares_account_id_accounts"),
        nullable=False,
    )
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE", name="fk_account_shares_user_id_users"),
        nullable=False,
    )
    role = Column(String(16), nullable=False)
    created_by = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL", name="fk_account_shares_created_by_users"),
        nullable=True,
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_account_shares"),
        UniqueConstraint("account_id", "user_id", name="uq_account_shares_account_id_user_id"),
        CheckConstraint("role IN ('viewer', 'editor', 'admin')", name="ck_account_shares_role"),
        Index("ix_account_shares_user_id", "user_id"),
    )

    account = relationship("Account", back_populates="shares")
    user = relationship("User", foreign_keys=[user_id])

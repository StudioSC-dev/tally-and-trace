"""Household tag shares: a user's Household tag shared, read-only, with another user (STU-233).

A share gives one user (``user_id``) a viewer-only share of one tag
(``tag_id``). Only the sharer's own Household system tag can be shared; that
is enforced by the application (``app/routers/shares.py``), not by the
database. A user holds at most one share per tag
(``uq_tag_shares_tag_id_user_id``). Deleting the tag or the user deletes the
share. See ``app/core/access.py`` for what a share lets its holder read (the
``tag_viewer`` role and read rules (b2) and (c)); it never grants a write.
"""

from sqlalchemy import (
    Column, DateTime, ForeignKey, Index, Integer, PrimaryKeyConstraint, UniqueConstraint, func,
)
from sqlalchemy.orm import relationship

from app.core.database import Base


class TagShare(Base):
    __tablename__ = "tag_shares"

    id = Column(Integer, nullable=False)
    tag_id = Column(
        Integer,
        ForeignKey("tags.id", ondelete="CASCADE", name="fk_tag_shares_tag_id_tags"),
        nullable=False,
    )
    user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE", name="fk_tag_shares_user_id_users"),
        nullable=False,
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        PrimaryKeyConstraint("id", name="pk_tag_shares"),
        UniqueConstraint("tag_id", "user_id", name="uq_tag_shares_tag_id_user_id"),
        Index("ix_tag_shares_user_id", "user_id"),
    )

    tag = relationship("Tag", back_populates="shares")
    user = relationship("User", foreign_keys=[user_id])

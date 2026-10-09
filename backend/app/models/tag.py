"""Tags: a user's own labels on accounts, transactions and recurring entries.

A tag belongs to one user (``user_id``) and is unique per user by
``lower(name)``. Every user has exactly one system tag, "Household"
(``is_system``), created at registration; it can't be renamed or deleted.
The three link tables tie a tag to a record; deleting either side deletes the
link (``ON DELETE CASCADE``). See ``app/core/tags.py`` for the rules.
"""

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Table, func, text,
)

from app.core.database import Base

HOUSEHOLD_TAG_NAME = "Household"


class Tag(Base):
    __tablename__ = "tags"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(50), nullable=False)
    color = Column(String(7), nullable=True)  # hex colour, e.g. #2563EB
    is_system = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        Index("uq_tags_user_id_lower_name", "user_id", func.lower(name), unique=True),
        Index("uq_tags_user_id_system", "user_id", unique=True,
              postgresql_where=text("is_system")),
    )


def _link_table(name: str, record_column: str, record_table: str) -> Table:
    return Table(
        name,
        Base.metadata,
        Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
        Column(record_column, Integer, ForeignKey(f"{record_table}.id", ondelete="CASCADE"),
               primary_key=True, index=True),
    )


account_tags = _link_table("account_tags", "account_id", "accounts")
transaction_tags = _link_table("transaction_tags", "transaction_id", "transactions")
budget_entry_tags = _link_table("budget_entry_tags", "budget_entry_id", "budget_entries")

from sqlalchemy import (
    CheckConstraint, Column, Date, DateTime, ForeignKey, Integer, Numeric, UniqueConstraint,
)
from sqlalchemy.sql import func

from app.core.database import Base


class CardStatementMinimum(Base):
    """A card statement's minimum amount due as the bank printed it (STU-343 Plan C, 2.5).

    One row per card and statement close (the close day of a closed statement).
    It replaces that statement's estimated minimum and feeds the next
    statements' overdue carry. Written by owners and admins of the card only
    (``PUT /cards/{account_id}/statements/{close_date}/minimum-due``).
    """
    __tablename__ = "card_statement_minimums"
    __table_args__ = (
        CheckConstraint("amount >= 0", name="ck_card_statement_minimums_amount_nonnegative"),
        UniqueConstraint("account_id", "statement_close",
                         name="uq_card_statement_minimums_account_close"),
    )

    id = Column(Integer, primary_key=True)
    account_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE",
                   name="fk_card_statement_minimums_account_id_accounts"),
        nullable=False,
    )
    statement_close = Column(Date, nullable=False)
    amount = Column(Numeric(15, 2), nullable=False)
    # Who last set it; null once that user is deleted.
    created_by_actor = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL",
                   name="fk_card_statement_minimums_created_by_actor_users"),
        nullable=True,
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

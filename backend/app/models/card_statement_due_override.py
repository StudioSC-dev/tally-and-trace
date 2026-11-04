from sqlalchemy import CheckConstraint, Column, Date, DateTime, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class CardStatementDueOverride(Base):
    """A card statement's due date as the bank printed it.

    One row per card and statement close (the computed close of the statement,
    which no override moves). ``due_date`` replaces that statement's rolled due
    (``close + days_until_due_date``, moved to the next banking day) everywhere
    a cycle is walked; the close and its window are unchanged. It is always
    after the close. Written by owners and admins of the card only
    (``PUT /cards/{account_id}/statements/{close_date}/due-date``).
    """
    __tablename__ = "card_statement_due_overrides"
    __table_args__ = (
        CheckConstraint("due_date > statement_close",
                        name="ck_card_statement_due_overrides_due_after_close"),
        UniqueConstraint("account_id", "statement_close",
                         name="uq_card_statement_due_overrides_account_close"),
    )

    id = Column(Integer, primary_key=True)
    account_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE",
                   name="fk_card_statement_due_overrides_account_id_accounts"),
        nullable=False,
    )
    statement_close = Column(Date, nullable=False)
    due_date = Column(Date, nullable=False)
    # Who last set it; null once that user is deleted.
    created_by_actor = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL",
                   name="fk_card_statement_due_overrides_created_by_actor_users"),
        nullable=True,
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

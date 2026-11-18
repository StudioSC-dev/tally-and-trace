from sqlalchemy import (
    Column, Date, DateTime, ForeignKey, Integer, Numeric, UniqueConstraint,
)
from sqlalchemy.sql import func

from app.core.database import Base


class StatementReconciliation(Base):
    """A card statement reconciled against the bank's statement (STU-749).

    One row per card and statement close, written by
    ``POST /cards/{account_id}/statements/reconcile`` once its apply has made the
    app's statement equal the bank's: the printed ``total_due``, the statement's
    ``line_balance`` (charges less credits) and ``line_count`` (its charge and
    credit lines), who reconciled it and when. A later reconcile of the same
    statement replaces it. The row goes with its card; ``reconciled_by_actor`` is
    cleared when that user is deleted.
    """
    __tablename__ = "statement_reconciliations"
    __table_args__ = (
        UniqueConstraint("card_id", "statement_close",
                         name="uq_statement_reconciliations_card_close"),
    )

    id = Column(Integer, primary_key=True)
    card_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE",
                   name="fk_statement_reconciliations_card_id_accounts"),
        nullable=False,
    )
    statement_close = Column(Date, nullable=False)
    total_due = Column(Numeric(15, 2), nullable=False)
    line_balance = Column(Numeric(15, 2), nullable=False)
    line_count = Column(Integer, nullable=False)
    reconciled_by_actor = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL",
                   name="fk_statement_reconciliations_reconciled_by_actor_users"),
        nullable=True,
    )
    reconciled_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class AccountStatementReconciliation(Base):
    """A savings, checking or e-wallet statement reconciled against the bank's (STU-753).

    One row per account and ``period_end``, written by
    ``POST /accounts/{account_id}/statements/reconcile`` once its apply has made the
    app's rows in the period, and its balance at ``period_end``, equal the bank's:
    the period, the printed ``opening_balance`` (when the statement gave it) and
    ``closing_balance``, the period's ``change`` (credits less debits) and
    ``line_count``, who reconciled it and when. A later reconcile of a statement
    ending on the same day replaces it. The row goes with its account;
    ``reconciled_by_actor`` is cleared when that user is deleted.
    """
    __tablename__ = "account_statement_reconciliations"
    __table_args__ = (
        UniqueConstraint("account_id", "period_end",
                         name="uq_account_statement_reconciliations_account_end"),
    )

    id = Column(Integer, primary_key=True)
    account_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE",
                   name="fk_account_statement_reconciliations_account_id_accounts"),
        nullable=False,
    )
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    opening_balance = Column(Numeric(15, 2), nullable=True)
    closing_balance = Column(Numeric(15, 2), nullable=False)
    change = Column(Numeric(15, 2), nullable=False)
    line_count = Column(Integer, nullable=False)
    reconciled_by_actor = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL",
                   name="fk_account_statement_reconciliations_reconciled_by_actor_users"),
        nullable=True,
    )
    reconciled_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

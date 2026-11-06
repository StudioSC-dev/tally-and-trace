from sqlalchemy import CheckConstraint, Column, Date, DateTime, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.sql import func

from app.core.database import Base


class PaymentDateOverride(Base):
    """One occurrence's forced date: the day the money really moves.

    One row per recurring entry or loan and nominal date. ``occurrence_date``
    is the schedule's own date, the occurrence's identity, which nothing moves;
    for a loan it is the nominal ``due_date(first, step)``, never the step.
    ``effective_date`` decides when that occurrence is due, shown, overdue and
    posted (``services/payment_dates.py``). Written through
    ``PUT /budget-entries/{id}/occurrences/{day}/date`` and
    ``PUT /accounts/{id}/loan-due-dates/{day}/date``.
    """
    __tablename__ = "payment_date_overrides"
    __table_args__ = (
        CheckConstraint("(budget_entry_id IS NULL) <> (loan_account_id IS NULL)",
                        name="ck_payment_date_overrides_one_owner"),
        CheckConstraint("effective_date <> occurrence_date",
                        name="ck_payment_date_overrides_date_moved"),
        UniqueConstraint("budget_entry_id", "occurrence_date",
                         name="uq_payment_date_overrides_entry_occurrence"),
        UniqueConstraint("loan_account_id", "occurrence_date",
                         name="uq_payment_date_overrides_loan_occurrence"),
    )

    id = Column(Integer, primary_key=True)
    budget_entry_id = Column(
        Integer,
        ForeignKey("budget_entries.id", ondelete="CASCADE",
                   name="fk_payment_date_overrides_budget_entry_id_budget_entries"),
        nullable=True,
    )
    loan_account_id = Column(
        Integer,
        ForeignKey("accounts.id", ondelete="CASCADE",
                   name="fk_payment_date_overrides_loan_account_id_accounts"),
        nullable=True,
    )
    occurrence_date = Column(Date, nullable=False)
    effective_date = Column(Date, nullable=False)
    # Who last set it; null once that user is deleted.
    created_by_actor = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL",
                   name="fk_payment_date_overrides_created_by_actor_users"),
        nullable=True,
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

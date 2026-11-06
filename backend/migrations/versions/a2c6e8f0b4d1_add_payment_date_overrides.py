"""add payment_date_overrides

One occurrence's forced date: one row per recurring entry or loan and nominal
date, naming the day the money really moves. Exactly one owner, and the row
always differs from the nominal date (setting the nominal date deletes it).
Each row goes with its entry or loan (``ON DELETE CASCADE``);
``created_by_actor`` is cleared when that user is deleted. The two unique
constraints each leave the other owner's rows alone, since NULLs are distinct.
The downgrade drops the table.

Revision ID: a2c6e8f0b4d1
Revises: c4e1a7d92b36
Create Date: 2026-11-06

"""
from alembic import op
import sqlalchemy as sa

revision = "a2c6e8f0b4d1"
down_revision = "c4e1a7d92b36"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "payment_date_overrides",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("budget_entry_id", sa.Integer(), nullable=True),
        sa.Column("loan_account_id", sa.Integer(), nullable=True),
        sa.Column("occurrence_date", sa.Date(), nullable=False),
        sa.Column("effective_date", sa.Date(), nullable=False),
        sa.Column("created_by_actor", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("(budget_entry_id IS NULL) <> (loan_account_id IS NULL)",
                           name="ck_payment_date_overrides_one_owner"),
        sa.CheckConstraint("effective_date <> occurrence_date",
                           name="ck_payment_date_overrides_date_moved"),
        sa.ForeignKeyConstraint(["budget_entry_id"], ["budget_entries.id"], ondelete="CASCADE",
                                name="fk_payment_date_overrides_budget_entry_id_budget_entries"),
        sa.ForeignKeyConstraint(["loan_account_id"], ["accounts.id"], ondelete="CASCADE",
                                name="fk_payment_date_overrides_loan_account_id_accounts"),
        sa.ForeignKeyConstraint(["created_by_actor"], ["users.id"], ondelete="SET NULL",
                                name="fk_payment_date_overrides_created_by_actor_users"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("budget_entry_id", "occurrence_date",
                            name="uq_payment_date_overrides_entry_occurrence"),
        sa.UniqueConstraint("loan_account_id", "occurrence_date",
                            name="uq_payment_date_overrides_loan_occurrence"),
    )


def downgrade() -> None:
    op.drop_table("payment_date_overrides")

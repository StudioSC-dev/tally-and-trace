"""add card_statement_minimums

A card statement's minimum amount due as the bank printed it (STU-343 Plan C,
section 2.5): one row per card and statement close, replacing that statement's
estimate. ``amount`` is never negative. The row goes with its card
(``ON DELETE CASCADE``); ``created_by_actor`` is cleared when that user is
deleted, as ``transactions.created_by_actor`` is. The downgrade drops the table.

Revision ID: 20604a414c22
Revises: 644091f19b93
Create Date: 2026-10-19

"""
from alembic import op
import sqlalchemy as sa

revision = "20604a414c22"
down_revision = "644091f19b93"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_statement_minimums",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("statement_close", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(15, 2), nullable=False),
        sa.Column("created_by_actor", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("amount >= 0", name="ck_card_statement_minimums_amount_nonnegative"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE",
                                name="fk_card_statement_minimums_account_id_accounts"),
        sa.ForeignKeyConstraint(["created_by_actor"], ["users.id"], ondelete="SET NULL",
                                name="fk_card_statement_minimums_created_by_actor_users"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "statement_close",
                            name="uq_card_statement_minimums_account_close"),
    )


def downgrade() -> None:
    op.drop_table("card_statement_minimums")

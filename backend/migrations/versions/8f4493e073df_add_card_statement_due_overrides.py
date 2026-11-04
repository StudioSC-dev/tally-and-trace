"""add card_statement_due_overrides

A card statement's due date as the bank printed it: one row per card and
statement close, replacing that statement's rolled due. ``due_date`` is always
after ``statement_close``. The row goes with its card (``ON DELETE CASCADE``);
``created_by_actor`` is cleared when that user is deleted, as
``card_statement_minimums.created_by_actor`` is. The downgrade drops the table.

Revision ID: 8f4493e073df
Revises: e7a1d3f5b9c2
Create Date: 2026-11-04

"""
from alembic import op
import sqlalchemy as sa

revision = "8f4493e073df"
down_revision = "e7a1d3f5b9c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_statement_due_overrides",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("statement_close", sa.Date(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("created_by_actor", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("due_date > statement_close",
                           name="ck_card_statement_due_overrides_due_after_close"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE",
                                name="fk_card_statement_due_overrides_account_id_accounts"),
        sa.ForeignKeyConstraint(["created_by_actor"], ["users.id"], ondelete="SET NULL",
                                name="fk_card_statement_due_overrides_created_by_actor_users"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "statement_close",
                            name="uq_card_statement_due_overrides_account_close"),
    )


def downgrade() -> None:
    op.drop_table("card_statement_due_overrides")

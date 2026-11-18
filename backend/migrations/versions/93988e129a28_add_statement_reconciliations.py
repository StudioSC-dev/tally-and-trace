"""add statement_reconciliations

STU-749: one row per card statement reconciled against the bank's statement
(``POST /cards/{account_id}/statements/reconcile``): the printed total due, the
statement's line balance and line count, who reconciled it and when. Unique per
card and statement close. The row goes with its card (``ON DELETE CASCADE``);
``reconciled_by_actor`` is cleared when that user is deleted. The table carries
the data version trigger (app/core/data_version.py). The downgrade drops it.

Revision ID: 93988e129a28
Revises: b3f7d9a1c5e8
Create Date: 2026-11-18

"""
from alembic import op
import sqlalchemy as sa

from app.core import data_version

revision = "93988e129a28"
down_revision = "b3f7d9a1c5e8"
branch_labels = None
depends_on = None

TABLE = "statement_reconciliations"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("card_id", sa.Integer(), nullable=False),
        sa.Column("statement_close", sa.Date(), nullable=False),
        sa.Column("total_due", sa.Numeric(15, 2), nullable=False),
        sa.Column("line_balance", sa.Numeric(15, 2), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False),
        sa.Column("reconciled_by_actor", sa.Integer(), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(["card_id"], ["accounts.id"], ondelete="CASCADE",
                                name="fk_statement_reconciliations_card_id_accounts"),
        sa.ForeignKeyConstraint(
            ["reconciled_by_actor"], ["users.id"], ondelete="SET NULL",
            name="fk_statement_reconciliations_reconciled_by_actor_users"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("card_id", "statement_close",
                            name="uq_statement_reconciliations_card_close"),
    )
    data_version.add_bump_trigger(op.get_bind(), TABLE)


def downgrade() -> None:
    op.drop_table(TABLE)

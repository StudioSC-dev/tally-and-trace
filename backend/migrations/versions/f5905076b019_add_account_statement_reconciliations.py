"""add account_statement_reconciliations

STU-753: one row per savings, checking or e-wallet statement reconciled against
the bank's statement (``POST /accounts/{account_id}/statements/reconcile``): the
period, the printed opening (nullable: a statement may omit it) and closing
balances, the period's change and line count, who reconciled it and when. Unique
per account and ``period_end``. A sibling of ``statement_reconciliations`` (a
card's, keyed by its close), which is left as it is. The row goes with its
account (``ON DELETE CASCADE``); ``reconciled_by_actor`` is cleared when that user
is deleted. The table carries the data version trigger (app/core/data_version.py).
The downgrade drops it.

Revision ID: f5905076b019
Revises: 93988e129a28
Create Date: 2026-11-18

"""
from alembic import op
import sqlalchemy as sa

from app.core import data_version

revision = "f5905076b019"
down_revision = "93988e129a28"
branch_labels = None
depends_on = None

TABLE = "account_statement_reconciliations"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("opening_balance", sa.Numeric(15, 2), nullable=True),
        sa.Column("closing_balance", sa.Numeric(15, 2), nullable=False),
        sa.Column("change", sa.Numeric(15, 2), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False),
        sa.Column("reconciled_by_actor", sa.Integer(), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], ondelete="CASCADE",
            name="fk_account_statement_reconciliations_account_id_accounts"),
        sa.ForeignKeyConstraint(
            ["reconciled_by_actor"], ["users.id"], ondelete="SET NULL",
            name="fk_account_statement_reconciliations_reconciled_by_actor_users"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "period_end",
                            name="uq_account_statement_reconciliations_account_end"),
    )
    data_version.add_bump_trigger(op.get_bind(), TABLE)


def downgrade() -> None:
    op.drop_table(TABLE)

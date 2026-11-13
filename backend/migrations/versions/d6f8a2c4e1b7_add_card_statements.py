"""add card_statements and card_statement_state

Stored closed card statements (STU-601, PERF-6; docs/statements-store.md): one row
per closed cycle of a card with its line-item balance and line count, and one state
row per card saying how far those rows are complete.

New tables only, created empty: purely additive, so the code serving during the
build never reads or writes them, and nothing needs a backfill (reads fill them
lazily). The downgrade drops both (nothing references them).

No data-version trigger (STU-602, ``app/core/data_version.py``): both tables are in
``EXCLUDED_TABLES``. They are derived from rows that do bump, and a read that
catches up writes them, so a trigger would change the version on a GET.

Revision ID: d6f8a2c4e1b7
Revises: a7c2e4f6b8d1
Create Date: 2026-11-13

"""
from alembic import op
import sqlalchemy as sa

revision = "d6f8a2c4e1b7"
down_revision = "a7c2e4f6b8d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_statements",
        sa.Column("card_id", sa.Integer(), nullable=False),
        sa.Column("close", sa.Date(), nullable=False),
        sa.Column("window_start", sa.Date(), nullable=False),
        sa.Column("line_balance", sa.Numeric(15, 2), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False),
        sa.Column("close_day", sa.SmallInteger(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(["card_id"], ["accounts.id"], ondelete="CASCADE",
                                name="fk_card_statements_card_id_accounts"),
        sa.PrimaryKeyConstraint("card_id", "close"),
    )
    op.create_table(
        "card_statement_state",
        sa.Column("card_id", sa.Integer(), nullable=False),
        sa.Column("materialized_through", sa.Date(), nullable=True),
        sa.Column("close_day", sa.SmallInteger(), nullable=True),
        sa.ForeignKeyConstraint(["card_id"], ["accounts.id"], ondelete="CASCADE",
                                name="fk_card_statement_state_card_id_accounts"),
        sa.PrimaryKeyConstraint("card_id"),
    )


def downgrade() -> None:
    op.drop_table("card_statement_state")
    op.drop_table("card_statements")

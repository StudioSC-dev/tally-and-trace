"""add payment routing columns to accounts (credit-card statement modelling)

Gives a credit card its own funding source, mirroring the UC1 primary -> overflow
routing that already exists on budget_entries. The forecast derives each card's
statement payable (amount from the cycle's transactions, due date from
billing_cycle_start + days_until_due_date) and routes it through these accounts.

Both columns are nullable and default to NULL, so existing rows are unaffected and
a card without routing simply contributes to the aggregate timeline without
producing a per-account funding shortfall.

Revision ID: f5a7c9e1d3b4
Revises: d4f6a8b0c2e3
Create Date: 2026-07-17

"""
from alembic import op
import sqlalchemy as sa

revision = "f5a7c9e1d3b4"
down_revision = "d4f6a8b0c2e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("payment_account_id", sa.Integer(), nullable=True))
    op.add_column("accounts", sa.Column("payment_overflow_account_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_accounts_payment_account_id",
        "accounts", "accounts",
        ["payment_account_id"], ["id"],
    )
    op.create_foreign_key(
        "fk_accounts_payment_overflow_account_id",
        "accounts", "accounts",
        ["payment_overflow_account_id"], ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_accounts_payment_overflow_account_id", "accounts", type_="foreignkey")
    op.drop_constraint("fk_accounts_payment_account_id", "accounts", type_="foreignkey")
    op.drop_column("accounts", "payment_overflow_account_id")
    op.drop_column("accounts", "payment_account_id")

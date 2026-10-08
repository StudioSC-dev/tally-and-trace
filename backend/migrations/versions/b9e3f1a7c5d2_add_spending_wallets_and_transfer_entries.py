"""add spending wallets and recurring transfer budget entries

``accounts.is_spending_wallet`` marks accounts (cash on hand, e-wallets) whose
balance is shown but not counted as projection cash: topping one up is the
expense, and spending from it is categorised without being counted twice.
Existing cash and e_wallet accounts backfill to true; every other account
backfills to false via the server default.

``budget_entries.transfer_to_account_id`` makes an entry a recurring transfer:
its occurrences move money from ``account_id`` to this account, and it
materialises as a transfer transaction.

Revision ID: b9e3f1a7c5d2
Revises: a4d8e2c6f1b9
Create Date: 2026-10-08

"""
from alembic import op
import sqlalchemy as sa

revision = "b9e3f1a7c5d2"
down_revision = "a4d8e2c6f1b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column(
            "is_spending_wallet",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.execute(
        "UPDATE accounts SET is_spending_wallet = true "
        "WHERE account_type IN ('cash', 'e_wallet')"
    )

    op.add_column(
        "budget_entries",
        sa.Column("transfer_to_account_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_budget_entries_transfer_to_account_id",
        "budget_entries", "accounts",
        ["transfer_to_account_id"], ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_budget_entries_transfer_to_account_id", "budget_entries", type_="foreignkey"
    )
    op.drop_column("budget_entries", "transfer_to_account_id")
    op.drop_column("accounts", "is_spending_wallet")

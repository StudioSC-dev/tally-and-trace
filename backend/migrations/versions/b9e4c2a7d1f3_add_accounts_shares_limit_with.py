"""add accounts.shares_limit_with_account_id

A credit card may share another card's credit limit: the column points at the
card holding the limit (the primary), and the linked card keeps no limit of its
own. Additive only, so it is safe while the previous release still serves: a
nullable column, a foreign key that nulls itself if the primary row goes, two
CHECKs that every existing row meets (the column is null on all of them) and an
index for the "who points at me" lookups. The downgrade drops all of it; the
links are not recoverable.

Revision ID: b9e4c2a7d1f3
Revises: d7b3f1a9c5e2
Create Date: 2026-11-09

"""
from alembic import op
import sqlalchemy as sa

revision = "b9e4c2a7d1f3"
down_revision = "d7b3f1a9c5e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("shares_limit_with_account_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_accounts_shares_limit_with_account_id", "accounts", "accounts",
        ["shares_limit_with_account_id"], ["id"], ondelete="SET NULL",
    )
    op.create_check_constraint(
        "ck_accounts_shared_limit_not_self", "accounts",
        "shares_limit_with_account_id IS NULL OR shares_limit_with_account_id <> id",
    )
    op.create_check_constraint(
        "ck_accounts_shared_limit_no_own_limit", "accounts",
        "shares_limit_with_account_id IS NULL OR credit_limit IS NULL",
    )
    op.create_index(
        "ix_accounts_shares_limit_with_account_id", "accounts",
        ["shares_limit_with_account_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_accounts_shares_limit_with_account_id", table_name="accounts")
    op.drop_constraint("ck_accounts_shared_limit_no_own_limit", "accounts", type_="check")
    op.drop_constraint("ck_accounts_shared_limit_not_self", "accounts", type_="check")
    op.drop_constraint(
        "fk_accounts_shares_limit_with_account_id", "accounts", type_="foreignkey")
    op.drop_column("accounts", "shares_limit_with_account_id")

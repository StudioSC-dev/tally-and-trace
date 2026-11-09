"""add quick_balance_account_ids to users

The dashboard's pinned quick balance accounts (STU-578): an ordered JSON list
of at most 6 account ids, null for the default tiles. A preference, not a
grant: the API re-checks every id on each read and skips one the user can no
longer pin, so the stored list is never trusted.

One nullable column, no default, no backfill, no constraint: purely additive,
so the code serving during the build never reads or writes it.

Revision ID: e5a1c7b3d9f2
Revises: b9e4c2a7d1f3
Create Date: 2026-11-10

"""
from alembic import op
import sqlalchemy as sa

revision = "e5a1c7b3d9f2"
down_revision = "b9e4c2a7d1f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("quick_balance_account_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "quick_balance_account_ids")

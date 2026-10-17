"""add main_account_id to users

The user's optional "main" account for the cash-flow timeline (STU-326): when
set, the timeline page opens on that one account's running balance instead of
the pooled cash of every account. A preference, not a grant: the API checks on
every read that the user still holds a direct role on an active projection-cash
account, and reads anything else as unpinned, so the stored id is never trusted.

Nullable, no backfill: nobody has a main account until they pick one. The FK
is ``ON DELETE SET NULL`` so a hard-deleted account (the demo reseed, the
cutover reset) clears the pin instead of blocking the delete. No index: the
table is small and Postgres needs none for ``SET NULL``.

Revision ID: c4e8a2f6b1d9
Revises: a3c9e5d7f1b4
Create Date: 2026-10-17

"""
from alembic import op
import sqlalchemy as sa

revision = "c4e8a2f6b1d9"
down_revision = "a3c9e5d7f1b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("main_account_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_users_main_account_id",
        "users", "accounts",
        ["main_account_id"], ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_users_main_account_id", "users", type_="foreignkey")
    op.drop_column("users", "main_account_id")

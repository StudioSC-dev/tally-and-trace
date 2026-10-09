"""add account shares

Shared accounts (STU-232).

- ``account_shares``: one row per (account, user), giving that user the role
  ``viewer``, ``editor`` or ``admin`` on the account. Deleting the account or
  the user deletes the share; deleting the user who created it keeps the share
  with ``created_by`` null. Indexed on ``user_id`` (the accounts shared with a
  user).
- ``transactions.created_by_actor``: who triggered a transaction when it is
  not its owner (an editor materialising another user's recurring entry).
  Nullable; null on every existing row.

Every constraint is named explicitly, with the same names as the ORM.
Downgrade drops the column and the table.

Revision ID: b5d2e8f4a1c6
Revises: 4c8e1f6a2d97
Create Date: 2026-10-09

"""
from alembic import op
import sqlalchemy as sa

revision = "b5d2e8f4a1c6"
down_revision = "4c8e1f6a2d97"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "account_shares",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_account_shares"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"],
                                name="fk_account_shares_account_id_accounts", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"],
                                name="fk_account_shares_user_id_users", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"],
                                name="fk_account_shares_created_by_users", ondelete="SET NULL"),
        sa.UniqueConstraint("account_id", "user_id", name="uq_account_shares_account_id_user_id"),
        sa.CheckConstraint("role IN ('viewer', 'editor', 'admin')", name="ck_account_shares_role"),
    )
    op.create_index("ix_account_shares_user_id", "account_shares", ["user_id"])

    op.add_column("transactions", sa.Column("created_by_actor", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_transactions_created_by_actor_users", "transactions", "users",
        ["created_by_actor"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_transactions_created_by_actor_users", "transactions", type_="foreignkey")
    op.drop_column("transactions", "created_by_actor")
    op.drop_index("ix_account_shares_user_id", table_name="account_shares")
    op.drop_table("account_shares")

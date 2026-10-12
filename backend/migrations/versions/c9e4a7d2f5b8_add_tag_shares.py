"""add tag shares

Household viewer share (STU-233).

- ``tag_shares``: one row per (tag, user), giving that user a viewer-only
  share of the tag. Only the sharer's Household system tag may be shared; the
  application enforces that (there is no database guard). Deleting the tag or
  the user deletes the share. Indexed on ``user_id`` (the tags shared with a
  user).

Every constraint is named explicitly, with the same names as the ORM.
Downgrade drops the table.

Revision ID: c9e4a7d2f5b8
Revises: b5d2e8f4a1c6
Create Date: 2026-10-11

"""
from alembic import op
import sqlalchemy as sa

revision = "c9e4a7d2f5b8"
down_revision = "b5d2e8f4a1c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tag_shares",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tag_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_tag_shares"),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"],
                                name="fk_tag_shares_tag_id_tags", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"],
                                name="fk_tag_shares_user_id_users", ondelete="CASCADE"),
        sa.UniqueConstraint("tag_id", "user_id", name="uq_tag_shares_tag_id_user_id"),
    )
    op.create_index("ix_tag_shares_user_id", "tag_shares", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_tag_shares_user_id", table_name="tag_shares")
    op.drop_table("tag_shares")

"""drop budget_entries.is_autopay

Nothing reads or writes the column any more: settlement is ``auto_post_enabled``
alone. Ships only after the release that stopped mapping the column is live,
since the old code would otherwise select a column that no longer exists.
The downgrade adds the column back, not null and false (the original definition);
the dropped values are not recoverable.

Revision ID: d7b3f1a9c5e2
Revises: a2c6e8f0b4d1
Create Date: 2026-11-06

"""
from alembic import op
import sqlalchemy as sa

revision = "d7b3f1a9c5e2"
down_revision = "a2c6e8f0b4d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("budget_entries", "is_autopay")


def downgrade() -> None:
    op.add_column(
        "budget_entries",
        sa.Column("is_autopay", sa.Boolean(), nullable=False, server_default=sa.text("FALSE")),
    )

"""add review and auto-post flags to budget entries

``installment_reviewed_at`` is the settlement status of a card installment (set
by the review, or on create for a new installment dated from today);
``auto_post_enabled`` is the scheduling flag. No backfill: every existing row is
unreviewed and off.

Revision ID: b3d7f1a9c5e2
Revises: 20604a414c22
Create Date: 2026-10-29

"""
from alembic import op
import sqlalchemy as sa

revision = "b3d7f1a9c5e2"
down_revision = "20604a414c22"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "budget_entries",
        sa.Column("auto_post_enabled", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.add_column(
        "budget_entries",
        sa.Column("installment_reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("budget_entries", "installment_reviewed_at")
    op.drop_column("budget_entries", "auto_post_enabled")

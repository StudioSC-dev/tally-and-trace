"""add the page-open auto-post claim to users

``installments_page_posted_at`` records each user's last page-open run of the
card installment auto-post, so the Transactions page posts at most once per
user per 15 minutes. Operational state only. No backfill.

Revision ID: d9a1c3e5f7b2
Revises: b3d7f1a9c5e2
Create Date: 2026-10-29

"""
from alembic import op
import sqlalchemy as sa

revision = "d9a1c3e5f7b2"
down_revision = "b3d7f1a9c5e2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("installments_page_posted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "installments_page_posted_at")

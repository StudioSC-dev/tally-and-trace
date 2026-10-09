"""add demo_state

A one-row table holding the demo seed's shape version. On startup the seed
compares it with ``DEMO_SHAPE_VERSION`` (``app/core/seed.py``): a missing row
or a different version replaces the demo user's data with the current shape;
otherwise nothing changes. The ``CHECK (id = 1)`` keeps it to one row.

Revision ID: d1e3a5c7b9f2
Revises: c4e8a2f6b1d3
Create Date: 2026-10-09

"""
from alembic import op
import sqlalchemy as sa

revision = "d1e3a5c7b9f2"
down_revision = "c4e8a2f6b1d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "demo_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("shape_version", sa.Integer(), nullable=False),
        sa.Column("seeded_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("id = 1", name="ck_demo_state_single_row"),
    )


def downgrade() -> None:
    op.drop_table("demo_state")

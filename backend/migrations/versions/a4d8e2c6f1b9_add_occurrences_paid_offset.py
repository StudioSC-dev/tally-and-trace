"""add occurrences_paid_offset to budget_entries

Installments partly paid before cutover (e.g. 5 of 6) must import with the
owner's real paid count without fabricating historical transactions. This
column is added to the linked-transaction count when deriving "n of m".

Existing rows backfill to 0 via the server default.

Revision ID: a4d8e2c6f1b9
Revises: c7e1a9f2b3d4
Create Date: 2026-10-07

"""
from alembic import op
import sqlalchemy as sa

revision = "a4d8e2c6f1b9"
down_revision = "c7e1a9f2b3d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "budget_entries",
        sa.Column(
            "occurrences_paid_offset",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_column("budget_entries", "occurrences_paid_offset")

"""add occurrence_date to transactions

The occurrence of its budget entry that a materialised transaction fulfils
(STU-224): the entry's ``next_occurrence`` when it was materialised, whatever
``transaction_date`` was chosen. Suppression of projected occurrences matches
on it, falling back to ``transaction_date`` when it is null.

``timestamptz`` like ``transaction_date`` (baseline) and ``next_occurrence``,
so comparing or coalescing the two never casts through the session time zone.
No backfill: existing rows are null and keep matching on ``transaction_date``.

Revision ID: f8b2d4a6c1e3
Revises: e7a3c5f9b2d4
Create Date: 2026-10-15

"""
from alembic import op
import sqlalchemy as sa

revision = "f8b2d4a6c1e3"
down_revision = "e7a3c5f9b2d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("occurrence_date", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("transactions", "occurrence_date")

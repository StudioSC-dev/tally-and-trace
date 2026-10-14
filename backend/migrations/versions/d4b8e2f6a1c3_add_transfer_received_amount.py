"""add transfer received amount

Cross-currency transfers (STU-236).

- ``transactions.received_amount``: what a transfer's destination received,
  in the destination account's currency. Null means "the same as
  ``amount``", which every existing row is, so nothing is backfilled.

Downgrade drops the column.

Revision ID: d4b8e2f6a1c3
Revises: c9e4a7d2f5b8
Create Date: 2026-10-13

"""
from alembic import op
import sqlalchemy as sa

revision = "d4b8e2f6a1c3"
down_revision = "c9e4a7d2f5b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("transactions",
                  sa.Column("received_amount", sa.Numeric(15, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("transactions", "received_amount")

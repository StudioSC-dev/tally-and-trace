"""add allocation rank

STU-786: ``allocations.rank`` is nullable. It is set on a user's active allocations of
type ``savings`` or ``goal`` (rank 1 is the top) and null on every other row. The upgrade
numbers each user's existing ranked rows from 1 by ``created_at`` ascending, then ``id``
ascending. The downgrade drops the column.

Revision ID: c4e8a2d6f1b9
Revises: a7c3e5f9b1d2
Create Date: 2026-11-26

"""
from alembic import op
import sqlalchemy as sa

revision = "c4e8a2d6f1b9"
down_revision = "a7c3e5f9b1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("allocations", sa.Column("rank", sa.Integer(), nullable=True))
    op.execute("""
        UPDATE allocations
        SET rank = numbered.rank
        FROM (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY user_id ORDER BY created_at ASC, id ASC) AS rank
            FROM allocations
            WHERE is_active IS TRUE AND allocation_type IN ('savings', 'goal')
        ) AS numbered
        WHERE allocations.id = numbered.id
    """)


def downgrade() -> None:
    op.drop_column("allocations", "rank")

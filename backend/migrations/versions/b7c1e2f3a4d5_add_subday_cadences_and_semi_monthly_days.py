"""add weekly/biweekly/semi_monthly cadences and semi-monthly day fields

Revision ID: b7c1e2f3a4d5
Revises: 8be3628d
Create Date: 2026-07-13 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'b7c1e2f3a4d5'
down_revision = '8be3628d'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # New recurrence cadences. ADD VALUE IF NOT EXISTS is safe inside a transaction
    # on PostgreSQL 12+ as long as the new values aren't used in the same transaction
    # (they aren't here).
    op.execute("ALTER TYPE recurrencefrequency ADD VALUE IF NOT EXISTS 'weekly'")
    op.execute("ALTER TYPE recurrencefrequency ADD VALUE IF NOT EXISTS 'biweekly'")
    op.execute("ALTER TYPE recurrencefrequency ADD VALUE IF NOT EXISTS 'semi_monthly'")

    # Two configurable days-of-month for SEMI_MONTHLY entries (default 1st & 15th).
    op.add_column(
        'budget_entries',
        sa.Column('semi_monthly_day_1', sa.Integer(), nullable=False, server_default='1'),
    )
    op.add_column(
        'budget_entries',
        sa.Column('semi_monthly_day_2', sa.Integer(), nullable=False, server_default='15'),
    )


def downgrade() -> None:
    op.drop_column('budget_entries', 'semi_monthly_day_2')
    op.drop_column('budget_entries', 'semi_monthly_day_1')
    # NOTE: PostgreSQL cannot DROP individual enum values, so the added
    # recurrencefrequency values ('weekly','biweekly','semi_monthly') are left in
    # place on downgrade. Removing them would require recreating the type.

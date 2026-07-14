"""add overflow_account_id to budget_entries (UC1 account-aware routing)

Revision ID: c3a5e7d9f1b2
Revises: e2d4f6a8b0c1
Create Date: 2026-07-14 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'c3a5e7d9f1b2'
down_revision = 'e2d4f6a8b0c1'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('budget_entries', sa.Column('overflow_account_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_budget_entries_overflow_account_id',
        'budget_entries', 'accounts',
        ['overflow_account_id'], ['id'],
    )


def downgrade() -> None:
    op.drop_constraint('fk_budget_entries_overflow_account_id', 'budget_entries', type_='foreignkey')
    op.drop_column('budget_entries', 'overflow_account_id')

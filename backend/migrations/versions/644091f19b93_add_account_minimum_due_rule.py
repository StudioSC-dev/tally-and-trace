"""add minimum_due_rule to accounts

How a credit card's bank works out the minimum amount due (STU-343 Plan C,
section 2.4): a JSON rule validated by ``app.schemas.minimum_due.MinimumDueRule``
and stored as ``rule.model_dump(mode="json")``, so its Decimals are strings and
lose no precision. Null means no rule. Existing rows stay null. The downgrade
drops the column.

Revision ID: 644091f19b93
Revises: 1b678ac2c4f3
Create Date: 2026-10-19

"""
from alembic import op
import sqlalchemy as sa

revision = "644091f19b93"
down_revision = "1b678ac2c4f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("minimum_due_rule", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("accounts", "minimum_due_rule")

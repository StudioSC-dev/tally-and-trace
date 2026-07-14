"""convert money columns from float to numeric(15,2)

Prime-directive fix: money must be exact Decimal, not float. Postgres casts
double precision -> numeric automatically (rounding to the given scale).

Revision ID: e2d4f6a8b0c1
Revises: b7c1e2f3a4d5
Create Date: 2026-07-14 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = 'e2d4f6a8b0c1'
down_revision = 'b7c1e2f3a4d5'
branch_labels = None
depends_on = None


# (table, column, scale) — scale 2 for money, 6 for the FX rate.
_MONEY_COLUMNS = [
    ("accounts", "balance", 2),
    ("accounts", "credit_limit", 2),
    ("budget_entries", "amount", 2),
    ("transactions", "amount", 2),
    ("transactions", "projected_amount", 2),
    ("transactions", "original_amount", 2),
    ("transactions", "exchange_rate", 6),
    ("transactions", "transfer_fee", 2),
    ("allocations", "target_amount", 2),
    ("allocations", "current_amount", 2),
    ("allocations", "monthly_target", 2),
    ("wishlist_items", "estimated_cost", 2),
]


def upgrade() -> None:
    for table, column, scale in _MONEY_COLUMNS:
        op.alter_column(
            table, column,
            type_=sa.Numeric(15, scale),
            existing_type=sa.Float(),
            postgresql_using=f"{column}::numeric(15,{scale})",
        )


def downgrade() -> None:
    for table, column, _scale in _MONEY_COLUMNS:
        op.alter_column(
            table, column,
            type_=sa.Float(),
            existing_type=sa.Numeric(15, 2),
        )

"""add budget periods and carry-over

STU-795: ``budget_periods`` stores each closed window of a budget allocation: its
``start`` and ``end`` (naive UTC, like ``allocations.period_start``), the ``limit``
and ``currency`` in force, and ``carry_from``, the allocation's ``carry_over_from``
while the window was current (null when carry was off). Unique on
(``allocation_id``, ``start``); a row goes with its allocation (``ON DELETE
CASCADE``); a window's ``end`` is after its ``start``
(``ck_budget_periods_positive_length``). The table carries the data version
trigger (app/core/data_version.py).
There is no backfill: windows are stored from the first roll after this ships.

``allocations.carry_over_from`` is nullable (null means carry is off).
``allocations.period_anchor_day`` (nullable) is the day of the month a monthly or
quarterly budget's windows end on, kept across rolls so a fixed 30th stays the
30th; null until the budget first rolls, and cleared when its dates change.

Budgets accepted ``configuration.account_ids`` but ignored it until now; it now
filters what a budget counts, so the upgrade strips it from every existing
budget's configuration, unconditionally, and no envelope starts filtering at
rollout. The downgrade drops the table and the columns and leaves configurations
as they are (a stripped key is not restored).

Revision ID: d9b3f5a7c2e8
Revises: c4e8a2d6f1b9
Create Date: 2026-11-27

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from app.core import data_version

revision = "d9b3f5a7c2e8"
down_revision = "c4e8a2d6f1b9"
branch_labels = None
depends_on = None

TABLE = "budget_periods"


def upgrade() -> None:
    op.add_column("allocations", sa.Column("carry_over_from", sa.DateTime(), nullable=True))
    op.add_column("allocations", sa.Column("period_anchor_day", sa.SmallInteger(), nullable=True))
    op.create_table(
        TABLE,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("allocation_id", sa.Integer(), nullable=False),
        sa.Column("start", sa.DateTime(), nullable=False),
        sa.Column("end", sa.DateTime(), nullable=False),
        sa.Column("limit", sa.Numeric(15, 2), nullable=True),
        sa.Column("currency", postgresql.ENUM(name="currencytype", create_type=False),
                  nullable=False),
        sa.Column("carry_from", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(["allocation_id"], ["allocations.id"], ondelete="CASCADE",
                                name="fk_budget_periods_allocation_id_allocations"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("allocation_id", "start", name="uq_budget_periods_allocation_start"),
        sa.CheckConstraint('"end" > start', name="ck_budget_periods_positive_length"),
    )
    data_version.add_bump_trigger(op.get_bind(), TABLE)
    op.execute("""
        UPDATE allocations
        SET configuration = configuration - 'account_ids'
        WHERE allocation_type = 'budget'
          AND jsonb_typeof(configuration) = 'object'
          AND configuration ? 'account_ids'
    """)


def downgrade() -> None:
    op.drop_table(TABLE)
    op.drop_column("allocations", "period_anchor_day")
    op.drop_column("allocations", "carry_over_from")

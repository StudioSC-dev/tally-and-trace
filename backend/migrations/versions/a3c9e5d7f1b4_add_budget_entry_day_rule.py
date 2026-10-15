"""add anchor_day and day_rule to budget_entries

The day a month-family entry (monthly, quarterly, semi-annual, annual) falls
on (STU-315). ``anchor_day`` is the intended day of month, 1-31, clamped to
each month's length when the schedule advances, so it never drifts; ``day_rule``
"last_weekday" is the last Monday-Friday of the month and wins over it. Both
null is the legacy schedule, which steps from the current date's day.

Nullable, no backfill: existing rows keep the legacy schedule, and code that
predates the columns ignores them. ``day_rule`` is a plain string validated by
the API (as ``end_mode`` is), not a Postgres enum.

Revision ID: a3c9e5d7f1b4
Revises: f8b2d4a6c1e3
Create Date: 2026-10-15

"""
from alembic import op
import sqlalchemy as sa

revision = "a3c9e5d7f1b4"
down_revision = "f8b2d4a6c1e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("budget_entries", sa.Column("anchor_day", sa.SmallInteger(), nullable=True))
    op.add_column("budget_entries", sa.Column("day_rule", sa.String(length=20), nullable=True))
    op.create_check_constraint(
        "ck_budget_entries_anchor_day_range",
        "budget_entries",
        "anchor_day BETWEEN 1 AND 31",
    )


def downgrade() -> None:
    op.drop_constraint("ck_budget_entries_anchor_day_range", "budget_entries", type_="check")
    op.drop_column("budget_entries", "day_rule")
    op.drop_column("budget_entries", "anchor_day")

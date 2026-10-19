"""add billing_kind to budget_entries

How an open-ended card expense is billed (STU-343): ``subscription`` or ``bill``.
Null means unset (the kind is then derived). Existing open-ended card expenses
are backfilled: ``bill`` when the creator's own active category is Utilities,
``subscription`` otherwise. Capped card expenses, cash expenses, income and
transfers stay null. The downgrade drops the column and its check.

Revision ID: b7d3f1a9c5e2
Revises: c4e8a2f6b1d9
Create Date: 2026-10-19

"""
from alembic import op
import sqlalchemy as sa

revision = "b7d3f1a9c5e2"
down_revision = "c4e8a2f6b1d9"
branch_labels = None
depends_on = None

CHECK = "ck_budget_entries_billing_kind"


def upgrade() -> None:
    op.add_column("budget_entries", sa.Column("billing_kind", sa.String(16), nullable=True))
    op.create_check_constraint(
        CHECK, "budget_entries", "billing_kind IN ('subscription','bill')")
    op.execute("""
        UPDATE budget_entries be SET billing_kind = CASE WHEN EXISTS (
            SELECT 1 FROM categories c WHERE c.id = be.category_id AND c.user_id = be.user_id
              AND c.is_active AND lower(c.name) = 'utilities') THEN 'bill' ELSE 'subscription' END
        FROM accounts a
        WHERE a.id = be.account_id AND a.account_type = 'credit' AND be.entry_type = 'expense'
          AND be.transfer_to_account_id IS NULL
          AND NOT (be.end_mode = 'after_occurrences' AND be.max_occurrences IS NOT NULL)
    """)


def downgrade() -> None:
    op.drop_constraint(CHECK, "budget_entries", type_="check")
    op.drop_column("budget_entries", "billing_kind")

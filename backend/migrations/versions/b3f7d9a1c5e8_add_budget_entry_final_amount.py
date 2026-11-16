"""add final_amount to budget_entries

STU-658: a card installment split from its total bills the total ÷ N rounded
to the centavo each month, and its last payment absorbs the rounding
difference, as the issuers state (Metrobank, HSBC). ``final_amount`` is that
last occurrence's amount; null means every occurrence is ``amount``, which is
how every existing row reads, so nothing is backfilled. The API accepts it
only on an entry with a finite occurrence count; the check constraint keeps
it positive.

Revision ID: b3f7d9a1c5e8
Revises: e2b4d6f8a1c3
Create Date: 2026-11-16

"""
from alembic import op
import sqlalchemy as sa

revision = "b3f7d9a1c5e8"
down_revision = "e2b4d6f8a1c3"
branch_labels = None
depends_on = None

CHECK = "ck_budget_entries_final_amount_positive"


def upgrade() -> None:
    op.add_column("budget_entries",
                  sa.Column("final_amount", sa.Numeric(15, 2), nullable=True))
    op.create_check_constraint(CHECK, "budget_entries",
                               "final_amount IS NULL OR final_amount > 0")


def downgrade() -> None:
    op.drop_constraint(CHECK, "budget_entries", type_="check")
    op.drop_column("budget_entries", "final_amount")

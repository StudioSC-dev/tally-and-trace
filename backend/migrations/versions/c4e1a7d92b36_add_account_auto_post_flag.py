"""add the settlement flag to accounts and clear stray entry flags

``accounts.auto_post_enabled`` is the loan side of the one settlement flag
(meaningful on loans only). ``budget_entries.auto_post_enabled`` keeps its
values, so no entry or loan starts posting, and ``is_autopay`` is never copied.

The one exception is a defensive clear: a flag on a row failing the full
eligibility rule (reviewed, on a credit account, and a card installment: capped,
a plain expense, not a transfer, ``billing_kind`` not 'bill') is turned off. A
no-op on healthy data, since only the create gate and the review set it. Paused,
foreign-currency and cycle-less installments pass that rule and keep their flag.

Safe under the code still serving during ``alembic upgrade head``: it never
names the new column and the server default fills it. The raw UPDATE leaves
``updated_at`` alone, so no open edit form goes stale.

Revision ID: c4e1a7d92b36
Revises: 8f4493e073df
Create Date: 2026-11-06

"""
from alembic import op
import sqlalchemy as sa

revision = "c4e1a7d92b36"
down_revision = "8f4493e073df"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("auto_post_enabled", sa.Boolean(), nullable=False,
                  server_default=sa.false()),
    )
    op.execute(
        """
        UPDATE budget_entries AS be
        SET auto_post_enabled = false
        WHERE be.auto_post_enabled
          AND NOT (
            be.installment_reviewed_at IS NOT NULL
            AND be.entry_type = 'expense'
            AND be.transfer_to_account_id IS NULL
            AND be.end_mode = 'after_occurrences'
            AND be.max_occurrences IS NOT NULL
            AND be.billing_kind IS DISTINCT FROM 'bill'
            AND EXISTS (
              SELECT 1 FROM accounts AS a
              WHERE a.id = be.account_id AND a.account_type = 'credit'
            )
          )
        """
    )


def downgrade() -> None:
    # The cleared flags stay off: which rows were stray is not recorded.
    op.drop_column("accounts", "auto_post_enabled")

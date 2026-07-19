"""add kind to categories (income/expense/transfer)

Gives categories a directional `kind` so the app can tell true income/expense
apart from movements of the user's own money — savings contributions,
investment funding, credit-card payments. Those are net-worth-neutral transfers
whose two legs have opposite signs (a savings contribution is an expense from
checking but income to savings). `kind` drives the transaction form's
type/counter-account suggestions and reporting buckets; balance math is unchanged.

Backfill: is_expense = true -> 'expense', false -> 'income'. Categories literally
named Savings / Investments are promoted to 'transfer' to match their intent —
there is no category-management UI yet, so this one-time nudge saves a manual
re-tag. is_expense is retained and kept in sync by the categories router.

Revision ID: c7e1a9f2b3d4
Revises: f5a7c9e1d3b4
Create Date: 2026-07-19

"""
from alembic import op
import sqlalchemy as sa

revision = "c7e1a9f2b3d4"
down_revision = "f5a7c9e1d3b4"
branch_labels = None
depends_on = None


category_kind_enum = sa.Enum("income", "expense", "transfer", name="categorykind")


def upgrade() -> None:
    bind = op.get_bind()
    category_kind_enum.create(bind, checkfirst=True)
    op.add_column(
        "categories",
        sa.Column(
            "kind",
            category_kind_enum,
            nullable=False,
            server_default="expense",
        ),
    )
    op.execute("UPDATE categories SET kind = 'income' WHERE is_expense = false")
    op.execute(
        "UPDATE categories SET kind = 'transfer' "
        "WHERE lower(name) IN ('savings', 'investments', 'investment')"
    )


def downgrade() -> None:
    op.drop_column("categories", "kind")
    bind = op.get_bind()
    category_kind_enum.drop(bind, checkfirst=True)

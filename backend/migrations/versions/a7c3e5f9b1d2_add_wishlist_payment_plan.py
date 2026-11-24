"""add wishlist payment plan

STU-779: a wishlist item names the account its purchase is paid from
(``account_id``, nullable, cleared if the account row is ever deleted) and how:
``payment_plan`` ``full`` (the default; every existing row) or ``installment``,
with ``installment_months`` (2 to 60) set exactly when it is an installment (a
check constraint). ``installment_entry_id`` is the card installment entry that
marking the item purchased created: nullable, unique (one entry per item, one
item per entry) and cleared when that entry is deleted. The downgrade drops the
four columns, the constraint and the enum type.

Revision ID: a7c3e5f9b1d2
Revises: b7d4e1a9c3f6
Create Date: 2026-11-23

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "a7c3e5f9b1d2"
down_revision = "b7d4e1a9c3f6"
branch_labels = None
depends_on = None

TABLE = "wishlist_items"
PLAN = postgresql.ENUM("full", "installment", name="wishlistpaymentplan", create_type=False)


def upgrade() -> None:
    PLAN.create(op.get_bind(), checkfirst=False)
    op.add_column(TABLE, sa.Column("account_id", sa.Integer(), nullable=True))
    op.add_column(TABLE, sa.Column("payment_plan", PLAN, nullable=False, server_default="full"))
    op.add_column(TABLE, sa.Column("installment_months", sa.Integer(), nullable=True))
    op.add_column(TABLE, sa.Column("installment_entry_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_wishlist_items_account_id_accounts", TABLE, "accounts",
        ["account_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key(
        "fk_wishlist_items_installment_entry_id_budget_entries", TABLE, "budget_entries",
        ["installment_entry_id"], ["id"], ondelete="SET NULL")
    op.create_unique_constraint(
        "uq_wishlist_items_installment_entry_id", TABLE, ["installment_entry_id"])
    op.create_check_constraint(
        "ck_wishlist_items_installment_months", TABLE,
        "(payment_plan = 'full' AND installment_months IS NULL) OR "
        "(payment_plan = 'installment' AND installment_months IS NOT NULL "
        "AND installment_months BETWEEN 2 AND 60)")
    op.create_index("ix_wishlist_items_account_id", TABLE, ["account_id"])


def downgrade() -> None:
    op.drop_index("ix_wishlist_items_account_id", table_name=TABLE)
    op.drop_constraint("ck_wishlist_items_installment_months", TABLE, type_="check")
    op.drop_constraint("uq_wishlist_items_installment_entry_id", TABLE, type_="unique")
    op.drop_constraint(
        "fk_wishlist_items_installment_entry_id_budget_entries", TABLE, type_="foreignkey")
    op.drop_constraint("fk_wishlist_items_account_id_accounts", TABLE, type_="foreignkey")
    op.drop_column(TABLE, "installment_entry_id")
    op.drop_column(TABLE, "installment_months")
    op.drop_column(TABLE, "payment_plan")
    op.drop_column(TABLE, "account_id")
    PLAN.drop(op.get_bind(), checkfirst=False)

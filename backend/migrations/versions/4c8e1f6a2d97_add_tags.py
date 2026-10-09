"""add tags

Tags (STU-231): a user's own labels, and the links that put them on accounts,
transactions and recurring entries.

- ``tags``: unique per user by ``lower(name)`` (a functional unique index),
  and at most one system tag per user (a partial unique index on ``user_id``
  where ``is_system``). Deleting a user deletes their tags.
- ``account_tags``, ``transaction_tags`` and ``budget_entry_tags``: keyed
  ``(tag_id, <record>_id)``, with ``ON DELETE CASCADE`` on both foreign keys and
  an index on the record id.

Upgrade also gives every existing user who has none their "Household" system
tag (new users get one at registration). Downgrade drops all four tables.

Revision ID: 4c8e1f6a2d97
Revises: 7b3d9f1a5c82
Create Date: 2026-10-09

"""
from alembic import op
import sqlalchemy as sa

revision = "4c8e1f6a2d97"
down_revision = "7b3d9f1a5c82"
branch_labels = None
depends_on = None

# (table, record id column, record table)
LINK_TABLES = (
    ("account_tags", "account_id", "accounts"),
    ("transaction_tags", "transaction_id", "transactions"),
    ("budget_entry_tags", "budget_entry_id", "budget_entries"),
)


def upgrade() -> None:
    op.create_table(
        "tags",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.Column("color", sa.String(length=7), nullable=True),
        sa.Column("is_system", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(),
                  nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_tags_user_id",
                                ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tags_id", "tags", ["id"])
    op.create_index("uq_tags_user_id_lower_name", "tags",
                    ["user_id", sa.text("lower(name)")], unique=True)
    op.create_index("uq_tags_user_id_system", "tags", ["user_id"], unique=True,
                    postgresql_where=sa.text("is_system"))

    for table, column, record_table in LINK_TABLES:
        op.create_table(
            table,
            sa.Column("tag_id", sa.Integer(), nullable=False),
            sa.Column(column, sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(["tag_id"], ["tags.id"], name=f"fk_{table}_tag_id",
                                    ondelete="CASCADE"),
            sa.ForeignKeyConstraint([column], [f"{record_table}.id"],
                                    name=f"fk_{table}_{column}", ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("tag_id", column, name=f"pk_{table}"),
        )
        op.create_index(f"ix_{table}_{column}", table, [column])

    op.execute(
        "INSERT INTO tags (user_id, name, is_system) "
        "SELECT u.id, 'Household', true FROM users u "
        "WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.user_id = u.id AND t.is_system)"
    )


def downgrade() -> None:
    for table, _column, _record_table in reversed(LINK_TABLES):
        op.drop_table(table)
    op.drop_table("tags")

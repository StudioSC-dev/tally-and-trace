"""add the gifts and donations given default expense category

Gives every existing user the expense default "Gifts & Donations" (STU-384); new
users get it at registration from ``constants/default_categories.json``. A user
who already has a same-name expense category, active or inactive, is skipped and
keeps theirs as it is: an inactive one was deleted by the user and is not
reactivated, as ``ensure_default_categories`` never recreates a soft-deleted
default. A same-name category of another kind (for example income) does not
block the insert while ``SKIP_WHEN_OTHER_KIND_EXISTS`` is False (owner ruling
B2): an income and an expense category may share a name.

Revision ID: 1b678ac2c4f3
Revises: b7d3f1a9c5e2
Create Date: 2026-10-20

"""
import logging

from alembic import op
import sqlalchemy as sa

revision = "1b678ac2c4f3"
down_revision = "b7d3f1a9c5e2"
branch_labels = None
depends_on = None

# True: a same-name category of any kind blocks the insert (B1).
# False: only a same-name expense category blocks it (B2, the owner's ruling).
SKIP_WHEN_OTHER_KIND_EXISTS = False

NAME = "Gifts & Donations"
DESCRIPTION = "Gifts and donations given"
COLOR = "#E599F7"

log = logging.getLogger("alembic.runtime.migration")


def upgrade() -> None:
    bind = op.get_bind()
    params = {"name": NAME}
    has_expense = ("EXISTS (SELECT 1 FROM categories c WHERE c.user_id = u.id "
                   "AND c.name = :name AND c.kind = 'expense')")
    has_other_kind_only = ("EXISTS (SELECT 1 FROM categories c WHERE c.user_id = u.id "
                           "AND c.name = :name AND c.kind <> 'expense') "
                           f"AND NOT {has_expense}")
    blocked = (f"({has_expense} OR {has_other_kind_only})" if SKIP_WHEN_OTHER_KIND_EXISTS
               else has_expense)

    skipped_expense = bind.execute(
        sa.text(f"SELECT count(*) FROM users u WHERE {has_expense}"), params).scalar_one()
    other_kind_only = bind.execute(
        sa.text(f"SELECT count(*) FROM users u WHERE {has_other_kind_only}"),
        params).scalar_one()

    inserted = bind.execute(sa.text(f"""
        INSERT INTO categories (user_id, name, description, color, kind, is_expense,
                                is_active, created_at)
        SELECT u.id, :name, :description, :color, 'expense', true, true, now()
        FROM users u
        WHERE NOT {blocked}
    """), {**params, "description": DESCRIPTION, "color": COLOR}).rowcount

    log.info("%s: inserted for %d users; skipped %d users with a same-name expense "
             "category (active or inactive)", NAME, inserted, skipped_expense)
    if SKIP_WHEN_OTHER_KIND_EXISTS:
        log.info("%s: skipped %d users whose only same-name category is another kind",
                 NAME, other_kind_only)
    else:
        log.info("%s: inserted beside a same-name category of another kind for %d users",
                 NAME, other_kind_only)


def downgrade() -> None:
    # Deliberately a no-op. Nothing marks which rows the upgrade created: a user may
    # have made their own "Gifts & Donations" since, and rows may already be linked
    # from transactions, budget entries and wishlist_items.category_id. Deleting by
    # name could destroy user data, so the categories stay.
    pass

"""add a unique index on lower(users.email)

STU-241: registration already refuses an email differing from a stored one only
by case, and the share picker treats such an email as naming no one; the
database now enforces it with the functional unique index
``uq_users_lower_email``.

Upgrade first counts the emails held by more than one user once case is
ignored. If there are any, it aborts with those counts (never the emails) and
changes nothing: resolve the duplicates, then upgrade again. Downgrade drops the
index.

Revision ID: e2b4d6f8a1c3
Revises: d6f8a2c4e1b7
Create Date: 2026-11-15

"""
from alembic import op
import sqlalchemy as sa

revision = "e2b4d6f8a1c3"
down_revision = "d6f8a2c4e1b7"
branch_labels = None
depends_on = None

INDEX = "uq_users_lower_email"

# One row: how many lower-cased emails are held by more than one user, and how
# many users hold them. Counts only, so the abort message carries no email.
CASE_DUPLICATES = sa.text(
    "SELECT count(*) AS emails, coalesce(sum(n), 0) AS users FROM ("
    "SELECT count(*) AS n FROM users GROUP BY lower(email) HAVING count(*) > 1"
    ") AS dup"
)


def upgrade() -> None:
    emails, users = op.get_bind().execute(CASE_DUPLICATES).one()
    if emails:
        raise RuntimeError(
            f"{INDEX}: refusing to upgrade: {emails} email address(es) differing only "
            f"by case are held by {users} users. Nothing was changed. Resolve those "
            "accounts, then upgrade again."
        )
    op.create_index(INDEX, "users", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index(INDEX, table_name="users")

"""make allocations.account_id nullable

STU-777: a savings allocation that totals its Savings transactions
(``configuration.goal_mode`` ``transaction_total``) needs no account, so
``allocations.account_id`` becomes nullable. Budgets, goals and the other
savings modes still need one; the API enforces that per mode.

The downgrade backfills every null with the owner's ``main_account_id`` (when
they own that account), else their first owned account (lowest id), then
restores NOT NULL. An owner with no account at all cannot be backfilled: the
downgrade stops with an error rather than delete their allocations.

Revision ID: b7d4e1a9c3f6
Revises: f5905076b019
Create Date: 2026-11-23

"""
from alembic import op
import sqlalchemy as sa

revision = "b7d4e1a9c3f6"
down_revision = "f5905076b019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("allocations", "account_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    bind = op.get_bind()
    nulls = sa.text("SELECT count(*) FROM allocations WHERE account_id IS NULL")
    if bind.execute(nulls).scalar():
        bind.execute(sa.text(
            "UPDATE allocations AS al SET account_id = COALESCE("
            "  (SELECT u.main_account_id FROM users u JOIN accounts a"
            "     ON a.id = u.main_account_id AND a.user_id = u.id WHERE u.id = al.user_id),"
            "  (SELECT min(a.id) FROM accounts a WHERE a.user_id = al.user_id)"
            ") WHERE al.account_id IS NULL"))
        # The write queued the data version's deferred bump (app/core/data_version.py):
        # run it now, so a later downgrade in this transaction can drop its table.
        bind.execute(sa.text("SET CONSTRAINTS ALL IMMEDIATE"))
    stranded = bind.execute(nulls).scalar()
    if stranded:
        raise RuntimeError(
            f"{stranded} allocation(s) have no account and their owner has none to "
            "backfill with; give the owner an account or delete them, then downgrade again")
    op.alter_column("allocations", "account_id", existing_type=sa.Integer(), nullable=False)

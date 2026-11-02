"""sync transaction recurring flag

Data cleanup for STU-485. ``transactions.is_recurring`` says a row is tied to
a recurring entry; ``budget_entry_id`` is the tie itself. Shared views drop
``budget_entry_id`` and keep ``is_recurring``, so the flag must agree with the
link. Every write path now keeps ``is_recurring == (budget_entry_id IS NOT
NULL)``, but rows written before it may not:

- deleting a recurring entry nulled ``budget_entry_id`` on its linked rows and
  left ``is_recurring`` (and ``recurrence_frequency``) set;
- ``e5b7c9d1f3a6`` cleared cross-owner ``budget_entry_id`` values the same way;
- the baseline added ``is_recurring`` with a ``FALSE`` default and no backfill,
  so an older linked row may read ``False``.

Two statements fix both directions:

- a row with no link and ``is_recurring`` set gets ``is_recurring = false``
  and ``recurrence_frequency = NULL``, as unlinking a transaction does;
- a linked row with ``is_recurring`` unset gets ``is_recurring = true``. Its
  ``recurrence_frequency`` is left as is.

Posted and pending rows are treated alike. Every statement only changes rows
that contradict their link, so the upgrade is idempotent: on clean data it
changes nothing.

The downgrade is a no-op: the old values contradicted the link and are not
recorded anywhere.

Revision ID: e7a1d3f5b9c2
Revises: d9a1c3e5f7b2
Create Date: 2026-11-02

"""
from alembic import op

revision = "e7a1d3f5b9c2"
down_revision = "d9a1c3e5f7b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE transactions SET is_recurring = false, recurrence_frequency = NULL "
        "WHERE budget_entry_id IS NULL AND is_recurring"
    )
    op.execute(
        "UPDATE transactions SET is_recurring = true "
        "WHERE budget_entry_id IS NOT NULL AND NOT is_recurring"
    )


def downgrade() -> None:
    """No-op: the cleared values contradicted the link and cannot be restored."""

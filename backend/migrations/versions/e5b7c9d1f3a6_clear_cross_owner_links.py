"""clear cross-owner links

Data cleanup for STU-229. The entity era let one user's record reference
another user's category, allocation or recurring entry through a shared
entity. The app no longer creates such references (the same-owner rule), and
this migration removes the ones left behind, so no code path can follow a
stale link into another user's data.

Every non-account reference whose target is owned by a different user than
the referencing row's ``user_id`` is set to NULL:

- ``transactions.category_id``, ``transactions.allocation_id`` and
  ``transactions.budget_entry_id``;
- ``budget_entries.category_id`` and ``budget_entries.allocation_id``;
- ``wishlist_items.category_id``;
- in ``allocations.configuration`` (JSONB), the ids the same-owner rule checks
  (``routers/allocations.py``): another user's id is removed from the
  ``category_ids`` and ``account_ids`` lists (order and the other elements are
  kept), and a ``savings_category_id`` naming another user's category is
  removed from the object. An id is read as the app reads it, a JSON number
  or a numeric string; anything else, and an id with no matching row, is left
  alone.

It also clears ``transfer_from_account_id`` and ``transfer_to_account_id`` on
every transaction that is not a ``transfer``: stray values the code ignores.

Account references are deliberately untouched (``account_id``, a transfer's
accounts, card routing and overflow): a cross-owner account reference is a
legitimate shared-pool row.

Every statement only changes rows that still hold such a reference, so the
upgrade is idempotent: on clean data it changes nothing.

The downgrade is a no-op: the cleared links are not recorded anywhere and
cannot be restored.

Revision ID: e5b7c9d1f3a6
Revises: d1e3a5c7b9f2
Create Date: 2026-10-09

"""
from alembic import op

revision = "e5b7c9d1f3a6"
down_revision = "d1e3a5c7b9f2"
branch_labels = None
depends_on = None

# (table, column, target table) for every plain non-account reference.
COLUMN_LINKS = (
    ("transactions", "category_id", "categories"),
    ("transactions", "allocation_id", "allocations"),
    ("transactions", "budget_entry_id", "budget_entries"),
    ("budget_entries", "category_id", "categories"),
    ("budget_entries", "allocation_id", "allocations"),
    ("wishlist_items", "category_id", "categories"),
)

# Id lists in allocations.configuration and the table their ids name.
CONFIG_LIST_KEYS = (
    ("category_ids", "categories"),
    ("account_ids", "accounts"),
)


def _config_id(element: str) -> str:
    """SQL for a JSONB element read as an id the way the app's ``int()`` does."""
    return (
        f"CASE WHEN jsonb_typeof({element}) = 'number' "
        f"THEN trunc(({element} #>> '{{}}')::numeric) "
        f"WHEN jsonb_typeof({element}) = 'string' "
        f"AND btrim({element} #>> '{{}}') ~ '^[+-]?[0-9]+$' "
        f"THEN btrim({element} #>> '{{}}')::numeric END"
    )


def upgrade() -> None:
    for table, column, target in COLUMN_LINKS:
        op.execute(
            f"UPDATE {table} AS r SET {column} = NULL "
            f"FROM {target} AS t "
            f"WHERE r.{column} = t.id AND t.user_id <> r.user_id"
        )

    for key, target in CONFIG_LIST_KEYS:
        foreign = (
            f"EXISTS (SELECT 1 FROM {target} AS t "
            f"WHERE t.id = {_config_id('x.e')} AND t.user_id <> a.user_id)"
        )
        op.execute(
            f"UPDATE allocations AS a SET configuration = jsonb_set("
            f"a.configuration, '{{{key}}}', ("
            f"SELECT COALESCE(jsonb_agg(x.e ORDER BY x.ord), '[]'::jsonb) "
            f"FROM jsonb_array_elements(a.configuration -> '{key}') "
            f"WITH ORDINALITY AS x(e, ord) WHERE NOT {foreign})) "
            f"WHERE jsonb_typeof(a.configuration) = 'object' "
            f"AND jsonb_typeof(a.configuration -> '{key}') = 'array' "
            f"AND EXISTS (SELECT 1 FROM jsonb_array_elements("
            f"a.configuration -> '{key}') AS x(e) WHERE {foreign})"
        )

    savings = "a.configuration -> 'savings_category_id'"
    op.execute(
        "UPDATE allocations AS a "
        "SET configuration = a.configuration - 'savings_category_id' "
        "WHERE jsonb_typeof(a.configuration) = 'object' "
        f"AND EXISTS (SELECT 1 FROM categories AS t "
        f"WHERE t.id = {_config_id(savings)} AND t.user_id <> a.user_id)"
    )

    op.execute(
        "UPDATE transactions "
        "SET transfer_from_account_id = NULL, transfer_to_account_id = NULL "
        "WHERE transaction_type <> 'transfer' "
        "AND (transfer_from_account_id IS NOT NULL OR transfer_to_account_id IS NOT NULL)"
    )


def downgrade() -> None:
    """No-op: the cleared links were not recorded and cannot be restored."""

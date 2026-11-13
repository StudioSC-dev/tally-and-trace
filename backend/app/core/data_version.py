"""The database's data version (STU-602, PERF-7): one number that changes with every
committed write, so a reader can tell whether anything changed since it last looked.

``data_version`` holds one row (``id`` 1). Every table except ``EXCLUDED_TABLES``
carries the statement-level trigger ``data_version_bump`` (``AFTER INSERT OR UPDATE
OR DELETE OR TRUNCATE ... FOR EACH STATEMENT``). It catches every writer: API routes,
``backend/scripts/*``, the cutover reset's raw ``DELETE``, seeds and later migrations.

The bump happens once per writing transaction, at its commit:

- the first write statement in a transaction marks it (a transaction-local setting)
  and inserts one row into ``data_version_pending``; later statements in the same
  transaction see the mark and do nothing more;
- that row's deferred constraint trigger runs at ``COMMIT`` and adds 1 to
  ``data_version.version`` (and deletes the pending row), in the same transaction as
  the data it stands for.

So a rolled-back write never bumps, an uncommitted bump is never visible, and the new
version and the new data become visible together. Taking the version row's lock at
commit, not at the first write, keeps it from serialising write transactions or
joining a deadlock with the row locks a transaction takes after its first write.

It is a row, not a sequence: ``nextval`` is not transactional and is visible before
the writer commits, which would let a reader tag stale data with a new version.

A new table gets the trigger in its own migration with ``add_bump_trigger``, or joins
``EXCLUDED_TABLES``; ``test_data_version_integration.py`` fails on a table with
neither.
"""
from typing import List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

TRIGGER = "data_version_bump"
MARK_FUNCTION = "data_version_mark"

# Tables whose writes do not change what any opted-in GET returns:
# tokens (auth only), stored statements (derived from rows that do bump, and written
# by reads catching up, PERF-6), the version machinery itself, idempotency replies
# (PERF-9) and Alembic's bookkeeping. A table listed here that does not exist yet is
# simply skipped.
EXCLUDED_TABLES = frozenset({
    "refresh_tokens",
    "email_tokens",
    "card_statements",
    "card_statement_state",
    "data_version",
    "data_version_pending",
    "idempotency_keys",
    "alembic_version",
})


def _quote(bind, table: str) -> str:
    return bind.dialect.identifier_preparer.quote(table)


def add_bump_trigger(bind, table: str) -> None:
    """Give ``table`` the version trigger (for a migration that creates a table)."""
    if table in EXCLUDED_TABLES:
        raise ValueError(f"{table} is excluded from the data version")
    bind.execute(text(
        f"CREATE TRIGGER {TRIGGER} AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE "
        f"ON {_quote(bind, table)} FOR EACH STATEMENT EXECUTE FUNCTION {MARK_FUNCTION}()"))


def drop_bump_trigger(bind, table: str) -> None:
    """Remove the version trigger from ``table`` (a downgrade's counterpart)."""
    bind.execute(text(f"DROP TRIGGER IF EXISTS {TRIGGER} ON {_quote(bind, table)}"))


def schema_tables(bind) -> List[str]:
    """Every ordinary table in the connection's current schema, by name."""
    return [name for (name,) in bind.execute(text(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname"))]


def covered_tables(bind) -> List[str]:
    """The tables that carry the trigger: every existing table not excluded."""
    return [t for t in schema_tables(bind) if t not in EXCLUDED_TABLES]


def current_version(db: Session) -> Optional[int]:
    """The committed data version, as this transaction's statement sees it now."""
    return db.execute(text("SELECT version FROM data_version WHERE id = 1")).scalar()
